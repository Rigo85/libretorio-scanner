import { createClient, RedisClientType } from "redis";
import { Logger } from "(src)/helpers/Logger";

const logger = new Logger("Redis Cache");

const redisUrl = process.env.REDIS_URL;

if (!redisUrl) {
	throw new Error("The environment variable 'REDIS_URL' is not defined.");
}

export class RedisCache {
	private static instance: RedisCache;
	private redisClient: RedisClientType;

	private constructor() {
		this.redisClient = createClient({url: redisUrl});
		this.redisClient.on("error", (err: any) => logger.error("Redis Client Error:", err));
		this.redisClient.connect().then(() => {
			logger.info("Connected to Redis.");
		});
	}

	public static getInstance(): RedisCache {
		if (!RedisCache.instance) {
			RedisCache.instance = new RedisCache();
		}

		return RedisCache.instance;
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
