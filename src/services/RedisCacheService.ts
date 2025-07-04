import { Logger } from "(src)/helpers/Logger";
import { RedisClientType } from "redis";
import RedisAdapter from "(src)/db/RedisAdapter";

const logger = new Logger("Redis Cache Service");

export class RedisCacheService {
	private static instance: RedisCacheService;
	private redisClient: RedisClientType;

	private constructor() {
		RedisAdapter.initialize().then((client: RedisClientType) => {
			this.redisClient = client;
			logger.info("Connected to Redis.");
		});
	}

	public static getInstance(): RedisCacheService {
		if (!RedisCacheService.instance) {
			RedisCacheService.instance = new RedisCacheService();
		}
		return RedisCacheService.instance;
	}

	public async set(key: string, value: string, expirationInSeconds?: number): Promise<void> {
		if (expirationInSeconds) {
			// eslint-disable-next-line @typescript-eslint/naming-convention
			await this.redisClient.set(key, value, {EX: expirationInSeconds});
		} else {
			await this.redisClient.set(key, value);
		}
	}

	public async get(key: string): Promise<string> {
		return await this.redisClient.get(key);
	}
}
