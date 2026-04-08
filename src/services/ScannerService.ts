import fs from "fs-extra";
import path from "path";
import { Dirent } from "fs";
import { v4 as uuidv4 } from "uuid";
import { parseStringPromise } from "xml2js";
import stringSimilarity from "string-similarity";

import { Logger } from "(src)/helpers/Logger";
import { ScanRootResult } from "(src)/models/interfaces/ScanRootResult";
import {
	cleanFilename,
	cleanTitle,
	generateHash,
	getHashes,
	humanFileSize,
	removeTrailingSeparator
} from "(src)/utils/fileUtils";
import { ScanResult } from "(src)/models/interfaces/ScanResult";
import { Directory } from "(src)/models/interfaces/Directory";
import { File, FileKind } from "(src)/models/interfaces/File";
import { CacheArtifactSnapshotSummary } from "(src)/models/interfaces/CacheArtifactSnapshot";
import { EligibleComicSource } from "(src)/models/interfaces/EligibleComicSource";
import { ScanRootRepository } from "(src)/repositories/ScanRootRepository";
import { FileRepository } from "(src)/repositories/FileRepository";
import { CalibreService } from "(src)/services/CalibreService";
import { ComicChunkCacheService } from "(src)/services/ComicChunkCacheService";
import { OpenLibraryService } from "(src)/services/OpenLibraryService";
import { CacheArtifactSnapshotService } from "(src)/services/CacheArtifactSnapshotService";
import { SpecialDirectoryArtifactService } from "(src)/services/SpecialDirectoryArtifactService";
import { config } from "(src)/config/configuration";
import { cleanupCacheBuildRoot } from "(src)/utils/comicCacheUtils";
import {
	ComicEligibilityReason,
	resolveEligibleComicSource
} from "(src)/utils/archiveDetectionUtils";

const logger = new Logger("Scanner Service");

interface ScanProgressContext {
	startedAt: number;
	lastLoggedAt: number;
	lastLoggedEntries: number;
	directoriesSeen: number;
	filesSeen: number;
	specialDirectoriesDetected: number;
}

interface CacheGarbageCollectionSummary {
	cacheDirsTotal: number;
	liveCoverIds: number;
	candidates: number;
	removed: number;
	bytesFreed: number;
}

interface EligibleComicSourceResolutionSummary {
	buildSources: EligibleComicSource[];
	eligibleCount: number;
	reusedReadyCount: number;
}

export class ScannerService {
	private static instance: ScannerService;
	private static readonly candidateProgressSmallBatch = 10;
	private static readonly candidateProgressMediumBatch = 25;
	private static readonly candidateProgressLargeBatch = 100;
	private static readonly scanProgressEveryEntries = 500;
	private static readonly scanProgressEveryMs = 5000;

	private constructor() {
	}

	public static getInstance(): ScannerService {
		if (!ScannerService.instance) {
			ScannerService.instance = new ScannerService();
		}
		return ScannerService.instance;
	}

	public async scan(rootPath: string): Promise<ScanRootResult> {
		logger.info(`Scanning: "${rootPath}"`);

		let result = undefined;
		const progress: ScanProgressContext = {
			startedAt: Date.now(),
			lastLoggedAt: Date.now(),
			lastLoggedEntries: 0,
			directoriesSeen: 0,
			filesSeen: 0,
			specialDirectoriesDetected: 0
		};

		try {
			const scanResult = await this.getStructureAndFiles(rootPath, undefined, progress);

			result = {
				root: rootPath,
				scan: scanResult
			} as ScanRootResult;
		} catch (error) {
			logger.error("Error scanning:", error);
		}

		this.maybeLogScanProgress(progress, rootPath, true);

		logger.info(`Scanning: "${result ? "Success" : "Failed"}"`);

		return result;
	}

	public async scanCompareUpdate(scanRootPath: string) {
		logger.info(`scanCompareUpdate for path: "${scanRootPath}".`);
		const scanStartedAt = Date.now();

		try {
			const scanRoot = await ScanRootRepository.getInstance().getScanRootByPath(scanRootPath);

			if (!scanRoot) {
				logger.error("No scan roots found.");
				return;
			}

			try {
				const removedStagingEntries = await cleanupCacheBuildRoot();
				logger.info(`Staging cleanup removed "${removedStagingEntries}" residual entries.`);
			} catch (cleanupError) {
				logger.error("Staging cleanup failed:", cleanupError);
			}

			// - escanear el directorio observado.
			const scanRootResult = await ScannerService.getInstance().scan(removeTrailingSeparator(scanRootPath));

			// - obtener los hashes de los directorios.
			const hash = getHashes(scanRootResult.scan.directories);

			// - eliminar los archivos en la db que NO tengan un parentHash dentro de los hashes obtenidos.
			const removedFilesCount = await FileRepository.getInstance().removeFileByParentHash(hash);
			logger.info(`Removed files by parent hash: ${removedFilesCount}.`);
			let removedByFileHashCount = 0;

			const scanHashSet = new Set(scanRootResult.scan.files.map((f: File) => f.fileHash));
			let currentDbFiles = await FileRepository.getInstance().getFilesForCacheBuild(scanRoot.id);
			let dbHashSet = new Set(currentDbFiles.map((file: File) => file.fileHash));
			const fileToRemove = currentDbFiles.filter((file: File) => !scanHashSet.has(file.fileHash));

			// - eliminar los archivos en la db que NO estén en el scan.
			if (fileToRemove.length) {
				removedByFileHashCount = await FileRepository.getInstance()
					.removeFileByFileHash(fileToRemove.map((file: File) => file.fileHash));
				logger.info(`Removed files by file hash: ${removedByFileHashCount}.`);
				currentDbFiles = await FileRepository.getInstance().getFilesForCacheBuild(scanRoot.id);
				dbHashSet = new Set(currentDbFiles.map((file: File) => file.fileHash));
			}

			// - los archivos del scan que no estén en la db, se insertan.
			const newFiles = scanRootResult.scan.files.filter((file: File) => !dbHashSet.has(file.fileHash));

			logger.info(`New files: ${newFiles.length}.`);
			logger.info(JSON.stringify(newFiles.map((f: File) => f.name)));

			const concurrency = config.production.scan.concurrency;
			const insertedNewFiles: File[] = [];
			let firstInsertElapsedMs: number | undefined = undefined;
			let metadataCompleted = 0;
			let insertCompleted = 0;
			let insertFailed = 0;

			// Phase 1: local metadata + web metadata + immediate DB insert per file
			logger.info(`Phase 1 — metadata and insert for ${newFiles.length} files (concurrency: ${concurrency})`);
			await this.processConcurrently(newFiles, async (file, idx) => {
				const fullPath = path.join(file.parentPath, file.name);
				logger.info(`Metadata start queued="${idx + 1}/${newFiles.length}" path="${fullPath}".`);
				await this.fillLocalDetails(file);
				await this.fillWebDetails(file);
				metadataCompleted++;
				logger.info(`Metadata progress completed="${metadataCompleted}/${newFiles.length}" path="${fullPath}".`);
				const insertedId = await FileRepository.getInstance().insertFile(file, scanRoot.id);

				if (insertedId) {
					file.id = insertedId;
					insertedNewFiles.push(file);
					if (firstInsertElapsedMs === undefined) {
						firstInsertElapsedMs = Date.now() - scanStartedAt;
					}
					insertCompleted++;
					logger.info(
						`Insert progress completed="${insertCompleted}/${newFiles.length}" failed="${insertFailed}" path="${fullPath}" id="${insertedId}".`
					);
				} else {
					insertFailed++;
					logger.error(`Insert failed for "${fullPath}".`);
					logger.info(
						`Insert progress completed="${insertCompleted}/${newFiles.length}" failed="${insertFailed}" path="${fullPath}".`
					);
				}
			}, concurrency);
			logger.info(
				`Phase 1 complete completed="${newFiles.length}/${newFiles.length}" metadataCompleted="${metadataCompleted}" inserted="${insertCompleted}" failed="${insertFailed}".`
			);

			const candidatePreparationStartedAt = Date.now();
			logger.info(
				`Preparing cache candidate inputs scanFiles="${scanRootResult.scan.files.length}" existingDbFiles="${currentDbFiles.length}" newInsertedFiles="${insertedNewFiles.length}".`
			);
			const currentDbFilesMap = new Map(currentDbFiles.map((file: File) => [file.fileHash, file]));
			const existingDbBackedFiles = scanRootResult.scan.files
				.filter((file: File) => dbHashSet.has(file.fileHash))
				.map((file: File) => currentDbFilesMap.get(file.fileHash))
				.filter((file: File | undefined): file is File => file !== undefined)
			;
			logger.info(
				`Cache candidate inputs ready existing="${existingDbBackedFiles.length}" new="${insertedNewFiles.length}" elapsedMs="${Date.now() - candidatePreparationStartedAt}".`
			);
			const existingEligibleSummary = await this.resolveEligibleComicSources(existingDbBackedFiles, "existing");
			const newEligibleSummary = await this.resolveEligibleComicSources(insertedNewFiles, "new");

			const zipOnlyClassificationStartedAt = Date.now();
			logger.info(
				`Resolving ZIP-only special directories existingPool="${currentDbFiles.length}" newPool="${insertedNewFiles.length}".`
			);
			const existingZipOnlySpecials = this.resolveZipOnlySpecialDirectories(currentDbFiles, "existing");
			const newZipOnlySpecials = this.resolveZipOnlySpecialDirectories(insertedNewFiles, "new");
			const zipOnlySpecials = [...existingZipOnlySpecials, ...newZipOnlySpecials];
			logger.info(
				`ZIP-only special directories resolved existing="${existingZipOnlySpecials.length}" new="${newZipOnlySpecials.length}" total="${zipOnlySpecials.length}" elapsedMs="${Date.now() - zipOnlyClassificationStartedAt}".`
			);
			let specialArtifactReadyCount = 0;
			let specialArtifactSkippedCount = 0;
			let specialArtifactErrorCount = 0;

			logger.info(
				`Phase 2 — special directory artifacts total="${zipOnlySpecials.length}" existing="${existingZipOnlySpecials.length}" new="${newZipOnlySpecials.length}".`
			);
			if (zipOnlySpecials.length) {
				const specialArtifactResults = await SpecialDirectoryArtifactService.getInstance().ensureArtifactsForFiles(
					zipOnlySpecials,
					{concurrency}
				);
				specialArtifactReadyCount = specialArtifactResults.filter((result) => result.status === "ready").length;
				specialArtifactSkippedCount = specialArtifactResults.filter((result) => result.status === "skipped").length;
				specialArtifactErrorCount = specialArtifactResults.filter((result) => result.status === "error").length;
				logger.info(
					`Phase 2 — special directory artifacts complete completed="${zipOnlySpecials.length}/${zipOnlySpecials.length}" ready="${specialArtifactReadyCount}" skipped="${specialArtifactSkippedCount}" error="${specialArtifactErrorCount}".`
				);
			}

			const eligibleSources = [...existingEligibleSummary.buildSources, ...newEligibleSummary.buildSources];
			const eligibleCount = existingEligibleSummary.eligibleCount + newEligibleSummary.eligibleCount;
			const readyReusedCount = existingEligibleSummary.reusedReadyCount + newEligibleSummary.reusedReadyCount;
			logger.info(
				`Phase 3 — cache build candidates total="${eligibleSources.length}" existing="${existingEligibleSummary.buildSources.length}" new="${newEligibleSummary.buildSources.length}" readyReused="${readyReusedCount}".`
			);
			let readyCount = 0;
			let skippedCount = 0;
			let errorCount = 0;

			if (eligibleSources.length) {
				const cacheResults = await ComicChunkCacheService.getInstance().ensureCacheForSources(eligibleSources, {
					concurrency: config.production.scan.cacheConcurrency
				});
				readyCount = cacheResults.filter((result) => result.status === "ready").length;
				skippedCount = cacheResults.filter((result) => result.status === "skipped").length;
				errorCount = cacheResults.filter((result) => result.status === "error").length;

				logger.info(
					`Phase 3 — cache build complete completed="${eligibleSources.length}/${eligibleSources.length}" ready="${readyCount}" skipped="${skippedCount}" error="${errorCount}".`
				);
			}

			await ScanRootRepository.getInstance().updateScanRoot(JSON.stringify(scanRootResult.scan.directories), scanRoot.id);
			const cacheGcSummary = await this.runCacheGarbageCollection();
			const cacheArtifactSnapshotSummary: CacheArtifactSnapshotSummary =
				await CacheArtifactSnapshotService.getInstance().rebuildSnapshotFromCache();
			logger.info(
				`scanCompareUpdate summary scanRoot="${scanRootPath}" newFiles="${newFiles.length}" inserted="${insertedNewFiles.length}" ` +
				`specialZipReady="${specialArtifactReadyCount}" specialZipSkipped="${specialArtifactSkippedCount}" specialZipError="${specialArtifactErrorCount}" ` +
				`eligible="${eligibleCount}" readyReused="${readyReusedCount}" buildCandidates="${eligibleSources.length}" cacheReady="${readyCount}" cacheSkipped="${skippedCount}" cacheError="${errorCount}" ` +
				`cacheGcCandidates="${cacheGcSummary.candidates}" cacheGcRemoved="${cacheGcSummary.removed}" cacheGcBytesFreed="${humanFileSize(cacheGcSummary.bytesFreed, true)}" ` +
				`cacheSnapshotRows="${cacheArtifactSnapshotSummary.rows}" cacheSnapshotReaderReady="${cacheArtifactSnapshotSummary.readerReady}" cacheSnapshotPartial="${cacheArtifactSnapshotSummary.partialReady}" ` +
				`cacheSnapshotError="${cacheArtifactSnapshotSummary.errorStates}" cacheSnapshotZipOnly="${cacheArtifactSnapshotSummary.zipOnly}" cacheSnapshotLegacy="${cacheArtifactSnapshotSummary.legacyReaderReady}" cacheSnapshotPublished="${cacheArtifactSnapshotSummary.published}" ` +
				`removedByParentHash="${removedFilesCount}" removedByFileHash="${removedByFileHashCount}" ` +
				`metadataCompleted="${metadataCompleted}" insertFailed="${insertFailed}" ` +
				`firstInsertMs="${firstInsertElapsedMs ?? -1}" totalMs="${Date.now() - scanStartedAt}".`
			);
		} catch (error) {
			logger.error(`scanCompareUpdate "${scanRootPath}":`, error.message);
		}
	}

	// Single-pass recursive scan. Detects special directories on first encounter,
	// so each directory is read from disk exactly once.
	private async getStructureAndFiles(
		dirPath: string,
		dirEntries?: Dirent[],
		progress?: ScanProgressContext
	): Promise<ScanResult> {
		if (progress) {
			progress.directoriesSeen++;
			this.maybeLogScanProgress(progress, dirPath);
		}

		const dirHash = generateHash(dirPath);
		const structure: Directory = {
			name: path.basename(dirPath),
			hash: dirHash,
			directories: [] as Directory[]
		};
		const filesList: File[] = [];

		const entries = dirEntries ?? await fs.readdir(dirPath, {withFileTypes: true});

		for (const entry of entries) {
			const entryPath = path.join(dirPath, entry.name);

			if (entry.isDirectory()) {
				const subEntries = await fs.readdir(entryPath, {withFileTypes: true});
				const specialKind = await this.detectSpecialDirectory(entryPath, subEntries);

				if (specialKind !== FileKind.NONE) {
					logger.info(`Special directory detected: "${entry.name}" [${specialKind}]`);
					if (progress) {
						progress.specialDirectoriesDetected++;
					}
					filesList.push({
						name: entry.name,
						parentPath: dirPath,
						parentHash: dirHash,
						fileHash: generateHash(entryPath),
						size: "0",
						coverId: uuidv4(),
						fileKind: specialKind
					});
					this.maybeLogScanProgress(progress, entryPath);
				} else {
					const subdirResult = await this.getStructureAndFiles(entryPath, subEntries, progress);
					structure.directories.push(subdirResult.directories);
					filesList.push(...subdirResult.files);
				}
			} else if (entry.isFile()) {
				const stats = await fs.stat(entryPath);
				filesList.push({
					name: entry.name,
					parentPath: dirPath,
					parentHash: dirHash,
					fileHash: generateHash(entryPath, true),
					size: humanFileSize(stats.size, true),
					coverId: uuidv4(),
					fileKind: FileKind.FILE
				});
				if (progress) {
					progress.filesSeen++;
				}
				this.maybeLogScanProgress(progress, entryPath);
			}
		}

		return {directories: structure, files: filesList};
	}

	private async detectSpecialDirectory(dirPath: string, entries: Dirent[]): Promise<FileKind> {
		if (this.matchesFolderFormat(entries, new Set(["jpg", "jpeg", "png", "webp", "gif"]), true)) {
			return FileKind.COMIC_MANGA;
		}
		if (this.matchesFolderFormat(entries, new Set(["mp3", "wav", "m4a", "m4b", "ogg"]), false)) {
			return FileKind.AUDIOBOOK;
		}
		return this.checkEpubDir(dirPath, entries);
	}

	// Checks if all entries are files with allowed extensions. If strict, all must share the same extension.
	private matchesFolderFormat(entries: Dirent[], allowed: Set<string>, strict: boolean): boolean {
		if (entries.length === 0) return false;
		let foundExt: string | undefined;
		for (const entry of entries) {
			if (!entry.isFile()) return false;
			const ext = path.extname(entry.name).toLowerCase().slice(1);
			if (!allowed.has(ext)) return false;
			if (strict) {
				if (!foundExt) {
					foundExt = ext;
				} else if (foundExt !== ext) {
					return false;
				}
			}
		}
		return true;
	}

	// Uses the already-read entries to skip pathExists calls; only reads file content when structure looks valid.
	private async checkEpubDir(dirPath: string, entries: Dirent[]): Promise<FileKind> {
		if (!entries.some(e => e.isFile() && e.name === "mimetype")) return FileKind.NONE;
		if (!entries.some(e => e.isDirectory() && e.name === "META-INF")) return FileKind.NONE;

		try {
			const mimetypeContent = (await fs.readFile(path.join(dirPath, "mimetype"), "utf-8")).trim();
			if (mimetypeContent !== "application/epub+zip") return FileKind.NONE;

			const containerXml = await fs.readFile(path.join(dirPath, "META-INF", "container.xml"), "utf-8");
			const parsed = await parseStringPromise(containerXml);
			const rootFile = parsed.container?.rootfiles?.[0]?.rootfile?.[0];
			if (!rootFile?.$?.["full-path"]) return FileKind.NONE;

			const opfExists = await fs.pathExists(path.join(dirPath, rootFile.$["full-path"]));
			return opfExists ? FileKind.EPUB : FileKind.NONE;
		} catch {
			return FileKind.NONE;
		}
	}

	// Runs fn over items with at most `concurrency` items in flight simultaneously.
	private async processConcurrently<T>(
		items: T[],
		fn: (item: T, index: number) => Promise<void>,
		concurrency: number
	): Promise<void> {
		let i = 0;
		const worker = async () => {
			while (i < items.length) {
				const idx = i++;
				await fn(items[idx], idx);
			}
		};
		await Promise.all(Array.from({length: Math.min(concurrency, items.length)}, worker));
	}

	private async resolveEligibleComicSources(
		files: File[],
		scope: "existing" | "new"
	): Promise<EligibleComicSourceResolutionSummary> {
		const total = files.length;
		const progressEvery = this.getCandidateProgressEvery(total);
		const startedAt = Date.now();
		const buildSources: EligibleComicSource[] = [];
		let eligibleCount = 0;
		let reusedReadyCount = 0;
		let skipped = 0;
		const reasonCounts = new Map<ComicEligibilityReason, number>();

		logger.info(`Resolving comic cache candidates scope="${scope}" total="${total}".`);

		for (let index = 0; index < files.length; index++) {
			const file = files[index];
			const resolution = await resolveEligibleComicSource(file);
			const source = resolution.source;
			reasonCounts.set(resolution.reason, (reasonCounts.get(resolution.reason) || 0) + 1);

			if (source) {
				eligibleCount++;
				if (resolution.reason === "ready-state") {
					reusedReadyCount++;
				} else {
					buildSources.push(source);
				}
			} else {
				skipped++;
			}

			const completed = index + 1;
			if (completed === total || completed % progressEvery === 0) {
				logger.info(
					`Candidate resolution progress scope="${scope}" completed="${completed}/${total}" eligible="${eligibleCount}" readyReused="${reusedReadyCount}" buildCandidates="${buildSources.length}" skipped="${skipped}" result="${resolution.result}" reason="${resolution.reason}" path="${path.join(file.parentPath, file.name)}".`
				);
			}
		}

		logger.info(
			`Candidate resolution complete scope="${scope}" total="${total}" eligible="${eligibleCount}" readyReused="${reusedReadyCount}" buildCandidates="${buildSources.length}" skipped="${skipped}" reasons="${this.formatReasonCounts(reasonCounts)}" elapsedMs="${Date.now() - startedAt}".`
		);

		return {
			buildSources,
			eligibleCount,
			reusedReadyCount
		};
	}

	private resolveZipOnlySpecialDirectories(
		files: File[],
		scope: "existing" | "new"
	): File[] {
		const total = files.length;
		const progressEvery = this.getCandidateProgressEvery(total);
		const startedAt = Date.now();
		const selected: File[] = [];

		logger.info(`Resolving ZIP-only special directories scope="${scope}" total="${total}".`);

		for (let index = 0; index < files.length; index++) {
			const file = files[index];
			if (SpecialDirectoryArtifactService.isZipOnlySpecialDirectory(file)) {
				selected.push(file);
			}

			const completed = index + 1;
			if (completed === total || completed % progressEvery === 0) {
				logger.info(
					`ZIP-only classification progress scope="${scope}" completed="${completed}/${total}" selected="${selected.length}" skipped="${completed - selected.length}" path="${path.join(file.parentPath, file.name)}".`
				);
			}
		}

		logger.info(
			`ZIP-only classification complete scope="${scope}" total="${total}" selected="${selected.length}" skipped="${total - selected.length}" elapsedMs="${Date.now() - startedAt}".`
		);

		return selected;
	}

	private getCandidateProgressEvery(total: number): number {
		if (total <= 50) {
			return ScannerService.candidateProgressSmallBatch;
		}

		if (total <= 250) {
			return ScannerService.candidateProgressMediumBatch;
		}

		return ScannerService.candidateProgressLargeBatch;
	}

	private maybeLogScanProgress(progress: ScanProgressContext | undefined, currentPath: string, force: boolean = false): void {
		if (!progress) {
			return;
		}

		const now = Date.now();
		const entriesSeen = progress.directoriesSeen + progress.filesSeen;
		const enoughEntries = entriesSeen - progress.lastLoggedEntries >= ScannerService.scanProgressEveryEntries;
		const enoughTime = now - progress.lastLoggedAt >= ScannerService.scanProgressEveryMs;

		if (!force && !enoughEntries && !enoughTime) {
			return;
		}

		progress.lastLoggedAt = now;
		progress.lastLoggedEntries = entriesSeen;
		logger.info(
			`scan-progress directoriesSeen="${progress.directoriesSeen}" filesSeen="${progress.filesSeen}" specialDirectoriesDetected="${progress.specialDirectoriesDetected}" currentPath="${currentPath}" elapsedMs="${now - progress.startedAt}".`
		);
	}

	private formatReasonCounts(reasonCounts: Map<ComicEligibilityReason, number>): string {
		return Array.from(reasonCounts.entries())
			.sort(([left], [right]) => left.localeCompare(right))
			.map(([reason, count]) => `${reason}:${count}`)
			.join(",");
	}

	private async runCacheGarbageCollection(): Promise<CacheGarbageCollectionSummary> {
		const liveCoverIds = await FileRepository.getInstance().getAllCoverIds();
		if (!liveCoverIds) {
			logger.error("Phase 4 — cache garbage collection skipped reason=\"live-coverid-query-failed\".");
			return {
				cacheDirsTotal: 0,
				liveCoverIds: 0,
				candidates: 0,
				removed: 0,
				bytesFreed: 0
			};
		}

		const cacheRoot = config.production.paths.cache;
		if (!(await fs.pathExists(cacheRoot))) {
			logger.info(`Phase 4 — cache garbage collection complete completed="0/0" removed="0" bytesFreed="${humanFileSize(0, true)}".`);
			return {
				cacheDirsTotal: 0,
				liveCoverIds: liveCoverIds.length,
				candidates: 0,
				removed: 0,
				bytesFreed: 0
			};
		}

		const entries = await fs.readdir(cacheRoot, {withFileTypes: true});
		const cacheDirs = entries
			.filter((entry: Dirent) => entry.isDirectory())
			.map((entry: Dirent) => entry.name)
			.filter((entryName: string) => entryName !== ".scanner-build")
		;
		const liveCoverIdSet = new Set(liveCoverIds);
		const candidates = cacheDirs.filter((coverId: string) => !liveCoverIdSet.has(coverId));
		logger.info(
			`Phase 4 — cache garbage collection totalCacheDirs="${cacheDirs.length}" liveCoverIds="${liveCoverIds.length}" candidates="${candidates.length}".`
		);

		let removed = 0;
		let bytesFreed = 0;

		for (let index = 0; index < candidates.length; index++) {
			const coverId = candidates[index];
			const cacheDirPath = path.join(cacheRoot, coverId);
			const sizeBytes = await this.getDirectorySizeBytes(cacheDirPath);
			await fs.rm(cacheDirPath, {recursive: true, force: true});
			removed++;
			bytesFreed += sizeBytes;
			logger.info(
				`cache-gc:delete item="${index + 1}/${candidates.length}" coverId="${coverId}" size="${humanFileSize(sizeBytes, true)}".`
			);
			logger.info(
				`cache-gc:progress completed="${index + 1}/${candidates.length}" removed="${removed}" bytesFreed="${humanFileSize(bytesFreed, true)}".`
			);
		}

		logger.info(
			`Phase 4 — cache garbage collection complete completed="${candidates.length}/${candidates.length}" removed="${removed}" bytesFreed="${humanFileSize(bytesFreed, true)}".`
		);

		return {
			cacheDirsTotal: cacheDirs.length,
			liveCoverIds: liveCoverIds.length,
			candidates: candidates.length,
			removed,
			bytesFreed
		};
	}

	private async getDirectorySizeBytes(targetPath: string): Promise<number> {
		if (!(await fs.pathExists(targetPath))) {
			return 0;
		}

		const stats = await fs.stat(targetPath);
		if (!stats.isDirectory()) {
			return stats.size;
		}

		let total = 0;
		const entries = await fs.readdir(targetPath, {withFileTypes: true});
		for (const entry of entries) {
			const entryPath = path.join(targetPath, entry.name);
			if (entry.isDirectory()) {
				total += await this.getDirectorySizeBytes(entryPath);
				continue;
			}

			if (entry.isFile()) {
				total += (await fs.stat(entryPath)).size;
			}
		}

		return total;
	}

	private async fillLocalDetails(file: File): Promise<void> {
		try {
			const meta = await CalibreService.getInstance().getEbookMeta(path.join(file.parentPath, file.name), file.coverId);
			if (meta) {
				meta.title = (meta.title || "").trim();
				file.localDetails = JSON.stringify(meta);
			}
		} catch (error) {
			logger.error(`fillLocalDetails "${path.join(file.parentPath, file.name)}":`, error.message);
		}
	}

	private async fillWebDetails(file: File): Promise<void> {
		if (!config.production.scan.openLibrary) return;
		try {
			const meta = file.localDetails ? JSON.parse(file.localDetails) : undefined;
			const filename = cleanFilename(file.name);
			const title = meta?.title ? cleanTitle(meta.title) : "";
			const similarity = stringSimilarity.compareTwoStrings(filename, title);
			const bookInfo = await OpenLibraryService.getInstance().getBookInfoOpenLibrary(
				similarity >= 0.5 ? title : filename
			);
			if (bookInfo) {
				file.webDetails = JSON.stringify(bookInfo);
			}
		} catch (error) {
			logger.error(`fillWebDetails "${path.join(file.parentPath, file.name)}":`, error.message);
		}
	}
}
