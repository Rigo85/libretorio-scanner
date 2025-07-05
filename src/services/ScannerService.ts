import fs from "fs-extra";
import path from "path";
import { v4 as uuidv4 } from "uuid";
import { parseStringPromise } from "xml2js";
import stringSimilarity from "string-similarity";

import { Logger } from "(src)/helpers/Logger";
import { ScanRootResult } from "(src)/models/interfaces/ScanRootResult";
import {
	cleanFilename,
	cleanTitle,
	generateHash,
	getHashes,
	getSpecialDirectorySize,
	humanFileSize,
	removeTrailingSeparator
} from "(src)/utils/fileUtils";
import { ScanResult } from "(src)/models/interfaces/ScanResult";
import { Directory } from "(src)/models/interfaces/Directory";
import { File, FileKind } from "(src)/models/interfaces/File";
import { ScanRootRepository } from "(src)/repositories/ScanRootRepository";
import { FileRepository } from "(src)/repositories/FileRepository";
import { CalibreService } from "(src)/services/CalibreService";
import { OpenLibraryService } from "(src)/services/OpenLibraryService";
import { config } from "(src)/config/configuration";

const logger = new Logger("Scanner Service");

export class ScannerService {
	private static instance: ScannerService;
	isScanning = false;

	private constructor() {
	}

	public static getInstance(): ScannerService {
		if (!ScannerService.instance) {
			ScannerService.instance = new ScannerService();
		}
		return ScannerService.instance;
	}


	public async scan(rootPath: string): Promise<ScanRootResult> {
		logger.info(`Scanning: "${rootPath}"`);

		this.isScanning = true;
		let result = undefined;

		try {
			let scanResult = await this.getStructureAndFiles(rootPath);
			scanResult = await this.scanForParticularKindOfFiles(scanResult, rootPath);

			result = {
				root: rootPath,
				scan: scanResult
			} as ScanRootResult;
		} catch (error) {
			logger.error("Error scanning:", error);
		} finally {
			this.isScanning = false;
		}

		logger.info(`Scanning: "${result ? "Success" : "Failed"}"`);

		return result;
	}

	public async scanCompareUpdate(scanRootPath: string) {
		logger.info(`scanCompareUpdate for path: "${scanRootPath}".`);

		try {
			const scanRoot = await ScanRootRepository.getInstance().getScanRootByPath(scanRootPath);

			if (!scanRoot) {
				logger.error("No scan roots found.");

				return;
			}

			// - en caso de que no exista la caché de los archivos especiales, se actualiza el tamaño y se crea la cache.
			// - puede ocurrir que la tenga que borrar por mantenimiento.
			const specialArchives = await FileRepository.getInstance().getSpecialArchives(scanRoot.id);
			for (const sa of specialArchives) {
				const cachePath = path.join(__dirname, "..", "public", "cache", sa.coverId);
				const exist = await fs.pathExists(cachePath);
				if (!exist) {
					logger.info(`Special archive cache not found: "${cachePath}".`);
					sa.size = await getSpecialDirectorySize(path.join(sa.parentPath, sa.name), sa.coverId);
					await FileRepository.getInstance().updateSpecialArchiveSize(sa.id, sa.size);
					logger.info(`Special archive size updated: "${sa.name}" - "${sa.size}".`);
				}
			}

			// - escanear el directorio observado.
			const scanRootResult = await ScannerService.getInstance().scan(removeTrailingSeparator(scanRootPath));

			// - obtener los hashes de los directorios.
			const hash = getHashes(scanRootResult.scan.directories);

			// - eliminar los archivos en la db que NO tengan un parentHash dentro de los hashes obtenidos.
			const removedFilesCount = await FileRepository.getInstance().removeFileByParentHash(hash);
			logger.info(`Removed files by parent hash: ${removedFilesCount}.`);

			// - obtener los archivos de la db.
			const hashes = await FileRepository.getInstance().getFileHashes(scanRoot.id);

			const fileToRemove = hashes.filter((h: { hash: string }) =>
				!scanRootResult.scan.files.find((file: File) => h.hash === file.fileHash));

			// - eliminar los archivos en la db que NO estén en el scan.
			if (fileToRemove.length) {
				const removedFilesCount = await FileRepository.getInstance()
					.removeFileByFileHash(fileToRemove.map((f: { hash: string }) => f.hash));
				logger.info(`Removed files by file hash: ${removedFilesCount}.`);
			}

			// - los archivos del scan que no estén en la db, se insertan.
			const newFiles = scanRootResult.scan.files.filter((file: File) =>
				!hashes.find((h: { hash: string }) => h.hash === file.fileHash));

			logger.info(`New files: ${newFiles.length}.`);
			logger.info(JSON.stringify(newFiles.map((f: File) => f.name)));

			let count = 1;
			for (const file of newFiles) {
				logger.info(`Updating book details info ${count++}/${newFiles.length}: "${path.join(file.parentPath, file.name)}"`);

				const _file = await this.fillFileDetails(file);
				// actualizar peso de los archivos especiales.
				if (_file.fileKind !== FileKind.FILE && _file.fileKind !== FileKind.NONE) {
					logger.info(`Getting special directory size: "${path.join(_file.parentPath, _file.name)}"`);
					_file.size = await getSpecialDirectorySize(path.join(_file.parentPath, _file.name), _file.coverId);
					logger.info(`Special directory size: "${_file.size}"`);
				}
				await FileRepository.getInstance().insertFile(_file, scanRoot.id);
			}

			await ScanRootRepository.getInstance().updateScanRoot(JSON.stringify(scanRootResult.scan.directories), scanRoot.id);
		} catch (error) {
			logger.error(`scanCompareUpdate "${scanRootPath}":`, error.message);
		}
	}

	private async getStructureAndFiles(dirPath: string): Promise<ScanResult> {
		const structure: Directory = {
			name: path.basename(dirPath),
			hash: generateHash(dirPath),
			directories: [] as Directory[]
		};

		const filesList = [] as File[];

		const items = await fs.readdir(dirPath);

		for (const item of items) {
			const itemPath = path.join(dirPath, item);
			const stats = await fs.stat(itemPath);

			if (stats.isDirectory()) {
				const subdirectoryStructure = await this.getStructureAndFiles(itemPath);
				structure.directories.push(subdirectoryStructure.directories);
				filesList.push(...subdirectoryStructure.files);
			} else if (stats.isFile()) {
				filesList.push({
					name: item,
					parentPath: dirPath,
					parentHash: generateHash(dirPath),
					fileHash: generateHash(itemPath, true),
					size: humanFileSize(stats.size, true),
					coverId: uuidv4(),
					fileKind: FileKind.FILE
				});
			}
		}

		return {directories: structure, files: filesList};
	}

	private async scanForParticularKindOfFiles(scanResult: ScanResult, dirPath: string): Promise<ScanResult> {
		const {directory, files} = await this._helper(scanResult.directories, scanResult.files, dirPath);

		return {directories: directory, files} as ScanResult;
	}

	private async _helper(directory: Directory, files: File[], dirPath: string
	): Promise<{ directory: Directory; files: File[] }> {

		const directories = directory.directories as Directory[];
		const results = [] as { directory: Directory; fileKind: FileKind }[];

		for (const directory of directories) {
			const directoryPath = path.join(dirPath, directory.name);
			const fileKind = await this.scanForSpecialDirectories(directoryPath);

			if (fileKind !== FileKind.NONE) {
				results.push({directory, fileKind});
			}
		}

		// logger.info(`dirPath: ${dirPath} - results: ${JSON.stringify(results)}`);

		for (const result of results) {
			const index = directories.findIndex((directory: Directory) => directory.name === result.directory.name);

			if (index > -1) {
				const [specialDirectory] = directories.splice(index, 1);
				logger.info("Special directory:", JSON.stringify(specialDirectory));
				const id = uuidv4();
				files.push({
					name: specialDirectory.name,
					parentPath: dirPath,
					parentHash: generateHash(dirPath),
					fileHash: generateHash(path.join(dirPath, specialDirectory.name)),
					// size: await this.getSpecialDirectorySize(path.join(dirPath, specialDirectory.name), id), // compactar la carpeta y obtener el peso, ese compactado será la descarga.
					size: "0",
					coverId: id,
					fileKind: result.fileKind
				});

				for (let i = files.length - 1; i >= 0; i--) {
					const fileParentPath = path.normalize(files[i].parentPath);
					const specialDirPath = path.normalize(path.join(dirPath, specialDirectory.name));
					if (fileParentPath.startsWith(specialDirPath)) {
						files.splice(i, 1);
					}
				}
			}
		}

		for (const _directory of directories) {
			// logger.info(`${_directory.name} - files length b4: ${files.length}`);
			await this._helper(_directory, files, path.join(dirPath, _directory.name));
			// logger.info(`${_directory.name} - files length after: ${files.length}`);
		}

		return {directory, files};
	}

	private async scanForSpecialDirectories(directoryPath: string): Promise<FileKind> {
		const scanners = [
			this.scanForComics.bind(this),
			this.scanForEpubs.bind(this),
			this.scanForAudioBooks.bind(this)
		];

		for (const scanner of scanners) {
			const fileKind = await scanner(directoryPath);
			if (fileKind !== FileKind.NONE) {
				return fileKind;
			}
		}

		return FileKind.NONE;
	}

	private async scanForComics(directoryPath: string): Promise<FileKind> {
		return await this.scanForFolderOfFormat(directoryPath, ["jpg", "jpeg", "png", "webp", "gif"], FileKind.COMIC_MANGA);
	}

	private async scanForAudioBooks(directoryPath: string): Promise<FileKind> {
		return await this.scanForFolderOfFormat(directoryPath, ["mp3", "wav", "m4a", "m4b", "ogg"], FileKind.AUDIOBOOK, false);
	}

	private async scanForFolderOfFormat(directoryPath: string, extensions: string[], format: FileKind, strict: boolean = true): Promise<FileKind> {
		const allowedExtensions = new Set(extensions || []);
		let foundExtension: string = undefined;

		try {
			const files = await fs.readdir(directoryPath);

			for (const file of files) {
				const filePath = path.join(directoryPath, file);
				const stat = await fs.stat(filePath);

				if (!stat.isFile()) {
					// logger.error(`scanForFolderOfFormat - "${filePath}" is not a file.`);

					return FileKind.NONE; // No es un archivo
				}

				const extension = path.extname(file).toLowerCase().slice(1);

				if (!allowedExtensions.has(extension)) {
					// logger.error(`scanForFolderOfFormat - "${file}" has an invalid extension.`);

					return FileKind.NONE; // Extensión no permitida
				}

				if (strict) {
					if (!foundExtension) {
						foundExtension = extension;
					} else if (foundExtension !== extension) {
						// logger.error(`scanForFolderOfFormat - "${file}" has a different extension of "${foundExtension || "none"}".`);

						return FileKind.NONE; // Las extensiones no coinciden
					}
				}
			}

			return files.length ? format : FileKind.NONE;
		} catch (error) {
			logger.error("scanForFolderOfFormat - Error reading directory:", error);

			return FileKind.NONE;
		}
	}

	private async scanForEpubs(directoryPath: string): Promise<FileKind> {
		try {
			// 1. Verificar el archivo mimetype
			const mimetypePath = path.join(directoryPath, "mimetype");
			const mimetypeExists = await fs.pathExists(mimetypePath);
			if (!mimetypeExists) {
				// logger.error(`scanForEpubs - "${mimetypePath}" does not exist.`);

				return FileKind.NONE;
			}
			const mimetypeContent = (await fs.readFile(mimetypePath, "utf-8")).trim();
			if (mimetypeContent !== "application/epub+zip") {
				// logger.error(`scanForEpubs - "${mimetypePath}" has an invalid content.`);

				return FileKind.NONE;
			}

			// 2. Verificar el directorio META-INF y el archivo container.xml
			const metaInfPath = path.join(directoryPath, "META-INF");
			const containerXmlPath = path.join(metaInfPath, "container.xml");
			const containerXmlExists = await fs.pathExists(containerXmlPath);
			if (!containerXmlExists) {
				// logger.error(`scanForEpubs - "${containerXmlPath}" does not exist.`);

				return FileKind.NONE;
			}

			// 3. Leer y analizar el archivo container.xml para encontrar el archivo .opf
			const containerXmlContent = await fs.readFile(containerXmlPath, "utf-8");
			let opfFilePath: string;
			try {
				const parsedXml = await parseStringPromise(containerXmlContent);
				// logger.info(JSON.stringify(parsedXml));
				const rootFile = parsedXml.container?.rootfiles?.[0]?.rootfile?.[0];
				if (rootFile && rootFile.$ && rootFile.$["full-path"]) {
					opfFilePath = rootFile.$["full-path"];
				} else {
					return FileKind.NONE; // Fallar si no se encuentra la ruta al OPF
				}
			} catch (error) {
				// logger.error(`scanForEpubs - Error parsing "${containerXmlPath}":`, error);

				return FileKind.NONE;
			}

			// 4. Verificar la existencia del archivo .opf
			if (!opfFilePath) {
				// logger.error(`scanForEpubs - "${containerXmlPath}" does not contain a valid .opf file path.`);
				return FileKind.NONE;
			}

			const opfAbsolutePath = path.join(directoryPath, opfFilePath);
			const opfExists = await fs.pathExists(opfAbsolutePath);
			if (!opfExists) {
				// logger.error(`scanForEpubs - "${opfAbsolutePath}" does not exist.`);

				return FileKind.NONE;
			}

			// Si se pasan todas las verificaciones, es un EPUB válido
			return FileKind.EPUB;
		} catch (error) {
			logger.error("scanForEpubs - Error reading directory:", error);

			return FileKind.NONE;
		}
	}

	private async fillFileDetails(file: File): Promise<File> {
		try {
			const meta = await CalibreService.getInstance().getEbookMeta(path.join(file.parentPath, file.name), file.coverId);

			const filename = cleanFilename(file.name);
			let _title = "";
			if (meta) {
				meta.title = (meta.title || "").trim();
				file.localDetails = JSON.stringify(meta);
				if (meta.title) {
					_title = cleanTitle(meta.title);
				}
			}

			const similarity = stringSimilarity.compareTwoStrings(filename, _title);

			if (config.production.scan.openLibrary) {
				const bookInfo = await OpenLibraryService.getInstance().getBookInfoOpenLibrary(similarity >= 0.5 ? _title : filename);
				if (bookInfo) {
					file.webDetails = JSON.stringify(bookInfo);
				}
			}
		} catch (error) {
			console.error(`fillFileDetails "${path.join(file.parentPath, file.name)}":`, error.message);
		}

		return file;
	}
}
