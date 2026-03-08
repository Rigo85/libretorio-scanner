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
	getSpecialDirectorySize,
	humanFileSize,
	removeTrailingSeparator
} from "(src)/utils/fileUtils";
import { ScanResult } from "(src)/models/interfaces/ScanResult";
import { Directory } from "(src)/models/interfaces/Directory";
import { File, FileKind } from "(src)/models/interfaces/File";
import { ScanRootRepository } from "(src)/repositories/ScanRootRepository";
import { FileRepository } from "(src)/repositories/FileRepository";
import { CalibreService } from "(src)/services/CalibreService";
import { OpenLibraryService } from "(src)/services/OpenLibraryService";
import { config } from "(src)/config/configuration";

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

		try {
			const scanRoot = await ScanRootRepository.getInstance().getScanRootByPath(scanRootPath);

			if (!scanRoot) {
				logger.error("No scan roots found.");
				return;
			}

			// - escanear el directorio observado.
			const scanRootResult = await ScannerService.getInstance().scan(removeTrailingSeparator(scanRootPath));

			// - obtener los hashes de los directorios.
			const hash = getHashes(scanRootResult.scan.directories);

			// - eliminar los archivos en la db que NO tengan un parentHash dentro de los hashes obtenidos.
			const removedFilesCount = await FileRepository.getInstance().removeFileByParentHash(hash);
			logger.info(`Removed files by parent hash: ${removedFilesCount}.`);

			// - obtener los archivos de la db.
			const hashes = await FileRepository.getInstance().getFileHashes(scanRoot.id);

			const scanHashSet = new Set(scanRootResult.scan.files.map((f: File) => f.fileHash));
			const dbHashSet = new Set(hashes.map((h: { hash: string }) => h.hash));

			const fileToRemove = hashes.filter((h: { hash: string }) => !scanHashSet.has(h.hash));

			// - eliminar los archivos en la db que NO estén en el scan.
			if (fileToRemove.length) {
				const removedCount = await FileRepository.getInstance()
					.removeFileByFileHash(fileToRemove.map((f: { hash: string }) => f.hash));
				logger.info(`Removed files by file hash: ${removedCount}.`);
			}

			// - los archivos del scan que no estén en la db, se insertan.
			const newFiles = scanRootResult.scan.files.filter((file: File) => !dbHashSet.has(file.fileHash));

			logger.info(`New files: ${newFiles.length}.`);
			logger.info(JSON.stringify(newFiles.map((f: File) => f.name)));

			// - generar la caché (ZIP) de los archivos especiales existentes solo si no existe.
			const existingSpecials = scanRootResult.scan.files.filter(
				(f: File) => dbHashSet.has(f.fileHash) && f.fileKind !== FileKind.FILE && f.fileKind !== FileKind.NONE
			);
			const specialArchives = await FileRepository.getInstance().getSpecialArchives(scanRoot.id);
			const specialDbMap = new Map(specialArchives.map((sa: File) => [sa.fileHash, sa]));

			logger.info(`Existing special archives: ${existingSpecials.length}.`);
			for (const sf of existingSpecials) {
				const dbRecord = specialDbMap.get(sf.fileHash);
				if (!dbRecord) continue;
				const cachePath = path.join(__dirname, "..", "public", "cache", dbRecord.coverId);
				const exist = await fs.pathExists(cachePath);
				if (!exist) {
					logger.info(`Special archive cache not found, building: "${sf.name}".`);
					const size = await getSpecialDirectorySize(path.join(sf.parentPath, sf.name), dbRecord.coverId);
					await FileRepository.getInstance().updateSpecialArchiveSize(dbRecord.id, size);
					logger.info(`Special archive size updated: "${sf.name}" - "${size}".`);
				}
			}

			const concurrency = config.production.scan.concurrency;

			// Phase 1: local metadata via calibre + special dir size (CPU/disk bound)
			logger.info(`Phase 1 — local metadata for ${newFiles.length} files (concurrency: ${concurrency})`);
			await this.processConcurrently(newFiles, async (file, idx) => {
				logger.info(`Local metadata ${idx + 1}/${newFiles.length}: "${path.join(file.parentPath, file.name)}"`);
				await this.fillLocalDetails(file);
				if (file.fileKind !== FileKind.FILE && file.fileKind !== FileKind.NONE) {
					logger.info(`Getting special directory size: "${path.join(file.parentPath, file.name)}"`);
					file.size = await getSpecialDirectorySize(path.join(file.parentPath, file.name), file.coverId);
					logger.info(`Special directory size: "${file.size}"`);
				}
			}, concurrency);

			// Phase 2: web metadata via OpenLibrary + DB insert (network bound)
			logger.info(`Phase 2 — web metadata for ${newFiles.length} files (concurrency: ${concurrency})`);
			await this.processConcurrently(newFiles, async (file, idx) => {
				logger.info(`Web metadata ${idx + 1}/${newFiles.length}: "${file.name}"`);
				await this.fillWebDetails(file);
				await FileRepository.getInstance().insertFile(file, scanRoot.id);
			}, concurrency);

			await ScanRootRepository.getInstance().updateScanRoot(JSON.stringify(scanRootResult.scan.directories), scanRoot.id);
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
