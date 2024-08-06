import path from "path";
import shell from "shelljs";
import fs from "fs-extra";
import * as unrar from "node-unrar-js";
import { extractFull } from "node-7z";
import sharp from "sharp";
import { exec } from "child_process";
import util from "util";

import { Logger } from "(src)/helpers/Logger";
import {
	getFiles,
	getFilesByText,
	getScanRoots,
	insertFile,
	insertScanRoot,
	ScanRoot,
	updateFile
} from "(src)/services/dbService";
import { Scanner, ScanResult, ScanRootResult } from "(src)/services/Scanner";
import { FileWatcher } from "(src)/services/FileWatcher";
import {
	checkIfPathExistsAndIsFile, ConvertToPdfResponse,
	DecompressResponse,
	Directory,
	File,
	fillFileDetails,
	removeTrailingSeparator
} from "(src)/helpers/FileUtils";
import { searchBookInfoOpenLibrary } from "(src)/services/book-info";

const execPromise = util.promisify(exec);
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

	public async decompressCB7(data: { filePath: string; id: string }): Promise<DecompressResponse> {
		logger.info(`decompressBook: "${JSON.stringify(data)}`);
		let extractPath = "";
		const cachePath = path.join(__dirname, "..", "public", "cache", data.id);
		const cacheFilePath = path.join(cachePath, `${data.id}.cache`);
		try {
			if (fs.existsSync(cacheFilePath)) {
				const pages = JSON.parse(fs.readFileSync(cacheFilePath).toString());
				return {pages, success: "OK"};
			} else {
				extractPath = path.join(__dirname, "extracted");
				if (!fs.existsSync(extractPath)) {
					fs.mkdirSync(extractPath);
				}

				await new Promise<void>((resolve, reject) => {
					const extraction = extractFull(data.filePath, extractPath, {
						$bin: require("7zip-bin").path7za
					});

					extraction.on("end", () => {
						console.log("Extraction complete");
						resolve();
					});
					extraction.on("error", (err: any) => {
						console.error("Error during extraction:", err);
						reject(err);
					});
				});

				let images = await this.findImagesInDirectory(extractPath);

				images = images.sort((a, b) => a.path.localeCompare(b.path)).map(img => img.base64);

				fs.rmSync(extractPath, {recursive: true});

				this.savePagesToFile(images, data.id);

				return {success: "OK", pages: images};
			}
		} catch (error) {
			logger.error("decompressCB7", error);

			return {success: "ERROR", error: error.message || "Error extracting comic/manga book."};
		} finally {
			if (extractPath && fs.existsSync(extractPath)) {
				fs.rmSync(extractPath, {recursive: true});
			}
		}
	}

	private async findImagesInDirectory(dir: string): Promise<any[]> {
		let images: any[] = [];
		const files = fs.readdirSync(dir);

		for (const file of files) {
			const fullPath = path.join(dir, file);
			const stat = fs.statSync(fullPath);

			if (stat.isDirectory()) {
				images = images.concat(await this.findImagesInDirectory(fullPath));
			} else {
				const fileExtension = path.extname(file).toLowerCase();
				if ([".jpg", ".jpeg", ".png", ".gif", ".webp"].includes(fileExtension)) {
					// console.log(`Processing image: ${fullPath}`);
					try {
						const imageBuffer = await sharp(fullPath).toBuffer();
						const base64Image = imageBuffer.toString("base64");
						images.push({
							path: fullPath,
							base64: `data:image/${fileExtension.slice(1)};base64,${base64Image}`
						});
					} catch (err) {
						console.error("Error processing image:", err);
					}
				}
			}
		}
		return images;
	}

	public async decompressRAR(data: { filePath: string; id: string }): Promise<DecompressResponse> {
		logger.info(`decompressBook: "${JSON.stringify(data)}`);

		try {
			if (!data?.filePath) {
				logger.info("The path to the RAR file has not been provided.");
				return {error: "The path to the Comic/Manga file has not been provided.", success: "ERROR"};
			}

			if (!fs.existsSync(data.filePath)) {
				logger.info(`The RAR file does not exist: "${data.filePath}"`);
				return {error: `The Comic/Manga file does not exist: "${data.filePath}"`, success: "ERROR"};
			}

			const cachePath = path.join(__dirname, "..", "public", "cache", data.id);
			const cacheFilePath = path.join(cachePath, `${data.id}.cache`);

			if (fs.existsSync(cacheFilePath)) {
				const pages = JSON.parse(fs.readFileSync(cacheFilePath).toString());
				return {pages, success: "OK"};
			} else {
				const buf = Uint8Array.from(fs.readFileSync(data.filePath)).buffer;
				const extractor = await unrar.createExtractorFromData({data: buf});

				const list = extractor.getFileList();
				if (!list.fileHeaders) {
					logger.info("Error retrieving the list of files.");
					return {error: "Error opening Comic/Manga file.", success: "ERROR"};
				}

				const fileHeaders = [...list.fileHeaders]
					.filter((fileHeader) => !fileHeader.flags.directory)
					.filter((fileHeader) => fileHeader.name.endsWith(".jpg") || fileHeader.name.endsWith(".png"))
					.sort((a, b) => a.name.localeCompare(b.name));

				const pages = [] as any[];

				for (const fileHeader of fileHeaders) {
					const extracted = extractor.extract({files: [fileHeader.name]});

					if (!extracted?.files) {
						logger.info(`Error extracting the file: "${fileHeader.name}"`);
						continue;
					}

					const _pages = [...extracted.files];
					if (!_pages.length) {
						logger.info(`No pages have been extracted from the file: "${fileHeader.name}"`);
						continue;
					}

					pages.push(..._pages
						.filter((file) => file.extraction)
						.map((file) => {
							return `data:image/${this.getImageFormat(file.fileHeader.name)};base64,${Buffer.from(file.extraction).toString("base64")}`;
						}))
					;
				}

				this.savePagesToFile(pages, data.id);

				return {pages, success: "OK"};
			}
		} catch (error) {
			logger.error("decompressBook", error);

			return {success: "ERROR", error: error.message || "Error extracting comic/manga book."};
		}
	}

	private savePagesToFile(pages: any[], id: string): Promise<void> {
		try {
			const cachePath = path.join(__dirname, "..", "public", "cache", id);
			const cacheFilePath = path.join(cachePath, `${id}.cache`);
			fs.mkdirSync(cachePath, {recursive: true});
			return fs.writeFile(cacheFilePath, JSON.stringify(pages));
		} catch (error) {
			logger.error("savePagesToFile", error);
		}
	}

	private getImageFormat(fileName: string): string {
		if (fileName.endsWith(".png")) {
			return "png";
		} else {
			return "jpeg";
		}
	}

	async convertEpubToPdf(data: { filePath: string; id: string }): Promise<ConvertToPdfResponse> {
		logger.info(`convertEpubToPdf: "${data.filePath || "<empty path>"}`);

		try {
			if (!data?.filePath) {
				logger.info("The path to the EPUB file has not been provided.");
				return {error: "The path to the EPUB file has not been provided.", success: "ERROR"};
			}

			if (!fs.existsSync(data.filePath)) {
				logger.info(`The EPUB file does not exist: "${data.filePath}"`);
				return {error: `The EPUB file does not exist: "${data.filePath}"`, success: "ERROR"};
			}

			const pdfDirPath = path.join(__dirname, "..", "public", "cache", data.id);
			const pdfPath = path.join(pdfDirPath, `${data.id}.pdf`);

			if (fs.existsSync(pdfPath)) {
				return {pdfPath: path.join("/cache", data.id, `${data.id}.pdf`), success: "OK"};
			} else {
				fs.mkdirSync(pdfDirPath, {recursive: true});
				const calibrePath = path.join(__dirname, "calibre", "ebook-convert");
				const command = `${calibrePath} "${data.filePath}" "${pdfPath}"`;

				const {stderr} = await execPromise(command);
				if (stderr) {
					logger.error(`convertEpubToPdf: ${stderr}`);
					return {error: "An error has occurred converting epub to pdf.", success: "ERROR"};
				}

				return {pdfPath: path.join("/cache", data.id, `${data.id}.pdf`), success: "OK"};
			}
		} catch (error) {
			logger.error("convertEpubToPdf", error);

			return {success: "ERROR", error: error.message || "An error has occurred converting epub to pdf."};
		}
	}
}


























