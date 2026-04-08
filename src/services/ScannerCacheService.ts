import { Logger } from "(src)/helpers/Logger";
import { RedisCacheService } from "(src)/services/RedisCacheService";
import { randomUUID } from "crypto";

const logger = new Logger("ScannerCache Service");

const HEARTBEAT_KEY = "scannerHeartbeat";
const HEARTBEAT_INTERVAL_MS = 60_000;  // renew every 60 s
const HEARTBEAT_TTL_S = 120;           // key lives 2× interval; dies if process crashes
const STATE_KEY = "scannerCache";

type ScannerCacheState = {
	isRunning: boolean;
	lastScan: string;
	startedAt: string;
};

export class ScannerCacheService {
	private static instance: ScannerCacheService;
	private heartbeatTimer?: NodeJS.Timeout;
	private leaseToken?: string;

	private constructor() {
		this.initializeState().catch((error: any) => logger.error("Error initializing scanner cache state:", error));
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
			return !!hb;
		} catch (error) {
			logger.error("isRunning:", error);
			return false;
		}
	}

	public async tryAcquireLease(): Promise<boolean> {
		try {
			const leaseToken = randomUUID();
			const acquired = await RedisCacheService.getInstance().setIfNotExists(HEARTBEAT_KEY, leaseToken, HEARTBEAT_TTL_S);
			if (!acquired) {
				return false;
			}

			this.leaseToken = leaseToken;
			await this.setRunning(true);
			await this.renewHeartbeat();

			if (this.heartbeatTimer) {
				clearInterval(this.heartbeatTimer);
			}

			this.heartbeatTimer = setInterval(() => {
				this.renewHeartbeat().catch((err: any) => logger.error("heartbeat renew error:", err));
			}, HEARTBEAT_INTERVAL_MS);

			logger.info("Scanner lease acquired.");
			return true;
		} catch (error) {
			logger.error("tryAcquireLease:", error);
			return false;
		}
	}

	public async releaseLease(): Promise<void> {
		try {
			if (this.heartbeatTimer) {
				clearInterval(this.heartbeatTimer);
				this.heartbeatTimer = undefined;
			}

			const leaseToken = this.leaseToken;
			this.leaseToken = undefined;
			if (!leaseToken) {
				return;
			}

			const released = await RedisCacheService.getInstance().compareAndDelete(HEARTBEAT_KEY, leaseToken);
			if (released) {
				await this.setRunning(false);
				logger.info("Scanner lease released.");
				return;
			}

			const currentLease = await RedisCacheService.getInstance().get(HEARTBEAT_KEY);
			if (!currentLease) {
				await this.setRunning(false);
				logger.info("Scanner lease expired before release; marked scanner as stopped.");
				return;
			}

			logger.info("Scanner lease ownership changed before release; leaving scanner state unchanged.");
		} catch (error) {
			logger.error("releaseLease:", error);
		}
	}

	public async shutdown(): Promise<void> {
		await this.releaseLease();
	}

	public async setRunning(isRunning: boolean): Promise<void> {
		try {
			if (isRunning) {
				const cache = await this.readState();
				await this.writeState({
					isRunning,
					lastScan: cache.lastScan,
					startedAt: new Date().toISOString()
				});
				logger.info("ScannerCache is running.");
			} else {
				const cache = await this.readState();
				await this.writeState({
					isRunning,
					lastScan: cache.startedAt,
					startedAt: "<not started>"
				});
				logger.info("ScannerCache is stopped.");
			}
		} catch (error) {
			logger.error("setRunning:", error);
		}
	}

	private async initializeState(): Promise<void> {
		const cache = await this.readState();
		const heartbeat = await RedisCacheService.getInstance().get(HEARTBEAT_KEY);

		if (cache.isRunning && !heartbeat) {
			logger.info(`ScannerCache stale running state detected since "${cache.startedAt}". Clearing it.`);
			await this.writeState({
				isRunning: false,
				lastScan: cache.startedAt,
				startedAt: "<not started>"
			});
			logger.info(`ScannerCache last scan was at "${cache.startedAt}".`);
			return;
		}

		if (cache.isRunning) {
			logger.info(`ScannerCache is running since "${cache.startedAt}".`);
		} else {
			logger.info(`ScannerCache last scan was at "${cache.lastScan}".`);
		}
	}

	private async renewHeartbeat(): Promise<void> {
		const leaseToken = this.leaseToken;
		if (!leaseToken) {
			return;
		}

		const renewed = await RedisCacheService.getInstance().compareAndExpire(HEARTBEAT_KEY, leaseToken, HEARTBEAT_TTL_S);
		if (!renewed) {
			logger.error("Scanner lease lost before renewal.");
			if (this.heartbeatTimer) {
				clearInterval(this.heartbeatTimer);
				this.heartbeatTimer = undefined;
			}
			this.leaseToken = undefined;

			const currentLease = await RedisCacheService.getInstance().get(HEARTBEAT_KEY);
			if (!currentLease) {
				await this.setRunning(false);
			}
		}
	}

	private async readState(): Promise<ScannerCacheState> {
		const value = await RedisCacheService.getInstance().get(STATE_KEY);
		if (!value) {
			const initialState = {
				isRunning: false,
				lastScan: "<no scan yet>",
				startedAt: "<not started>"
			};

			await this.writeState(initialState);
			logger.info("ScannerCache initialized.");
			return initialState;
		}

		return JSON.parse(value) as ScannerCacheState;
	}

	private async writeState(state: ScannerCacheState): Promise<void> {
		await RedisCacheService.getInstance().set(STATE_KEY, JSON.stringify(state));
	}
}
