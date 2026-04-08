import { ScannerCacheService } from "(src)/services/ScannerCacheService";
import { ScanRootRepository } from "(src)/repositories/ScanRootRepository";
import { Logger } from "(src)/helpers/Logger";
import { ScannerService } from "(src)/services/ScannerService";

const logger = new Logger("Books Service");

export class BooksService {
	private static instance: BooksService;

	private constructor() {
	}

	public static getInstance(): BooksService {
		if (!BooksService.instance) {
			BooksService.instance = new BooksService();
		}

		return BooksService.instance;
	}

	public async cronUpdateBooksInfo() {
		logger.info("Cron updating books info");

		const acquired = await ScannerCacheService.getInstance().tryAcquireLease();
		if (!acquired) {
			logger.info("Scanner is already running.");
			return;
		}

		const dbScanRoots = await ScanRootRepository.getInstance().getScanRoots();
		if (!dbScanRoots.length) {
			await ScannerCacheService.getInstance().releaseLease();
			logger.error("No scan roots found.");
			return;
		}

		try {
			await ScannerService.getInstance().scanCompareUpdate(dbScanRoots[0].path);
			logger.info("Done cron updating books info");
		} catch (error) {
			logger.error("cronUpdateBooksInfo:", error);
		} finally {
			await ScannerCacheService.getInstance().releaseLease();
		}
	}
}
