import fs from "fs-extra";

import { Logger } from "(src)/helpers/Logger";
import { File, FileKind } from "(src)/models/interfaces/File";
import { FileRepository } from "(src)/repositories/FileRepository";
import {
	createCacheStagingDir,
	cleanupStagingDir,
	generateDirectoryZipArtifact,
	getZipPath,
	promoteStagingCache,
	validateZipArtifact
} from "(src)/utils/comicCacheUtils";
import { humanFileSize } from "(src)/utils/fileUtils";

const logger = new Logger("SpecialDirectoryArtifact");

export interface SpecialDirectoryArtifactResult {
	coverId: string;
	status: "ready" | "skipped" | "error";
	size?: string;
	zipPath?: string;
	error?: string;
	elapsedMs: number;
}

export class SpecialDirectoryArtifactService {
	private static instance: SpecialDirectoryArtifactService;

	private constructor() {
	}

	public static getInstance(): SpecialDirectoryArtifactService {
		if (!SpecialDirectoryArtifactService.instance) {
			SpecialDirectoryArtifactService.instance = new SpecialDirectoryArtifactService();
		}
		return SpecialDirectoryArtifactService.instance;
	}

	public static isZipOnlySpecialDirectory(file: File): boolean {
		return file.fileKind !== FileKind.FILE && file.fileKind !== FileKind.NONE && file.fileKind !== FileKind.COMIC_MANGA;
	}

	public async ensureArtifactsForFiles(
		files: File[],
		options?: { concurrency?: number }
	): Promise<SpecialDirectoryArtifactResult[]> {
		const concurrency = options?.concurrency ?? 1;
		const uniqueFiles = Array.from(new Map(files.map((file) => [file.coverId, file])).values());
		const results: SpecialDirectoryArtifactResult[] = [];
		let pointer = 0;
		let completed = 0;
		let readyCount = 0;
		let skippedCount = 0;
		let errorCount = 0;

		const worker = async (): Promise<void> => {
			while (pointer < uniqueFiles.length) {
				const file = uniqueFiles[pointer++];
				const result = await this.ensureArtifactForFile(file);
				results.push(result);
				completed++;

				if (result.status === "ready") {
					readyCount++;
				} else if (result.status === "skipped") {
					skippedCount++;
				} else {
					errorCount++;
				}

				logger.info(
					`artifact-progress completed="${completed}/${uniqueFiles.length}" ready="${readyCount}" skipped="${skippedCount}" error="${errorCount}" coverId="${file.coverId}".`
				);
			}
		};

		await Promise.all(Array.from({length: Math.min(concurrency, uniqueFiles.length)}, worker));
		return results;
	}

	public async ensureArtifactForFile(file: File): Promise<SpecialDirectoryArtifactResult> {
		const start = Date.now();
		const sourcePath = `${file.parentPath}/${file.name}`;
		const zipPath = getZipPath(file.coverId);

		if (!SpecialDirectoryArtifactService.isZipOnlySpecialDirectory(file)) {
			return {
				coverId: file.coverId,
				status: "skipped",
				elapsedMs: Date.now() - start
			};
		}

		try {
			if (await validateZipArtifact(zipPath)) {
				const stats = await fs.stat(zipPath);
				const size = humanFileSize(stats.size, true);
				await this.updateSpecialDirectorySizeIfNeeded(file, size);
				logger.info(`artifact-skip-ready coverId="${file.coverId}" kind="${file.fileKind}" size="${size}" path="${sourcePath}".`);

				return {
					coverId: file.coverId,
					status: "skipped",
					size,
					zipPath,
					elapsedMs: Date.now() - start
				};
			}

			if (await fs.pathExists(zipPath)) {
				logger.info(`artifact-rebuild-invalid coverId="${file.coverId}" kind="${file.fileKind}" path="${sourcePath}".`);
			}

			const stagingDir = await createCacheStagingDir(file.coverId);

			logger.info(`artifact-build:start coverId="${file.coverId}" kind="${file.fileKind}" path="${sourcePath}".`);
			try {
				const zipResult = await generateDirectoryZipArtifact(sourcePath, file.coverId, stagingDir);
				if (!(await validateZipArtifact(zipResult.zipPath))) {
					throw new Error(`Generated zip artifact is invalid for "${sourcePath}".`);
				}

				await promoteStagingCache(file.coverId, stagingDir);
				const stats = await fs.stat(zipPath);
				const size = humanFileSize(stats.size, true);
				await this.updateSpecialDirectorySizeIfNeeded(file, size);
				logger.info(`artifact-build:complete coverId="${file.coverId}" kind="${file.fileKind}" size="${size}" elapsedMs="${Date.now() - start}".`);

				return {
					coverId: file.coverId,
					status: "ready",
					size,
					zipPath,
					elapsedMs: Date.now() - start
				};
			} catch (error) {
				await cleanupStagingDir(stagingDir);
				throw error;
			}
		} catch (error) {
			logger.error(`artifact-build:error coverId="${file.coverId}" kind="${file.fileKind}" path="${sourcePath}":`, error);
			return {
				coverId: file.coverId,
				status: "error",
				error: error instanceof Error ? error.message : String(error),
				elapsedMs: Date.now() - start
			};
		}
	}

	private async updateSpecialDirectorySizeIfNeeded(file: File, size: string): Promise<void> {
		if (!file.id) {
			file.size = size;
			return;
		}

		if (file.size === size) {
			return;
		}

		await FileRepository.getInstance().updateSpecialArchiveSize(file.id, size);
		file.size = size;
	}
}
