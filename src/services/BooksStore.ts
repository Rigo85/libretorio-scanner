import path from "path";
import shell, { cp } from "shelljs";

import { Logger } from "(src)/helpers/Logger";
import { getFiles, getFilesByText, getScanRoots, insertFile, insertScanRoot, ScanRoot } from "(src)/services/dbService";
import { Scanner, ScanResult, ScanRootResult } from "(src)/services/Scanner";
import { FileWatcher } from "(src)/services/FileWatcher";
import {
	Directory,
	fillFileDetails,
	removeTrailingSeparator,
	File,
	checkIfPathExistsAndIsFile
} from "(src)/helpers/FileUtils";
import { searchBookInfoOpenLibrary } from "(src)/services/book-info";
import { updateFile } from "(src)/services/dbService";

const logger = new Logger("Books Store");

const envScanRoot = process.env.SCAN_ROOT;

if (!envScanRoot) {
	throw new Error("The environment variable 'SCAN_ROOT' is not defined.");
}

export class BooksStore {
	private static instance: BooksStore;

	private constructor() {
	}

	public static getInstance(): BooksStore {
		if (!BooksStore.instance) {
			BooksStore.instance = new BooksStore();
		}

		return BooksStore.instance;
	}

	private async startBooksInfo(): Promise<ScanRoot> {
		try {
			const scanRootResult = await Scanner.getInstance().scan(removeTrailingSeparator(envScanRoot));

			return await this.updateBooksDetailsInfo(scanRootResult);
		} catch (error) {
			logger.error("startBooksInfo:", error);

			return undefined;
		}
	}

	private async updateBooksDetailsInfo(scanRootResult: ScanRootResult): Promise<ScanRoot> {
		logger.info(`Updating books details info for "${scanRootResult.root}"`);

		const scanRoot = await insertScanRoot(scanRootResult);

		if (!scanRoot) {
			logger.error(`Error inserting scan root for "${scanRootResult.root}"`);

			return undefined;
		}

		let count = 1;
		for (const file of scanRootResult.scan.files) {
			logger.info(`Updating book details info ${count++}/${scanRootResult.scan.files.length}: "${path.join(file.parentPath, file.name)}"`);

			try {
				const _file = await fillFileDetails(file);
				await insertFile(_file, scanRoot.id);
			} catch (error) {
				logger.error(`updateBooksDetailsInfo "${path.join(file.parentPath, file.name)}":`, error);

				return undefined;
			}
		}

		return scanRoot;
	}

	public async updateBooksInfo() {
		logger.info("Updating books info");

		let dbScanRoots = await getScanRoots();

		if (!dbScanRoots.length) {
			const scanRoot = await this.startBooksInfo();
			if (!scanRoot) {
				logger.error(`Error starting books info for "${envScanRoot}"`);

				return;
			}

			dbScanRoots = [scanRoot];
		}

		for (const dbScanRoot of dbScanRoots) {
			const fileWatcher = new FileWatcher(dbScanRoot);

			try {
				await fileWatcher.startWatching();
			} catch (error) {
				logger.error("updateBooksInfo:", error);
			}
		}

		logger.info("Done updating books info");
	}

	public async getBooksList(parentHash?: string): Promise<ScanResult> {
		logger.info("getBooksList:", parentHash ?? "root");

		try {
			const scanRoots = await getScanRoots();

			if (!scanRoots?.length) {
				logger.error("getBooksList", "No scan roots found");
				return undefined;
			}

			const directories = JSON.parse(scanRoots[0].directories) as Directory;
			const files = await getFiles(parentHash ?? directories.hash);

			return {directories, files};
		} catch (error) {
			logger.error("getBooksList", error);

			return undefined;
		}
	}

	public async searchBookInfoOpenLibrary(searchOptions: { title: string; author: string }): Promise<any[]> {
		logger.info("searchBookInfoOpenLibrary:", searchOptions);

		try {
			return searchBookInfoOpenLibrary(searchOptions.title, searchOptions.author);
		} catch (error) {
			logger.error("searchBookInfoOpenLibrary", error);

			return [];
		}
	}

	// leer

	// descargar

	public async updateBooksDetails(file: File): Promise<boolean> {
		logger.info("updateBooksDetails:", {id: file.id, name: file.name});

		try {
			const response = await updateFile(file);

			if (response) {
				// eslint-disable-next-line @typescript-eslint/naming-convention
				const cover_i = this.getWebDetailsCoverId(file);
				if (cover_i) {
					const coverPath = path.join(__dirname, "..", "public", "temp_covers", `${cover_i}.jpg`);
					if (checkIfPathExistsAndIsFile(coverPath)) {
						const cpResponse = shell.cp(coverPath, path.join(__dirname, "..", "public", "covers", `${cover_i}.jpg`));
						if (cpResponse.code === 0) {
							return true;
						} else {
							logger.error(`updateBooksDetails(code=${cpResponse.code})`, cpResponse.stderr ?? "Error copying cover image.");
						}
					} else {
						logger.error("updateBooksDetails", `Cover image not found: "${coverPath}".`);
					}
				} else {
					logger.error("updateBooksDetails", "Cover ID not found.");
				}
			}

			return response;
		} catch (error) {
			logger.error("updateBooksDetails", error);

			return false;
		}
	}

	async searchBooksByTextOnDb(data: { searchText: string }): Promise<ScanResult> {
		logger.info("searchBooksByTextOnDb:", data);

		try {
			const scanRoots = await getScanRoots();

			if (!scanRoots?.length) {
				logger.error("searchBooksByTextOnDb", "No scan roots found");
				return undefined;
			}

			const directories = JSON.parse(scanRoots[0].directories) as Directory;
			const files = await getFilesByText(data.searchText);

			return {directories, files};
		} catch (error) {
			logger.error("searchBooksByTextOnDb", error);

			return undefined;
		}
	}

	private getWebDetailsCoverId(file: File): string | number | undefined {
		try {
			const webDetails = JSON.parse(file.webDetails ?? "{}");

			return webDetails.cover_i;
		} catch (error) {
			console.error("getWebDetailsCoverId", error);

			return undefined;
		}
	}
}
