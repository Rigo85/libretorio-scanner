import { createClient, RedisClientType } from "redis";
import { Logger } from "(src)/helpers/Logger";

const logger = new Logger("Redis Queue");

const redisUrl = process.env.REDIS_URL;

if (!redisUrl) {
	throw new Error("The environment variable 'REDIS_URL' is not defined.");
}

export type ProcessFunction = (path: string) => Promise<void>;

export class RedisQueue {
	private static instance: RedisQueue;
	private redisClient: RedisClientType;
	private readonly queueName: string;
	private readonly processFunction: ProcessFunction;
	private readonly interval: number;
	private processing: boolean;

	private constructor(processFunction: ProcessFunction, queueName: string, interval: number) {
		this.queueName = queueName;
		this.processFunction = processFunction;
		this.interval = interval;
		this.redisClient = createClient({url: redisUrl});
		this.processing = false;

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

	public async addToQueue(path: string) {
		await this.redisClient.lPush(this.queueName, path);
	}

	private async startProcessing(): Promise<void> {
		setInterval(async () => {
			if (!this.processing) {
				const item = await this.redisClient.rPop(this.queueName);
				if (item) {
					this.processing = true;
					try {
						await this.processFunction(item);
					} catch (err) {
						logger.error(`Error processing path="${item}"`, err);
					} finally {
						this.processing = false;
					}
				}
			}
		}, this.interval);
	}
}
