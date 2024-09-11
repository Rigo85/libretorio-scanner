import path from "path";

import { Logger } from "(src)/helpers/Logger";
import {
	getScanRoots,
	insertFile,
	insertScanRoot,
	ScanRoot
} from "(src)/services/dbService";
import { Scanner, ScanRootResult } from "(src)/services/Scanner";
import { FileWatcher } from "(src)/services/FileWatcher";
import {
	fillFileDetails,
	removeTrailingSeparator, scanCompareUpdate
} from "(src)/helpers/FileUtils";
import { ScannerCache } from "(src)/services/ScannerCache";

const logger = new Logger("Books Store");

const envScanRoot = path.join(__dirname, "..", "public", "books");

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

	public async cronUpdateBooksInfo() {
		logger.info("Cron updating books info");

		try {
			const isRunning = await ScannerCache.getInstance().isRunning();
			if (isRunning) {
				logger.info("Scanner is already running.");
				return;
			}

			await ScannerCache.getInstance().setRunning(true);

			const dbScanRoots = await getScanRoots();

			if (!dbScanRoots.length) {
				logger.error("No scan roots found.");
				return;
			}

			await scanCompareUpdate(dbScanRoots[0].path);

			logger.info("Done cron updating books info");
		} catch (error) {
			logger.error("cronUpdateBooksInfo:", error);
		} finally {
			await ScannerCache.getInstance().setRunning(false);
		}
	}
}


























