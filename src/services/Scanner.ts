import fs from "fs";
import crypto from "crypto";
import path from "path";

import { Logger } from "(src)/helpers/Logger";

const logger = new Logger("Scanner");

export interface Directory {
	name: string;
	hash: string;
	directories: Directory[];
}

export interface File {
	name: string;
	parentPath: string;
	parentHash: string;
	localDetails?: string;
	webDetails?: string;
}

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

	private generateHash(data: string): string {
		return crypto.createHash("sha256").update(data).digest("hex").slice(0, 16);
	};

	private async getStructureAndFiles(dirPath: string): Promise<ScanResult> {
		const structure: Directory = {
			name: path.basename(dirPath),
			hash: this.generateHash(dirPath),
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
					parentHash: this.generateHash(dirPath)
				});
			}
		}

		return {directories: structure, files: filesList};
	};
}
