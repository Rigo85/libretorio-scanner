import { Logger } from "(src)/helpers/Logger";
import { RedisClientType } from "redis";
import RedisAdapter from "(src)/db/RedisAdapter";

const logger = new Logger("Redis Cache Service");

export class RedisCacheService {
	private static instance: RedisCacheService;
	private redisClient?: RedisClientType = undefined;
	private initPromise: Promise<void>;

	private constructor() {
		this.initPromise = this.initialize();
	}

	private async initialize(): Promise<void> {
		try {
			this.redisClient = await RedisAdapter.initialize();
			logger.info("Connected to Redis.");
		} catch (error) {
			logger.error("Error connecting to Redis:", error);
			throw error;
		}
	}

	public static getInstance(): RedisCacheService {
		if (!RedisCacheService.instance) {
			RedisCacheService.instance = new RedisCacheService();
		}
		return RedisCacheService.instance;
	}

	public async set(key: string, value: string, expirationInSeconds?: number): Promise<void> {
		await this.initPromise;

		if (expirationInSeconds) {
			// eslint-disable-next-line @typescript-eslint/naming-convention
			await this.redisClient.set(key, value, {EX: expirationInSeconds});
		} else {
			await this.redisClient.set(key, value);
		}
	}

	public async get(key: string): Promise<string> {
		await this.initPromise;
		return await this.redisClient.get(key);
	}
}
