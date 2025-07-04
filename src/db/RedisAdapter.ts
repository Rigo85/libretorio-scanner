import { createClient, RedisClientType } from "redis";

import { Logger } from "(src)/helpers/Logger";
import { config } from "(src)/config/configuration";

const logger = new Logger("Redis Adapter");

class RedisAdapter {
	private static instance?: RedisAdapter = undefined;
	private client?: RedisClientType = undefined;
	private initPromise?: Promise<RedisClientType> = undefined;

	private constructor() {}

	public static getInstance(): RedisAdapter {
		if (!RedisAdapter.instance) {
			RedisAdapter.instance = new RedisAdapter();
		}
		return RedisAdapter.instance;
	}

	public initialize(): Promise<RedisClientType> {
		if (this.initPromise) {
			return this.initPromise;
		}

		this.initPromise = new Promise<RedisClientType>((resolve, reject) => {
			try {
				this.client = createClient({
					url: config.production.db.redisUrl,
				});

				this.client.on("error", (err: any) => {
					logger.error("Redis connection error:", err);
					reject(err);
				});

				this.client.on("connect", () => {
					logger.info("Redis connection established");
				});

				this.client.on("reconnect", () => {
					logger.info("Reconnecting to Redis...");
				});

				this.client.connect().then(() => {
					logger.info("Redis client connected successfully");
					resolve(this.client!);
				}).catch((err: any) => {
					logger.error("Error connecting to Redis:", err);
					this.client = undefined;
					this.initPromise = undefined;
					reject(err);
				});
			} catch (err) {
				logger.error("Error creating Redis client:", err);
				this.client = undefined;
				this.initPromise = undefined;
				reject(err);
			}
		});

		return this.initPromise;
	}

	public getClient(): RedisClientType | undefined {
		return this.client;
	}

	public async disconnect(): Promise<void> {
		if (this.client) {
			await this.client.quit();
			this.client = undefined;
			this.initPromise = undefined;
			logger.info("Redis connection closed");
		}
	}
}

export default RedisAdapter.getInstance();