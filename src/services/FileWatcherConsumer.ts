import nsfw, { ActionType, FileChangeEvent } from "nsfw";
import path from "path";
import fs from "fs-extra";

import { Logger } from "(src)/helpers/Logger";
import {
	Directory, existDirectory,
	File,
	fillFileDetails,
	generateHash,
	getHashes,
	travelTree,
	updateTree
} from "(src)/helpers/FileUtils";
import {
	getFileFromDb,
	getScanRoot,
	insertFile, removeFile,
	updateFile,
	updateFileOnDirectoryRenamed,
	updateScanRoot
} from "(src)/services/dbService";
import { RedisQueue } from "(src)/services/RedisQueue";

const logger = new Logger("File Watcher Consumer");

interface ProcessEvent {
	fileChangeEvent: FileChangeEvent;
	scanRootId: number;
	count?: number;
}

function actionTypeToString(actionType: ActionType) {
	/* eslint-disable @typescript-eslint/indent */
	switch (actionType) {
		case ActionType.CREATED:
			return "CREATED";
		case ActionType.DELETED:
			return "DELETED";
		case ActionType.MODIFIED:
			return "MODIFIED";
		case ActionType.RENAMED:
			return "RENAMED";
	}
	/* eslint-enable @typescript-eslint/indent */
}

function getQueue() {
	return RedisQueue.getInstance(() => Promise.resolve());
}

export async function fileWatcherConsumer(event: ProcessEvent) {
	let fullPath: string;
	let stats: fs.Stats;
	/* eslint-disable @typescript-eslint/indent */
	switch (event.fileChangeEvent.action) {
		case nsfw.actions.CREATED:
			try {
				fullPath = path.join(event.fileChangeEvent.directory, event.fileChangeEvent.file);
				stats = fs.statSync(fullPath);
				if (stats.isDirectory()) {
					await processDirectoryAddition(event);
				} else if (stats.isFile()) {
					await processFileAddition(event);
				}
			} catch (error) {
				logger.error(`Error processing item(${actionTypeToString(event.fileChangeEvent.action)}):`, error.message);
			}
			break;
		case nsfw.actions.RENAMED:
			try {
				fullPath = path.join(event.fileChangeEvent.directory, event.fileChangeEvent.newFile);
				stats = fs.statSync(fullPath);
				if (stats.isDirectory()) {
					await processDirectoryRename(event);
				} else if (stats.isFile()) {
					await processFileRename(event);
				}
			} catch (error) {
				logger.error(`Error processing item(${actionTypeToString(event.fileChangeEvent.action)}):`, error.message);
			}
			break;
		case nsfw.actions.DELETED:
			try {
				if (event.count === 1) {
					await getQueue().addToQueue(event.fileChangeEvent, event.scanRootId, event.count);
				} else {
					const fileFromDb = await getFileFromDb(generateHash(event.fileChangeEvent.directory), event.fileChangeEvent.directory, event.fileChangeEvent.file);
					const isDirectory = await existDirectory(event.fileChangeEvent.directory, event.fileChangeEvent.file, event.scanRootId);
					if (fileFromDb || isDirectory) {
						await processDeletion(event);
					}
				}
			} catch (error) {
				logger.error(`Error processing item(${actionTypeToString(event.fileChangeEvent.action)}):`, error.message);
			}
			break;
	}
	/* eslint-enable @typescript-eslint/indent */
}

async function processDirectoryAddition(event: ProcessEvent) {
	try {
		if (event.fileChangeEvent.action !== ActionType.RENAMED) {
			const directory = event.fileChangeEvent.directory;
			const file = event.fileChangeEvent.file;

			logger.info(`Adding directory: ${path.join(directory, file)}`);

			const scanRoot = await getScanRoot(event.scanRootId);

			if (scanRoot) {
				const {guardTree, dirTree, trace} = travelTree(directory, scanRoot.directories);

				if (!dirTree.directories.find((d: Directory) => d.name === file)) {
					dirTree.directories.push({
						name: file,
						hash: generateHash(path.join(directory, file)),
						directories: [] as Directory[]
					} as Directory);

					scanRoot.directories = JSON.stringify(guardTree);
					await updateScanRoot(scanRoot.directories, scanRoot.id);

					logger.info(`Inserted directory: ${path.join(directory, file)}`);
				} else {
					logger.info(`Directory already exists on Db: ${path.join(directory, file)}`);
				}
			} else {
				logger.error(`Scan root not found: "${event.scanRootId}"`);
			}
		}
	} catch (error) {
		logger.error(`Error processing item(${actionTypeToString(event.fileChangeEvent.action)}):`, error.message);
	}
}

async function processDirectoryRename(event: ProcessEvent) {
	try {
		if (event.fileChangeEvent.action === ActionType.RENAMED) {
			const directory = event.fileChangeEvent.directory;
			const oldFile = event.fileChangeEvent.oldFile;
			const newFile = event.fileChangeEvent.newFile;

			logger.info(`Renaming directory: ${path.join(directory, oldFile)} -> ${path.join(directory, newFile)}`);

			const scanRoot = await getScanRoot(event.scanRootId);

			if (scanRoot) {
				const {guardTree, dirTree, trace} = travelTree(directory, scanRoot.directories);

				const oldDir = dirTree.directories.find((d: Directory) => d.name === oldFile);
				if (oldDir) {
					const oldHashes = updateTree(oldDir, directory, newFile);
					scanRoot.directories = JSON.stringify(guardTree);
					await updateScanRoot(scanRoot.directories, scanRoot.id);
					await updateFileOnDirectoryRenamed(oldHashes, oldFile, newFile);

					logger.info(`Renamed directory: ${path.join(directory, oldFile)} -> ${path.join(directory, newFile)}`);
				} else {
					logger.error(`Directory not found: "${path.join(directory, oldFile)}"`);
				}
			}
		}
	} catch (error) {
		logger.error(`Error processing item(${actionTypeToString(event.fileChangeEvent.action)}):`, error.message);
	}

}

async function processFileAddition(event: ProcessEvent) {
	if (event.fileChangeEvent.action !== ActionType.RENAMED) {
		const directory = event.fileChangeEvent.directory;
		const file = event.fileChangeEvent.file;
		logger.info(`Adding file: ${path.join(directory, file)}`);

		try {
			const fileFromDb = await getFileFromDb(generateHash(directory), directory, file);
			if (!fileFromDb) {
				const fileId = await insertFile(await getFile(event.fileChangeEvent), event.scanRootId);
				if (fileId) {
					logger.info(`Inserted file "${file}" with id: "${fileId}" for scan root: "${event.scanRootId}"`);
				}
			} else {
				logger.info(`File already exists on Db: ${path.join(directory, file)}`);
			}
		} catch (error) {
			logger.error(`Error processing item(${actionTypeToString(event.fileChangeEvent.action)}):`, error.message);
		}
	}
}

async function processDeletion(event: ProcessEvent) {
	try {
		if (event.fileChangeEvent.action !== ActionType.RENAMED) {
			const directory = event.fileChangeEvent.directory;
			const file = event.fileChangeEvent.file;

			logger.info(`Deleting file or directory: ${path.join(directory, file)}`);

			const scanRoot = await getScanRoot(event.scanRootId);

			if (scanRoot) {
				const {guardTree, dirTree, trace} = travelTree(directory, scanRoot.directories);
				const dir = dirTree.directories.find((d: Directory) => d.name === file);
				let hashes: string[];
				let _file: string = undefined;

				if (dir) {
					hashes = getHashes(dir);
					dirTree.directories = dirTree.directories.filter((d: Directory) => d.name !== file);
					scanRoot.directories = JSON.stringify(guardTree);
					await updateScanRoot(scanRoot.directories, scanRoot.id);
				} else {
					hashes = [generateHash(directory)];
					_file = file;
				}

				const ids = await removeFile(hashes, _file);

				const msg = dir ?
					`Directory "${dir.name}" removed and "${ids}" files.` :
					`File "${file}" removed.`
				;

				logger.info(msg);
			}
		}
	} catch (error) {
		logger.error(`Error processing item(${actionTypeToString(event.fileChangeEvent.action)}):`, error.message);
	}
}

async function processFileRename(event: ProcessEvent) {
	try {
		if (event.fileChangeEvent.action === ActionType.RENAMED) {
			const oldPath = path.join(event.fileChangeEvent.directory, event.fileChangeEvent.oldFile);
			const newPath = path.join(event.fileChangeEvent.directory, event.fileChangeEvent.newFile);
			logger.info(`Renaming file: ${oldPath} -> ${newPath}`);

			try {
				const id = await updateFile(
					generateHash(event.fileChangeEvent.directory),
					event.fileChangeEvent.oldFile,
					event.fileChangeEvent.newFile
				);

				if (id) {
					logger.info(`Updated file "${oldPath}" -> "${newPath}" with id: "${id}"`);
				}
			} catch (error) {
				logger.error(`Error processing item(${actionTypeToString(event.fileChangeEvent.action)}):`, error.message);
			}
		}
	} catch (error) {
		logger.error(`Error processing item(${actionTypeToString(event.fileChangeEvent.action)}):`, error.message);
	}
}

async function getFile(event: FileChangeEvent): Promise<File> {
	let name;
	if (event.action !== ActionType.RENAMED) {
		name = event.file;
	}

	return await fillFileDetails({
		name,
		parentPath: event.directory,
		parentHash: generateHash(event.directory)
	} as File);
}












