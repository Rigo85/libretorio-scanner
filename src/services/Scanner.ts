import fs from "fs-extra";
import path from "path";
import { v4 as uuidv4 } from "uuid";
import { parseStringPromise } from "xml2js";
import archiver from "archiver";
import pLimit from "p-limit";
import { strict as assert } from "node:assert";

import { Logger } from "(src)/helpers/Logger";
import { Directory, File, FileKind, generateHash, humanFileSize } from "(src)/helpers/FileUtils";

const logger = new Logger("Scanner");

const _limit = process.env.P_LIMIT;
assert.ok(_limit, "P_LIMIT is not defined.");
// eslint-disable-next-line @typescript-eslint/naming-convention
let __limit: number;
try {
	__limit = parseInt(_limit);
} catch (error) {
	logger.error("Error parsing P_LIMIT:", error);
	__limit = 4;
}
const debuglogScannerOfFormats = process.env.DEBUGLOG_SCANNER_OF_FORMATS;
assert.ok(debuglogScannerOfFormats, "DEBUGLOG_SCANNER_OF_FORMATS is not defined.");
const debugLogs = debuglogScannerOfFormats === "true";

export interface ScanResult {
	directories: Directory;
	files: File[];
	total?: number;
}

export interface ScanRootResult {
	root: string;
	scan: ScanResult;
}

export class Scanner {
	private static instance: Scanner;
	isScanning = false;

	private constructor() {
	}

	public static getInstance(): Scanner {
		if (!Scanner.instance) {
			Scanner.instance = new Scanner();
		}

		return Scanner.instance;
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

	private async getStructureAndFiles(dirPath: string): Promise<ScanResult> {
		const structure: Directory = {
			name: path.basename(dirPath),
			hash: generateHash(dirPath),
			directories: [] as Directory[]
		};

		const filesList: File[] = [];

		const limit = pLimit(__limit); // Limitamos la concurrencia a 4

		const items = await fs.readdir(dirPath, {withFileTypes: true});

		// Creamos una lista de promesas con limitación de concurrencia
		const promises = items.map((item) => limit(async () => {
			const itemPath = path.join(dirPath, item.name);

			if (item.isDirectory()) {
				const subdirectoryStructure = await this.getStructureAndFiles(itemPath);
				structure.directories.push(subdirectoryStructure.directories);
				filesList.push(...subdirectoryStructure.files);
			} else if (item.isFile()) {
				const stats = await fs.stat(itemPath);
				filesList.push({
					name: item.name,
					parentPath: dirPath,
					parentHash: generateHash(dirPath),
					fileHash: generateHash(itemPath, true),
					size: humanFileSize(stats.size, true),
					coverId: uuidv4(),
					fileKind: FileKind.FILE
				});
			}
		}));

		// Esperamos a que todas las promesas se resuelvan
		await Promise.all(promises);

		return {directories: structure, files: filesList};
	}

	private async scanForParticularKindOfFiles(scanResult: ScanResult, dirPath: string): Promise<ScanResult> {
		const {directory, files} = await this._helper(scanResult.directories, scanResult.files, dirPath);

		return {directories: directory, files} as ScanResult;
	}

	private async _helper(
		directory: Directory,
		files: File[],
		dirPath: string
	): Promise<{ directory: Directory; files: File[] }> {

		const directories = directory.directories as Directory[];
		const limit = pLimit(__limit);
		const results: { directory: Directory; fileKind: FileKind }[] = [];

		// Procesamos los directorios en paralelo con limitación de concurrencia
		await Promise.all(directories.map(dir => limit(async () => {
			const directoryPath = path.join(dirPath, dir.name);
			const fileKind = await this.scanForSpecialDirectories(directoryPath);

			if (fileKind !== FileKind.NONE) {
				results.push({directory: dir, fileKind});
			}
		})));

		// Procesamos los resultados
		for (const result of results) {
			const index = directories.findIndex((dir: Directory) => dir.name === result.directory.name);

			if (index > -1) {
				const [specialDirectory] = directories.splice(index, 1);
				logger.info("Special directory:", JSON.stringify(specialDirectory));
				const id = uuidv4();
				files.push({
					name: specialDirectory.name,
					parentPath: dirPath,
					parentHash: generateHash(dirPath),
					fileHash: generateHash(path.join(dirPath, specialDirectory.name)),
					size: await this.getSpecialDirectorySize(path.join(dirPath, specialDirectory.name), id),
					coverId: id,
					fileKind: result.fileKind
				});

				// Eliminamos archivos que estén dentro del directorio especial
				files = files.filter(file => {
					const fileParentPath = path.normalize(file.parentPath);
					const specialDirPath = path.normalize(path.join(dirPath, specialDirectory.name));
					return !fileParentPath.startsWith(specialDirPath);
				});
			}
		}

		// Procesamos subdirectorios recursivamente con limitación de concurrencia
		await Promise.all(directories.map(dir => limit(async () => {
			await this._helper(dir, files, path.join(dirPath, dir.name));
		})));

		return {directory, files};
	}

	private async getSpecialDirectorySize(directoryPath: string, id: string): Promise<string> {
		try {
			const cachePath = path.join(__dirname, "..", "public", "cache", id);
			await fs.mkdir(cachePath, {recursive: true});

			return new Promise((resolve, reject) => {
				const outputFileName = path.join(cachePath, `${id}.zip`);
				const output = fs.createWriteStream(outputFileName);
				const archive = archiver("zip", {
					zlib: {level: 9} // Nivel de compresión
				});

				output.on("close", () => {
					resolve(humanFileSize(archive.pointer(), true)); // Devuelve el tamaño del archivo ZIP en bytes
				});

				archive.on("error", (err) => {
					reject(err); // Rechaza la promesa en caso de error
				});

				archive.pipe(output);
				archive.directory(directoryPath, false);
				archive.finalize();
			});
		} catch (error) {
			logger.error("getSpecialDirectorySize - Error reading directory:", error);

			return "0";
		}
	}

	private async scanForSpecialDirectories(directoryPath: string): Promise<FileKind> {
		const scanners = [
			this.scanForComics.bind(this),
			this.scanForEpubs.bind(this),
			this.scanForAudioBooks.bind(this)
		];

		const limit = pLimit(__limit);

		// Creamos promesas para cada escáner con control de concurrencia
		const scannerPromises = scanners.map(scanner => limit(async () => {
			const fileKind = await scanner(directoryPath);
			if (fileKind !== FileKind.NONE) {
				return fileKind;
			} else {
				// Rechazamos la promesa si no se encuentra un resultado válido
				throw new Error("No match");
			}
		}));

		try {
			// Usamos Promise.any para retornar el primer resultado válido
			return await Promise.any(scannerPromises);
		} catch (error) {
			// Si todos los escáneres fallan, retornamos FileKind.NONE
			return FileKind.NONE;
		}
	}

	private async scanForComics(directoryPath: string): Promise<FileKind> {
		return await this.scanForFolderOfFormat(directoryPath, ["jpg", "jpeg", "png", "webp", "gif"], FileKind.COMIC_MANGA);
	}

	private async scanForAudioBooks(directoryPath: string): Promise<FileKind> {
		return await this.scanForFolderOfFormat(directoryPath, ["mp3", "wav", "m4a", "m4b", "ogg"], FileKind.AUDIOBOOK, false);
	}

	private async scanForFolderOfFormat(directoryPath: string, extensions: string[], format: FileKind, strict: boolean = true): Promise<FileKind> {
		const allowedExtensions = new Set(extensions || []);
		let foundExtension: string | undefined = undefined;

		try {
			const limit = pLimit(__limit);
			const items = await fs.readdir(directoryPath, {withFileTypes: true});

			if (!items.length) {
				return FileKind.NONE; // El directorio está vacío
			}

			const promises = items.map(item => limit(async () => {
				if (!item.isFile()) {
					// logger.error(`scanForFolderOfFormat - "${item.name}" is not a file.`);
					throw new Error(`"${item.name}" is not a file.`);
				}

				const extension = path.extname(item.name).toLowerCase().slice(1);

				if (!allowedExtensions.has(extension)) {
					// logger.error(`scanForFolderOfFormat - "${item.name}" has an invalid extension.`);
					throw new Error(`"${item.name}" has an invalid extension.`);
				}

				if (!foundExtension) {
					foundExtension = extension;
				} else if (foundExtension !== extension && strict) {
					// logger.error(`scanForFolderOfFormat - "${item.name}" has a different extension of "${foundExtension}".`);
					throw new Error(`"${item.name}" has a different extension.`);
				}
			}));

			// Esperamos a que todas las promesas se resuelvan
			await Promise.all(promises);

			return format;
		} catch (error) {
			if (debugLogs) {
				logger.error("scanForFolderOfFormat:", error.message);
			}
			return FileKind.NONE;
		}
	}

	private async scanForEpubs(directoryPath: string): Promise<FileKind> {
		try {
			// 1. Verificar el archivo mimetype de forma asíncrona
			const mimetypePath = path.join(directoryPath, "mimetype");
			const mimetypeExists = await fs.pathExists(mimetypePath);

			if (!mimetypeExists) {
				// logger.error(`scanForEpubs - "${mimetypePath}" does not exist.`);
				return FileKind.NONE;
			}

			const mimetypeContent = (await fs.readFile(mimetypePath, "utf-8")).trim();
			if (mimetypeContent !== "application/epub+zip") {
				// logger.error(`scanForEpubs - "${mimetypePath}" has invalid content.`);
				return FileKind.NONE;
			}

			// 2. Verificar el directorio META-INF y el archivo container.xml de forma asíncrona
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
				const rootFile = parsedXml.container?.rootfiles?.[0]?.rootfile?.[0];
				if (rootFile && rootFile.$ && rootFile.$["full-path"]) {
					opfFilePath = rootFile.$["full-path"];
				} else {
					// logger.error(`scanForEpubs - "${containerXmlPath}" does not contain a valid .opf file path.`);
					return FileKind.NONE;
				}
			} catch (error) {
				// logger.error(`scanForEpubs - Error parsing "${containerXmlPath}":`, error);
				return FileKind.NONE;
			}

			// 4. Verificar la existencia del archivo .opf
			if (!opfFilePath) {
				// logger.error(`scanForEpubs - No .opf file path found in "${containerXmlPath}".`);
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
}
