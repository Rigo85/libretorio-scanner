#!/usr/bin/env node

import fs from "fs";
import fsp from "fs/promises";
import path from "path";
import os from "os";
import { fileURLToPath } from "url";
import { spawn } from "child_process";
import readline from "readline";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const SCRIPT_DIR = path.dirname(SCRIPT_PATH);
const DEFAULT_TIMEOUT_MS = 180_000;
const DEFAULT_LOG_PATH = path.join(os.homedir(), "libretorio-scanner.log");
const DEFAULT_READER_FORMAT = "jpeg";
const DEFAULT_READER_MAX_DIMENSION = 2400;
const DEFAULT_READER_QUALITY = 82;
const DEFAULT_VIPS_CONCURRENCY = 1;

function printUsage() {
	process.stdout.write(
		[
			"Usage:",
			"  node scripts/review-cache-failures.mjs [options]",
			"",
			"Options:",
			"  --repo-root PATH      Scanner repo root. Auto-detected when possible.",
			"  --log-path PATH       Log file to inspect. Default: ~/libretorio-scanner.log",
			"  --scan-root PATH      Scan root used to isolate the latest run.",
			"  --paths-file PATH     Plain-text file with one path per line.",
			"  --path PATH           Add one path explicitly. Repeatable.",
			"  --limit N             Only process the first N paths.",
			"  --timeout-ms N        Per-item worker timeout. Default: 180000.",
			"  --tmp-dir PATH        Temporary working root. Default: <script dir>/.review-cache-worker-tmp",
			"  --report PATH         JSON report output path.",
			"  --keep-temp           Keep per-item temp dirs for inspection.",
			"  --reader-format FMT   jpeg|webp. Default: jpeg.",
			"  --reader-max-dimension N",
			"  --reader-quality N",
			"  --vips-concurrency N",
			"  --help                Show this help.",
			"",
			"If no --path or --paths-file is provided, the script extracts the failing",
			"cache-build paths from the latest scanCompareUpdate run in the log.",
			"All worker outputs go to an isolated temp root. Production cache is never touched.",
			""
		].join("\n")
	);
}

function parseArgs(argv) {
	const options = {
		logPath: DEFAULT_LOG_PATH,
		timeoutMs: DEFAULT_TIMEOUT_MS,
		readerFormat: DEFAULT_READER_FORMAT,
		readerMaxDimension: DEFAULT_READER_MAX_DIMENSION,
		readerQuality: DEFAULT_READER_QUALITY,
		vipsConcurrency: DEFAULT_VIPS_CONCURRENCY,
		paths: [],
		keepTemp: false
	};

	for (let index = 0; index < argv.length; index++) {
		const arg = argv[index];
		switch (arg) {
			case "--repo-root":
				options.repoRoot = argv[++index];
				break;
			case "--log-path":
				options.logPath = argv[++index];
				break;
			case "--scan-root":
				options.scanRoot = argv[++index];
				break;
			case "--paths-file":
				options.pathsFile = argv[++index];
				break;
			case "--path":
				options.paths.push(argv[++index]);
				break;
			case "--limit":
				options.limit = Number.parseInt(argv[++index], 10);
				break;
			case "--timeout-ms":
				options.timeoutMs = Number.parseInt(argv[++index], 10);
				break;
			case "--tmp-dir":
				options.tmpDir = argv[++index];
				break;
			case "--report":
				options.reportPath = argv[++index];
				break;
			case "--keep-temp":
				options.keepTemp = true;
				break;
			case "--reader-format":
				options.readerFormat = argv[++index];
				break;
			case "--reader-max-dimension":
				options.readerMaxDimension = Number.parseInt(argv[++index], 10);
				break;
			case "--reader-quality":
				options.readerQuality = Number.parseInt(argv[++index], 10);
				break;
			case "--vips-concurrency":
				options.vipsConcurrency = Number.parseInt(argv[++index], 10);
				break;
			case "--help":
			case "-h":
				options.help = true;
				break;
			default:
				throw new Error(`Unknown argument: ${arg}`);
		}
	}

	return options;
}

function findRepoRoot(explicitRoot) {
	if (explicitRoot) {
		return path.resolve(explicitRoot);
	}

	const starts = [process.cwd(), SCRIPT_DIR];
	for (const start of starts) {
		let current = path.resolve(start);
		while (true) {
			if (
				fs.existsSync(path.join(current, "package.json")) &&
				fs.existsSync(path.join(current, "native", "worker", "src", "app", "main.cpp"))
			) {
				return current;
			}
			const parent = path.dirname(current);
			if (parent === current) {
				break;
			}
			current = parent;
		}
	}

	throw new Error("Could not detect scanner repo root. Pass --repo-root explicitly.");
}

function findWorkerBinary(repoRoot) {
	const executable = process.platform === "win32" ? "comic-cache-worker.exe" : "comic-cache-worker";
	const candidates = [
		path.join(repoRoot, "native", "worker", "build", executable),
		path.join(repoRoot, "dist", "native", "worker", executable)
	];

	for (const candidate of candidates) {
		if (fs.existsSync(candidate)) {
			return candidate;
		}
	}

	throw new Error(`Could not find comic-cache-worker under "${repoRoot}".`);
}

function normalizeScanRoot(repoRoot, explicitScanRoot) {
	return explicitScanRoot ? path.resolve(explicitScanRoot) : path.join(repoRoot, "dist", "public", "books");
}

function timestampForFileName(date = new Date()) {
	const parts = [
		date.getFullYear(),
		String(date.getMonth() + 1).padStart(2, "0"),
		String(date.getDate()).padStart(2, "0"),
		"-",
		String(date.getHours()).padStart(2, "0"),
		String(date.getMinutes()).padStart(2, "0"),
		String(date.getSeconds()).padStart(2, "0")
	];
	return parts.join("");
}

function detectArchiveFormatByExtension(filePath) {
	const ext = path.extname(filePath || "").toLowerCase();
	if (ext === ".cbr" || ext === ".rar") return "rar";
	if (ext === ".cbz" || ext === ".zip") return "zip";
	if (ext === ".cb7" || ext === ".7z") return "7z";
	if (ext === ".cbt" || ext === ".tar" || ext === ".tgz" || ext === ".tbz2" || ext === ".txz") return "tar";
	return undefined;
}

function detectArchiveFormatByMagic(filePath) {
	if (!filePath || !fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
		return undefined;
	}

	const fd = fs.openSync(filePath, "r");
	try {
		const header = Buffer.alloc(262);
		const bytesRead = fs.readSync(fd, header, 0, header.length, 0);

		if (bytesRead >= 7) {
			const rar4 = Buffer.from([0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0x00]);
			const rar5 = Buffer.from([0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0x01, 0x00]);
			if (header.subarray(0, 7).equals(rar4) || (bytesRead >= 8 && header.subarray(0, 8).equals(rar5))) {
				return "rar";
			}
		}

		if (bytesRead >= 4) {
			const signature = header.readUInt32LE(0);
			if (signature === 0x04034b50 || signature === 0x06054b50 || signature === 0x08074b50) {
				return "zip";
			}
		}

		if (bytesRead >= 6) {
			const sevenz = Buffer.from([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c]);
			if (header.subarray(0, 6).equals(sevenz)) {
				return "7z";
			}
		}

		if (bytesRead >= 262) {
			const ustar = header.subarray(257, 262).toString("ascii");
			if (ustar === "ustar") {
				return "tar";
			}
		}

		if (bytesRead >= 2 && header[0] === 0x1f && header[1] === 0x8b) {
			return "tar";
		}

		if (bytesRead >= 3 && header[0] === 0x42 && header[1] === 0x5a && header[2] === 0x68) {
			return "tar";
		}

		if (bytesRead >= 6) {
			const xz = Buffer.from([0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00]);
			if (header.subarray(0, 6).equals(xz)) {
				return "tar";
			}
		}
	} finally {
		fs.closeSync(fd);
	}

	return undefined;
}

function detectBackend(filePath) {
	return detectArchiveFormatByMagic(filePath) || detectArchiveFormatByExtension(filePath);
}

async function readPathsFile(filePath) {
	const content = await fsp.readFile(filePath, "utf8");
	return content
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter(Boolean);
}

async function findLatestRunStartLine(logPath, scanRoot) {
	let lineNumber = 0;
	let lastStart = 0;
	const marker = `scanCompareUpdate for path: "${scanRoot}".`;

	const rl = readline.createInterface({
		input: fs.createReadStream(logPath, { encoding: "utf8" }),
		crlfDelay: Infinity
	});

	for await (const line of rl) {
		lineNumber++;
		if (line.includes(marker)) {
			lastStart = lineNumber;
		}
	}

	if (!lastStart) {
		throw new Error(`Could not find latest scanCompareUpdate marker for "${scanRoot}" in "${logPath}".`);
	}

	return lastStart;
}

async function extractPathsFromLatestRun(logPath, scanRoot) {
	const startLine = await findLatestRunStartLine(logPath, scanRoot);
	const paths = [];
	const seen = new Set();
	let lineNumber = 0;
	const regex = /cache-build:error item="[^"]+" coverId="[^"]+" path="([^"]+)":/;

	const rl = readline.createInterface({
		input: fs.createReadStream(logPath, { encoding: "utf8" }),
		crlfDelay: Infinity
	});

	for await (const line of rl) {
		lineNumber++;
		if (lineNumber < startLine) {
			continue;
		}
		const match = regex.exec(line);
		if (!match) {
			continue;
		}
		const failurePath = match[1];
		if (!seen.has(failurePath)) {
			seen.add(failurePath);
			paths.push(failurePath);
		}
	}

	return paths;
}

function summarizeManifest(manifest) {
	if (!manifest || !Array.isArray(manifest.pages)) {
		return undefined;
	}

	const bypassedPages = manifest.pages.filter((page) => page.bypassed === true).length;
	const resizedPages = manifest.pages.length - bypassedPages;

	return {
		backend: manifest.backend,
		status: manifest.status,
		totalPages: manifest.totalPages ?? manifest.pages.length,
		bypassedPages,
		resizedPages,
		config: manifest.config
	};
}

function parseWorkerEvent(line) {
	try {
		const event = JSON.parse(line);
		return event && typeof event === "object" ? event : undefined;
	} catch {
		return undefined;
	}
}

async function runWorkerForPath(workerBinary, itemPath, options, tempRoot, index, total) {
	const startedAt = Date.now();
	const stat = await fsp.stat(itemPath);
	const sourceType = stat.isDirectory() ? "directory" : "archive-file";
	const itemSlug = `${String(index + 1).padStart(3, "0")}-${path.basename(itemPath).replace(/[^a-zA-Z0-9._-]+/g, "_")}`;
	const outputDir = path.join(tempRoot, itemSlug);
	await fsp.rm(outputDir, { recursive: true, force: true });

	const args = sourceType === "directory"
		? ["--input-dir", itemPath, "--output", outputDir]
		: ["--input", itemPath, "--output", outputDir, "--backend", detectBackend(itemPath) || "auto"];
	args.push(
		"--reader-format", options.readerFormat,
		"--reader-max-dimension", String(options.readerMaxDimension),
		"--reader-quality", String(options.readerQuality),
		"--vips-concurrency", String(options.vipsConcurrency)
	);

	const stdoutLines = [];
	const stderrLines = [];
	let workerErrorEvent;
	let workerWarningEvents = [];
	let lastProgress;
	let timedOut = false;

	const child = spawn(workerBinary, args, {
		stdio: ["ignore", "pipe", "pipe"]
	});

	child.stdout.setEncoding("utf8");
	child.stderr.setEncoding("utf8");

	const stdoutRl = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
	const stderrRl = readline.createInterface({ input: child.stderr, crlfDelay: Infinity });

	stdoutRl.on("line", (line) => {
		stdoutLines.push(line);
		const event = parseWorkerEvent(line);
		if (!event) {
			return;
		}
		if (event.type === "error") {
			workerErrorEvent = event.message || JSON.stringify(event);
		}
		if (event.type === "warning") {
			workerWarningEvents.push(event);
		}
		if (event.type === "extracting") {
			lastProgress = {
				current: event.current,
				total: event.total,
				name: event.name
			};
		}
	});

	stderrRl.on("line", (line) => {
		if (line.trim()) {
			stderrLines.push(line);
		}
	});

	const timeoutHandle = setTimeout(() => {
		timedOut = true;
		child.kill("SIGKILL");
	}, options.timeoutMs);

	const exit = await new Promise((resolve, reject) => {
		child.on("error", reject);
		child.on("close", (code, signal) => {
			clearTimeout(timeoutHandle);
			resolve({ code: code ?? -1, signal: signal ?? null });
		});
	});

	const manifestPath = path.join(outputDir, "manifest.json");
	let manifest;
	if (!timedOut && exit.code === 0 && fs.existsSync(manifestPath)) {
		manifest = JSON.parse(await fsp.readFile(manifestPath, "utf8"));
	}

	const result = {
		index: index + 1,
		total,
		path: itemPath,
		sourceType,
		declaredExtension: stat.isFile() ? path.extname(itemPath).toLowerCase() : undefined,
		detectedBackend: stat.isFile() ? detectBackend(itemPath) : "directory",
		exists: true,
		sizeBytes: stat.size,
		args,
		durationMs: Date.now() - startedAt,
		exitCode: exit.code,
		exitSignal: exit.signal,
		timedOut,
		success: !timedOut && exit.code === 0,
		lastProgress,
		workerErrorEvent,
		workerWarningEvents,
		stderrLines,
		manifestPath: manifest ? manifestPath : undefined,
		manifestSummary: summarizeManifest(manifest)
	};

	if (!options.keepTemp) {
		await fsp.rm(outputDir, { recursive: true, force: true });
	}

	return result;
}

async function main() {
	const options = parseArgs(process.argv.slice(2));
	if (options.help) {
		printUsage();
		return;
	}

	if (!Number.isFinite(options.timeoutMs) || options.timeoutMs < 1000) {
		throw new Error("--timeout-ms must be >= 1000");
	}

	const repoRoot = findRepoRoot(options.repoRoot);
	const workerBinary = findWorkerBinary(repoRoot);
	const scanRoot = normalizeScanRoot(repoRoot, options.scanRoot);
	const tempRoot = path.resolve(options.tmpDir || path.join(SCRIPT_DIR, ".review-cache-worker-tmp"));
	const reportPath = path.resolve(
		options.reportPath || path.join(SCRIPT_DIR, `review-cache-worker-report-${timestampForFileName()}.json`)
	);

	let paths = [...options.paths];
	if (options.pathsFile) {
		paths.push(...await readPathsFile(options.pathsFile));
	}
	if (!paths.length) {
		paths = await extractPathsFromLatestRun(path.resolve(options.logPath), scanRoot);
	}

	const uniquePaths = [];
	const seen = new Set();
	for (const itemPath of paths) {
		const normalized = path.resolve(itemPath);
		if (!seen.has(normalized)) {
			seen.add(normalized);
			uniquePaths.push(normalized);
		}
	}

	if (Number.isFinite(options.limit) && options.limit > 0) {
		uniquePaths.splice(options.limit);
	}

	if (!uniquePaths.length) {
		throw new Error("No input paths to review.");
	}

	await fsp.mkdir(tempRoot, { recursive: true });

	const results = [];
	process.stdout.write(`Reviewing ${uniquePaths.length} paths with worker "${workerBinary}".\n`);
	process.stdout.write(`Temp root: ${tempRoot}\n`);
	process.stdout.write(`Report: ${reportPath}\n`);

	for (let index = 0; index < uniquePaths.length; index++) {
		const itemPath = uniquePaths[index];
		process.stdout.write(`[${index + 1}/${uniquePaths.length}] ${itemPath}\n`);
		try {
			const result = await runWorkerForPath(workerBinary, itemPath, options, tempRoot, index, uniquePaths.length);
			results.push(result);
			process.stdout.write(
				`  -> ${result.success ? "OK" : "FAIL"} exit=${result.exitCode} timedOut=${result.timedOut ? "yes" : "no"} ` +
				`backend=${result.detectedBackend || "-"} durationMs=${result.durationMs}\n`
			);
			if (!result.success) {
				const firstDetail = result.workerErrorEvent || result.stderrLines[0] || "no error detail captured";
				process.stdout.write(`     ${firstDetail}\n`);
			}
		} catch (error) {
			results.push({
				index: index + 1,
				total: uniquePaths.length,
				path: itemPath,
				success: false,
				fatalRunnerError: error instanceof Error ? error.message : String(error)
			});
			process.stdout.write(`  -> FAIL runner-error=${error instanceof Error ? error.message : String(error)}\n`);
		}
	}

	const summary = {
		repoRoot,
		scanRoot,
		logPath: path.resolve(options.logPath),
		workerBinary,
		tempRoot,
		reportPath,
		timeoutMs: options.timeoutMs,
		readerFormat: options.readerFormat,
		readerMaxDimension: options.readerMaxDimension,
		readerQuality: options.readerQuality,
		vipsConcurrency: options.vipsConcurrency,
		total: results.length,
		success: results.filter((result) => result.success).length,
		failed: results.filter((result) => !result.success).length,
		timedOut: results.filter((result) => result.timedOut).length,
		createdAt: new Date().toISOString(),
		results
	};

	await fsp.writeFile(reportPath, JSON.stringify(summary, null, 2), "utf8");

	if (!options.keepTemp) {
		await fsp.rm(tempRoot, { recursive: true, force: true });
	}

	process.stdout.write(
		[
			"",
			"Done.",
			`  total:   ${summary.total}`,
			`  success: ${summary.success}`,
			`  failed:  ${summary.failed}`,
			`  timeout: ${summary.timedOut}`,
			`  report:  ${reportPath}`,
			""
		].join("\n")
	);
}

main().catch((error) => {
	process.stderr.write(`${error instanceof Error ? error.stack || error.message : String(error)}\n`);
	process.exit(1);
});
