import fs from "fs-extra";
import path from "path";
import { Dirent } from "fs";

import { config } from "(src)/config/configuration";
import { Logger } from "(src)/helpers/Logger";
import {
	CacheArtifactSnapshotSummary,
	CacheArtifactStateRow
} from "(src)/models/interfaces/CacheArtifactSnapshot";
import { ComicCacheState } from "(src)/models/interfaces/ComicCacheState";
import { CacheArtifactStateRepository } from "(src)/repositories/CacheArtifactStateRepository";
import { ComicCacheStateService } from "(src)/services/ComicCacheStateService";
import { getStatePath, getZipPath } from "(src)/utils/comicCacheUtils";

const logger = new Logger("CacheArtifactSnapshot");

export class CacheArtifactSnapshotService {
	private static instance: CacheArtifactSnapshotService;
	private static readonly progressEvery = 100;

	private constructor() {
	}

	public static getInstance(): CacheArtifactSnapshotService {
		if (!CacheArtifactSnapshotService.instance) {
			CacheArtifactSnapshotService.instance = new CacheArtifactSnapshotService();
		}
		return CacheArtifactSnapshotService.instance;
	}

	public async rebuildSnapshotFromCache(): Promise<CacheArtifactSnapshotSummary> {
		const startedAt = Date.now();
		const cacheRoot = config.production.paths.cache;

		if (!(await fs.pathExists(cacheRoot))) {
			const published = await CacheArtifactStateRepository.getInstance().replaceSnapshot([]);
			logger.info(
				`Phase 5 — cache artifact state snapshot complete completed="0/0" rows="0" readerReady="0" partial="0" error="0" zipOnly="0" legacy="0" published="${published}" elapsedMs="${Date.now() - startedAt}".`
			);
			return {
				totalCacheDirs: 0,
				rows: 0,
				readerReady: 0,
				partialReady: 0,
				errorStates: 0,
				zipOnly: 0,
				legacyReaderReady: 0,
				published,
				elapsedMs: Date.now() - startedAt
			};
		}

		const entries = await fs.readdir(cacheRoot, {withFileTypes: true});
		const cacheDirs = entries
			.filter((entry: Dirent) => entry.isDirectory())
			.map((entry: Dirent) => entry.name)
			.filter((entryName: string) => entryName !== ".scanner-build")
		;
		logger.info(`Phase 5 — cache artifact state snapshot totalCacheDirs="${cacheDirs.length}".`);

		const rows: CacheArtifactStateRow[] = [];
		let readerReady = 0;
		let partialReady = 0;
		let errorStates = 0;
		let zipOnly = 0;
		let legacyReaderReady = 0;

		for (let index = 0; index < cacheDirs.length; index++) {
			const coverId = cacheDirs[index];
			const row = await this.buildRow(coverId, path.join(cacheRoot, coverId));
			rows.push(row);

			if (row.readerReady) {
				readerReady++;
				if (row.buildOutcome === "partial") {
					partialReady++;
				}
				if (!row.lastError && !row.buildOutcome && row.status === "ready") {
					legacyReaderReady++;
				}
			} else if (row.status === "error") {
				errorStates++;
			}

			if (!row.readerReady && row.zipReady && !row.status) {
				zipOnly++;
			}

			const completed = index + 1;
			if (completed === cacheDirs.length || completed % CacheArtifactSnapshotService.progressEvery === 0) {
				logger.info(
					`cache-artifact-snapshot:progress completed="${completed}/${cacheDirs.length}" rows="${rows.length}" readerReady="${readerReady}" partial="${partialReady}" error="${errorStates}" zipOnly="${zipOnly}" legacy="${legacyReaderReady}" coverId="${coverId}".`
				);
			}
		}

		const published = await CacheArtifactStateRepository.getInstance().replaceSnapshot(rows);
		const elapsedMs = Date.now() - startedAt;
		logger.info(
			`Phase 5 — cache artifact state snapshot complete completed="${cacheDirs.length}/${cacheDirs.length}" rows="${rows.length}" readerReady="${readerReady}" partial="${partialReady}" error="${errorStates}" zipOnly="${zipOnly}" legacy="${legacyReaderReady}" published="${published}" elapsedMs="${elapsedMs}".`
		);

		return {
			totalCacheDirs: cacheDirs.length,
			rows: rows.length,
			readerReady,
			partialReady,
			errorStates,
			zipOnly,
			legacyReaderReady,
			published,
			elapsedMs
		};
	}

	private async buildRow(coverId: string, cacheDir: string): Promise<CacheArtifactStateRow> {
		const now = new Date().toISOString();
		const entries = await fs.readdir(cacheDir, {withFileTypes: true});
		const fileNames = entries
			.filter((entry: Dirent) => entry.isFile())
			.map((entry: Dirent) => entry.name)
		;
		const zipReady = fileNames.includes(path.basename(getZipPath(coverId, cacheDir)));
		const chunkIndices = this.collectChunkIndices(coverId, fileNames);
		const hasStateFile = fileNames.includes(path.basename(getStatePath(coverId, cacheDir)));

		if (hasStateFile) {
			const state = await ComicCacheStateService.getInstance().read(getStatePath(coverId, cacheDir));
			if (state) {
				return this.buildRowFromState(coverId, state, chunkIndices, zipReady, now);
			}

			return {
				coverId,
				readerReady: false,
				zipReady,
				status: "error",
				buildOutcome: undefined,
				chunkCount: chunkIndices.length || undefined,
				totalPages: undefined,
				updatedAt: now,
				lastError: "Invalid _scanner_state.json"
			};
		}

		const legacyReaderReady = this.hasExpectedChunkSet(chunkIndices.length, chunkIndices);

		return {
			coverId,
			readerReady: legacyReaderReady,
			zipReady,
			status: legacyReaderReady ? "ready" : undefined,
			buildOutcome: undefined,
			chunkCount: legacyReaderReady ? chunkIndices.length : undefined,
			totalPages: undefined,
			updatedAt: now,
			lastError: undefined
		};
	}

	private buildRowFromState(
		coverId: string,
		state: ComicCacheState,
		chunkIndices: number[],
		zipReady: boolean,
		fallbackUpdatedAt: string
	): CacheArtifactStateRow {
		const normalizedBuildOutcome = state.status === "ready"
			? (state.buildOutcome || "complete")
			: undefined
		;
		const readerReady = state.status === "ready"
			&& state.chunksReady
			&& state.chunkCount > 0
			&& state.totalPages > 0
			&& this.hasExpectedChunkSet(state.chunkCount, chunkIndices)
		;

		return {
			coverId,
			readerReady,
			zipReady,
			status: state.status,
			buildOutcome: normalizedBuildOutcome,
			chunkCount: state.chunkCount || undefined,
			totalPages: state.totalPages || undefined,
			updatedAt: state.updatedAt || fallbackUpdatedAt,
			lastError: state.lastError || undefined
		};
	}

	private collectChunkIndices(coverId: string, fileNames: string[]): number[] {
		const pattern = new RegExp(`^${this.escapeRegex(coverId)}_(\\d+)\\.cache$`);
		return fileNames
			.map((fileName: string) => {
				const match = fileName.match(pattern);
				return match ? Number.parseInt(match[1], 10) : undefined;
			})
			.filter((index: number | undefined): index is number => Number.isInteger(index) && index >= 0)
			.sort((left: number, right: number) => left - right)
		;
	}

	private hasExpectedChunkSet(expectedCount: number, chunkIndices: number[]): boolean {
		if (expectedCount < 1) {
			return false;
		}

		const chunkIndexSet = new Set(chunkIndices);
		for (let index = 0; index < expectedCount; index++) {
			if (!chunkIndexSet.has(index)) {
				return false;
			}
		}

		return true;
	}

	private escapeRegex(value: string): string {
		return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	}
}
