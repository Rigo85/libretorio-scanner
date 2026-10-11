import fs from "fs-extra";
import path from "path";
import { createHash } from "crypto";
import { ConversionCandidate, ConversionError } from "(src)/models/interfaces/DocumentConversion";

export async function fileSignature(file: string): Promise<string | undefined> {
	try {
		const info = await fs.lstat(file, {bigint: true});
		if (!info.isFile() || info.size < 1n) return undefined;
		return [info.dev, info.ino, info.size, info.mtimeNs, info.ctimeNs].map(String).join(":");
	} catch (error) {
		if (error.code === "ENOENT") return undefined;
		throw error;
	}
}

export async function fileDigest(file: string): Promise<string> {
	const hash = createHash("sha256");
	for await (const bytes of fs.createReadStream(file)) hash.update(bytes);
	return hash.digest("hex");
}

export interface DocumentSource {
	path: string;
	inputRoot: string;
	inputName: string;
	extension: string;
	signature: string;
	directory: boolean;
	size?: number;
}

export async function inspectDocumentSource(candidate: ConversionCandidate, library: string): Promise<DocumentSource> {
	const root = await fs.realpath(library);
	const source = await fs.realpath(path.join(candidate.parentPath, candidate.name));
	if (!source.startsWith(root + path.sep)) throw new ConversionError("source_path", "Source escapes library");
	const directory = candidate.fileKind === "EPUB";
	const info = await fs.stat(source);
	if (directory ? !info.isDirectory() : !info.isFile()) throw new ConversionError("source_type", "Catalogued source type changed");
	const extension = directory ? "epub" : path.extname(candidate.name).slice(1).toLowerCase();
	const resources = directory || ["html", "htm", "md"].includes(extension);
	const inputRoot = directory ? source : path.dirname(source);
	const signature = createHash("sha256").update(source);
	let entries = 0;
	const visit = async (current: string): Promise<void> => {
		if (++entries > 50000) throw new ConversionError("resource_limit", "Source resources exceed 50000 entries");
		const stat = await fs.lstat(current, {bigint: true});
		if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory())) {
			throw new ConversionError("source_resource", "Unsupported symlink or special resource in document input");
		}
		signature.update(JSON.stringify([path.relative(inputRoot, current), stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].map(String)));
		if (stat.isDirectory()) {
			// One directory at a time; no whole-library list or document buffers.
			const names = (await fs.readdir(current)).sort();
			for (const name of names) await visit(path.join(current, name));
		}
	};
	await visit(resources ? inputRoot : source);
	return {path: source, inputRoot, inputName: directory ? "" : path.basename(source), extension,
		directory, size: info.isFile() ? info.size : undefined, signature: signature.digest("hex")};
}

export async function conversionCacheDirectory(cache: string, coverId: string): Promise<string> {
	if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(coverId)) {
		throw new ConversionError("cache_id", "Invalid coverId");
	}
	const root = await fs.realpath(cache);
	const target = path.join(root, coverId);
	await fs.ensureDir(target);
	if (await fs.realpath(target) !== target) throw new ConversionError("cache_path", "Cache directory is a symlink", true);
	return target;
}
