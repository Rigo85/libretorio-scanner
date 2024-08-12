import fs from "fs";
import path from "path";
import { v4 as uuidv4 } from "uuid";
import { parseStringPromise } from "xml2js";
import archiver from "archiver";

import { Logger } from "(src)/helpers/Logger";
import { Directory, File, FileKind, generateHash, humanFileSize } from "(src)/helpers/FileUtils";

const logger = new Logger("Scanner");

export interface ScanResult {
	directories: Directory;
	files: File[];
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

		const filesList = [] as File[];

		const items = fs.readdirSync(dirPath);

		for (const item of items) {
			const itemPath = path.join(dirPath, item);
			const stats = fs.statSync(itemPath);

			if (stats.isDirectory()) {
				const subdirectoryStructure = await this.getStructureAndFiles(itemPath);
				structure.directories.push(subdirectoryStructure.directories);
				filesList.push(...subdirectoryStructure.files);
			} else if (stats.isFile()) {
				filesList.push({
					name: item,
					parentPath: dirPath,
					parentHash: generateHash(dirPath),
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

	private async _helper(
		directory: Directory,
		files: File[],
		dirPath: string
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
					size: await this.getSpecialDirectorySize(path.join(dirPath, specialDirectory.name), id), // compactar la carpeta y obtener el peso, ese compactado será la descarga.
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

	private async getSpecialDirectorySize(directoryPath: string, id: string): Promise<string> {
		try {
			const cachePath = path.join(__dirname, "..", "public", "cache", id);
			fs.mkdirSync(cachePath, {recursive: true});

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
			this.scanForComics,
			this.scanForEpubs
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
		const allowedExtensions = new Set(["jpg", "jpeg", "png", "webp", "gif"]);
		let foundExtension: string = undefined;

		try {
			const files = fs.readdirSync(directoryPath);

			for (const file of files) {
				const filePath = path.join(directoryPath, file);
				const stat = fs.statSync(filePath);

				if (!stat.isFile()) {
					logger.error(`scanForComics - "${filePath}" is not a file.`);

					return FileKind.NONE; // No es un archivo
				}

				const extension = path.extname(file).toLowerCase().slice(1);

				if (!allowedExtensions.has(extension)) {
					logger.error(`scanForComics - "${file}" has an invalid extension.`);

					return FileKind.NONE; // Extensión no permitida
				}

				if (!foundExtension) {
					foundExtension = extension;
				} else if (foundExtension !== extension) {
					logger.error(`scanForComics - "${file}" has a different extension of "${foundExtension || "none"}".`);

					return FileKind.NONE; // Las extensiones no coinciden
				}
			}

			return files.length ? FileKind.COMIC_MANGA : FileKind.NONE;
		} catch (error) {
			logger.error("scanForComics - Error reading directory:", error);

			return FileKind.NONE;
		}
	}

	private async scanForEpubs(directoryPath: string): Promise<FileKind> {
		try {
			// 1. Verificar el archivo mimetype
			const mimetypePath = path.join(directoryPath, "mimetype");
			if (!fs.existsSync(mimetypePath)) {
				logger.error(`scanForEpubs - "${mimetypePath}" does not exist.`);

				return FileKind.NONE;
			}
			const mimetypeContent = fs.readFileSync(mimetypePath, "utf-8").trim();
			if (mimetypeContent !== "application/epub+zip") {
				logger.error(`scanForEpubs - "${mimetypePath}" has an invalid content.`);

				return FileKind.NONE;
			}

			// 2. Verificar el directorio META-INF y el archivo container.xml
			const metaInfPath = path.join(directoryPath, "META-INF");
			const containerXmlPath = path.join(metaInfPath, "container.xml");
			if (!fs.existsSync(containerXmlPath)) {
				logger.error(`scanForEpubs - "${containerXmlPath}" does not exist.`);

				return FileKind.NONE;
			}

			// 3. Leer y analizar el archivo container.xml para encontrar el archivo .opf
			const containerXmlContent = fs.readFileSync(containerXmlPath, "utf-8");
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
				logger.error(`scanForEpubs - Error parsing "${containerXmlPath}":`, error);

				return FileKind.NONE;
			}

			// 4. Verificar la existencia del archivo .opf
			if (!opfFilePath) {
				logger.error(`scanForEpubs - "${containerXmlPath}" does not contain a valid .opf file path.`);
				return FileKind.NONE;
			}

			const opfAbsolutePath = path.join(directoryPath, opfFilePath);
			if (!fs.existsSync(opfAbsolutePath)) {
				logger.error(`scanForEpubs - "${opfAbsolutePath}" does not exist.`);

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
