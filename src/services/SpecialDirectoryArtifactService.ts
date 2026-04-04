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
	validateZipArtifact,
	ZipArtifactProgress
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

interface ArtifactProgressContext {
	itemIndex: number;
	totalItems: number;
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
				const index = pointer++;
				const file = uniqueFiles[index];
				const progress = {
					itemIndex: index + 1,
					totalItems: uniqueFiles.length
				} satisfies ArtifactProgressContext;
				const result = await this.ensureArtifactForFileInternal(file, progress);
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
		return this.ensureArtifactForFileInternal(file, undefined);
	}

	private async ensureArtifactForFileInternal(
		file: File,
		progress?: ArtifactProgressContext
	): Promise<SpecialDirectoryArtifactResult> {
		const start = Date.now();
		const sourcePath = `${file.parentPath}/${file.name}`;
		const zipPath = getZipPath(file.coverId);
		const itemProgress = this.formatItemProgress(progress);

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
				logger.info(`artifact-skip-ready ${itemProgress}coverId="${file.coverId}" kind="${file.fileKind}" size="${size}" path="${sourcePath}".`);

				return {
					coverId: file.coverId,
					status: "skipped",
					size,
					zipPath,
					elapsedMs: Date.now() - start
				};
			}

			if (await fs.pathExists(zipPath)) {
				logger.info(`artifact-rebuild-invalid ${itemProgress}coverId="${file.coverId}" kind="${file.fileKind}" path="${sourcePath}".`);
			}

			const stagingDir = await createCacheStagingDir(file.coverId);

			logger.info(`artifact-build:start ${itemProgress}coverId="${file.coverId}" kind="${file.fileKind}" path="${sourcePath}".`);
			try {
				let lastEntriesProcessed = 0;
				let lastBytesProcessed = 0;
				const zipResult = await generateDirectoryZipArtifact(sourcePath, file.coverId, stagingDir, {
					onProgress: async (zipProgress) => {
						if (!this.shouldLogZipProgress(zipProgress, lastEntriesProcessed, lastBytesProcessed)) {
							return;
						}

						lastEntriesProcessed = zipProgress.entriesProcessed;
						lastBytesProcessed = zipProgress.bytesProcessed;
						logger.info(
							`artifact-zip-progress ${itemProgress}coverId="${file.coverId}" kind="${file.fileKind}" entries="${zipProgress.entriesProcessed}/${zipProgress.entriesTotal || -1}" bytes="${humanFileSize(zipProgress.bytesProcessed, true)}/${humanFileSize(zipProgress.bytesTotal, true)}".`
						);
					}
				});
				if (!(await validateZipArtifact(zipResult.zipPath))) {
					throw new Error(`Generated zip artifact is invalid for "${sourcePath}".`);
				}

				await promoteStagingCache(file.coverId, stagingDir);
				const stats = await fs.stat(zipPath);
				const size = humanFileSize(stats.size, true);
				await this.updateSpecialDirectorySizeIfNeeded(file, size);
				logger.info(`artifact-build:complete ${itemProgress}coverId="${file.coverId}" kind="${file.fileKind}" size="${size}" elapsedMs="${Date.now() - start}".`);

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
			logger.error(`artifact-build:error ${itemProgress}coverId="${file.coverId}" kind="${file.fileKind}" path="${sourcePath}":`, error);
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

	private formatItemProgress(progress?: ArtifactProgressContext): string {
		if (!progress) {
			return "";
		}

		return `item="${progress.itemIndex}/${progress.totalItems}" `;
	}

	private shouldLogZipProgress(
		progress: ZipArtifactProgress,
		lastEntriesProcessed: number,
		lastBytesProcessed: number
	): boolean {
		if (progress.entriesProcessed <= 0 && progress.bytesProcessed <= 0) {
			return false;
		}

		if (progress.entriesProcessed === 1) {
			return true;
		}

		if (progress.entriesTotal > 0 && progress.entriesProcessed >= progress.entriesTotal) {
			return true;
		}

		if (progress.entriesProcessed >= lastEntriesProcessed + 25) {
			return true;
		}

		return progress.bytesProcessed >= lastBytesProcessed + (50 * 1024 * 1024);
	}
}
