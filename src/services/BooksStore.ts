import { Logger } from "(src)/helpers/Logger";
import { getScanRoots, insertFile, insertScanRoot } from "(src)/services/dbService";
import { Scanner, ScanRootResult } from "(src)/services/Scanner";
import path from "path";
import { FileWatcher } from "(src)/services/FileWatcher";
import { RedisQueue } from "(src)/services/RedisQueue";
import { fileWatcherConsumer } from "(src)/services/FileWatcherConsumer";
import { fillFileDetails, removeTrailingSeparator } from "(src)/helpers/FileUtils";

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
			const scanRootResult = await Scanner.getInstance().scan(removeTrailingSeparator(envScanRoot));

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
				const _file = await fillFileDetails(file);
				await insertFile(_file, scanRootId);
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

		RedisQueue.getInstance(fileWatcherConsumer);

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

	// actualizar metadata manualmente.

	// leer

	// descargar

}