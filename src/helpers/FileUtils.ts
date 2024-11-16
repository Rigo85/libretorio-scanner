import crypto from "crypto";
import path from "path";
import stringSimilarity from "string-similarity";
import fs from "fs-extra";
import * as dotenv from "dotenv";

import { getEbookMeta } from "(src)/services/calibre-info";
import { getBookInfoOpenLibrary } from "(src)/services/book-info";
import { Logger, isTrue } from "(src)/helpers/Logger";
import {
	getFileHashes,
	getScanRootByPath, getSpecialArchives,
	insertFile, removeFileByFileHash,
	removeFileByParentHash, updateScanRoot, updateSpecialArchiveSize
} from "(src)/services/dbService";
import { Scanner } from "(src)/services/Scanner";
import archiver from "archiver";

dotenv.config({path: ".env"});
const logger = new Logger("File Utils");

export enum FileKind {
	/* eslint-disable @typescript-eslint/naming-convention */
	FILE = "FILE",
	COMIC_MANGA = "COMIC-MANGA",
	EPUB = "EPUB",
	AUDIOBOOK = "AUDIOBOOK",
	NONE = "NONE"
	/* eslint-enable @typescript-eslint/naming-convention */
}

export interface File {
	id?: number;
	name: string;
	parentPath: string;
	parentHash: string;
	fileHash: string;
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

export async function scanCompareUpdate(scanRootPath: string) {
	logger.info(`scanCompareUpdate for path: "${scanRootPath}".`);

	try {
		const scanRoot = await getScanRootByPath(scanRootPath);

		if (!scanRoot) {
			logger.error("No scan roots found.");

			return;
		}

		// - en caso de que no exista el cache de los archivos especiales, se actualiza el tamaño y se crea la cache.
		// - puede ocurrir que la tenga que borrar por mantenimiento.
		const specialArchives = await getSpecialArchives(scanRoot.id);
		for (const sa of specialArchives) {
			const cachePath = path.join(__dirname, "..", "public", "cache", sa.coverId);
			const exist = await fs.pathExists(cachePath);
			if (!exist) {
				logger.info(`Special archive cache not found: "${cachePath}".`);
				sa.size = await getSpecialDirectorySize(path.join(sa.parentPath, sa.name), sa.coverId);
				await updateSpecialArchiveSize(sa.id, sa.size);
				logger.info(`Special archive size updated: "${sa.name}" - "${sa.size}".`);
			}
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

		const fileToRemove = hashes.filter((h: { hash: string }) =>
			!scanRootResult.scan.files.find((file: File) => h.hash === file.fileHash));

		// - eliminar los archivos en la db que NO estén en el scan.
		if (fileToRemove.length) {
			const removedFilesCount = await removeFileByFileHash(fileToRemove.map((f: { hash: string }) => f.hash));
			logger.info(`Removed files by file hash: ${removedFilesCount}.`);
		}

		// - los archivos del scan que no estén en la db, se insertan.
		const newFiles = scanRootResult.scan.files.filter((file: File) =>
			!hashes.find((h: { hash: string }) => h.hash === file.fileHash));

		logger.info(`New files: ${newFiles.length}.`);
		logger.info(JSON.stringify(newFiles.map((f: File) => f.name)));

		let count = 1;
		for (const file of newFiles) {
			logger.info(`Updating book details info ${count++}/${newFiles.length}: "${path.join(file.parentPath, file.name)}"`);

			const _file = await fillFileDetails(file);
			// actualizar peso de los archivos especiales.
			if (_file.fileKind !== FileKind.FILE && _file.fileKind !== FileKind.NONE) {
				logger.info(`Getting special directory size: "${path.join(_file.parentPath, _file.name)}"`);
				_file.size = await getSpecialDirectorySize(path.join(_file.parentPath, _file.name), _file.coverId);
				logger.info(`Special directory size: "${_file.size}"`);
			}
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

		if (isTrue(process.env.CAN_USE_OPENLIBRARY_API)) {
			const bookInfo = await getBookInfoOpenLibrary(similarity >= 0.5 ? _title : filename);
			if (bookInfo) {
				file.webDetails = JSON.stringify(bookInfo);
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

async function getSpecialDirectorySize(directoryPath: string, id: string): Promise<string> {
	try {
		const cachePath = path.join(__dirname, "..", "public", "cache", id);
		await fs.mkdir(cachePath, {recursive: true});

		return new Promise((resolve, reject) => {
			const outputFileName = path.join(cachePath, `${id}.zip`);
			const output = fs.createWriteStream(outputFileName);
			const archive = archiver("zip", {
				zlib: {level: 9} // Nivel de compresión
			});

			output.on("close", () => {
				resolve(humanFileSize(archive.pointer(), true)); // Devuelve el tamaño del archivo ZIP en bytes
			});

			archive.on("error", (err) => {
				reject(err); // Rechaza la promesa en caso de error
			});

			archive.pipe(output);
			archive.directory(directoryPath, false);
			archive.finalize();
		});
	} catch (error) {
		logger.error("getSpecialDirectorySize - Error reading directory:", error);

		return "0";
	}
}
