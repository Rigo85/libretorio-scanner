import fs from "fs-extra";
import path from "path";
import { spawn } from "child_process";
import { extractFull } from "node-7z";
import unzipper from "unzipper";
import { v4 as uuidv4 } from "uuid";

import { Logger } from "(src)/helpers/Logger";
import { ComicArchiveFormat, EligibleComicSource } from "(src)/models/interfaces/EligibleComicSource";
import { config } from "(src)/config/configuration";

const logger = new Logger("NativeComicCacheWorker");

interface NativeWorkerManifestPage {
	index: number;
	raw: string;
	originalName?: string;
	originalWidth?: number;
	originalHeight?: number;
	outputWidth?: number;
	outputHeight?: number;
	bypassed?: boolean;
}

interface NativeWorkerManifest {
	version?: number;
	source?: string;
	backend?: string;
	status?: string;
	totalPages?: number;
	config?: {
		readerFormat?: "jpeg" | "webp";
		readerQuality?: number;
		readerMaxDimension?: number;
		vipsConcurrency?: number;
	};
	pages?: NativeWorkerManifestPage[];
}

interface NativeWorkerExtractResult {
	tempDir: string;
	rawDir: string;
	totalPages?: number;
	detectedBackend?: ComicArchiveFormat;
	manifestPath?: string;
	manifest?: NativeWorkerManifest;
}

interface WorkerEvent {
	type: "start" | "extracting" | "complete" | "warning" | "error";
	current?: number;
	total?: number;
	name?: string;
	backend?: string;
	pages?: number;
	input?: string;
	output?: string;
	manifestPath?: string;
	message?: string;
	requested?: string;
	detected?: string;
}

export class NativeComicCacheWorkerService {
	private static instance: NativeComicCacheWorkerService;

	private constructor() {
	}

	public static getInstance(): NativeComicCacheWorkerService {
		if (!NativeComicCacheWorkerService.instance) {
			NativeComicCacheWorkerService.instance = new NativeComicCacheWorkerService();
		}
		return NativeComicCacheWorkerService.instance;
	}

	public async extractArchiveToOrderedRaw(
		inputPath: string,
		coverId: string,
		backend: ComicArchiveFormat
	): Promise<NativeWorkerExtractResult> {
		const tempDir = path.join(config.production.paths.temp, `${coverId}-${uuidv4()}`);
		const rawDir = path.join(tempDir, "raw");

		await fs.ensureDir(tempDir);

		const nativeBinary = await this.findNativeBinaryPath();
		if (nativeBinary) {
			try {
				const workerResult = await this.runNativeWorker(
					nativeBinary,
					["--input", inputPath, "--output", tempDir, "--backend", backend],
					coverId,
					backend
				);
				return {
					tempDir,
					rawDir,
					totalPages: workerResult.totalPages,
					detectedBackend: workerResult.detectedBackend,
					manifestPath: workerResult.manifestPath,
					manifest: workerResult.manifest
				};
			} catch (error) {
				logger.error(`runNativeWorker "${inputPath}":`, error);
				logger.info(`Falling back to JS extraction for "${inputPath}".`);
			}
		}

		await fs.ensureDir(rawDir);
		await this.extractWithFallback(inputPath, rawDir, backend);
		return {tempDir, rawDir};
	}

	public async extractSourceToOrderedRaw(source: EligibleComicSource): Promise<NativeWorkerExtractResult> {
		const resizeConfig = config.production.scan.cacheResize;
		const tempDir = path.join(config.production.paths.temp, `${source.coverId}-${uuidv4()}`);
		const rawDir = path.join(tempDir, "raw");

		await fs.ensureDir(tempDir);

		const nativeBinary = await this.findNativeBinaryPath();
		if (!nativeBinary) {
			await fs.rm(tempDir, {recursive: true, force: true});
			throw new Error(`Native comic cache worker is required for resize-enabled cache builds: "${source.sourcePath}".`);
		}

		const args = source.sourceType === "directory" ?
			[
				"--input-dir", source.sourcePath,
				"--output", tempDir
			] :
			[
				"--input", source.sourcePath,
				"--output", tempDir,
				"--backend", source.archiveFormat || "auto"
			]
		;
		args.push(
			"--reader-format", resizeConfig.readerFormat,
			"--reader-max-dimension", `${resizeConfig.readerMaxDimension}`,
			"--reader-quality", `${resizeConfig.readerQuality}`,
			"--vips-concurrency", `${resizeConfig.vipsConcurrency}`
		);

		try {
			const workerResult = await this.runNativeWorker(
				nativeBinary,
				args,
				source.coverId,
				source.archiveFormat
			);
			return {
				tempDir,
				rawDir,
				totalPages: workerResult.totalPages,
				detectedBackend: workerResult.detectedBackend,
				manifestPath: workerResult.manifestPath,
				manifest: workerResult.manifest
			};
		} catch (error) {
			await fs.rm(tempDir, {recursive: true, force: true});
			throw error;
		}
	}

	private async findNativeBinaryPath(): Promise<string | undefined> {
		const executable = process.platform === "win32" ? "comic-cache-worker.exe" : "comic-cache-worker";
		const candidates = [
			path.join(process.cwd(), "native", "worker", "build", executable),
			path.join(process.cwd(), "dist", "native", "worker", executable)
		];

		for (const candidate of candidates) {
			if (await fs.pathExists(candidate)) {
				return candidate;
			}
		}

		return undefined;
	}

	private async runNativeWorker(
		binaryPath: string,
		args: string[],
		coverId: string,
		backend?: ComicArchiveFormat
	): Promise<{ totalPages?: number; detectedBackend?: ComicArchiveFormat; manifestPath?: string; manifest?: NativeWorkerManifest }> {
		logger.info(`Using native worker "${binaryPath}" with coverId="${coverId}" args="${args.join(" ")}".`);
		return await new Promise((resolve, reject) => {
			const proc = spawn(binaryPath, args, {
				stdio: ["ignore", "pipe", "pipe"]
			});
			let completed = false;
			let totalPages: number | undefined = undefined;
			let detectedBackend: ComicArchiveFormat | undefined = undefined;
			let manifestPath: string | undefined = undefined;
			let manifest: NativeWorkerManifest | undefined = undefined;
			let progressLogStep = 0;
			const inputPath = this.readCliValue(args, "--input") || this.readCliValue(args, "--input-dir") || "";

			this.attachLineReader(proc.stdout, (line) => {
				const event = this.parseWorkerEvent(line);
				if (!event) {
					logger.info(`worker stdout coverId="${coverId}": ${line}`);
					return;
				}

				if (event.type === "start") {
					logger.info(
						`worker-start coverId="${coverId}" backend="${event.backend || backend}" input="${event.input || inputPath}".`
					);
					return;
				}

				if (event.type === "warning") {
					logger.info(
						`worker-warning coverId="${coverId}" message="${event.message || ""}" requested="${event.requested || ""}" detected="${event.detected || ""}".`
					);
					return;
				}

				if (event.type === "extracting") {
					const current = event.current || 0;
					if (current === 1 || current >= progressLogStep + 25) {
						progressLogStep = current;
						logger.info(
							`worker-progress coverId="${coverId}" current="${current}" total="${event.total || -1}" entry="${event.name || ""}".`
						);
					}
					return;
				}

				if (event.type === "complete") {
					completed = true;
					totalPages = event.pages;
					detectedBackend = this.normalizeWorkerBackend(event.backend) || backend;
					manifestPath = event.manifestPath;
					manifest = manifestPath ? this.readManifest(manifestPath) : undefined;
					logger.info(
						`worker-complete coverId="${coverId}" backend="${detectedBackend}" pages="${totalPages || 0}" manifest="${manifestPath || ""}".`
					);
					return;
				}

				if (event.type === "error") {
					logger.error(`worker-error coverId="${coverId}" message="${event.message || "unknown"}".`);
				}
			});

			this.attachLineReader(proc.stderr, (line) => {
				const event = this.parseWorkerEvent(line);
				if (event?.type === "error") {
					logger.error(`worker-stderr-error coverId="${coverId}" message="${event.message || "unknown"}".`);
					return;
				}

				logger.info(`worker stderr coverId="${coverId}": ${line}`);
			});

			proc.on("error", reject);
			proc.on("close", (code) => {
				if (code === 0 && completed) {
					resolve({totalPages, detectedBackend, manifestPath, manifest});
				} else if (code === 0) {
					resolve({totalPages, detectedBackend: backend, manifestPath, manifest});
				} else {
					reject(new Error(`worker exited with code ${code}`));
				}
			});
		});
	}

	private readCliValue(args: string[], name: string): string | undefined {
		const index = args.indexOf(name);
		if (index < 0 || index + 1 >= args.length) {
			return undefined;
		}
		return args[index + 1];
	}

	private readManifest(manifestPath: string): NativeWorkerManifest | undefined {
		try {
			if (!fs.existsSync(manifestPath)) {
				return undefined;
			}
			return fs.readJsonSync(manifestPath) as NativeWorkerManifest;
		} catch (error) {
			logger.error(`readManifest "${manifestPath}":`, error);
			return undefined;
		}
	}

	private attachLineReader(
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

	private parseWorkerEvent(line: string): WorkerEvent | undefined {
		try {
			const parsed = JSON.parse(line) as WorkerEvent;
			return parsed?.type ? parsed : undefined;
		} catch {
			return undefined;
		}
	}

	private normalizeWorkerBackend(value?: string): ComicArchiveFormat | undefined {
		if (value === "rar" || value === "zip" || value === "7z" || value === "tar") {
			return value;
		}

		return undefined;
	}

	private async extractWithFallback(
		inputPath: string,
		rawDir: string,
		backend: ComicArchiveFormat
	): Promise<void> {
		if (backend === "zip") {
			await this.extractZip(inputPath, rawDir);
			return;
		}

		if (backend === "rar") {
			try {
				await this.extractWith7z(inputPath, rawDir);
				return;
			} catch (error) {
				logger.info(`extractWith7z failed for RAR "${inputPath}", trying /usr/bin/unrar.`);
				await this.extractRarWithUnrar(inputPath, rawDir);
				return;
			}
		}

		await this.extractWith7z(inputPath, rawDir);
	}

	private async extractWith7z(inputPath: string, outputDir: string): Promise<void> {
		await new Promise<void>((resolve, reject) => {
			const extraction = extractFull(inputPath, outputDir, {
				$bin: require("7zip-bin").path7za
			});

			extraction.on("end", () => resolve());
			extraction.on("error", (error: Error) => reject(error));
		});
	}

	private async extractZip(inputPath: string, outputDir: string): Promise<void> {
		await new Promise<void>((resolve, reject) => {
			fs.createReadStream(inputPath)
				.pipe(unzipper.Extract({path: outputDir}))
				.on("close", resolve)
				.on("error", reject);
		});
	}

	private async extractRarWithUnrar(inputPath: string, outputDir: string): Promise<void> {
		await new Promise<void>((resolve, reject) => {
			const proc = spawn("/usr/bin/unrar", ["x", "-y", inputPath, `${outputDir}/`], {
				stdio: ["ignore", "ignore", "pipe"]
			});

			proc.stderr?.on("data", (chunk: Buffer) => {
				logger.info(`unrar stderr: ${chunk.toString().trim()}`);
			});

			proc.on("error", reject);
			proc.on("close", (code) => {
				if (code === 0) {
					resolve();
				} else {
					reject(new Error(`unrar exited with code ${code}`));
				}
			});
		});
	}
}
