import fs from "fs-extra";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it, jest } from "@jest/globals";

import { config } from "(src)/config/configuration";
import { CacheArtifactStateRow } from "(src)/models/interfaces/CacheArtifactSnapshot";
import { CacheArtifactStateRepository } from "(src)/repositories/CacheArtifactStateRepository";
import { CacheArtifactSnapshotService } from "(src)/services/CacheArtifactSnapshotService";
import { ComicCacheState } from "(src)/models/interfaces/ComicCacheState";
import { getChunkPath, getStatePath, getZipPath } from "(src)/utils/comicCacheUtils";

describe("CacheArtifactSnapshotService", () => {
	let service: CacheArtifactSnapshotService;
	let originalCachePath: string;
	const tempCacheRoots: string[] = [];

	beforeEach(() => {
		service = CacheArtifactSnapshotService.getInstance();
		originalCachePath = config.production.paths.cache;
	});

	afterEach(async () => {
		config.production.paths.cache = originalCachePath;
		jest.restoreAllMocks();
		while (tempCacheRoots.length) {
			await fs.rm(tempCacheRoots.pop()!, {recursive: true, force: true});
		}
	});

	it("builds and publishes cache artifact rows from state files, zip-only dirs, legacy chunks and malformed state", async () => {
		const cacheRoot = await fs.mkdtemp(path.join(os.tmpdir(), "libretorio-cache-snapshot-"));
		tempCacheRoots.push(cacheRoot);
		config.production.paths.cache = cacheRoot;

		await fs.ensureDir(path.join(cacheRoot, ".scanner-build"));

		await createReadyState("cover-ready-complete", {
			status: "ready",
			buildOutcome: "complete",
			chunkCount: 2,
			totalPages: 20,
			zipReady: false,
			chunksReady: true,
			updatedAt: "2026-04-08T12:00:00.000Z"
		});
		await createReadyState("cover-ready-partial", {
			status: "ready",
			buildOutcome: "partial",
			chunkCount: 3,
			totalPages: 30,
			zipReady: true,
			chunksReady: true,
			updatedAt: "2026-04-08T12:05:00.000Z"
		});
		await fs.writeFile(getZipPath("cover-ready-partial"), "zip");

		await createReadyState("cover-error", {
			status: "error",
			chunkCount: 0,
			totalPages: 0,
			zipReady: false,
			chunksReady: false,
			lastError: "worker exited with code 2"
		});

		await fs.ensureDir(path.join(cacheRoot, "cover-zip-only"));
		await fs.writeFile(getZipPath("cover-zip-only"), "zip");

		await fs.ensureDir(path.join(cacheRoot, "cover-legacy"));
		await fs.writeFile(getChunkPath("cover-legacy", 0), "{\"index\":0}");
		await fs.writeFile(getChunkPath("cover-legacy", 1), "{\"index\":1}");

		await fs.ensureDir(path.join(cacheRoot, "cover-malformed"));
		await fs.writeFile(getStatePath("cover-malformed"), "{broken");

		const replaceSnapshotSpy = jest.spyOn(CacheArtifactStateRepository.getInstance(), "replaceSnapshot")
			.mockResolvedValue(true);

		const summary = await service.rebuildSnapshotFromCache();

		expect(replaceSnapshotSpy).toHaveBeenCalledTimes(1);
		const rows = replaceSnapshotSpy.mock.calls[0][0] as CacheArtifactStateRow[];
		expect(rows).toHaveLength(6);
		expect(rows).toEqual(expect.arrayContaining([
			expect.objectContaining({
				coverId: "cover-ready-complete",
				readerReady: true,
				zipReady: false,
				status: "ready",
				buildOutcome: "complete",
				chunkCount: 2,
				totalPages: 20
			}),
			expect.objectContaining({
				coverId: "cover-ready-partial",
				readerReady: true,
				zipReady: true,
				status: "ready",
				buildOutcome: "partial",
				chunkCount: 3,
				totalPages: 30
			}),
			expect.objectContaining({
				coverId: "cover-error",
				readerReady: false,
				zipReady: false,
				status: "error",
				lastError: "worker exited with code 2"
			}),
			expect.objectContaining({
				coverId: "cover-zip-only",
				readerReady: false,
				zipReady: true,
				status: undefined,
				buildOutcome: undefined
			}),
			expect.objectContaining({
				coverId: "cover-legacy",
				readerReady: true,
				zipReady: false,
				status: "ready",
				buildOutcome: undefined,
				chunkCount: 2
			}),
			expect.objectContaining({
				coverId: "cover-malformed",
				readerReady: false,
				zipReady: false,
				status: "error",
				lastError: "Invalid _scanner_state.json"
			})
		]));
		expect(summary).toEqual(expect.objectContaining({
			totalCacheDirs: 6,
			rows: 6,
			readerReady: 3,
			partialReady: 1,
			errorStates: 2,
			zipOnly: 1,
			legacyReaderReady: 1,
			published: true
		}));
	});
});

async function createReadyState(
	coverId: string,
	overrides: Partial<ComicCacheState>
): Promise<void> {
	const now = "2026-04-08T11:59:00.000Z";
	const state: ComicCacheState = {
		version: 1,
		sourcePath: `/library/${coverId}.cbz`,
		sourceType: "archive-file",
		archiveFormat: "zip",
		fileHash: `hash-${coverId}`,
		createdAt: now,
		updatedAt: now,
		status: "ready",
		buildOutcome: "complete",
		chunkCount: 1,
		totalPages: 1,
		zipReady: false,
		chunksReady: true,
		...overrides
	};

	await fs.ensureDir(path.dirname(getStatePath(coverId)));
	await fs.writeJson(getStatePath(coverId), state);

	for (let index = 0; index < (state.chunkCount || 0); index++) {
		await fs.writeFile(getChunkPath(coverId, index), `{"index":${index}}`);
	}
}
