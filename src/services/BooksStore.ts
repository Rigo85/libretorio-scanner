import path from "path";

import { Logger } from "(src)/helpers/Logger";
import {
	getScanRoots
} from "(src)/services/dbService";
import {
	scanCompareUpdate
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

	public async cronUpdateBooksInfo() {
		logger.info("Cron updating books info");

		const isRunning = await ScannerCache.getInstance().isRunning();
		if (isRunning) {
			logger.info("Scanner is already running.");
			return;
		}

		const dbScanRoots = await getScanRoots();
		if (!dbScanRoots.length) {
			logger.error("No scan roots found.");
			return;
		}

		await ScannerCache.getInstance().setRunning(true);

		try {
			await scanCompareUpdate(dbScanRoots[0].path);
			logger.info("Done cron updating books info");
		} catch (error) {
			logger.error("cronUpdateBooksInfo:", error);
		} finally {
			await ScannerCache.getInstance().setRunning(false);
		}
	}
}


























