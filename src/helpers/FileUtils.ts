import crypto from "crypto";
import path from "path";
import { getEbookMeta } from "(src)/services/calibre-info";
import { getBookInfoOpenLibrary } from "(src)/services/book-info";
import { Logger } from "(src)/helpers/Logger";
import fs from "fs-extra";

const logger = new Logger("File Utils");

export interface File {
	name: string;
	parentPath: string;
	parentHash: string;
	localDetails?: string;
	webDetails?: string;
}

export interface Directory {
	name: string;
	hash: string;
	directories: Directory[];
}

export function generateHash(data: string): string {
	return crypto.createHash("sha256").update(data).digest("hex").slice(0, 16);
}

export async function fillFileDetails(file: File): Promise<File> {
	try {
		const meta = await getEbookMeta(path.join(file.parentPath, file.name));

		if (meta) {
			meta.title = (meta.title || "").trim();
			file.localDetails = JSON.stringify(meta);
			if (meta.title) {
				// const bookInfo = await getBookInfoGoogleBooks(meta.title);
				const bookInfo = await getBookInfoOpenLibrary(meta.title);
				if (bookInfo) {
					file.webDetails = JSON.stringify(bookInfo);
				}
			}
		}
	} catch (error) {
		console.error(`fillFileDetails "${path.join(file.parentPath, file.name)}":`, error.message);
	}

	return file;
}

export function removeTrailingSeparator(uri: string): string {
	if (uri.endsWith(path.sep)) {
		return uri.slice(0, -path.sep.length);
	}
	return uri;
}

export function travelTree(directory: string, tree: string): any {
	const dirs = directory.split(path.sep).filter((dir: string) => dir);
	let dirTree = JSON.parse(tree) as Directory;
	const guardTree = dirTree;
	const trace = [] as string[];

	let tmp: string = "";
	while (dirTree.name !== tmp) {
		tmp = dirs.shift() as string;
		trace.push(tmp);
	}

	logger.info(`dirs: "${JSON.stringify(dirs)}" - trace: "${JSON.stringify(trace)}"`);

	for (const dir of dirs) {
		const tmp = dirTree.directories.find((d: Directory) => d.name === dir);
		if (!tmp) {
			throw new Error(`Directory not found: "${dir}" on "${trace.join(path.sep)}"`);
		}
		dirTree = tmp;
	}

	return {guardTree, dirTree, trace};
}

export function updateTree(tree: Directory, directory: string, newFile: string): string[] {
	const oldHashes = [] as string[];

	oldHashes.push(tree.hash);
	tree.hash = generateHash(path.join(directory, newFile));
	tree.name = newFile;

	function updateDir(tree: Directory, newPath: string, oldHashes: string[]) {
		oldHashes.push(tree.hash);
		tree.hash = generateHash(path.join(newPath, tree.name));
		for (const dir of tree.directories) {
			updateDir(dir, path.join(newPath, tree.name), oldHashes);
		}
	}

	for (const dir of tree.directories) {
		updateDir(dir, path.join(directory, newFile), oldHashes);
	}

	return oldHashes;
}

export function getHashes(tree: Directory) {
	const hashes = [] as string[];

	function getDirHashes(tree: Directory) {
		hashes.push(tree.hash);
		for (const dir of tree.directories) {
			getDirHashes(dir);
		}
	}

	getDirHashes(tree);

	return hashes;
}

async function pathExists(path: string): Promise<boolean> {
	try {
		await fs.access(path);
		return true;
	} catch (error) {
		if (error.code === "ENOENT") {
			return false;
		} else {
			throw error;
		}
	}
}
