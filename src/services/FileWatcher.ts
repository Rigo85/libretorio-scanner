import { v4 as uuidv4 } from "uuid";
import chokidar, { FSWatcher } from "chokidar";

import { Logger } from "(src)/helpers/Logger";
import { ScanRoot } from "(src)/services/dbService";
import { RedisQueue } from "(src)/services/RedisQueue";
import { scanCompareUpdate } from "(src)/helpers/FileUtils";

const logger = new Logger("File Watcher");

const eventDelay = parseInt(process.env.EVENT_DELAY || "1000");

export class FileWatcher {
	private watcher: FSWatcher;
	private readonly uuid: string;
	private eventTimeout: NodeJS.Timeout;
	private queue: RedisQueue;
	// eslint-disable-next-line @typescript-eslint/naming-convention
	private readonly EVENT_DELAY = eventDelay;

	constructor(private scanRoot: ScanRoot) {
		this.uuid = uuidv4();

		this.handleEventsEnd = this.handleEventsEnd.bind(this);
		this.startWatching = this.startWatching.bind(this);
		this.queue = RedisQueue.getInstance(scanCompareUpdate);

		this.watcher = chokidar.watch(this.scanRoot.path, {
			persistent: true,
			ignoreInitial: true
		});
		logger.info(`FileWatcher "${this.uuid}" created.`);
	}

	private handleEventsEnd() {
		this.queue.addToQueue(this.scanRoot.path).catch(error => logger.error("Error adding to queue:", error));
	}

	public async startWatching() {
		this.watcher
			.on("all", (event: "add" | "addDir" | "change" | "unlink" | "unlinkDir", path: string) => {
				if (event !== "change") {
					logger.info(`"${event}" detected on "${path}".`);

					if (this.eventTimeout) {
						clearTimeout(this.eventTimeout);
					}

					this.eventTimeout = setTimeout(this.handleEventsEnd, this.EVENT_DELAY);
				}
			})
			.on("ready", () => logger.info(`FileWatcher(${this.uuid}) is ready monitoring changes in "${this.scanRoot.path}".`))
			.on("error", error => logger.error(`Watcher error: ${error}.`));
	}
}