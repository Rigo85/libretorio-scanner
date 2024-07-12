import crypto from "crypto";
import path from "path";

import { getEbookMeta } from "(src)/services/calibre-info";
import { getBookInfoOpenLibrary } from "(src)/services/book-info";
import { Logger } from "(src)/helpers/Logger";
import {
	getFileHashes,
	getScanRootByPath,
	insertFile,
	removeFile, updateScanRoot
} from "(src)/services/dbService";
import { Scanner } from "(src)/services/Scanner";

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
		const removedFilesCount = await removeFile(hash);
		logger.info(`Removed files: ${removedFilesCount}.`);

		// - obtener los archivos de la db.
		const hashes = await getFileHashes(scanRoot.id);

		// - los archivos del scan que no estén en la db, se insertan.
		const newFiles = scanRootResult.scan.files.filter((file: File) => {
			return !hashes.find((h: { hash: string }) => {
				return h.hash === generateHash(path.join(file.parentPath, file.name), true);
			});
		});

		logger.info(`New files: ${newFiles.length}.`);

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
