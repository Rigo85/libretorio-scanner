import fs from "fs-extra";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it } from "@jest/globals";

import { config } from "(src)/config/configuration";
import { FileKind } from "(src)/models/interfaces/File";
import { ComicCacheStateService } from "(src)/services/ComicCacheStateService";
import {
	cleanupCacheBuildRoot,
	collectSortedDirectoryImages,
	createCacheStagingDir,
	generateDirectoryZipArtifact,
	getCacheBuildRoot,
	getCacheDir,
	getZipPath,
	getStatePath,
	validateChunkCache,
	validateZipArtifact,
	writeChunksFromFiles
} from "(src)/utils/comicCacheUtils";

describe("comicCacheUtils", () => {
	let tempDir: string;
	let originalCachePath: string;

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "libretorio-comic-cache-"));
		originalCachePath = config.production.paths.cache;
		config.production.paths.cache = path.join(tempDir, "cache");
	});

	afterEach(async () => {
		config.production.paths.cache = originalCachePath;
		await fs.rm(tempDir, {recursive: true, force: true});
	});

	it("collects sorted images with natural ordering and junk filtering", async () => {
		const sourceDir = path.join(tempDir, "source");
		await fs.ensureDir(path.join(sourceDir, "chapter"));
		await fs.ensureDir(path.join(sourceDir, "__MACOSX"));
		await fs.writeFile(path.join(sourceDir, "chapter", "10.jpg"), "ten");
		await fs.writeFile(path.join(sourceDir, "chapter", "2.jpg"), "two");
		await fs.writeFile(path.join(sourceDir, "__MACOSX", "._2.jpg"), "junk");
		await fs.writeFile(path.join(sourceDir, ".hidden.jpg"), "hidden");

		const images = await collectSortedDirectoryImages(sourceDir);

		expect(images.map((image) => path.basename(image.filePath))).toEqual(["2.jpg", "10.jpg"]);
	});

	it("writes valid chunk cache files using the configured payload contract", async () => {
		const sourceDir = path.join(tempDir, "raw");
		const coverId = "cover-42";
		await fs.ensureDir(sourceDir);
		await fs.writeFile(path.join(sourceDir, "000000.jpg"), "a");
		await fs.writeFile(path.join(sourceDir, "000001.jpg"), "b");
		await fs.writeFile(path.join(sourceDir, "000002.jpg"), "c");

		const files = await collectSortedDirectoryImages(sourceDir);
		await fs.ensureDir(getCacheDir(coverId));
		const result = await writeChunksFromFiles(files, coverId, 30);

		await ComicCacheStateService.getInstance().markReady(getStatePath(coverId), {
			dbId: 1,
			coverId,
			fileHash: "hash-42",
			name: "chapter.cbz",
			parentPath: tempDir,
			fileKind: FileKind.FILE,
			sourcePath: path.join(tempDir, "chapter.cbz"),
			sourceType: "archive-file",
			archiveFormat: "zip",
			requiresZipArtifact: false
		}, {
			chunkCount: result.chunkCount,
			totalPages: result.totalPages,
			zipReady: false
		});

		expect(result.totalPages).toBe(3);
		expect(result.chunkCount).toBeGreaterThan(1);

		await expect(validateChunkCache(coverId, false)).resolves.toEqual({
			valid: true,
			chunkCount: result.chunkCount,
			totalPages: result.totalPages
		});

		const state = await ComicCacheStateService.getInstance().read(getStatePath(coverId));
		expect(state?.status).toBe("ready");
		expect(state?.chunksReady).toBe(true);
	});

	it("validates generated zip artifacts and rejects corrupted zip files", async () => {
		const sourceDir = path.join(tempDir, "zip-source");
		const badZipPath = path.join(tempDir, "bad.zip");
		await fs.ensureDir(sourceDir);
		await fs.writeFile(path.join(sourceDir, "chapter-01.jpg"), "page");

		const zipResult = await generateDirectoryZipArtifact(sourceDir, "cover-zip");
		await fs.writeFile(badZipPath, "not-a-zip");

		await expect(validateZipArtifact(zipResult.zipPath)).resolves.toBe(true);
		await expect(validateZipArtifact(badZipPath)).resolves.toBe(false);
	});

	it("cleans staging residues without touching final cache directories", async () => {
		const finalDir = getCacheDir("cover-final");
		const finalFile = path.join(finalDir, "keep.txt");
		await fs.ensureDir(finalDir);
		await fs.writeFile(finalFile, "keep");

		const stagingDir = await createCacheStagingDir("cover-stage");
		await fs.writeFile(path.join(stagingDir, "temp.txt"), "temp");

		const removed = await cleanupCacheBuildRoot();

		expect(removed).toBe(1);
		expect(await fs.pathExists(finalFile)).toBe(true);
		await expect(fs.readdir(getCacheBuildRoot())).resolves.toHaveLength(0);
	});

	it("treats a corrupt zip as invalid when chunk cache requires zip artifacts", async () => {
		const sourceDir = path.join(tempDir, "raw-zip-invalid");
		const coverId = "cover-zip-invalid";
		await fs.ensureDir(sourceDir);
		await fs.writeFile(path.join(sourceDir, "000000.jpg"), "a");

		const files = await collectSortedDirectoryImages(sourceDir);
		await fs.ensureDir(getCacheDir(coverId));
		const result = await writeChunksFromFiles(files, coverId, 1024);
		await fs.writeFile(getZipPath(coverId), "corrupted");

		await ComicCacheStateService.getInstance().markReady(getStatePath(coverId), {
			dbId: 2,
			coverId,
			fileHash: "hash-invalid-zip",
			name: "comic-folder",
			parentPath: tempDir,
			fileKind: FileKind.COMIC_MANGA,
			sourcePath: path.join(tempDir, "comic-folder"),
			sourceType: "directory",
			requiresZipArtifact: true
		}, {
			chunkCount: result.chunkCount,
			totalPages: result.totalPages,
			zipReady: true
		});

		await expect(validateChunkCache(coverId, true)).resolves.toEqual({
			valid: false,
			chunkCount: 0,
			totalPages: 0
		});
	});

	it("keeps a single oversized page in one valid chunk", async () => {
		const sourceDir = path.join(tempDir, "raw-single-large");
		const coverId = "cover-single-large";
		await fs.ensureDir(sourceDir);
		await fs.writeFile(path.join(sourceDir, "000000.jpg"), "x".repeat(256));

		const files = await collectSortedDirectoryImages(sourceDir);
		await fs.ensureDir(getCacheDir(coverId));
		const result = await writeChunksFromFiles(files, coverId, 32);

		await ComicCacheStateService.getInstance().markReady(getStatePath(coverId), {
			dbId: 3,
			coverId,
			fileHash: "hash-large-page",
			name: "chapter.cbz",
			parentPath: tempDir,
			fileKind: FileKind.FILE,
			sourcePath: path.join(tempDir, "chapter.cbz"),
			sourceType: "archive-file",
			archiveFormat: "zip",
			requiresZipArtifact: false
		}, {
			chunkCount: result.chunkCount,
			totalPages: result.totalPages,
			zipReady: false
		});

		expect(result.totalPages).toBe(1);
		expect(result.chunkCount).toBe(1);
		await expect(validateChunkCache(coverId, false)).resolves.toEqual({
			valid: true,
			chunkCount: 1,
			totalPages: 1
		});
	});
});
