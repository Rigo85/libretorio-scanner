import fs from "fs-extra";
import path from "path";

import { Logger } from "(src)/helpers/Logger";
import { config } from "(src)/config/configuration";
import { humanFileSize } from "(src)/utils/fileUtils";
import { ComicCacheBuildResult } from "(src)/models/interfaces/ComicCacheBuildResult";
import { EligibleComicSource } from "(src)/models/interfaces/EligibleComicSource";
import { ComicCacheStateService } from "(src)/services/ComicCacheStateService";
import { NativeComicCacheWorkerService } from "(src)/services/NativeComicCacheWorkerService";
import {
	collectSortedDirectoryImages,
	createCacheStagingDir,
	cleanupStagingDir,
	generateDirectoryZipArtifact,
	getZipPath,
	getStatePath,
	ImageFileEntry,
	promoteStagingCache,
	validateChunkCache,
	writeChunksFromFiles
} from "(src)/utils/comicCacheUtils";
import { FileRepository } from "(src)/repositories/FileRepository";

const logger = new Logger("ComicChunkCache");

interface CollectedSourceImages {
	imageFiles: ImageFileEntry[];
	tempDir?: string;
}

export class ComicChunkCacheService {
	private static instance: ComicChunkCacheService;

	private constructor() {
	}

	public static getInstance(): ComicChunkCacheService {
		if (!ComicChunkCacheService.instance) {
			ComicChunkCacheService.instance = new ComicChunkCacheService();
		}
		return ComicChunkCacheService.instance;
	}

	public async ensureCacheForSources(
		sources: EligibleComicSource[],
		options?: { concurrency?: number }
	): Promise<ComicCacheBuildResult[]> {
		const concurrency = options?.concurrency ?? 1;
		const uniqueSources = Array.from(new Map(sources.map((source) => [source.coverId, source])).values());
		const results: ComicCacheBuildResult[] = [];
		let pointer = 0;
		let completed = 0;
		let readyCount = 0;
		let skippedCount = 0;
		let errorCount = 0;

		const worker = async (): Promise<void> => {
			while (pointer < uniqueSources.length) {
				const index = pointer++;
				const source = uniqueSources[index];
				const result = await this.ensureCacheForSource(source);
				results.push(result);
				completed++;
				if (result.status === "ready") {
					readyCount++;
				} else if (result.status === "skipped") {
					skippedCount++;
				} else if (result.status === "error") {
					errorCount++;
				}
				logger.info(
					`cache-build:progress completed="${completed}/${uniqueSources.length}" ready="${readyCount}" skipped="${skippedCount}" error="${errorCount}" coverId="${source.coverId}".`
				);
			}
		};

		await Promise.all(Array.from({length: Math.min(concurrency, uniqueSources.length)}, worker));
		return results;
	}

	public async ensureCacheForSource(source: EligibleComicSource): Promise<ComicCacheBuildResult> {
		const start = Date.now();
		const validation = await validateChunkCache(source.coverId, source.requiresZipArtifact);

		if (validation.valid) {
			logger.info(
				`skip-ready coverId="${source.coverId}" chunks="${validation.chunkCount}" pages="${validation.totalPages}" path="${source.sourcePath}".`
			);

			return {
				coverId: source.coverId,
				status: "skipped",
				totalPages: validation.totalPages,
				chunkCount: validation.chunkCount,
				elapsedMs: Date.now() - start
			};
		}

		logger.info(
			`cache-build:start coverId="${source.coverId}" type="${source.sourceType}" format="${source.archiveFormat || ""}" path="${source.sourcePath}".`
		);

		const stagingDir = await createCacheStagingDir(source.coverId);
		const statePath = getStatePath(source.coverId, stagingDir);
		let sourceTempDir: string | undefined = undefined;

		try {
			await ComicCacheStateService.getInstance().markBuilding(statePath, source);

			let zipPath: string | undefined = undefined;
			let zipSize = "";

			if (source.requiresZipArtifact) {
				const zipResult = await generateDirectoryZipArtifact(source.sourcePath, source.coverId, stagingDir);
				zipPath = getZipPath(source.coverId);
				zipSize = humanFileSize(zipResult.sizeBytes, true);
				logger.info(`cache-build:zip-ready coverId="${source.coverId}" size="${zipSize}".`);
			}

			const collected = await this.collectSourceImages(source);
			sourceTempDir = collected.tempDir;
			const imageFiles = collected.imageFiles;

			if (!imageFiles.length) {
				throw new Error("No image pages found to build chunk cache.");
			}

			const chunkWriteResult = await writeChunksFromFiles(imageFiles, source.coverId, undefined, stagingDir);

			await ComicCacheStateService.getInstance().markReady(statePath, source, {
				chunkCount: chunkWriteResult.chunkCount,
				totalPages: chunkWriteResult.totalPages,
				zipReady: source.requiresZipArtifact
			});

			const stagingValidation = await validateChunkCache(source.coverId, source.requiresZipArtifact, stagingDir);
			if (!stagingValidation.valid) {
				throw new Error(`Generated chunk cache is invalid for "${source.sourcePath}".`);
			}

			await promoteStagingCache(source.coverId, stagingDir);

			if (source.requiresZipArtifact) {
				const finalZipStats = await fs.stat(getZipPath(source.coverId));
				zipSize = humanFileSize(finalZipStats.size, true);
			}

			if (source.requiresZipArtifact && source.dbId) {
				await FileRepository.getInstance().updateSpecialArchiveSize(source.dbId, zipSize);
			}

			logger.info(
				`cache-build:complete coverId="${source.coverId}" chunks="${chunkWriteResult.chunkCount}" pages="${chunkWriteResult.totalPages}" elapsedMs="${Date.now() - start}".`
			);

			return {
				coverId: source.coverId,
				status: "ready",
				totalPages: chunkWriteResult.totalPages,
				chunkCount: chunkWriteResult.chunkCount,
				zipPath,
				elapsedMs: Date.now() - start
			};
		} catch (error) {
			await cleanupStagingDir(stagingDir);

			logger.error(`cache-build:error coverId="${source.coverId}" path="${source.sourcePath}":`, error);

			return {
				coverId: source.coverId,
				status: "error",
				totalPages: 0,
				chunkCount: 0,
				error: error instanceof Error ? error.message : String(error),
				elapsedMs: Date.now() - start
			};
		} finally {
			if (sourceTempDir) {
				await fs.rm(sourceTempDir, {recursive: true, force: true});
			}
		}
	}

	private async collectSourceImages(source: EligibleComicSource): Promise<CollectedSourceImages> {
		if (config.production.scan.cacheResize.enabled) {
			return this.collectWorkerSourceImages(source);
		}

		if (source.sourceType === "directory") {
			return {
				imageFiles: await collectSortedDirectoryImages(source.sourcePath)
			};
		}

		return await this.collectLegacyArchiveImages(source);
	}

	private async collectWorkerSourceImages(source: EligibleComicSource): Promise<CollectedSourceImages> {
		const extraction = await NativeComicCacheWorkerService.getInstance().extractSourceToOrderedRaw(source);
		logger.info(
			`cache-build:source-raw-ready coverId="${source.coverId}" type="${source.sourceType}" backend="${extraction.detectedBackend || source.archiveFormat || ""}" pages="${extraction.totalPages || 0}" manifest="${extraction.manifestPath || ""}".`
		);

		const imageFiles = await collectSortedDirectoryImages(extraction.rawDir);
		this.validateWorkerExtraction(source, extraction, imageFiles);
		return {
			imageFiles,
			tempDir: extraction.tempDir
		};
	}

	private validateWorkerExtraction(
		source: EligibleComicSource,
		extraction: {
			manifestPath?: string;
			manifest?: {
				status?: string;
				totalPages?: number;
				pages?: Array<{ index: number; raw: string }>;
			};
		},
		imageFiles: Array<{ filePath: string }>
	): void {
		if (!extraction.manifestPath || !extraction.manifest) {
			throw new Error(`Worker manifest is required for resize-enabled source "${source.sourcePath}".`);
		}

		const manifest = extraction.manifest;
		if (manifest.status !== "complete") {
			throw new Error(`Worker manifest is not complete for "${source.sourcePath}".`);
		}

		if (!Array.isArray(manifest.pages) || manifest.pages.length < 1) {
			throw new Error(`Worker manifest contains no pages for "${source.sourcePath}".`);
		}

		if (imageFiles.length !== manifest.pages.length) {
			throw new Error(
				`Worker raw image count mismatch for "${source.sourcePath}": raw="${imageFiles.length}" manifest="${manifest.pages.length}".`
			);
		}

		if (manifest.totalPages !== undefined && manifest.totalPages !== manifest.pages.length) {
			throw new Error(
				`Worker manifest totalPages mismatch for "${source.sourcePath}": total="${manifest.totalPages}" pages="${manifest.pages.length}".`
			);
		}

		const actualNames = new Set(imageFiles.map((image) => path.basename(image.filePath)));
		for (const page of manifest.pages) {
			const rawName = path.basename(page.raw || "");
			if (!rawName || !actualNames.has(rawName)) {
				throw new Error(`Worker manifest page is missing on disk for "${source.sourcePath}": "${page.raw}".`);
			}
		}
	}

	private async collectArchiveImages(source: EligibleComicSource) {
		if (!source.archiveFormat) {
			throw new Error(`Missing archive format for "${source.sourcePath}".`);
		}

		const extraction = await NativeComicCacheWorkerService.getInstance().extractArchiveToOrderedRaw(
			source.sourcePath,
			source.coverId,
			source.archiveFormat
		);
		logger.info(
			`cache-build:archive-raw-ready coverId="${source.coverId}" backend="${extraction.detectedBackend || source.archiveFormat}" pages="${extraction.totalPages || 0}" manifest="${extraction.manifestPath || ""}".`
		);

		return {
			imageFiles: await collectSortedDirectoryImages(extraction.rawDir),
			tempDir: extraction.tempDir
		};
	}

	private async collectLegacyArchiveImages(source: EligibleComicSource): Promise<CollectedSourceImages> {
		return this.collectArchiveImages(source);
	}
}
