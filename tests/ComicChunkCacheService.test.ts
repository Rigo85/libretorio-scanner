import fs from "fs-extra";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it, jest } from "@jest/globals";

import { config } from "(src)/config/configuration";
import { FileKind } from "(src)/models/interfaces/File";
import { EligibleComicSource } from "(src)/models/interfaces/EligibleComicSource";
import { ComicCacheStateService } from "(src)/services/ComicCacheStateService";
import { ComicChunkCacheService } from "(src)/services/ComicChunkCacheService";
import { NativeComicCacheWorkerService } from "(src)/services/NativeComicCacheWorkerService";
import * as comicCacheUtils from "(src)/utils/comicCacheUtils";
import {
	collectSortedDirectoryImages,
	generateDirectoryZipArtifact,
	getStatePath,
	getZipPath,
	validateChunkCache,
	writeChunksFromFiles
} from "(src)/utils/comicCacheUtils";

describe("ComicChunkCacheService", () => {
	let tempDir: string;
	let originalCachePath: string;
	let originalTempPath: string;
	let service: ComicChunkCacheService;

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "libretorio-comic-cache-service-"));
		originalCachePath = config.production.paths.cache;
		originalTempPath = config.production.paths.temp;
		config.production.paths.cache = path.join(tempDir, "cache");
		config.production.paths.temp = path.join(tempDir, "tmp");
		service = ComicChunkCacheService.getInstance();
	});

	afterEach(async () => {
		config.production.paths.cache = originalCachePath;
		config.production.paths.temp = originalTempPath;
		jest.restoreAllMocks();
		await fs.rm(tempDir, {recursive: true, force: true});
	});

	async function createWorkerExtractionFixture(
		rawNames: string[],
		options?: { status?: string; totalPages?: number }
	) {
		const workerTempDir = await fs.mkdtemp(path.join(tempDir, "worker-extract-"));
		const rawDir = path.join(workerTempDir, "raw");
		const manifestPath = path.join(workerTempDir, "manifest.json");
		await fs.ensureDir(rawDir);

		const pages = [];
		for (let index = 0; index < rawNames.length; index++) {
			const rawName = rawNames[index];
			await fs.writeFile(path.join(rawDir, rawName), `page-${index}`);
			pages.push({
				index,
				raw: path.join(rawDir, rawName),
				originalName: rawName,
				originalWidth: 3200,
				originalHeight: 2400,
				outputWidth: 2400,
				outputHeight: 1800,
				bypassed: false
			});
		}

		const manifest = {
			version: 1,
			status: options?.status || "complete",
			totalPages: options?.totalPages ?? pages.length,
			pages
		};
		await fs.writeJson(manifestPath, manifest);

		return {
			tempDir: workerTempDir,
			rawDir,
			totalPages: manifest.totalPages,
			manifestPath,
			manifest
		};
	}

	it("rebuilds COMIC_MANGA cache when the existing zip is corrupt", async () => {
		const sourceDir = path.join(tempDir, "comic-valid-rebuild");
		const coverId = "cover-comic-rebuild";
		await fs.ensureDir(sourceDir);
		await fs.writeFile(path.join(sourceDir, "001.jpg"), "a");
		await fs.writeFile(path.join(sourceDir, "002.jpg"), "b");

		const source: EligibleComicSource = {
			coverId,
			fileHash: "hash-comic-rebuild",
			name: "comic-valid-rebuild",
			parentPath: tempDir,
			fileKind: FileKind.COMIC_MANGA,
			sourcePath: sourceDir,
			sourceType: "directory",
			requiresZipArtifact: true
		};

		const files = await collectSortedDirectoryImages(sourceDir);
		const chunkResult = await writeChunksFromFiles(files, coverId, 1024);
		await fs.writeFile(getZipPath(coverId), "corrupt-zip");
		await ComicCacheStateService.getInstance().markReady(getStatePath(coverId), source, {
			chunkCount: chunkResult.chunkCount,
			totalPages: chunkResult.totalPages,
			zipReady: true
		});
		const extraction = await createWorkerExtractionFixture(["000000.jpg", "000001.jpg"]);
		jest.spyOn(NativeComicCacheWorkerService.getInstance(), "extractSourceToOrderedRaw").mockResolvedValue(extraction);

		const result = await service.ensureCacheForSource(source);

		expect(result.status).toBe("ready");
		await expect(validateChunkCache(coverId, true)).resolves.toEqual({
			valid: true,
			chunkCount: result.chunkCount,
			totalPages: result.totalPages
		});
	});

	it("keeps the previous final cache when a forced rebuild fails", async () => {
		const sourceDir = path.join(tempDir, "comic-keep-old");
		const coverId = "cover-comic-keep-old";
		await fs.ensureDir(sourceDir);
		await fs.writeFile(path.join(sourceDir, "001.jpg"), "a");
		await fs.writeFile(path.join(sourceDir, "002.jpg"), "b");

		const source: EligibleComicSource = {
			coverId,
			fileHash: "hash-comic-keep-old",
			name: "comic-keep-old",
			parentPath: tempDir,
			fileKind: FileKind.COMIC_MANGA,
			sourcePath: sourceDir,
			sourceType: "directory",
			requiresZipArtifact: true
		};

		const files = await collectSortedDirectoryImages(sourceDir);
		const seeded = await writeChunksFromFiles(files, coverId, 1024);
		await generateDirectoryZipArtifact(sourceDir, coverId);
		await ComicCacheStateService.getInstance().markReady(getStatePath(coverId), source, {
			chunkCount: seeded.chunkCount,
			totalPages: seeded.totalPages,
			zipReady: true
		});

		const previousZip = await fs.readFile(getZipPath(coverId));
		const actualValidateChunkCache = comicCacheUtils.validateChunkCache;
		jest.spyOn(comicCacheUtils, "validateChunkCache")
			.mockImplementationOnce(async () => ({valid: false, chunkCount: 0, totalPages: 0}))
			.mockImplementation(actualValidateChunkCache)
		;
		const extraction = await createWorkerExtractionFixture(["000000.jpg", "000001.jpg"]);
		jest.spyOn(NativeComicCacheWorkerService.getInstance(), "extractSourceToOrderedRaw").mockResolvedValue(extraction);
		jest.spyOn(comicCacheUtils, "collectSortedDirectoryImages").mockRejectedValue(new Error("image collection failed"));

		const result = await service.ensureCacheForSource(source);
		const afterZip = await fs.readFile(getZipPath(coverId));

		expect(result.status).toBe("error");
		expect(afterZip.equals(previousZip)).toBe(true);
		await expect(validateChunkCache(coverId, true)).resolves.toEqual({
			valid: true,
			chunkCount: seeded.chunkCount,
			totalPages: seeded.totalPages
		});
	});

	it("returns error when no valid images exist for chunk generation", async () => {
		const sourceDir = path.join(tempDir, "comic-no-images");
		const coverId = "cover-comic-no-images";
		await fs.ensureDir(sourceDir);
		await fs.writeFile(path.join(sourceDir, "ComicInfo.xml"), "<xml></xml>");

		const source: EligibleComicSource = {
			coverId,
			fileHash: "hash-comic-no-images",
			name: "comic-no-images",
			parentPath: tempDir,
			fileKind: FileKind.COMIC_MANGA,
			sourcePath: sourceDir,
			sourceType: "directory",
			requiresZipArtifact: true
		};
		const extraction = await createWorkerExtractionFixture([], {
			status: "complete",
			totalPages: 0
		});
		jest.spyOn(NativeComicCacheWorkerService.getInstance(), "extractSourceToOrderedRaw").mockResolvedValue(extraction);

		const result = await service.ensureCacheForSource(source);

		expect(result.status).toBe("error");
		await expect(validateChunkCache(coverId, true)).resolves.toEqual({
			valid: false,
			chunkCount: 0,
			totalPages: 0
		});
	});
});
