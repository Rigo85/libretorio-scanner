import fs from "fs-extra";
import os from "os";
import path from "path";
import archiver from "archiver";
import sharp from "sharp";
import { spawn } from "child_process";
import { afterEach, beforeEach, describe, expect, it } from "@jest/globals";

import { config } from "(src)/config/configuration";
import { FileKind } from "(src)/models/interfaces/File";
import { EligibleComicSource } from "(src)/models/interfaces/EligibleComicSource";
import { NativeComicCacheWorkerService } from "(src)/services/NativeComicCacheWorkerService";

async function createSolidImage(
	filePath: string,
	width: number,
	height: number,
	format: "png" | "jpeg" = "png"
): Promise<void> {
	const image = sharp({
		create: {
			width,
			height,
			channels: 3,
			background: {r: 32, g: 96, b: 160}
		}
	});

	if (format === "jpeg") {
		await image.jpeg({quality: 90}).toFile(filePath);
		return;
	}

	await image.png().toFile(filePath);
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

function attachLineReader(
	stream: NodeJS.ReadableStream | null | undefined,
	onLine: (line: string) => void
): void {
	if (!stream) {
		return;
	}

	let buffer = "";
	stream.on("data", (chunk: Buffer | string) => {
		buffer += chunk.toString();
		const lines = buffer.split(/\r?\n/);
		buffer = lines.pop() || "";
		for (const line of lines) {
			const trimmed = line.trim();
			if (trimmed) {
				onLine(trimmed);
			}
		}
	});

	stream.on("end", () => {
		const trimmed = buffer.trim();
		if (trimmed) {
			onLine(trimmed);
		}
	});
}

describe("NativeComicCacheWorker resize integration", () => {
	let tempDir: string;
	let originalTempPath: string;
	let originalResizeConfig: {
		enabled: boolean;
		readerMaxDimension: number;
		readerQuality: number;
		readerFormat: "jpeg" | "webp";
		vipsConcurrency: number;
	};
	let service: NativeComicCacheWorkerService;

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "libretorio-native-resize-"));
		originalTempPath = config.production.paths.temp;
		originalResizeConfig = {
			enabled: config.production.scan.cacheResize.enabled,
			readerMaxDimension: config.production.scan.cacheResize.readerMaxDimension,
			readerQuality: config.production.scan.cacheResize.readerQuality,
			readerFormat: config.production.scan.cacheResize.readerFormat as "jpeg" | "webp",
			vipsConcurrency: config.production.scan.cacheResize.vipsConcurrency
		};
		config.production.paths.temp = path.join(tempDir, "tmp");
		config.production.scan.cacheResize.enabled = true;
		config.production.scan.cacheResize.readerMaxDimension = 2400;
		config.production.scan.cacheResize.readerQuality = 82;
		config.production.scan.cacheResize.readerFormat = "jpeg";
		config.production.scan.cacheResize.vipsConcurrency = 1;
		service = NativeComicCacheWorkerService.getInstance();
	});

	afterEach(async () => {
		config.production.paths.temp = originalTempPath;
		config.production.scan.cacheResize.enabled = originalResizeConfig.enabled;
		config.production.scan.cacheResize.readerMaxDimension = originalResizeConfig.readerMaxDimension;
		config.production.scan.cacheResize.readerQuality = originalResizeConfig.readerQuality;
		config.production.scan.cacheResize.readerFormat = originalResizeConfig.readerFormat;
		config.production.scan.cacheResize.vipsConcurrency = originalResizeConfig.vipsConcurrency;
		await fs.rm(tempDir, {recursive: true, force: true});
	});

	it("bypasses small pages and resizes oversized pages in directory mode", async () => {
		const sourceDir = path.join(tempDir, "directory-source");
		await fs.ensureDir(sourceDir);
		await createSolidImage(path.join(sourceDir, "002-small.png"), 1200, 800, "png");
		await createSolidImage(path.join(sourceDir, "010-large.png"), 3200, 2400, "png");

		const source: EligibleComicSource = {
			coverId: "cover-directory-resize",
			fileHash: "hash-directory-resize",
			name: "directory-source",
			parentPath: tempDir,
			fileKind: FileKind.COMIC_MANGA,
			sourcePath: sourceDir,
			sourceType: "directory",
			requiresZipArtifact: true
		};

		const extraction = await service.extractSourceToOrderedRaw(source);

		try {
			expect(extraction.manifest?.status).toBe("complete");
			expect(extraction.manifest?.config).toEqual(expect.objectContaining({
				readerFormat: "jpeg",
				readerQuality: 82,
				readerMaxDimension: 2400,
				vipsConcurrency: 1
			}));
			expect(extraction.manifest?.pages).toHaveLength(2);

			const [smallPage, largePage] = extraction.manifest!.pages!;
			expect(path.basename(smallPage.raw)).toBe("000000.png");
			expect(smallPage.bypassed).toBe(true);
			expect(smallPage.originalWidth).toBe(1200);
			expect(smallPage.originalHeight).toBe(800);
			expect(smallPage.outputWidth).toBe(1200);
			expect(smallPage.outputHeight).toBe(800);

			expect(path.basename(largePage.raw)).toBe("000001.jpg");
			expect(largePage.bypassed).toBe(false);
			expect(largePage.originalWidth).toBe(3200);
			expect(largePage.originalHeight).toBe(2400);
			expect(largePage.outputWidth).toBe(2400);
			expect(largePage.outputHeight).toBe(1800);

			const smallMeta = await sharp(path.join(extraction.tempDir, smallPage.raw)).metadata();
			const largeMeta = await sharp(path.join(extraction.tempDir, largePage.raw)).metadata();
			expect(smallMeta.format).toBe("png");
			expect(smallMeta.width).toBe(1200);
			expect(smallMeta.height).toBe(800);
			expect(largeMeta.format).toBe("jpeg");
			expect(largeMeta.width).toBe(2400);
			expect(largeMeta.height).toBe(1800);
		} finally {
			await fs.rm(extraction.tempDir, {recursive: true, force: true});
		}
	});

	it("honors readerFormat=webp for resized pages while keeping bypassed originals", async () => {
		const sourceDir = path.join(tempDir, "directory-webp");
		await fs.ensureDir(sourceDir);
		await createSolidImage(path.join(sourceDir, "001-small.png"), 900, 900, "png");
		await createSolidImage(path.join(sourceDir, "002-large.png"), 3600, 2400, "png");

		config.production.scan.cacheResize.readerFormat = "webp";

		const source: EligibleComicSource = {
			coverId: "cover-directory-webp",
			fileHash: "hash-directory-webp",
			name: "directory-webp",
			parentPath: tempDir,
			fileKind: FileKind.COMIC_MANGA,
			sourcePath: sourceDir,
			sourceType: "directory",
			requiresZipArtifact: true
		};

		const extraction = await service.extractSourceToOrderedRaw(source);

		try {
			expect(extraction.manifest?.pages).toHaveLength(2);
			const [smallPage, largePage] = extraction.manifest!.pages!;

			expect(path.basename(smallPage.raw)).toBe("000000.png");
			expect(smallPage.bypassed).toBe(true);

			expect(path.basename(largePage.raw)).toBe("000001.webp");
			expect(largePage.bypassed).toBe(false);

			const largeMeta = await sharp(path.join(extraction.tempDir, largePage.raw)).metadata();
			expect(largeMeta.format).toBe("webp");
			expect(largeMeta.width).toBe(2400);
			expect(largeMeta.height).toBe(1600);
		} finally {
			await fs.rm(extraction.tempDir, {recursive: true, force: true});
		}
	});

	it("processes archive-file input with the same resize policy and manifest contract", async () => {
		const sourceDir = path.join(tempDir, "archive-pages");
		const archivePath = path.join(tempDir, "chapter.cbz");
		await fs.ensureDir(sourceDir);
		await createSolidImage(path.join(sourceDir, "001-small.png"), 1000, 700, "png");
		await createSolidImage(path.join(sourceDir, "002-large.png"), 3200, 1600, "png");
		await createZipArchive(sourceDir, archivePath);

		const source: EligibleComicSource = {
			coverId: "cover-archive-resize",
			fileHash: "hash-archive-resize",
			name: "chapter.cbz",
			parentPath: tempDir,
			fileKind: FileKind.FILE,
			sourcePath: archivePath,
			sourceType: "archive-file",
			archiveFormat: "zip",
			requiresZipArtifact: false
		};

		const extraction = await service.extractSourceToOrderedRaw(source);

		try {
			expect(extraction.detectedBackend).toBe("zip");
			expect(extraction.manifest?.backend).toBe("zip");
			expect(extraction.manifest?.pages).toHaveLength(2);

			const [smallPage, largePage] = extraction.manifest!.pages!;
			expect(smallPage.bypassed).toBe(true);
			expect(smallPage.outputWidth).toBe(1000);
			expect(smallPage.outputHeight).toBe(700);

			expect(largePage.bypassed).toBe(false);
			expect(largePage.outputWidth).toBe(2400);
			expect(largePage.outputHeight).toBe(1200);
			expect(path.basename(largePage.raw)).toBe("000001.jpg");
		} finally {
			await fs.rm(extraction.tempDir, {recursive: true, force: true});
		}
	});

	it("does not write a complete manifest when the native worker is cancelled", async () => {
		const sourceDir = path.join(tempDir, "directory-cancel");
		const outputDir = path.join(tempDir, "cancel-output");
		await fs.ensureDir(sourceDir);
		for (let index = 0; index < 6; index++) {
			await createSolidImage(path.join(sourceDir, `${index.toString().padStart(3, "0")}-large.png`), 4200, 3200, "png");
		}

		const workerPath = await (service as any).findNativeBinaryPath();
		expect(workerPath).toBeTruthy();

		const result = await new Promise<{
			code: number | null;
			signal: NodeJS.Signals | null;
			stdout: string[];
			stderr: string[];
			signalled: boolean;
		}>((resolve, reject) => {
			const proc = spawn(workerPath as string, [
				"--input-dir", sourceDir,
				"--output", outputDir,
				"--reader-format", "jpeg",
				"--reader-max-dimension", "2400",
				"--reader-quality", "82",
				"--vips-concurrency", "1"
			], {
				stdio: ["ignore", "pipe", "pipe"]
			});
			const stdout: string[] = [];
			const stderr: string[] = [];
			let signalled = false;

			attachLineReader(proc.stdout, (line) => {
				stdout.push(line);
				if (!signalled && line.includes("\"type\":\"start\"")) {
					signalled = true;
					proc.kill("SIGTERM");
				}
			});
			attachLineReader(proc.stderr, (line) => {
				stderr.push(line);
			});

			proc.on("error", reject);
			proc.on("close", (code, signal) => {
				resolve({code, signal, stdout, stderr, signalled});
			});
		});

		expect(result.signalled).toBe(true);
		expect(result.code).toBe(2);
		expect(result.signal).toBeNull();
		expect(result.stdout.some((line) => line.includes("\"type\":\"complete\""))).toBe(false);
		expect(result.stdout.some((line) => line.includes("\"type\":\"error\"") && line.includes("cancelled"))).toBe(true);
		await expect(fs.pathExists(path.join(outputDir, "manifest.json"))).resolves.toBe(false);
	});
});
