import fs from "fs-extra";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it, jest } from "@jest/globals";

import { config } from "(src)/config/configuration";
import { FileKind } from "(src)/models/interfaces/File";
import { FileRepository } from "(src)/repositories/FileRepository";
import { SpecialDirectoryArtifactService } from "(src)/services/SpecialDirectoryArtifactService";
import * as comicCacheUtils from "(src)/utils/comicCacheUtils";
import { generateDirectoryZipArtifact, getZipPath, validateZipArtifact } from "(src)/utils/comicCacheUtils";

describe("SpecialDirectoryArtifactService", () => {
	let tempDir: string;
	let originalCachePath: string;

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "libretorio-special-artifact-"));
		originalCachePath = config.production.paths.cache;
		config.production.paths.cache = path.join(tempDir, "cache");
	});

	afterEach(async () => {
		config.production.paths.cache = originalCachePath;
		jest.restoreAllMocks();
		await fs.rm(tempDir, {recursive: true, force: true});
	});

	it("builds zip artifacts and updates size for EPUB directories", async () => {
		const sourceDir = path.join(tempDir, "books", "epub-special");
		await fs.ensureDir(sourceDir);
		await fs.writeFile(path.join(sourceDir, "mimetype"), "application/epub+zip");
		await fs.writeFile(path.join(sourceDir, "content.opf"), "<package></package>");

		const updateSizeSpy = jest.spyOn(FileRepository.getInstance(), "updateSpecialArchiveSize")
			.mockResolvedValue(15);

		const file = {
			id: 15,
			name: "epub-special",
			parentPath: path.dirname(sourceDir),
			parentHash: "parent-1",
			fileHash: "hash-1",
			size: "0 B",
			coverId: "cover-epub",
			fileKind: FileKind.EPUB
		};

		const result = await SpecialDirectoryArtifactService.getInstance().ensureArtifactForFile(file);
		const zipPath = getZipPath(file.coverId);

		expect(result.status).toBe("ready");
		expect(result.zipPath).toBe(zipPath);
		expect(await fs.pathExists(zipPath)).toBe(true);
		expect(result.size).toBeDefined();
		expect(file.size).toBe(result.size);
		expect(updateSizeSpy).toHaveBeenCalledWith(15, result.size);
	});

	it("reuses existing valid zip artifacts for AUDIOBOOK directories", async () => {
		const sourceDir = path.join(tempDir, "books", "audio-special");
		await fs.ensureDir(sourceDir);
		await fs.writeFile(path.join(sourceDir, "track-01.mp3"), "audio-track");

		const coverId = "cover-audio";
		await generateDirectoryZipArtifact(sourceDir, coverId);
		const zipPath = getZipPath(coverId);

		const updateSizeSpy = jest.spyOn(FileRepository.getInstance(), "updateSpecialArchiveSize")
			.mockResolvedValue(21);

		const file = {
			id: 21,
			name: "audio-special",
			parentPath: path.dirname(sourceDir),
			parentHash: "parent-2",
			fileHash: "hash-2",
			size: "0 B",
			coverId,
			fileKind: FileKind.AUDIOBOOK
		};

		const result = await SpecialDirectoryArtifactService.getInstance().ensureArtifactForFile(file);

		expect(result.status).toBe("skipped");
		expect(result.zipPath).toBe(zipPath);
		expect(result.size).toBeDefined();
		expect(file.size).toBe(result.size);
		expect(updateSizeSpy).toHaveBeenCalledWith(21, result.size);
	});

	it("rebuilds invalid existing zip artifacts instead of skipping them", async () => {
		const sourceDir = path.join(tempDir, "books", "audio-invalid");
		await fs.ensureDir(sourceDir);
		await fs.writeFile(path.join(sourceDir, "track-01.mp3"), "audio-track");

		const coverId = "cover-audio-invalid";
		const zipPath = getZipPath(coverId);
		await fs.ensureDir(path.dirname(zipPath));
		await fs.writeFile(zipPath, "not-a-zip");

		const updateSizeSpy = jest.spyOn(FileRepository.getInstance(), "updateSpecialArchiveSize")
			.mockResolvedValue(22);

		const file = {
			id: 22,
			name: "audio-invalid",
			parentPath: path.dirname(sourceDir),
			parentHash: "parent-invalid",
			fileHash: "hash-invalid",
			size: "0 B",
			coverId,
			fileKind: FileKind.AUDIOBOOK
		};

		const result = await SpecialDirectoryArtifactService.getInstance().ensureArtifactForFile(file);

		expect(result.status).toBe("ready");
		await expect(validateZipArtifact(zipPath)).resolves.toBe(true);
		expect(updateSizeSpy).toHaveBeenCalledWith(22, result.size);
	});

	it("keeps the previous final zip when a forced rebuild fails", async () => {
		const sourceDir = path.join(tempDir, "books", "audio-keep-old");
		await fs.ensureDir(sourceDir);
		await fs.writeFile(path.join(sourceDir, "track-01.mp3"), "audio-track");

		const coverId = "cover-audio-keep-old";
		await generateDirectoryZipArtifact(sourceDir, coverId);
		const zipPath = getZipPath(coverId);
		const previousBuffer = await fs.readFile(zipPath);

		const validateSpy = jest.spyOn(comicCacheUtils, "validateZipArtifact")
			.mockImplementation(async (candidatePath: string) => candidatePath !== zipPath);
		const generateSpy = jest.spyOn(comicCacheUtils, "generateDirectoryZipArtifact")
			.mockRejectedValue(new Error("zip build failed"));

		const file = {
			id: 23,
			name: "audio-keep-old",
			parentPath: path.dirname(sourceDir),
			parentHash: "parent-keep-old",
			fileHash: "hash-keep-old",
			size: "0 B",
			coverId,
			fileKind: FileKind.AUDIOBOOK
		};

		const result = await SpecialDirectoryArtifactService.getInstance().ensureArtifactForFile(file);
		const afterBuffer = await fs.readFile(zipPath);

		expect(result.status).toBe("error");
		expect(generateSpy).toHaveBeenCalled();
		expect(validateSpy).toHaveBeenCalled();
		expect(afterBuffer.equals(previousBuffer)).toBe(true);
	});

	it("does not route COMIC_MANGA directories into the zip-only special flow", async () => {
		const file = {
			id: 30,
			name: "comic-special",
			parentPath: path.join(tempDir, "books"),
			parentHash: "parent-3",
			fileHash: "hash-3",
			size: "0 B",
			coverId: "cover-comic",
			fileKind: FileKind.COMIC_MANGA
		};

		expect(SpecialDirectoryArtifactService.isZipOnlySpecialDirectory(file)).toBe(false);

		const result = await SpecialDirectoryArtifactService.getInstance().ensureArtifactForFile(file);

		expect(result.status).toBe("skipped");
		expect(result.zipPath).toBeUndefined();
	});
});
