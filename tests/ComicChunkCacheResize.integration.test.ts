import fs from "fs-extra";
import os from "os";
import path from "path";
import archiver from "archiver";
import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it } from "@jest/globals";

import { config } from "(src)/config/configuration";
import { FileKind } from "(src)/models/interfaces/File";
import { EligibleComicSource } from "(src)/models/interfaces/EligibleComicSource";
import { ComicCacheStateService } from "(src)/services/ComicCacheStateService";
import { ComicChunkCacheService } from "(src)/services/ComicChunkCacheService";
import {
	getChunkPath,
	getStatePath,
	getZipPath,
	validateChunkCache,
	validateZipArtifact
} from "(src)/utils/comicCacheUtils";

async function createSolidImage(filePath: string, width: number, height: number): Promise<void> {
	await sharp({
		create: {
			width,
			height,
			channels: 3,
			background: {r: 48, g: 120, b: 192}
		}
	}).png().toFile(filePath);
}

async function createZipArchive(sourceDir: string, zipPath: string): Promise<void> {
	await fs.ensureDir(path.dirname(zipPath));

	await new Promise<void>((resolve, reject) => {
		const output = fs.createWriteStream(zipPath);
		const archive = archiver("zip", {store: true});

		output.on("close", () => resolve());
		output.on("error", reject);
		archive.on("error", reject);

		archive.pipe(output);
		archive.directory(sourceDir, false);
		void archive.finalize();
	});
}

describe("ComicChunkCacheService resize integration", () => {
	let tempDir: string;
	let originalCachePath: string;
	let originalTempPath: string;
	let originalResizeConfig: {
		enabled: boolean;
		readerMaxDimension: number;
		readerQuality: number;
		readerFormat: "jpeg" | "webp";
		vipsConcurrency: number;
	};
	let service: ComicChunkCacheService;

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "libretorio-comic-cache-resize-"));
		originalCachePath = config.production.paths.cache;
		originalTempPath = config.production.paths.temp;
		originalResizeConfig = {
			enabled: config.production.scan.cacheResize.enabled,
			readerMaxDimension: config.production.scan.cacheResize.readerMaxDimension,
			readerQuality: config.production.scan.cacheResize.readerQuality,
			readerFormat: config.production.scan.cacheResize.readerFormat as "jpeg" | "webp",
			vipsConcurrency: config.production.scan.cacheResize.vipsConcurrency
		};
		config.production.paths.cache = path.join(tempDir, "cache");
		config.production.paths.temp = path.join(tempDir, "tmp");
		config.production.scan.cacheResize.enabled = true;
		config.production.scan.cacheResize.readerMaxDimension = 2400;
		config.production.scan.cacheResize.readerQuality = 82;
		config.production.scan.cacheResize.readerFormat = "jpeg";
		config.production.scan.cacheResize.vipsConcurrency = 1;
		service = ComicChunkCacheService.getInstance();
	});

	afterEach(async () => {
		config.production.paths.cache = originalCachePath;
		config.production.paths.temp = originalTempPath;
		config.production.scan.cacheResize.enabled = originalResizeConfig.enabled;
		config.production.scan.cacheResize.readerMaxDimension = originalResizeConfig.readerMaxDimension;
		config.production.scan.cacheResize.readerQuality = originalResizeConfig.readerQuality;
		config.production.scan.cacheResize.readerFormat = originalResizeConfig.readerFormat;
		config.production.scan.cacheResize.vipsConcurrency = originalResizeConfig.vipsConcurrency;
		await fs.rm(tempDir, {recursive: true, force: true});
	});

	it("builds final zip and chunk cache for a COMIC_MANGA directory using the native resize worker", async () => {
		const sourceDir = path.join(tempDir, "comic-directory");
		const coverId = "cover-comic-directory";
		await fs.ensureDir(sourceDir);
		await createSolidImage(path.join(sourceDir, "001-small.png"), 1000, 700);
		await createSolidImage(path.join(sourceDir, "002-large.png"), 3200, 2400);

		const source: EligibleComicSource = {
			coverId,
			fileHash: "hash-comic-directory",
			name: "comic-directory",
			parentPath: tempDir,
			fileKind: FileKind.COMIC_MANGA,
			sourcePath: sourceDir,
			sourceType: "directory",
			requiresZipArtifact: true
		};

		const result = await service.ensureCacheForSource(source);

		expect(result.status).toBe("ready");
		expect(result.totalPages).toBe(2);
		expect(result.chunkCount).toBe(1);
		await expect(validateChunkCache(coverId, true)).resolves.toEqual({
			valid: true,
			chunkCount: 1,
			totalPages: 2
		});
		await expect(validateZipArtifact(getZipPath(coverId))).resolves.toBe(true);

		const chunk = await fs.readJson(getChunkPath(coverId, 0));
		expect(chunk.currentPagesLength).toBe(2);
		expect(chunk.totalPages).toBe(2);
		expect(chunk.pages).toHaveLength(2);

		const state = await ComicCacheStateService.getInstance().read(getStatePath(coverId));
		expect(state?.status).toBe("ready");
		expect(state?.chunksReady).toBe(true);
		expect(state?.zipReady).toBe(true);
	});

	it("builds chunk cache for an archive-file comic using resized raw pages from the native worker", async () => {
		const sourceDir = path.join(tempDir, "archive-source");
		const archivePath = path.join(tempDir, "chapter.cbz");
		const coverId = "cover-comic-archive";
		await fs.ensureDir(sourceDir);
		await createSolidImage(path.join(sourceDir, "001-small.png"), 1000, 700);
		await createSolidImage(path.join(sourceDir, "002-large.png"), 3200, 2400);
		await createZipArchive(sourceDir, archivePath);

		const source: EligibleComicSource = {
			coverId,
			fileHash: "hash-comic-archive",
			name: "chapter.cbz",
			parentPath: tempDir,
			fileKind: FileKind.FILE,
			sourcePath: archivePath,
			sourceType: "archive-file",
			archiveFormat: "zip",
			requiresZipArtifact: false
		};

		const result = await service.ensureCacheForSource(source);

		expect(result.status).toBe("ready");
		expect(result.totalPages).toBe(2);
		expect(result.chunkCount).toBe(1);
		await expect(validateChunkCache(coverId, false)).resolves.toEqual({
			valid: true,
			chunkCount: 1,
			totalPages: 2
		});
		await expect(fs.pathExists(getZipPath(coverId))).resolves.toBe(false);
	});

	it("persists ready+partial cache state when one directory page is dropped", async () => {
		const sourceDir = path.join(tempDir, "comic-directory-partial");
		const coverId = "cover-comic-directory-partial";
		await fs.ensureDir(sourceDir);
		await fs.writeFile(path.join(sourceDir, "000-empty.jpg"), "");
		await createSolidImage(path.join(sourceDir, "001-good.png"), 1600, 1000);

		const source: EligibleComicSource = {
			coverId,
			fileHash: "hash-comic-directory-partial",
			name: "comic-directory-partial",
			parentPath: tempDir,
			fileKind: FileKind.COMIC_MANGA,
			sourcePath: sourceDir,
			sourceType: "directory",
			requiresZipArtifact: true
		};

		const result = await service.ensureCacheForSource(source);

		expect(result.status).toBe("ready");
		expect(result.buildOutcome).toBe("partial");
		expect(result.droppedPages).toBe(1);
		expect(result.warningCount).toBe(1);
		await expect(validateChunkCache(coverId, true)).resolves.toEqual({
			valid: true,
			chunkCount: 1,
			totalPages: 1
		});

		const state = await ComicCacheStateService.getInstance().read(getStatePath(coverId));
		expect(state?.status).toBe("ready");
		expect(state?.buildOutcome).toBe("partial");
		expect(state?.droppedPages).toBe(1);
		expect(state?.warningCount).toBe(1);
		expect(state?.lastWarnings?.[0]).toContain("000-empty.jpg");
	});
});
