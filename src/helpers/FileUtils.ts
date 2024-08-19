import crypto from "crypto";
import path from "path";
import stringSimilarity from "string-similarity";
import fs from "fs";

import { getEbookMeta } from "(src)/services/calibre-info";
import { getBookInfoOpenLibrary } from "(src)/services/book-info";
import { Logger } from "(src)/helpers/Logger";
import {
	getFileHashes,
	getScanRootByPath,
	insertFile, removeFileByFileHash,
	removeFileByParentHash, updateScanRoot
} from "(src)/services/dbService";
import { Scanner } from "(src)/services/Scanner";

const logger = new Logger("File Utils");

export enum FileKind {
	/* eslint-disable @typescript-eslint/naming-convention */
	FILE = "FILE",
	COMIC_MANGA = "COMIC-MANGA",
	EPUB = "EPUB",
	NONE = "NONE"
	/* eslint-enable @typescript-eslint/naming-convention */
}


export interface File {
	id?: number;
	name: string;
	parentPath: string;
	parentHash: string;
	size: string;
	coverId: string;
	localDetails?: string;
	webDetails?: string;
	customDetails?: boolean;
	fileKind: FileKind;
}

export interface Directory {
	name: string;
	hash: string;
	directories: Directory[];
}

export interface DecompressResponse {
	success: "OK" | "ERROR";
	error?: string;
	pages?: DecompressPages;
}

export interface DecompressPages {
	pages: any[];
	pageIndex: number;
	currentPagesLength: number;
	totalPages: number;
	index: number;
}

export interface ConvertToPdfResponse {
	success: "OK" | "ERROR";
	error?: string;
	pdfPath?: string;
}

export type ConventToPdfUtilFunction = (filePath: string, coverId: string) => Promise<void>;

export async function scanCompareUpdate(scanRootPath: string) {
	logger.info(`scanCompareUpdate for path: "${scanRootPath}".`);

	try {
		const scanRoot = await getScanRootByPath(scanRootPath);

		if (!scanRoot) {
			logger.error("No scan roots found.");

			return;
		}

		// - escanear el directorio observado.
		const scanRootResult = await Scanner.getInstance().scan(removeTrailingSeparator(scanRootPath));

		// - obtener los hashes de los directorios.
		const hash = getHashes(scanRootResult.scan.directories);

		// - eliminar los archivos en la db que NO tengan un parentHash dentro de los hashes obtenidos.
		const removedFilesCount = await removeFileByParentHash(hash);
		logger.info(`Removed files by parent hash: ${removedFilesCount}.`);

		// - obtener los archivos de la db.
		const hashes = await getFileHashes(scanRoot.id);

		const fileToRemove = hashes.filter((h: { hash: string }) => {
			return !scanRootResult.scan.files.find((file: File) => {
				return h.hash === generateHash(path.join(file.parentPath, file.name), true);
			});
		});

		// - eliminar los archivos en la db que NO estén en el scan.
		if (fileToRemove.length) {
			const removedFilesCount = await removeFileByFileHash(fileToRemove.map((f: { hash: string }) => f.hash));
			logger.info(`Removed files by file hash: ${removedFilesCount}.`);
		}

		// - los archivos del scan que no estén en la db, se insertan.
		const newFiles = scanRootResult.scan.files.filter((file: File) => {
			return !hashes.find((h: { hash: string }) => {
				return h.hash === generateHash(path.join(file.parentPath, file.name), true);
			});
		});

		logger.info(`New files: ${newFiles.length}.`);
		logger.info(JSON.stringify(newFiles.map((f: File) => f.name)));

		for (const file of newFiles) {
			const _file = await fillFileDetails(file);
			await insertFile(_file, scanRoot.id);
		}

		await updateScanRoot(JSON.stringify(scanRootResult.scan.directories), scanRoot.id);
	} catch (error) {
		logger.error(`scanCompareUpdate "${scanRootPath}":`, error.message);
	}
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

export async function fillFileDetails(file: File): Promise<File> {
	try {
		const meta = await getEbookMeta(path.join(file.parentPath, file.name), file.coverId);

		const filename = cleanFilename(file.name);
		let _title = "";
		if (meta) {
			meta.title = (meta.title || "").trim();
			file.localDetails = JSON.stringify(meta);
			if (meta.title) {
				_title = cleanTitle(meta.title);
			}
		}

		const similarity = stringSimilarity.compareTwoStrings(filename, _title);

		const bookInfo = await getBookInfoOpenLibrary(similarity >= 0.5 ? _title : filename);
		if (bookInfo) {
			file.webDetails = JSON.stringify(bookInfo);
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

function cleanFilename(filename: string): string {
	return filename
		.replace(/\.[^/.]+$/, "")
		.replace(/[^a-zA-ZñÑáéíóúÁÉÍÓÚ0-9 ]/g, " ")
		.replace(/\s+/g, " ")
		.toLowerCase();
}

function cleanTitle(title: string): string {
	return title
		.replace(/[^a-zA-ZñÑáéíóúÁÉÍÓÚ0-9 ]/g, " ")
		.replace(/\s+/g, " ")
		.toLowerCase();
}

export function checkIfPathExistsAndIsFile(filePath: string): boolean {
	if (fs.existsSync(filePath)) {
		return fs.statSync(filePath).isFile();
	}
	return false;
}
