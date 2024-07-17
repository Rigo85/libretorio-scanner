import fs from "fs";
import path from "path";
import { v4 as uuidv4 } from "uuid";

import { Logger } from "(src)/helpers/Logger";
import { generateHash, File, Directory, humanFileSize } from "(src)/helpers/FileUtils";

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
			result = {
				root: rootPath,
				scan: await this.getStructureAndFiles(rootPath)
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
					coverId: uuidv4()
				});
			}
		}

		return {directories: structure, files: filesList};
	};
}
