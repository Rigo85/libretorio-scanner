import { RedisCache } from "(src)/services/RedisCache";
import { Logger } from "(src)/helpers/Logger";

const logger = new Logger("Scanner Cache");

export class ScannerCache {
	private static instance: ScannerCache;

	private constructor() {
		RedisCache.getInstance()
			.get("scannerCache")
			.then((value: string) => {
				if (value) {
					const cache = JSON.parse(value) as { isRunning: boolean; lastScan: string; startedAt: string };
					if (cache.isRunning) {
						logger.info(`ScannerCache is running since "${cache.startedAt}".`);
					} else {
						logger.info(`ScannerCache last scan was at "${cache.lastScan}".`);
					}
				} else {
					RedisCache.getInstance()
						.set("scannerCache", JSON.stringify({
							isRunning: false,
							lastScan: "<no scan yet>",
							startedAt: "<not started>"
						}))
						.then(() => logger.info("ScannerCache initialized."))
						.catch(error => logger.error("Error setting scannerCache:", error))
					;
				}
			})
			.catch(error => logger.error("Error getting scannerCache:", error))
		;
	}

	public static getInstance(): ScannerCache {
		if (!ScannerCache.instance) {
			ScannerCache.instance = new ScannerCache();
		}

		return ScannerCache.instance;
	}

	public async isRunning(): Promise<boolean> {
		try {
			const value = await RedisCache.getInstance().get("scannerCache");
			if (value) {
				const cache = JSON.parse(value) as { isRunning: boolean; lastScan: string; startedAt: string };
				return cache.isRunning;
			}
			return false;
		} catch (error) {
			logger.error("isRunning:", error);

			return false;
		}
	}

	public async setRunning(isRunning: boolean): Promise<void> {
		try {
			const cacheStr = await RedisCache.getInstance().get("scannerCache");
			const cache = cacheStr ?
				JSON.parse(cacheStr) as { isRunning: boolean; lastScan: string; startedAt: string } :
				{isRunning: false, lastScan: "<no scan yet>", startedAt: "<not started>"}
			;

			if (isRunning) {
				await RedisCache.getInstance()
					.set("scannerCache", JSON.stringify({
						isRunning,
						lastScan: cache.lastScan,
						startedAt: new Date().toISOString()
					}))
					.catch(error => logger.error("Error setting scannerCache:", error))
				;
				logger.info("ScannerCache is running.");
			} else {
				await RedisCache.getInstance()
					.set("scannerCache", JSON.stringify({
						isRunning,
						lastScan: cache.startedAt,
						startedAt: "<not started>"
					}))
					.catch(error => logger.error("Error setting scannerCache:", error))
				;
				logger.info("ScannerCache is stopped.");
			}
		} catch (error) {
			logger.error("setRunning:", error);
		}
	}
}