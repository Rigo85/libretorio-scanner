import fs from "fs-extra";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it, jest } from "@jest/globals";

import { FileKind } from "(src)/models/interfaces/File";
import { config } from "(src)/config/configuration";
import { ComicCacheStateService } from "(src)/services/ComicCacheStateService";
import { NativeComicCacheWorkerService } from "(src)/services/NativeComicCacheWorkerService";
import {
	detectArchiveFormatByPathOrMagic,
	resolveEligibleComicSource,
	toEligibleComicSource
} from "(src)/utils/archiveDetectionUtils";

describe("archiveDetectionUtils", () => {
	let tempDir: string;

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "libretorio-archive-detect-"));
	});

	afterEach(async () => {
		jest.restoreAllMocks();
		await fs.rm(tempDir, {recursive: true, force: true});
	});

	it("prioritizes magic bytes over extension", async () => {
		const filePath = path.join(tempDir, "mismatch.cbr");
		await fs.writeFile(filePath, Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00]));

		expect(detectArchiveFormatByPathOrMagic(filePath)).toBe("zip");
	});

	it("falls back to extension when the file does not exist", () => {
		const filePath = path.join(tempDir, "chapter.cb7");
		expect(detectArchiveFormatByPathOrMagic(filePath)).toBe("7z");
	});

	it("builds an eligible source for archive files without changing fileKind", async () => {
		const filePath = path.join(tempDir, "volume.zip");
		await fs.writeFile(filePath, Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00]));

		const eligible = toEligibleComicSource({
			id: 99,
			name: "volume.zip",
			parentPath: tempDir,
			parentHash: "parent",
			fileHash: "hash",
			size: "10 B",
			coverId: "cover-1",
			fileKind: FileKind.FILE
		});

		expect(eligible).toEqual(expect.objectContaining({
			dbId: 99,
			coverId: "cover-1",
			sourceType: "archive-file",
			archiveFormat: "zip",
			requiresZipArtifact: false
		}));
	});

	it("accepts direct cbz files without requiring the generic probe", async () => {
		const filePath = path.join(tempDir, "issue.cbz");
		await fs.writeFile(filePath, Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00]));
		const probeSpy = jest.spyOn(NativeComicCacheWorkerService.getInstance(), "probeArchiveForComic");

		const resolution = await resolveEligibleComicSource({
			id: 101,
			name: "issue.cbz",
			parentPath: tempDir,
			parentHash: "parent",
			fileHash: "hash-cbz",
			size: "1 KB",
			coverId: "cover-cbz",
			fileKind: FileKind.FILE
		});

		expect(resolution.result).toBe("eligible");
		expect(resolution.reason).toBe("direct-comic-extension");
		expect(resolution.source).toEqual(expect.objectContaining({
			archiveFormat: "zip",
			sourceType: "archive-file"
		}));
		expect(probeSpy).not.toHaveBeenCalled();
	});

	it("rejects multipart rar tails before probing", async () => {
		const filePath = path.join(tempDir, "Enciclopedia.part03.rar");
		await fs.writeFile(filePath, Buffer.from([0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0x00]));
		const probeSpy = jest.spyOn(NativeComicCacheWorkerService.getInstance(), "probeArchiveForComic");

		const resolution = await resolveEligibleComicSource({
			id: 102,
			name: "Enciclopedia.part03.rar",
			parentPath: tempDir,
			parentHash: "parent",
			fileHash: "hash-rar-tail",
			size: "1 KB",
			coverId: "cover-rar-tail",
			fileKind: FileKind.FILE
		});

		expect(resolution.result).toBe("skipped");
		expect(resolution.reason).toBe("ignored-multipart-tail");
		expect(probeSpy).not.toHaveBeenCalled();
	});

	it("probes generic archives and persists ignored negatives", async () => {
		const filePath = path.join(tempDir, "bundle.zip");
		await fs.writeFile(filePath, Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00]));
		const readSpy = jest.spyOn(ComicCacheStateService.getInstance(), "read").mockResolvedValueOnce(undefined);
		const markIgnoredSpy = jest.spyOn(ComicCacheStateService.getInstance(), "markIgnored").mockResolvedValue({
			version: 1,
			status: "ignored",
			sourcePath: filePath,
			sourceType: "archive-file",
			archiveFormat: "zip",
			fileHash: "hash-bundle",
			createdAt: new Date().toISOString(),
			updatedAt: new Date().toISOString(),
			chunkCount: 0,
			totalPages: 0,
			zipReady: false,
			chunksReady: false,
			ignoreReason: "below_min_images",
			probeEntriesScanned: 40,
			probeImageCount: 4,
			probeMaxEntries: config.production.scan.cacheProbe.maxEntries,
			probeMinImages: config.production.scan.cacheProbe.minImages
		});
		const probeSpy = jest.spyOn(NativeComicCacheWorkerService.getInstance(), "probeArchiveForComic").mockResolvedValue({
			accepted: false,
			reason: "below_min_images",
			entriesScanned: 40,
			imageCount: 4,
			detectedBackend: "zip"
		});

		const resolution = await resolveEligibleComicSource({
			id: 103,
			name: "bundle.zip",
			parentPath: tempDir,
			parentHash: "parent",
			fileHash: "hash-bundle",
			size: "1 KB",
			coverId: "cover-bundle",
			fileKind: FileKind.FILE
		});

		expect(readSpy).toHaveBeenCalledTimes(1);
		expect(probeSpy).toHaveBeenCalledTimes(1);
		expect(markIgnoredSpy).toHaveBeenCalledTimes(1);
		expect(resolution.result).toBe("skipped");
		expect(resolution.reason).toBe("ignored-below-min-images");
		expect(resolution.probeEntriesScanned).toBe(40);
		expect(resolution.probeImageCount).toBe(4);
	});

	it("reuses persisted ignored state for generic archives without probing again", async () => {
		const filePath = path.join(tempDir, "bundle.rar");
		await fs.writeFile(filePath, Buffer.from([0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0x00]));
		jest.spyOn(ComicCacheStateService.getInstance(), "read").mockResolvedValue({
			version: 1,
			status: "ignored",
			sourcePath: filePath,
			sourceType: "archive-file",
			archiveFormat: "rar",
			fileHash: "hash-bundle-rar",
			createdAt: new Date().toISOString(),
			updatedAt: new Date().toISOString(),
			chunkCount: 0,
			totalPages: 0,
			zipReady: false,
			chunksReady: false,
			ignoreReason: "no_images",
			probeEntriesScanned: 40,
			probeImageCount: 0,
			probeMaxEntries: config.production.scan.cacheProbe.maxEntries,
			probeMinImages: config.production.scan.cacheProbe.minImages
		});
		const probeSpy = jest.spyOn(NativeComicCacheWorkerService.getInstance(), "probeArchiveForComic");

		const resolution = await resolveEligibleComicSource({
			id: 104,
			name: "bundle.rar",
			parentPath: tempDir,
			parentHash: "parent",
			fileHash: "hash-bundle-rar",
			size: "1 KB",
			coverId: "cover-bundle-rar",
			fileKind: FileKind.FILE
		});

		expect(resolution.result).toBe("skipped");
		expect(resolution.reason).toBe("ignored-no-images");
		expect(probeSpy).not.toHaveBeenCalled();
	});
});
