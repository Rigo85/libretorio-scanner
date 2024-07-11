import { createClient, RedisClientType } from "redis";
import { Logger } from "(src)/helpers/Logger";
import { FileChangeEvent } from "nsfw";

const logger = new Logger("Redis Queue");

const redisUrl = process.env.REDIS_URL;

if (!redisUrl) {
	throw new Error("The environment variable 'REDIS_URL' is not defined.");
}

export type ProcessFunction = (event: { fileChangeEvent: FileChangeEvent; scanRootId: number }) => Promise<void>;

export class RedisQueue {
	private static instance: RedisQueue;
	private redisClient: RedisClientType;
	private readonly queueName: string;
	private readonly processFunction: (item: any) => Promise<void>;
	private readonly interval: number;

	private constructor(processFunction: ProcessFunction, queueName: string = "FileWatcherQueue", interval: number = 1000) {
		this.queueName = queueName;
		this.processFunction = processFunction;
		this.interval = interval;
		this.redisClient = createClient({url: redisUrl});

		this.redisClient.on("error", (err: any) => logger.error("Redis Client Error:", err));
		this.redisClient.connect().then(() => {
			logger.info("Connected to Redis.");
			this.startProcessing().catch((err: any) => logger.error("Error starting processing:", err));
		});
	}

	public static getInstance(processFunction: ProcessFunction, queueName: string = "FileWatcherQueue", interval: number = 1000): RedisQueue {
		if (!RedisQueue.instance) {
			RedisQueue.instance = new RedisQueue(processFunction, queueName, interval);
		}
		return RedisQueue.instance;
	}

	public async addToQueue(fileChangeEvent: FileChangeEvent, scanRootId: number): Promise<void> {
		await this.redisClient.lPush(this.queueName, JSON.stringify({fileChangeEvent, scanRootId}));
	}

	private async startProcessing(): Promise<void> {
		setInterval(async () => {
			const item = await this.redisClient.rPop(this.queueName);
			if (item) {
				try {
					await this.processFunction(JSON.parse(item));
				} catch (err) {
					logger.error("Error processing item:", err);
				}
			}
		}, this.interval);
	}
}
