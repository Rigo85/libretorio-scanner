import fs from "fs-extra";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it, jest } from "@jest/globals";

import { config } from "(src)/config/configuration";
import { FileKind } from "(src)/models/interfaces/File";
import { EligibleComicSource } from "(src)/models/interfaces/EligibleComicSource";
import { NativeComicCacheWorkerService } from "(src)/services/NativeComicCacheWorkerService";

describe("NativeComicCacheWorkerService", () => {
	let tempDir: string;
	let originalTempPath: string;
	let service: NativeComicCacheWorkerService;

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "libretorio-native-worker-"));
		originalTempPath = config.production.paths.temp;
		config.production.paths.temp = path.join(tempDir, "tmp");
		service = NativeComicCacheWorkerService.getInstance();
	});

	afterEach(async () => {
		config.production.paths.temp = originalTempPath;
		jest.restoreAllMocks();
		await fs.rm(tempDir, {recursive: true, force: true});
	});

	it("falls back to JS extraction when no native binary is available", async () => {
		const findBinarySpy = jest.spyOn(service as any, "findNativeBinaryPath").mockResolvedValue(undefined);
		const extractFallbackSpy = jest.spyOn(service as any, "extractWithFallback").mockResolvedValue(undefined);

		const result = await service.extractArchiveToOrderedRaw("/tmp/example.cbz", "cover-fallback", "zip");

		expect(findBinarySpy).toHaveBeenCalledTimes(1);
		expect(extractFallbackSpy).toHaveBeenCalledTimes(1);
		expect(result.rawDir).toBe(path.join(result.tempDir, "raw"));
		await expect(fs.pathExists(result.rawDir)).resolves.toBe(true);
	});

	it("falls back to JS extraction when the native worker fails", async () => {
		const findBinarySpy = jest.spyOn(service as any, "findNativeBinaryPath").mockResolvedValue("/fake/comic-cache-worker");
		const runNativeSpy = jest.spyOn(service as any, "runNativeWorker").mockRejectedValue(new Error("native failed"));
		const extractFallbackSpy = jest.spyOn(service as any, "extractWithFallback").mockResolvedValue(undefined);

		const result = await service.extractArchiveToOrderedRaw("/tmp/example.cbr", "cover-native-error", "rar");

		expect(findBinarySpy).toHaveBeenCalledTimes(1);
		expect(runNativeSpy).toHaveBeenCalledTimes(1);
		expect(extractFallbackSpy).toHaveBeenCalledTimes(1);
		expect(result.rawDir).toBe(path.join(result.tempDir, "raw"));
		await expect(fs.pathExists(result.rawDir)).resolves.toBe(true);
	});

	it("requires the native worker for resize-enabled source extraction", async () => {
		const source: EligibleComicSource = {
			coverId: "cover-resize-required",
			fileHash: "hash-resize-required",
			name: "resize-required.cbz",
			parentPath: "/tmp",
			fileKind: FileKind.FILE,
			sourcePath: "/tmp/resize-required.cbz",
			sourceType: "archive-file",
			archiveFormat: "zip",
			requiresZipArtifact: false
		};

		const findBinarySpy = jest.spyOn(service as any, "findNativeBinaryPath").mockResolvedValue(undefined);

		await expect(service.extractSourceToOrderedRaw(source)).rejects.toThrow(
			/Native comic cache worker is required for resize-enabled cache builds/
		);
		expect(findBinarySpy).toHaveBeenCalledTimes(1);
	});

	it("passes directory mode and resize arguments to the native worker", async () => {
		const source: EligibleComicSource = {
			coverId: "cover-directory-resize",
			fileHash: "hash-directory-resize",
			name: "directory-resize",
			parentPath: "/tmp",
			fileKind: FileKind.COMIC_MANGA,
			sourcePath: "/tmp/directory-resize",
			sourceType: "directory",
			requiresZipArtifact: true
		};

		const manifestPath = path.join(tempDir, "manifest.json");
		const manifest = {
			version: 1,
			status: "complete",
			totalPages: 2,
			config: {
				readerFormat: "jpeg" as const,
				readerQuality: 82,
				readerMaxDimension: 2400,
				vipsConcurrency: 1
			},
			pages: [
				{index: 0, raw: "raw/000000.jpg"},
				{index: 1, raw: "raw/000001.jpg"}
			]
		};
		const findBinarySpy = jest.spyOn(service as any, "findNativeBinaryPath").mockResolvedValue("/fake/comic-cache-worker");
		const runNativeSpy = jest.spyOn(service as any, "runNativeWorker").mockResolvedValue({
			totalPages: 2,
			manifestPath,
			manifest
		});

		const result = await service.extractSourceToOrderedRaw(source);

		expect(findBinarySpy).toHaveBeenCalledTimes(1);
		expect(runNativeSpy).toHaveBeenCalledWith(
			"/fake/comic-cache-worker",
			expect.arrayContaining([
				"--input-dir", "/tmp/directory-resize",
				"--output", result.tempDir,
				"--reader-format", "jpeg",
				"--reader-max-dimension", "2400",
				"--reader-quality", "82",
				"--vips-concurrency", "1"
			]),
			"cover-directory-resize",
			undefined
		);
		expect(result.manifest).toEqual(manifest);
	});

	it("passes probe arguments to the native worker for generic archives", async () => {
		const findBinarySpy = jest.spyOn(service as any, "findNativeBinaryPath").mockResolvedValue("/fake/comic-cache-worker");
		const runProbeSpy = jest.spyOn(service as any, "runNativeProbe").mockResolvedValue({
			accepted: false,
			reason: "below_min_images",
			entriesScanned: 40,
			imageCount: 6,
			detectedBackend: "zip"
		});

		const result = await service.probeArchiveForComic("/tmp/bundle.zip", "cover-probe", "zip", {
			maxEntries: 40,
			minImages: 8
		});

		expect(findBinarySpy).toHaveBeenCalledTimes(1);
		expect(runProbeSpy).toHaveBeenCalledWith(
			"/fake/comic-cache-worker",
			expect.arrayContaining([
				"--probe",
				"--input", "/tmp/bundle.zip",
				"--backend", "zip",
				"--probe-max-entries", "40",
				"--probe-min-images", "8"
			]),
			"cover-probe",
			"zip"
		);
		expect(result).toEqual(expect.objectContaining({
			accepted: false,
			reason: "below_min_images",
			entriesScanned: 40,
			imageCount: 6,
			detectedBackend: "zip"
		}));
	});

	it("accepts generic archives by fallback when the native probe is unavailable", async () => {
		jest.spyOn(service as any, "findNativeBinaryPath").mockResolvedValue(undefined);
		const runProbeSpy = jest.spyOn(service as any, "runNativeProbe");

		const result = await service.probeArchiveForComic("/tmp/bundle.rar", "cover-probe-fallback", "rar");

		expect(runProbeSpy).not.toHaveBeenCalled();
		expect(result).toEqual(expect.objectContaining({
			accepted: true,
			reason: "probe_unavailable",
			detectedBackend: "rar"
		}));
	});
});
