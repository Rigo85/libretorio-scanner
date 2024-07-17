import path from "path";

import { Logger } from "(src)/helpers/Logger";
import { getFiles, getScanRoots, insertFile, insertScanRoot, ScanRoot } from "(src)/services/dbService";
import { Scanner, ScanResult, ScanRootResult } from "(src)/services/Scanner";
import { FileWatcher } from "(src)/services/FileWatcher";
import { Directory, fillFileDetails, removeTrailingSeparator, File } from "(src)/helpers/FileUtils";

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

	private async startBooksInfo(): Promise<ScanRoot> {
		try {
			const scanRootResult = await Scanner.getInstance().scan(removeTrailingSeparator(envScanRoot));

			return await this.updateBooksDetailsInfo(scanRootResult);
		} catch (error) {
			logger.error("startBooksInfo:", error);

			return undefined;
		}
	}

	private async updateBooksDetailsInfo(scanRootResult: ScanRootResult): Promise<ScanRoot> {
		logger.info(`Updating books details info for "${scanRootResult.root}"`);

		const scanRoot = await insertScanRoot(scanRootResult);

		if (!scanRoot) {
			logger.error(`Error inserting scan root for "${scanRootResult.root}"`);

			return undefined;
		}

		let count = 1;
		for (const file of scanRootResult.scan.files) {
			logger.info(`Updating book details info ${count++}/${scanRootResult.scan.files.length}: "${path.join(file.parentPath, file.name)}"`);

			try {
				const _file = await fillFileDetails(file);
				await insertFile(_file, scanRoot.id);
			} catch (error) {
				logger.error(`updateBooksDetailsInfo "${path.join(file.parentPath, file.name)}":`, error);

				return undefined;
			}
		}

		return scanRoot;
	}

	public async updateBooksInfo() {
		logger.info("Updating books info");

		let dbScanRoots = await getScanRoots();

		if (!dbScanRoots.length) {
			const scanRoot = await this.startBooksInfo();
			if (!scanRoot) {
				logger.error(`Error starting books info for "${envScanRoot}"`);

				return;
			}

			dbScanRoots = [scanRoot];
		}

		for (const dbScanRoot of dbScanRoots) {
			const fileWatcher = new FileWatcher(dbScanRoot);

			try {
				await fileWatcher.startWatching();
			} catch (error) {
				logger.error("updateBooksInfo:", error);
			}
		}

		logger.info("Done updating books info");
	}

	public async getBooksList(parentHash?: string): Promise<ScanResult> {
		logger.info("getBooksList:", parentHash ?? "root");

		try {
			const scanRoots = await getScanRoots();

			if (!scanRoots?.length) {
				logger.error("getBooksList", "No scan roots found");
				return undefined;
			}

			const directories = JSON.parse(scanRoots[0].directories) as Directory;
			const files = await getFiles(parentHash ?? directories.hash);

			return {directories, files};
		} catch (error) {
			logger.error("getBooksList", error);

			return undefined;
		}
	}

	// actualizar metadata manualmente.

	// leer

	// descargar

}