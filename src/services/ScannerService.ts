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
import { EligibleComicSource } from "(src)/models/interfaces/EligibleComicSource";
import { ScanRootRepository } from "(src)/repositories/ScanRootRepository";
import { FileRepository } from "(src)/repositories/FileRepository";
import { CalibreService } from "(src)/services/CalibreService";
import { ComicChunkCacheService } from "(src)/services/ComicChunkCacheService";
import { OpenLibraryService } from "(src)/services/OpenLibraryService";
import { SpecialDirectoryArtifactService } from "(src)/services/SpecialDirectoryArtifactService";
import { config } from "(src)/config/configuration";
import { cleanupCacheBuildRoot } from "(src)/utils/comicCacheUtils";
import { toEligibleComicSource } from "(src)/utils/archiveDetectionUtils";

const logger = new Logger("Scanner Service");

export class ScannerService {
	private static instance: ScannerService;

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

		try {
			const scanResult = await this.getStructureAndFiles(rootPath);

			result = {
				root: rootPath,
				scan: scanResult
			} as ScanRootResult;
		} catch (error) {
			logger.error("Error scanning:", error);
		}

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

			const currentDbFilesMap = new Map(currentDbFiles.map((file: File) => [file.fileHash, file]));
			const existingEligibleSources = scanRootResult.scan.files
				.filter((file: File) => dbHashSet.has(file.fileHash))
				.map((file: File) => currentDbFilesMap.get(file.fileHash))
				.filter((file: File | undefined): file is File => file !== undefined)
				.map((file: File) => toEligibleComicSource(file))
				.filter((source: EligibleComicSource | undefined): source is EligibleComicSource => source !== undefined)
			;

			const newEligibleSources = insertedNewFiles
				.map((file: File) => toEligibleComicSource(file))
				.filter((source: EligibleComicSource | undefined): source is EligibleComicSource => source !== undefined)
			;

			const existingZipOnlySpecials = currentDbFiles
				.filter((file: File) => SpecialDirectoryArtifactService.isZipOnlySpecialDirectory(file))
			;
			const newZipOnlySpecials = insertedNewFiles
				.filter((file: File) => SpecialDirectoryArtifactService.isZipOnlySpecialDirectory(file))
			;
			const zipOnlySpecials = [...existingZipOnlySpecials, ...newZipOnlySpecials];
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
					`Phase 2 — special directory artifacts complete ready="${specialArtifactReadyCount}" skipped="${specialArtifactSkippedCount}" error="${specialArtifactErrorCount}".`
				);
			}

			const eligibleSources = [...existingEligibleSources, ...newEligibleSources];
			logger.info(
				`Phase 3 — cache build candidates total="${eligibleSources.length}" existing="${existingEligibleSources.length}" new="${newEligibleSources.length}".`
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
					`Phase 3 — cache build complete ready="${readyCount}" skipped="${skippedCount}" error="${errorCount}".`
				);
			}

			await ScanRootRepository.getInstance().updateScanRoot(JSON.stringify(scanRootResult.scan.directories), scanRoot.id);
			logger.info(
				`scanCompareUpdate summary scanRoot="${scanRootPath}" newFiles="${newFiles.length}" inserted="${insertedNewFiles.length}" ` +
				`specialZipReady="${specialArtifactReadyCount}" specialZipSkipped="${specialArtifactSkippedCount}" specialZipError="${specialArtifactErrorCount}" ` +
				`eligible="${eligibleSources.length}" cacheReady="${readyCount}" cacheSkipped="${skippedCount}" cacheError="${errorCount}" ` +
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
	private async getStructureAndFiles(dirPath: string, dirEntries?: Dirent[]): Promise<ScanResult> {
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
					filesList.push({
						name: entry.name,
						parentPath: dirPath,
						parentHash: dirHash,
						fileHash: generateHash(entryPath),
						size: "0",
						coverId: uuidv4(),
						fileKind: specialKind
					});
				} else {
					const subdirResult = await this.getStructureAndFiles(entryPath, subEntries);
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
