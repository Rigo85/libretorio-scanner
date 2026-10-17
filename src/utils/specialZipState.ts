import fs from "fs-extra";
import path from "path";
import { createHash, randomUUID } from "crypto";
import unzipper from "unzipper";

interface SourceEntry {
	size: string;
	directory: boolean;
	dosTime: number;
}

export interface SpecialZipSource {
	signature: string;
	entries: Map<string, SourceEntry>;
}

interface ZipState {
	version: 1;
	status: "ready" | "publishing";
	origin: "generated" | "legacy";
	sourceSignature: string;
	zipSignature?: string;
}

export const specialZipStatePath = (zipPath: string): string => `${zipPath}.source.json`;

// Match the UTC DOS timestamp (including clamping) used by our ZIP writer.
function dosTime(milliseconds: number): number {
	const date = new Date(milliseconds);
	const year = date.getUTCFullYear();
	if (year < 1980) return 2162688;
	if (year >= 2044) return 2141175677;
	return (((year - 1980) << 25) | ((date.getUTCMonth() + 1) << 21) | (date.getUTCDate() << 16)
		| (date.getUTCHours() << 11) | (date.getUTCMinutes() << 5) | (date.getUTCSeconds() >> 1)) >>> 0;
}

export async function specialZipSignature(filePath: string): Promise<string> {
	const stat = await fs.lstat(filePath, {bigint: true});
	if (!stat.isFile()) throw new Error(`ZIP is not a regular file: ${filePath}`);
	// Device numbers can change on remount; do not invalidate a persistent cache for that alone.
	return JSON.stringify([stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].map(String));
}

export async function inspectSpecialZipSource(sourcePath: string): Promise<SpecialZipSource> {
	const root = await fs.lstat(sourcePath, {bigint: true});
	if (!root.isDirectory()) throw new Error(`ZIP source is not a directory: ${sourcePath}`);
	const hash = createHash("sha256");
	hash.update(JSON.stringify([await fs.realpath(sourcePath), String(root.ino)]));
	const entries = new Map<string, SourceEntry>();
	const pending = [""];
	while (pending.length) {
		const relative = pending.pop()!;
		const names = (await fs.readdir(path.join(sourcePath, relative))).sort();
		for (const name of names) {
			const child = relative ? `${relative}/${name}` : name;
			const stat = await fs.lstat(path.join(sourcePath, child), {bigint: true});
			if (!stat.isFile() && !stat.isDirectory()) throw new Error(`Unsupported ZIP source entry: ${child}`);
			const directory = stat.isDirectory();
			const key = directory ? `${child}/` : child;
			// archiver uses regular Stats.mtime, which rounds to milliseconds rather than truncating BigInt mtimeMs.
			const zipDateMs = Math.round(Number(stat.mtimeMs) + Number(stat.mtimeNs % 1000000n) / 1000000);
			entries.set(key, {directory, size: directory ? "0" : String(stat.size), dosTime: dosTime(zipDateMs)});
			hash.update(JSON.stringify(directory ? [key] : [key, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].map(String)));
			if (directory) pending.push(child);
		}
	}
	return {signature: hash.digest("hex"), entries};
}

export async function specialZipMatchesSource(zipPath: string, source: SpecialZipSource): Promise<boolean> {
	const directory = await unzipper.Open.file(zipPath);
	if (!directory.files.length || directory.files.length !== source.entries.size) return false;
	const seen = new Set<string>();
	for (const entry of directory.files) {
		const expected = source.entries.get(entry.path);
		if (!expected || seen.has(entry.path) || expected.directory !== (entry.type === "Directory")) return false;
		seen.add(entry.path);
		if (!Number.isSafeInteger(entry.uncompressedSize) || String(entry.uncompressedSize) !== expected.size) return false;
		const storedTime = ((entry.lastModifiedDate << 16) | entry.lastModifiedTime) >>> 0;
		if (!expected.directory && storedTime !== expected.dosTime) return false;
	}
	return true;
}

async function syncDirectory(directory: string): Promise<void> {
	const handle = await fs.open(directory, "r");
	try {
		await fs.fsync(handle);
	} finally {
		await fs.close(handle);
	}
}

async function writeState(zipPath: string, state: ZipState): Promise<void> {
	const target = specialZipStatePath(zipPath);
	const temporary = `${target}.${randomUUID()}.tmp`;
	await fs.ensureDir(path.dirname(target));
	try {
		const handle = await fs.open(temporary, "wx", 0o600);
		try {
			await fs.writeFile(handle, JSON.stringify(state));
			await fs.fsync(handle);
		} finally {
			await fs.close(handle);
		}
		await fs.rename(temporary, target);
		await syncDirectory(path.dirname(target));
	} finally {
		await fs.rm(temporary, {force: true});
	}
}

export async function checkSpecialZip(zipPath: string, source: SpecialZipSource): Promise<{reuse: boolean; reason: string; legacy?: boolean}> {
	let state: ZipState | undefined;
	try {
		const statePath = specialZipStatePath(zipPath);
		if ((await fs.stat(statePath)).size > 4096) return {reuse: false, reason: "invalid-state"};
		state = JSON.parse(await fs.readFile(statePath, "utf8"));
		if (!state || state.version !== 1 || state.status !== "ready" ||
			!["generated", "legacy"].includes(state.origin) || typeof state.zipSignature !== "string") {
			return {reuse: false, reason: "incomplete-state"};
		}
	} catch (error) {
		if (error instanceof SyntaxError) return {reuse: false, reason: "invalid-state"};
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
	let signature: string;
	try {
		signature = await specialZipSignature(zipPath);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return {reuse: false, reason: "missing-zip"};
		throw error;
	}
	if (state && state.zipSignature !== signature) return {reuse: false, reason: "zip-changed"};
	if (state && state.sourceSignature !== source.signature) return {reuse: false, reason: "source-changed"};
	try {
		if (!await specialZipMatchesSource(zipPath, source)) return {reuse: false, reason: "inventory-mismatch"};
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code) throw error;
		return {reuse: false, reason: "invalid-zip"};
	}
	if (await specialZipSignature(zipPath) !== signature) throw new Error("ZIP changed during verification");
	return {reuse: true, reason: state ? "unchanged" : "legacy-inventory", legacy: !state};
}

export async function adoptLegacySpecialZip(zipPath: string, sourcePath: string, source: SpecialZipSource): Promise<void> {
	const signature = await specialZipSignature(zipPath);
	if (!await specialZipMatchesSource(zipPath, source) ||
		(await inspectSpecialZipSource(sourcePath)).signature !== source.signature ||
		await specialZipSignature(zipPath) !== signature) throw new Error("Source or ZIP changed during legacy verification");
	await writeState(zipPath, {version: 1, status: "ready", origin: "legacy", sourceSignature: source.signature, zipSignature: signature});
}

export async function publishSpecialZip(stagedZip: string, zipPath: string, source: SpecialZipSource): Promise<void> {
	await fs.ensureDir(path.dirname(zipPath));
	if ((await fs.stat(stagedZip)).dev !== (await fs.stat(path.dirname(zipPath))).dev) {
		throw new Error("ZIP staging and destination must be on the same filesystem");
	}
	const handle = await fs.open(stagedZip, "r");
	try {
		await fs.fsync(handle);
	} finally {
		await fs.close(handle);
	}
	const state: ZipState = {version: 1, status: "publishing", origin: "generated", sourceSignature: source.signature};
	// Persist the intent before replacing the ZIP: a crash must never turn this into legacy adoption.
	await writeState(zipPath, state);
	await fs.rename(stagedZip, zipPath);
	await syncDirectory(path.dirname(zipPath));
	await writeState(zipPath, {...state, status: "ready", zipSignature: await specialZipSignature(zipPath)});
}
