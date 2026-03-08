import { Logger } from "(src)/helpers/Logger";
import { RedisCacheService } from "(src)/services/RedisCacheService";

const logger = new Logger("ScannerCache Service");

const HEARTBEAT_KEY = "scannerHeartbeat";
const HEARTBEAT_INTERVAL_MS = 60_000;  // renew every 60 s
const HEARTBEAT_TTL_S = 120;           // key lives 2× interval; dies if process crashes

export class ScannerCacheService {
	private static instance: ScannerCacheService;
	private heartbeatTimer?: NodeJS.Timeout;

	private constructor() {
		RedisCacheService.getInstance()
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
					RedisCacheService.getInstance()
						.set("scannerCache", JSON.stringify({
							isRunning: false,
							lastScan: "<no scan yet>",
							startedAt: "<not started>"
						}))
						.then(() => logger.info("ScannerCache initialized."))
						.catch((error: any) => logger.error("Error setting scannerCache:", error))
					;
				}
			})
			.catch(error => logger.error("Error getting scannerCache:", error))
		;
	}

	public static getInstance(): ScannerCacheService {
		if (!ScannerCacheService.instance) {
			ScannerCacheService.instance = new ScannerCacheService();
		}
		return ScannerCacheService.instance;
	}

	public async isRunning(): Promise<boolean> {
		try {
			const hb = await RedisCacheService.getInstance().get(HEARTBEAT_KEY);
			return hb !== null && hb !== undefined;
		} catch (error) {
			logger.error("isRunning:", error);
			return false;
		}
	}

	public async startHeartbeat(): Promise<void> {
		await this.writeHeartbeat();
		this.heartbeatTimer = setInterval(() => {
			this.writeHeartbeat().catch((err: any) => logger.error("heartbeat write error:", err));
		}, HEARTBEAT_INTERVAL_MS);
	}

	public async stopHeartbeat(): Promise<void> {
		if (this.heartbeatTimer) {
			clearInterval(this.heartbeatTimer);
			this.heartbeatTimer = undefined;
		}
		await RedisCacheService.getInstance().del(HEARTBEAT_KEY);
	}

	private async writeHeartbeat(): Promise<void> {
		await RedisCacheService.getInstance().set(HEARTBEAT_KEY, new Date().toISOString(), HEARTBEAT_TTL_S);
	}

	public async setRunning(isRunning: boolean): Promise<void> {
		try {
			const cacheStr = await RedisCacheService.getInstance().get("scannerCache");
			const cache = cacheStr ?
				JSON.parse(cacheStr) as { isRunning: boolean; lastScan: string; startedAt: string } :
				{isRunning: false, lastScan: "<no scan yet>", startedAt: "<not started>"}
			;

			if (isRunning) {
				await RedisCacheService.getInstance()
					.set("scannerCache", JSON.stringify({
						isRunning,
						lastScan: cache.lastScan,
						startedAt: new Date().toISOString()
					}))
					.catch((error: any) => logger.error("Error setting scannerCache:", error))
				;
				logger.info("ScannerCache is running.");
			} else {
				await RedisCacheService.getInstance()
					.set("scannerCache", JSON.stringify({
						isRunning,
						lastScan: cache.startedAt,
						startedAt: "<not started>"
					}))
					.catch((error: any) => logger.error("Error setting scannerCache:", error))
				;
				logger.info("ScannerCache is stopped.");
			}
		} catch (error) {
			logger.error("setRunning:", error);
		}
	}
}
