import nsfw, { ActionType, FileChangeEvent, NSFW } from "nsfw";
import { v4 as uuidv4 } from "uuid";
import { Logger } from "(src)/helpers/Logger";
import { RedisQueue } from "(src)/services/RedisQueue";
import { ScanRoot } from "(src)/services/dbService";

const logger = new Logger("File Watcher");

export class FileWatcher {
	private watcher: NSFW;
	private readonly uuid: string;
	private redisQueue: RedisQueue;
	private processFunction = () => Promise.resolve();

	constructor(private scanRoot: ScanRoot) {
		this.uuid = uuidv4();
		this.eventHandler = this.eventHandler.bind(this);
		this.redisQueue = RedisQueue.getInstance(this.processFunction);
		logger.info(`FileWatcher "${this.uuid}" created`);
	}

	private async eventHandler(events: FileChangeEvent[]) {
		for (const event of events) {
			if ([ActionType.CREATED, ActionType.DELETED, ActionType.RENAMED].includes(event.action)) {
				await this.redisQueue.addToQueue(event, this.scanRoot.id);
			}
		}
	};

	public async startWatching() {
		this.watcher = await nsfw(this.scanRoot.path, this.eventHandler, {
			debounceMS: 200, // Retardo de rebote en milisegundos
			errorCallback: error => logger.error(`starWatching(${this.uuid}): ${error}.`)
		});

		await this.watcher.start();
		logger.info(`FileWatcher(${this.uuid}) monitoring changes in ${this.scanRoot.path}.`);
	}

	public async stopWatching() {
		if (this.watcher) {
			await this.watcher.stop();
			logger.info(`FileWatcher(${this.uuid}) monitoring stopped.`);
		}
	}
}