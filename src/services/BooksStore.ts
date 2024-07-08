import { Logger } from "(src)/helpers/Logger";
import { getScanRoots, insertFile, insertScanRoot } from "(src)/services/dbService";
import { File, Scanner, ScanRootResult } from "(src)/services/Scanner";
import { getEbookMeta } from "(src)/services/calibre-info";
import { getBookInfoGoogleBooks, getBookInfoOpenLibrary } from "(src)/services/book-info";
import path from "path";
import { FileWatcher } from "(src)/services/FileWatcher";

const logger = new Logger("Books Store");

const envScanRoot = process.env.SCAN_ROOT;

if (!envScanRoot) {
	throw new Error("The environment variable 'SCAN_ROOT' is not defined.");
}

export class BooksStore {
	private static instance: BooksStore;

	private constructor() {
	}

	public static getInstance(): BooksStore {
		if (!BooksStore.instance) {
			BooksStore.instance = new BooksStore();
		}

		return BooksStore.instance;
	}

	private async startBooksInfo(): Promise<number> {
		try {
			const scanRootResult = await Scanner.getInstance().scan(envScanRoot);

			return await this.updateBooksDetailsInfo(scanRootResult);
		} catch (error) {
			logger.error("startBooksInfo:", error);

			return undefined;
		}
	}

	private async updateBooksDetailsInfo(scanRootResult: ScanRootResult): Promise<number> {
		logger.info(`Updating books details info for "${scanRootResult.root}"`);

		const scanRootId = await insertScanRoot(scanRootResult);

		if (!scanRootId) {
			logger.error(`Error inserting scan root for "${scanRootResult.root}"`);
			return undefined;
		}

		let count = 1;
		for (const file of scanRootResult.scan.files) {
			logger.info(`Updating book details info ${count++}/${scanRootResult.scan.files.length}: "${path.join(file.parentPath, file.name)}"`);

			try {
				const meta = await getEbookMeta(path.join(file.parentPath, file.name));

				if (meta) {
					meta.title = (meta.title || "").trim();
					file.localDetails = JSON.stringify(meta);
					if (meta.title && meta.title.trim()) {
						// const bookInfo = await getBookInfoGoogleBooks(meta.title);
						const bookInfo = await getBookInfoOpenLibrary(meta.title);
						if (bookInfo) {
							file.webDetails = JSON.stringify(bookInfo);
						}
					}
				}

				await insertFile(file, scanRootId);
			} catch (error) {
				logger.error(`updateBooksDetailsInfo "${path.join(file.parentPath, file.name)}":`, error);

				return undefined;
			}
		}

		return scanRootId;
	}

	public async updateBooksInfo() {
		logger.info("Updating books info");

		let dbScanRoots = await getScanRoots();
		if (dbScanRoots.length === 0) {
			const id = await this.startBooksInfo();
			if (!id) {
				logger.error(`Error starting books info for "${envScanRoot}"`);
			}
		}

		dbScanRoots = await getScanRoots();
		if (dbScanRoots.length === 0) {
			logger.error("No scan roots found.");
			return;
		}

		for (const dbScanRoot of dbScanRoots) {
			const fileWatcher = new FileWatcher(dbScanRoot.path);

			try {
				await fileWatcher.startWatching();
			} catch (error) {
				logger.error("updateBooksInfo:", error);
			}
			// new FileWatcher(dbScanRoot.path).startWatching()
			// 	.catch(error => {
			// 		logger.error("updateBooksInfo:", error);
			// 	});
		}

		logger.info("Done updating books info");
	}

	// actualizar metadata manualmente.

	// leer

	// descargar

}