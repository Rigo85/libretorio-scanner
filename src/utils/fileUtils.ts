import crypto from "crypto";
import path from "path";
import fs from "fs-extra";

import { Directory } from "(src)/models/interfaces/Directory";

export function checkIfPathExistsAndIsFile(filePath: string): boolean {
	if (fs.existsSync(filePath)) {
		return fs.statSync(filePath).isFile();
	}
	return false;
}

export function generateHash(data: string, full?: boolean): string {
	let hash: string;

	if (full) {
		hash = crypto.createHash("sha256").update(data).digest("hex");
	} else {
		hash = crypto.createHash("sha256").update(data).digest("hex").slice(0, 16);
	}

	return hash;
}

export function removeTrailingSeparator(uri: string): string {
	if (uri.endsWith(path.sep)) {
		return uri.slice(0, -path.sep.length);
	}
	return uri;
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

export function humanFileSize(bytes: number, si: boolean = false, dp: number = 1): string {
	const thresh = si ? 1000 : 1024;

	if (Math.abs(bytes) < thresh) {
		return bytes + " B";
	}

	const units = si
		? ["kB", "MB", "GB", "TB", "PB", "EB", "ZB", "YB"]
		: ["KiB", "MiB", "GiB", "TiB", "PiB", "EiB", "ZiB", "YiB"];
	let u = -1;
	const r = 10 ** dp;

	do {
		bytes /= thresh;
		++u;
	} while (Math.round(Math.abs(bytes) * r) / r >= thresh && u < units.length - 1);

	return `${bytes.toFixed(dp)} ${units[u]}`;
}

export function cleanFilename(filename: string): string {
	return filename
		.replace(/\.[^/.]+$/, "")
		.replace(/[^a-zA-ZñÑáéíóúÁÉÍÓÚ0-9 ]/g, " ")
		.replace(/\s+/g, " ")
		.toLowerCase();
}

export function cleanTitle(title: string): string {
	return title
		.replace(/[^a-zA-ZñÑáéíóúÁÉÍÓÚ0-9 ]/g, " ")
		.replace(/\s+/g, " ")
		.toLowerCase();
}
