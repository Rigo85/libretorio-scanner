import path from "path";
import shell from "shelljs";
import fs from "fs-extra";
import * as unrar from "node-unrar-js";
import { extractFull } from "node-7z";
import sharp from "sharp";
import { exec } from "child_process";
import util from "util";
import unzipper from "unzipper";
import { Base64 } from "js-base64";

import { Logger } from "(src)/helpers/Logger";
import {
	getFiles,
	getFilesByText, getFilesCount,
	getScanRoots,
	insertFile,
	insertScanRoot,
	ScanRoot,
	updateFile
} from "(src)/services/dbService";
import { Scanner, ScanResult, ScanRootResult } from "(src)/services/Scanner";
import { FileWatcher } from "(src)/services/FileWatcher";
import {
	checkIfPathExistsAndIsFile,
	ConventToPdfUtilFunction,
	ConvertToPdfResponse, DecompressPages,
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

	public async getBooksList(offset: number, limit: number, parentHash?: string): Promise<ScanResult> {
		logger.info("getBooksList:", {parentHash: parentHash ?? "root", offset, limit});

		try {
			const scanRoots = await getScanRoots();

			if (!scanRoots?.length) {
				logger.error("getBooksList", "No scan roots found");
				return undefined;
			}

			const directories = JSON.parse(scanRoots[0].directories) as Directory;
			// const files = await getFiles(parentHash ?? directories.hash, offset, limit);
			// const total = await getFilesCount(parentHash ?? directories.hash);
			const [files, total] = await Promise.all([
				getFiles(parentHash ?? directories.hash, offset, limit), getFilesCount(parentHash ?? directories.hash)]);

			return {directories, files, total};
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
		logger.info(`decompressCB7: '${JSON.stringify(data)}'`);

		let extractPath = "";
		try {
			if (!data?.filePath) {
				logger.info("The path to the 7z file has not been provided.");
				return {error: "The path to the Comic/Manga file has not been provided.", success: "ERROR"};
			}

			if (!fs.existsSync(data.filePath)) {
				logger.info(`The 7z file does not exist: "${data.filePath}"`);
				return {error: `The Comic/Manga file does not exist: "${data.filePath}"`, success: "ERROR"};
			}

			const cachePath = path.join(__dirname, "..", "public", "cache", data.id);
			const cacheFilePath = path.join(cachePath, `${data.id}_0.cache`);

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

				await this.savePagesToFile(images, data.id);

				if (fs.existsSync(cacheFilePath)) {
					const pages = JSON.parse(fs.readFileSync(cacheFilePath).toString());
					return {pages, success: "OK"};
				} else {
					return {success: "ERROR", error: "Error extracting comic/manga book."};
				}
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

	public async gettingComicMangaImages(data: { filePath: string; id: string }): Promise<DecompressResponse> {
		logger.info(`gettingComicMangaImages: '${JSON.stringify(data)}'`);

		try {
			if (!data?.filePath) {
				logger.info("The path to the Comic/Manga file has not been provided.");
				return {error: "The path to the Comic/Manga file has not been provided.", success: "ERROR"};
			}

			if (!fs.existsSync(data.filePath)) {
				logger.info(`The Comic/Manga file does not exist: "${data.filePath}"`);
				return {error: `The Comic/Manga file does not exist: "${data.filePath}"`, success: "ERROR"};
			}

			const cachePath = path.join(__dirname, "..", "public", "cache", data.id);
			const cacheFilePath = path.join(cachePath, `${data.id}_0.cache`);

			if (fs.existsSync(cacheFilePath)) {
				const pages = JSON.parse(fs.readFileSync(cacheFilePath).toString());
				return {pages, success: "OK"};
			} else {
				let images = await this.findImagesInDirectory(data.filePath);
				images = images.sort((a, b) => a.path.localeCompare(b.path)).map(img => img.base64);

				await this.savePagesToFile(images, data.id);

				if (fs.existsSync(cacheFilePath)) {
					const pages = JSON.parse(fs.readFileSync(cacheFilePath).toString());
					return {pages, success: "OK"};
				} else {
					return {success: "ERROR", error: "Error extracting comic/manga book."};
				}
			}
		} catch (error) {
			logger.error("gettingComicMangaImages", error);

			return {success: "ERROR", error: error.message || "Error getting comic/manga book."};
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
		logger.info(`decompressRAR: '${JSON.stringify(data)}'`);

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
			const cacheFilePath = path.join(cachePath, `${data.id}_0.cache`);

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
							const fileExtension = path.extname(file.fileHeader.name).toLowerCase();
							return `data:image/${fileExtension.slice(1)};base64,${Buffer.from(file.extraction).toString("base64")}`;
						}))
					;
				}

				await this.savePagesToFile(pages, data.id);

				if (fs.existsSync(cacheFilePath)) {
					const pages = JSON.parse(fs.readFileSync(cacheFilePath).toString());
					return {pages, success: "OK"};
				} else {
					return {success: "ERROR", error: "Error extracting comic/manga book."};
				}
			}
		} catch (error) {
			logger.error("decompressRAR", error);

			return {success: "ERROR", error: error.message || "Error extracting comic/manga book."};
		}
	}

	public async decompressZIP(data: { filePath: string; id: string }): Promise<DecompressResponse> {
		logger.info(`decompressZIP: '${JSON.stringify(data)}'`);

		let extractPath = "";
		try {
			if (!data?.filePath) {
				logger.info("The path to the ZIP file has not been provided.");
				return {error: "The path to the Comic/Manga file has not been provided.", success: "ERROR"};
			}

			if (!fs.existsSync(data.filePath)) {
				logger.info(`The ZIP file does not exist: "${data.filePath}"`);
				return {error: `The Comic/Manga file does not exist: "${data.filePath}"`, success: "ERROR"};
			}

			const cachePath = path.join(__dirname, "..", "public", "cache", data.id);
			const cacheFilePath = path.join(cachePath, `${data.id}_0.cache`);

			if (fs.existsSync(cacheFilePath)) {
				const pages = JSON.parse(fs.readFileSync(cacheFilePath).toString());
				return {pages, success: "OK"};
			} else {
				extractPath = path.join(__dirname, "extracted");
				if (!fs.existsSync(extractPath)) {
					fs.mkdirSync(extractPath);
				}

				await new Promise<void>((resolve, reject) => {
					fs.createReadStream(data.filePath)
						.pipe(unzipper.Extract({path: extractPath}))
						.on("close", resolve)
						.on("error", reject);
				});

				const files = fs.readdirSync(extractPath)
					.filter(file => /\.(jpg|jpeg|png|webp|gif)$/i.test(file))
					.sort((a, b) => a.localeCompare(b));

				const pages = [] as any[];
				for (const file of files) {
					const fileExtension = path.extname(file).toLowerCase();
					const filePath = path.join(extractPath, file);
					const imageBuffer = await sharp(filePath).toBuffer();
					const base64Image = imageBuffer.toString("base64");
					const base64 = `data:image/${fileExtension.slice(1)};base64,${base64Image}`;
					pages.push(base64);
				}

				fs.rmSync(extractPath, {recursive: true});

				await this.savePagesToFile(pages, data.id);

				if (fs.existsSync(cacheFilePath)) {
					const pages = JSON.parse(fs.readFileSync(cacheFilePath).toString());
					return {pages, success: "OK"};
				} else {
					return {success: "ERROR", error: "Error extracting comic/manga book."};
				}
			}
		} catch (error) {
			logger.error("decompressZIP", error);

			return {success: "ERROR", error: error.message || "Error extracting comic/manga book."};
		} finally {
			if (extractPath && fs.existsSync(extractPath)) {
				fs.rmSync(extractPath, {recursive: true});
			}
		}
	}

	public detectCompressionType(filePath: string): string {
		try {
			if (filePath?.trim()) {
				const buffer = Buffer.alloc(4); // Leemos los primeros 4 bytes
				const fd = fs.openSync(filePath, "r");
				fs.readSync(fd, buffer, 0, 4, 0);
				fs.closeSync(fd);

				// Magic numbers para 7z, RAR y ZIP
				const magicNumbers: { [key: string]: string } = {
					/* eslint-disable @typescript-eslint/naming-convention */
					"504B0304": "cbz",   // ZIP
					"52617221": "cbr",   // RAR (RAR3)
					"377ABCAF": "cb7"    // 7-Zip
					/* eslint-enable @typescript-eslint/naming-convention */
				};

				const fileSignature = buffer.toString("hex").toUpperCase();
				for (const [magic, type] of Object.entries(magicNumbers)) {
					if (fileSignature.startsWith(magic)) {
						return type;
					}
				}
			}

			return "";
		} catch (error) {
			logger.error("detectCompressionType", error);

			return "";
		}
	}

	private savePagesToFile(pages: any[], id: string, sizeThreshold: number = 10 * 1024 * 1024): Promise<void> {
		try {
			const cachePath = path.join(__dirname, "..", "public", "cache", id);
			fs.mkdirSync(cachePath, {recursive: true});

			let currentSize = 0;
			let fileIndex = 0;
			let currentBatch: any[] = [];
			let pageIndex = 1;

			for (const page of pages) {
				const pageSize = Buffer.byteLength(JSON.stringify(page), "utf8");
				if (currentSize + pageSize > sizeThreshold && currentBatch.length) {
					// Save the current batch to a new file
					const cacheFilePath = path.join(cachePath, `${id}_${fileIndex}.cache`);
					fs.writeFileSync(
						cacheFilePath,
						JSON.stringify({
							pages: currentBatch,
							pageIndex,
							currentPagesLength: currentBatch.length,
							totalPages: pages.length,
							index: fileIndex
						})
					);
					pageIndex += currentBatch.length;
					fileIndex++;
					currentBatch = [];
					currentSize = 0;
				}
				currentBatch.push(page);
				currentSize += pageSize;
			}

			// Save the last batch if any
			if (currentBatch.length > 0) {
				const cacheFilePath = path.join(cachePath, `${id}_${fileIndex}.cache`);
				fs.writeFileSync(
					cacheFilePath,
					JSON.stringify({
						pages: currentBatch,
						pageIndex,
						currentPagesLength: currentBatch.length,
						totalPages: pages.length,
						index: fileIndex
					})
				);
			}

			return Promise.resolve();
		} catch (error) {
			logger.error("savePagesToFile", error);
		}
	}

	public async convertWithCalibreToPdf(data: { filePath: string; id: string }): Promise<ConvertToPdfResponse> {
		logger.info(`convertWithCalibreToPdf: '${JSON.stringify(data)}'`);

		const pdfDirPath = path.join(__dirname, "..", "public", "cache", data.id);
		const pdfPath = path.join(pdfDirPath, `${data.id}.pdf`);
		const calibrePath = path.join(__dirname, "calibre", "ebook-convert");
		const command = `${calibrePath} "${data.filePath}" "${pdfPath}"`;

		return await this.convertToPdf(data, command);
	}

	async convertOfficeToPdf(data: { filePath: string; id: string }): Promise<ConvertToPdfResponse> {
		logger.info(`convertOfficeToPdf: '${JSON.stringify(data)}'`);

		const pdfDirPath = path.join(__dirname, "..", "public", "cache", data.id);
		const command = `LD_LIBRARY_PATH=/usr/lib/libreoffice/program/ libreoffice --headless --convert-to pdf --outdir "${pdfDirPath}" "${data.filePath}"`;
		const utilFun = async (filePath: string, id: string) => {
			const pdfFile = path.join(pdfDirPath, `${data.id}.pdf`);
			const outputPdfFile = path.join(pdfDirPath, `${path.basename(data.filePath, path.extname(data.filePath))}.pdf`);
			fs.renameSync(outputPdfFile, pdfFile);
		};

		return await this.convertToPdf(data, command, utilFun);
	}

	async convertHtmlToPdf(data: { filePath: string; id: string }): Promise<ConvertToPdfResponse> {
		logger.info(`convertHtmlToPdf: '${JSON.stringify(data)}'`);

		const pdfDirPath = path.join(__dirname, "..", "public", "cache", data.id);
		const pdfPath = path.join(pdfDirPath, `${data.id}.pdf`);
		const command = `htmldoc --webpage --quiet -f "${pdfPath}" "${data.filePath}"`;

		return await this.convertToPdf(data, command);
	}

	async convertToPdf(
		data: { filePath: string; id: string },
		command: string,
		utilFun?: ConventToPdfUtilFunction): Promise<ConvertToPdfResponse> {

		logger.info(`convertToPdf: '${JSON.stringify(data)}'`);

		try {
			if (!data?.filePath) {
				logger.info("The path to the file has not been provided.");
				return {error: "The path to the file has not been provided.", success: "ERROR"};
			}

			if (!fs.existsSync(data.filePath)) {
				logger.info(`The file does not exist: "${data.filePath}"`);
				return {error: `The file does not exist: "${data.filePath}"`, success: "ERROR"};
			}

			const pdfDirPath = path.join(__dirname, "..", "public", "cache", data.id);
			const pdfPath = path.join(pdfDirPath, `${data.id}.pdf`);

			if (fs.existsSync(pdfPath)) {
				return {pdfPath: path.join("/cache", data.id, `${data.id}.pdf`), success: "OK"};
			} else {
				fs.mkdirSync(pdfDirPath, {recursive: true});

				const {stderr} = await execPromise(command);
				if (stderr) {
					logger.error(`convertToPdf: ${stderr}`);
					return {error: "An error has occurred converting to pdf.", success: "ERROR"};
				}

				if (utilFun) {
					await utilFun(data.filePath, data.id);
				}

				return {pdfPath: path.join("/cache", data.id, `${data.id}.pdf`), success: "OK"};
			}
		} catch (error) {
			logger.error("convertToPdf", error);

			return {success: "ERROR", error: error.message || "An error has occurred converting to pdf."};
		}
	}

	async getMorePages(id: string, index: number): Promise<DecompressResponse> {
		logger.info(`getMorePages: '${id}', '${index}'`);

		try {
			if (!id) {
				logger.info("The Comic/Manga ID has not been provided.");
				return {error: "The Comic/Manga ID has not been provided.", success: "ERROR"};
			}

			if (index === undefined) {
				logger.info("The Comic/Manga cache index has not been provided.");
				return {error: "The Comic/Manga cache index has not been provided.", success: "ERROR"};
			}

			const cachePath = path.join(__dirname, "..", "public", "cache", id);
			const cacheFilePath = path.join(cachePath, `${id}_${index}.cache`);

			if (fs.existsSync(cacheFilePath)) {
				const pages = JSON.parse(fs.readFileSync(cacheFilePath).toString());
				return {pages, success: "OK"};
			} else {
				logger.error(`The Comic/Manga cache file does not exist: "${cacheFilePath}"`);
				return {success: "ERROR", error: "Error getting more pages."};
			}
		} catch (error) {
			logger.error("getMorePages", error);

			return {success: "ERROR", error: error.message || "Error getting more pages."};
		}
	}
}


























