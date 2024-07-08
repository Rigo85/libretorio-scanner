import nsfw, { FileChangeEvent, NSFW } from "nsfw";
import path from "path";
import fs from "fs-extra";
import crypto from "crypto";
import { v4 as uuidv4 } from "uuid";
import { Logger } from "(src)/helpers/Logger";

const logger = new Logger("File Watcher");

export class FileWatcher {
	private watcher: NSFW;
	private readonly uuid: string;

	constructor(private watchDir: string) {
		this.uuid = uuidv4();
		this.getFileHash = this.getFileHash.bind(this);
		this.eventHandler = this.eventHandler.bind(this);
		logger.info(`FileWatcher "${this.uuid}" created`);
	}

	private async getFileHash(filePath: string) {
		try {
			const fileBuffer = await fs.readFile(filePath);
			const hashSum = crypto.createHash("sha256");
			hashSum.update(fileBuffer);

			return hashSum.digest("hex");
		} catch (error) {
			logger.error(`Error getting hash of "${filePath}":`, error);

			return undefined;
		}
	};

	/* eslint-disable @typescript-eslint/indent */
	private async eventHandler(events: FileChangeEvent[]) {
		for (const event of events) {
			switch (event.action) {
				case nsfw.actions.CREATED:
					console.log(`Archivo creado: ${event.file}`);
					const fullPath = path.join(event.directory, event.file);
					// si es un directorio: modificar el árbol de carpetas.
					// si es un archivo: agregar a la base de datos.
					break;
				case nsfw.actions.DELETED:
					console.log(`Archivo eliminado: ${event.file}`);
					// si es un directorio: modificar el árbol de carpetas y
					//      eliminar todos los archivos de la base de datos hijos de esta carpeta.
					// si es un archivo: eliminar de la base de datos.
					break;
				case nsfw.actions.MODIFIED:
					// si es un directorio: ignorar.
					// si en un archivo: verificar si el contenido cambió.
					const hashBefore = await this.getFileHash(path.join(event.directory, event.file));
					// Simular un pequeño retardo para permitir la escritura del archivo
					setTimeout(async () => {
						const hashAfter = await this.getFileHash(path.join(event.directory, event.file));
						if (hashBefore && hashAfter && hashBefore !== hashAfter) {
							console.log(`Archivo modificado (contenido cambiado): ${event.file}`);
						}
					}, 100);
					break;
				case nsfw.actions.RENAMED:
					// si es un directorio: modificar el árbol de carpetas y sus archivos hijos(parentParent, parentHash).
					// si es un archivo: renombrar en la base de datos.
					console.log(`Archivo renombrado de ${event.oldFile} a ${event.newFile}`);
					break;
				default:
					break;
			}
		}
	};

	/* eslint-enable @typescript-eslint/indent */

	public async startWatching() {
		this.watcher = await nsfw(this.watchDir, this.eventHandler, {
			debounceMS: 100, // Retardo de rebote en milisegundos
			errorCallback: error => logger.error(`starWatching(${this.uuid}): ${error}.`)
		});

		await this.watcher.start();
		logger.info(`FileWatcher(${this.uuid}) monitoring changes in ${this.watchDir}.`);
	}

	public async stopWatching() {
		if (this.watcher) {
			await this.watcher.stop();
			logger.info(`FileWatcher(${this.uuid}) monitoring stopped.`);
		}
	}
}