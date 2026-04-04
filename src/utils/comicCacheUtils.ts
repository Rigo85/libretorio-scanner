import fs from "fs-extra";
import path from "path";
import archiver from "archiver";
import unzipper from "unzipper";
import { v4 as uuidv4 } from "uuid";

import { config } from "(src)/config/configuration";
import { Logger } from "(src)/helpers/Logger";
import { ComicCacheState } from "(src)/models/interfaces/ComicCacheState";
import { naturalCompare } from "(src)/utils/naturalSortUtils";

const logger = new Logger("ComicCacheUtils");

export interface ImageFileEntry {
	filePath: string;
	ext: string;
	sortKey: string;
}

export interface ChunkCacheValidationResult {
	valid: boolean;
	chunkCount: number;
	totalPages: number;
}

const IMAGE_EXTENSIONS = new Set([
	".jpg", ".jpeg", ".png", ".webp", ".avif", ".gif", ".bmp", ".tiff", ".tif"
]);

const MIME_TYPES = new Map<string, string>([
	[".jpg", "image/jpeg"],
	[".jpeg", "image/jpeg"],
	[".png", "image/png"],
	[".webp", "image/webp"],
	[".avif", "image/avif"],
	[".gif", "image/gif"],
	[".bmp", "image/bmp"],
	[".tiff", "image/tiff"],
	[".tif", "image/tiff"]
]);

export function getCacheBuildRoot(): string {
	return path.join(config.production.paths.cache, ".scanner-build");
}

export function getCacheDir(coverId: string, cacheRoot: string = config.production.paths.cache): string {
	return path.join(cacheRoot, coverId);
}

export function getStatePath(coverId: string, cacheDir: string = getCacheDir(coverId)): string {
	return path.join(cacheDir, "_scanner_state.json");
}

export function getZipPath(coverId: string, cacheDir: string = getCacheDir(coverId)): string {
	return path.join(cacheDir, `${coverId}.zip`);
}

export function getChunkPath(coverId: string, index: number, cacheDir: string = getCacheDir(coverId)): string {
	return path.join(cacheDir, `${coverId}_${index}.cache`);
}

export async function createCacheStagingDir(coverId: string): Promise<string> {
	const buildRoot = getCacheBuildRoot();
	const stagingDir = path.join(buildRoot, `${coverId}-${uuidv4()}`);

	await fs.ensureDir(stagingDir);
	return stagingDir;
}

export async function cleanupStagingDir(stagingDir: string): Promise<void> {
	await fs.rm(stagingDir, {recursive: true, force: true});
}

export async function cleanupCacheBuildRoot(): Promise<number> {
	const buildRoot = getCacheBuildRoot();
	await fs.ensureDir(buildRoot);

	const entries = await fs.readdir(buildRoot);
	await Promise.all(entries.map((entry) => fs.rm(path.join(buildRoot, entry), {recursive: true, force: true})));
	return entries.length;
}

export async function promoteStagingCache(coverId: string, stagingDir: string): Promise<string> {
	const finalDir = getCacheDir(coverId);
	const buildRoot = getCacheBuildRoot();
	const backupDir = path.join(buildRoot, `${coverId}-backup-${uuidv4()}`);
	let backupCreated = false;

	await fs.ensureDir(config.production.paths.cache);

	try {
		if (await fs.pathExists(finalDir)) {
			await fs.move(finalDir, backupDir, {overwrite: true});
			backupCreated = true;
		}

		await fs.move(stagingDir, finalDir, {overwrite: true});

		if (backupCreated) {
			await fs.rm(backupDir, {recursive: true, force: true});
		}

		return finalDir;
	} catch (error) {
		if (!(await fs.pathExists(finalDir)) && backupCreated && await fs.pathExists(backupDir)) {
			try {
				await fs.move(backupDir, finalDir, {overwrite: true});
			} catch (restoreError) {
				logger.error(`promoteStagingCache restore "${coverId}":`, restoreError);
			}
		}

		throw error;
	} finally {
		if (await fs.pathExists(stagingDir)) {
			await fs.rm(stagingDir, {recursive: true, force: true});
		}
		if (await fs.pathExists(backupDir)) {
			await fs.rm(backupDir, {recursive: true, force: true});
		}
	}
}

export async function validateZipArtifact(zipPath: string): Promise<boolean> {
	try {
		if (!(await fs.pathExists(zipPath))) {
			return false;
		}

		const stats = await fs.stat(zipPath);
		if (!stats.isFile() || stats.size < 1) {
			return false;
		}

		const directory = await unzipper.Open.file(zipPath);
		return Array.isArray(directory.files) && directory.files.length > 0;
	} catch (error) {
		logger.error(`validateZipArtifact "${zipPath}":`, error);
		return false;
	}
}

export async function validateChunkCache(
	coverId: string,
	requireZipArtifact: boolean,
	cacheDir: string = getCacheDir(coverId)
): Promise<ChunkCacheValidationResult> {
	const statePath = getStatePath(coverId, cacheDir);

	if (!(await fs.pathExists(cacheDir)) || !(await fs.pathExists(statePath))) {
		return {valid: false, chunkCount: 0, totalPages: 0};
	}

	try {
		const state = JSON.parse(await fs.readFile(statePath, "utf8")) as ComicCacheState;

		if (state.status !== "ready" || !state.chunksReady || state.chunkCount < 1 || state.totalPages < 1) {
			return {valid: false, chunkCount: 0, totalPages: 0};
		}

		for (let index = 0; index < state.chunkCount; index++) {
			const chunkPath = getChunkPath(coverId, index, cacheDir);
			if (!(await fs.pathExists(chunkPath))) {
				return {valid: false, chunkCount: 0, totalPages: 0};
			}

			const parsed = JSON.parse(await fs.readFile(chunkPath, "utf8")) as {
				pages?: unknown[];
				totalPages?: number;
				index?: number;
			};

			if (!Array.isArray(parsed.pages) || parsed.totalPages !== state.totalPages || parsed.index !== index) {
				return {valid: false, chunkCount: 0, totalPages: 0};
			}
		}

		if (requireZipArtifact) {
			if (!state.zipReady || !(await validateZipArtifact(getZipPath(coverId, cacheDir)))) {
				return {valid: false, chunkCount: 0, totalPages: 0};
			}
		}

		return {valid: true, chunkCount: state.chunkCount, totalPages: state.totalPages};
	} catch (error) {
		logger.error(`validateChunkCache "${coverId}":`, error);
		return {valid: false, chunkCount: 0, totalPages: 0};
	}
}

export function normalizeSortKey(value: string): string {
	return value
		.replace(/\\/g, "/")
		.replace(/\/+/g, "/")
		.replace(/^\.\/+/g, "")
		.replace(/^\/+/g, "")
		.replace(/\/+$/g, "")
		.toLowerCase();
}

export function isJunkPath(value: string): boolean {
	const normalized = normalizeSortKey(value);
	const base = path.posix.basename(normalized);

	if (base.startsWith("._")) return true;
	if (base.startsWith(".")) return true;
	if (normalized.includes("__macosx/")) return true;
	if (base === "thumbs.db" || base === "desktop.ini") return true;

	return false;
}

export async function collectSortedDirectoryImages(directoryPath: string): Promise<ImageFileEntry[]> {
	const result: ImageFileEntry[] = [];

	async function walk(currentPath: string, relativePath: string): Promise<void> {
		const entries = await fs.readdir(currentPath, {withFileTypes: true});

		for (const entry of entries) {
			const nextFullPath = path.join(currentPath, entry.name);
			const nextRelativePath = relativePath ? path.posix.join(relativePath, entry.name) : entry.name;
			const normalizedSortKey = normalizeSortKey(nextRelativePath);

			if (isJunkPath(normalizedSortKey)) {
				continue;
			}

			if (entry.isDirectory()) {
				await walk(nextFullPath, nextRelativePath);
				continue;
			}

			if (!entry.isFile()) {
				continue;
			}

			const ext = path.extname(entry.name).toLowerCase();
			if (!IMAGE_EXTENSIONS.has(ext)) {
				continue;
			}

			result.push({
				filePath: nextFullPath,
				ext,
				sortKey: normalizedSortKey
			});
		}
	}

	await walk(directoryPath, "");
	result.sort((left, right) => naturalCompare(left.sortKey, right.sortKey));
	return result;
}

export async function generateDirectoryZipArtifact(
	directoryPath: string,
	coverId: string,
	cacheDir: string = getCacheDir(coverId)
): Promise<{ zipPath: string; sizeBytes: number }> {
	const zipPath = getZipPath(coverId, cacheDir);
	await fs.ensureDir(path.dirname(zipPath));

	return new Promise((resolve, reject) => {
		const output = fs.createWriteStream(zipPath);
		const archive = archiver("zip", {store: true});

		output.on("close", () => {
			resolve({zipPath, sizeBytes: archive.pointer()});
		});

		output.on("error", reject);
		archive.on("error", reject);

		archive.pipe(output);
		archive.directory(directoryPath, false);
		void archive.finalize();
	});
}

export async function writeChunksFromFiles(
	files: ImageFileEntry[],
	coverId: string,
	sizeThreshold: number = config.production.scan.cacheChunkBytes,
	cacheDir: string = getCacheDir(coverId)
): Promise<{ chunkCount: number; totalPages: number }> {
	await fs.ensureDir(cacheDir);

	const totalPages = files.length;
	let chunkIndex = 0;
	let pageIndex = 1;
	let currentSize = 0;
	let currentBatch: string[] = [];

	const flushBatch = async (): Promise<void> => {
		if (!currentBatch.length) {
			return;
		}

		const chunkPath = getChunkPath(coverId, chunkIndex, cacheDir);
		await fs.writeFile(chunkPath, JSON.stringify({
			pages: currentBatch,
			pageIndex,
			currentPagesLength: currentBatch.length,
			totalPages,
			index: chunkIndex
		}));

		pageIndex += currentBatch.length;
		chunkIndex++;
		currentBatch = [];
		currentSize = 0;
	};

	for (const file of files) {
		const raw = await fs.readFile(file.filePath);
		const mime = MIME_TYPES.get(file.ext) || "application/octet-stream";
		const base64 = `data:${mime};base64,${raw.toString("base64")}`;
		const pageSize = Buffer.byteLength(base64, "utf8");

		if (currentBatch.length > 0 && currentSize + pageSize > sizeThreshold) {
			await flushBatch();
		}

		currentBatch.push(base64);
		currentSize += pageSize;
	}

	await flushBatch();

	return {
		chunkCount: chunkIndex,
		totalPages
	};
}
