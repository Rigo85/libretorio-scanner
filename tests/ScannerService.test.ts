import fs from "fs-extra";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it, jest } from "@jest/globals";

import { config } from "(src)/config/configuration";
import { FileKind } from "(src)/models/interfaces/File";
import { FileRepository } from "(src)/repositories/FileRepository";
import { ScanRootRepository } from "(src)/repositories/ScanRootRepository";
import { CacheArtifactSnapshotService } from "(src)/services/CacheArtifactSnapshotService";
import { ComicChunkCacheService } from "(src)/services/ComicChunkCacheService";
import { ScannerService } from "(src)/services/ScannerService";
import { SpecialDirectoryArtifactService } from "(src)/services/SpecialDirectoryArtifactService";
import * as comicCacheUtils from "(src)/utils/comicCacheUtils";

describe("ScannerService orchestration", () => {
	let scanner: ScannerService;
	let originalCachePath: string;
	const tempCacheRoots: string[] = [];

	beforeEach(() => {
		scanner = ScannerService.getInstance();
		originalCachePath = config.production.paths.cache;
		jest.spyOn(CacheArtifactSnapshotService.getInstance(), "rebuildSnapshotFromCache").mockResolvedValue({
			totalCacheDirs: 0,
			rows: 0,
			readerReady: 0,
			partialReady: 0,
			errorStates: 0,
			zipOnly: 0,
			legacyReaderReady: 0,
			published: true,
			elapsedMs: 0
		});
	});

	afterEach(async () => {
		config.production.paths.cache = originalCachePath;
		jest.restoreAllMocks();
		while (tempCacheRoots.length) {
			await fs.rm(tempCacheRoots.pop()!, {recursive: true, force: true});
		}
	});

	it("logs cache candidate resolution progress when there are no new files", async () => {
		const existingComicFile = {
			id: 21,
			name: "backlog.cbz",
			parentPath: "/library",
			parentHash: "parent-backlog",
			fileHash: "hash-backlog",
			size: "10 MB",
			coverId: "cover-backlog",
			fileKind: FileKind.FILE
		};
		const consoleSpy = jest.spyOn(console, "log").mockImplementation(() => undefined);

		jest.spyOn(ScanRootRepository.getInstance(), "getScanRootByPath")
			.mockResolvedValue({id: 3, path: "/library"} as never);
		jest.spyOn(comicCacheUtils, "cleanupCacheBuildRoot").mockResolvedValue(0);
		jest.spyOn(scanner, "scan").mockResolvedValue({
			root: "/library",
			scan: {
				directories: {
					name: "library",
					hash: "root-hash",
					directories: []
				},
				files: [existingComicFile]
			}
		});
		jest.spyOn(FileRepository.getInstance(), "removeFileByParentHash").mockResolvedValue(0);
		jest.spyOn(FileRepository.getInstance(), "getFilesForCacheBuild").mockResolvedValue([existingComicFile]);
		jest.spyOn(FileRepository.getInstance(), "getAllCoverIds").mockResolvedValue(["cover-backlog"]);
		jest.spyOn(FileRepository.getInstance(), "removeFileByFileHash").mockResolvedValue(0);
		jest.spyOn(ScanRootRepository.getInstance(), "updateScanRoot").mockResolvedValue(undefined as never);
		jest.spyOn(SpecialDirectoryArtifactService.getInstance(), "ensureArtifactsForFiles").mockResolvedValue([]);
		jest.spyOn(ComicChunkCacheService.getInstance(), "ensureCacheForSources").mockResolvedValue([{
			coverId: "cover-backlog",
			status: "skipped",
			totalPages: 12,
			chunkCount: 2,
			elapsedMs: 1
		}]);

		await scanner.scanCompareUpdate("/library");

		const joinedLogs = consoleSpy.mock.calls.map((call) => String(call[0])).join("\n");
		expect(joinedLogs).toContain("Phase 1 complete completed=\"0/0\" metadataCompleted=\"0\" inserted=\"0\" failed=\"0\".");
		expect(joinedLogs).toContain("Preparing cache candidate inputs scanFiles=\"1\" existingDbFiles=\"1\" newInsertedFiles=\"0\".");
		expect(joinedLogs).toContain("Resolving comic cache candidates scope=\"existing\" total=\"1\".");
		expect(joinedLogs).toContain("Candidate resolution progress scope=\"existing\" completed=\"1/1\" eligible=\"1\" readyReused=\"0\" buildCandidates=\"1\" skipped=\"0\" result=\"eligible\" reason=\"direct-comic-extension\" path=\"/library/backlog.cbz\".");
		expect(joinedLogs).toContain("Candidate resolution complete scope=\"existing\" total=\"1\" eligible=\"1\" readyReused=\"0\" buildCandidates=\"1\" skipped=\"0\"");
		expect(joinedLogs).toContain("Resolving comic cache candidates scope=\"new\" total=\"0\".");
		expect(joinedLogs).toContain("Resolving ZIP-only special directories scope=\"existing\" total=\"1\".");
		expect(joinedLogs).toContain("ZIP-only classification progress scope=\"existing\" completed=\"1/1\" selected=\"0\" skipped=\"1\" path=\"/library/backlog.cbz\".");
	});

	it("still resolves metadata and inserts new files even when comic cache is already ready or skipped", async () => {
		const newComicFile = {
			name: "chapter.cbz",
			parentPath: "/library/comics",
			parentHash: "parent-hash",
			fileHash: "file-hash",
			size: "10 MB",
			coverId: "cover-comic",
			fileKind: FileKind.FILE
		};

		jest.spyOn(ScanRootRepository.getInstance(), "getScanRootByPath")
			.mockResolvedValue({id: 5, path: "/library"} as never);
		const cleanupSpy = jest.spyOn(comicCacheUtils, "cleanupCacheBuildRoot").mockResolvedValue(0);
		jest.spyOn(scanner, "scan").mockResolvedValue({
			root: "/library",
			scan: {
				directories: {
					name: "library",
					hash: "root-hash",
					directories: []
				},
				files: [newComicFile]
			}
		});

		jest.spyOn(FileRepository.getInstance(), "removeFileByParentHash").mockResolvedValue(0);
		jest.spyOn(FileRepository.getInstance(), "getFilesForCacheBuild").mockResolvedValue([]);
		jest.spyOn(FileRepository.getInstance(), "getAllCoverIds").mockResolvedValue(["cover-comic"]);
		jest.spyOn(FileRepository.getInstance(), "removeFileByFileHash").mockResolvedValue(0);
		const insertSpy = jest.spyOn(FileRepository.getInstance(), "insertFile").mockResolvedValue(101);
		jest.spyOn(ScanRootRepository.getInstance(), "updateScanRoot").mockResolvedValue(undefined as never);

		const fillLocalSpy = jest.spyOn(scanner as any, "fillLocalDetails");
		fillLocalSpy.mockImplementation(async (file: any) => {
			file.localDetails = "{\"title\":\"chapter\"}";
		});
		const fillWebSpy = jest.spyOn(scanner as any, "fillWebDetails");
		fillWebSpy.mockImplementation(async (file: any) => {
			file.webDetails = "{\"title\":\"chapter\"}";
		});
		const specialArtifactSpy = jest.spyOn(SpecialDirectoryArtifactService.getInstance(), "ensureArtifactsForFiles")
			.mockResolvedValue([]);
		const comicCacheSpy = jest.spyOn(ComicChunkCacheService.getInstance(), "ensureCacheForSources")
			.mockResolvedValue([{
				coverId: "cover-comic",
				status: "skipped",
				totalPages: 12,
				chunkCount: 2,
				elapsedMs: 1
			}]);

		await scanner.scanCompareUpdate("/library");

		expect(fillLocalSpy).toHaveBeenCalledTimes(1);
		expect(fillWebSpy).toHaveBeenCalledTimes(1);
		expect(insertSpy).toHaveBeenCalledTimes(1);
		expect(cleanupSpy).toHaveBeenCalledTimes(1);
		expect(specialArtifactSpy).not.toHaveBeenCalled();
		expect(comicCacheSpy).toHaveBeenCalledTimes(1);
		expect(comicCacheSpy.mock.calls[0][0]).toHaveLength(1);
		expect(comicCacheSpy.mock.calls[0][0][0]).toEqual(expect.objectContaining({
			coverId: "cover-comic",
			sourceType: "archive-file",
			archiveFormat: "zip"
		}));
	});

	it("reuses ready-state caches without sending them to Phase 3", async () => {
		const readyComicFile = {
			id: 31,
			name: "ready.cbz",
			parentPath: "/library/comics",
			parentHash: "parent-ready",
			fileHash: "hash-ready",
			size: "10 MB",
			coverId: "cover-ready",
			fileKind: FileKind.FILE
		};
		const statePath = comicCacheUtils.getStatePath("cover-ready");
		await fs.ensureDir(path.dirname(statePath));
		await fs.writeJson(statePath, {
			version: 1,
			status: "ready",
			sourcePath: "/library/comics/ready.cbz",
			sourceType: "archive-file",
			archiveFormat: "zip",
			fileHash: "hash-ready",
			createdAt: new Date().toISOString(),
			updatedAt: new Date().toISOString(),
			chunkCount: 2,
			totalPages: 20,
			zipReady: false,
			chunksReady: true
		});
		await fs.writeFile(comicCacheUtils.getChunkPath("cover-ready", 0), "{\"index\":0}");
		await fs.writeFile(comicCacheUtils.getChunkPath("cover-ready", 1), "{\"index\":1}");

		const consoleSpy = jest.spyOn(console, "log").mockImplementation(() => undefined);

		jest.spyOn(ScanRootRepository.getInstance(), "getScanRootByPath")
			.mockResolvedValue({id: 7, path: "/library"} as never);
		jest.spyOn(comicCacheUtils, "cleanupCacheBuildRoot").mockResolvedValue(0);
		jest.spyOn(scanner, "scan").mockResolvedValue({
			root: "/library",
			scan: {
				directories: {
					name: "library",
					hash: "root-hash",
					directories: []
				},
				files: [readyComicFile]
			}
		});
		jest.spyOn(FileRepository.getInstance(), "removeFileByParentHash").mockResolvedValue(0);
		jest.spyOn(FileRepository.getInstance(), "getFilesForCacheBuild").mockResolvedValue([readyComicFile]);
		jest.spyOn(FileRepository.getInstance(), "getAllCoverIds").mockResolvedValue(["cover-ready"]);
		jest.spyOn(FileRepository.getInstance(), "removeFileByFileHash").mockResolvedValue(0);
		jest.spyOn(ScanRootRepository.getInstance(), "updateScanRoot").mockResolvedValue(undefined as never);
		jest.spyOn(SpecialDirectoryArtifactService.getInstance(), "ensureArtifactsForFiles").mockResolvedValue([]);
		const comicCacheSpy = jest.spyOn(ComicChunkCacheService.getInstance(), "ensureCacheForSources").mockResolvedValue([]);

		await scanner.scanCompareUpdate("/library");

		expect(comicCacheSpy).not.toHaveBeenCalled();

		const joinedLogs = consoleSpy.mock.calls.map((call) => String(call[0])).join("\n");
		expect(joinedLogs).toContain("Candidate resolution progress scope=\"existing\" completed=\"1/1\" eligible=\"1\" readyReused=\"1\" buildCandidates=\"0\" skipped=\"0\" result=\"eligible\" reason=\"ready-state\" path=\"/library/comics/ready.cbz\".");
		expect(joinedLogs).toContain("Phase 3 — cache build candidates total=\"0\" existing=\"0\" new=\"0\" readyReused=\"1\".");
		expect(joinedLogs).toContain("scanCompareUpdate summary scanRoot=\"/library\"");
		expect(joinedLogs).toContain("eligible=\"1\" readyReused=\"1\" buildCandidates=\"0\"");
	});

	it("routes EPUB and AUDIOBOOK special directories to zip artifacts and excludes them from comic chunk cache", async () => {
		const epubFile = {
			id: 11,
			name: "epub-special",
			parentPath: "/library",
			parentHash: "parent-epub",
			fileHash: "hash-epub",
			size: "0 B",
			coverId: "cover-epub",
			fileKind: FileKind.EPUB
		};
		const audioFile = {
			id: 12,
			name: "audio-special",
			parentPath: "/library",
			parentHash: "parent-audio",
			fileHash: "hash-audio",
			size: "0 B",
			coverId: "cover-audio",
			fileKind: FileKind.AUDIOBOOK
		};
		const comicDir = {
			id: 13,
			name: "comic-special",
			parentPath: "/library",
			parentHash: "parent-comic",
			fileHash: "hash-comic",
			size: "0 B",
			coverId: "cover-comic-dir",
			fileKind: FileKind.COMIC_MANGA
		};

		jest.spyOn(ScanRootRepository.getInstance(), "getScanRootByPath")
			.mockResolvedValue({id: 9, path: "/library"} as never);
		const cleanupSpy = jest.spyOn(comicCacheUtils, "cleanupCacheBuildRoot").mockResolvedValue(2);
		jest.spyOn(scanner, "scan").mockResolvedValue({
			root: "/library",
			scan: {
				directories: {
					name: "library",
					hash: "root-hash",
					directories: []
				},
				files: [epubFile, audioFile, comicDir]
			}
		});

		jest.spyOn(FileRepository.getInstance(), "removeFileByParentHash").mockResolvedValue(0);
		jest.spyOn(FileRepository.getInstance(), "getFilesForCacheBuild").mockResolvedValue([epubFile, audioFile, comicDir]);
		jest.spyOn(FileRepository.getInstance(), "getAllCoverIds").mockResolvedValue(["cover-epub", "cover-audio", "cover-comic-dir"]);
		jest.spyOn(FileRepository.getInstance(), "removeFileByFileHash").mockResolvedValue(0);
		jest.spyOn(ScanRootRepository.getInstance(), "updateScanRoot").mockResolvedValue(undefined as never);

		const fillLocalSpy = jest.spyOn(scanner as any, "fillLocalDetails");
		const fillWebSpy = jest.spyOn(scanner as any, "fillWebDetails");
		const insertSpy = jest.spyOn(FileRepository.getInstance(), "insertFile");

		const specialArtifactSpy = jest.spyOn(SpecialDirectoryArtifactService.getInstance(), "ensureArtifactsForFiles")
			.mockResolvedValue([
				{coverId: "cover-epub", status: "ready", elapsedMs: 1},
				{coverId: "cover-audio", status: "skipped", elapsedMs: 1}
			]);
		const comicCacheSpy = jest.spyOn(ComicChunkCacheService.getInstance(), "ensureCacheForSources")
			.mockResolvedValue([{
				coverId: "cover-comic-dir",
				status: "skipped",
				totalPages: 24,
				chunkCount: 4,
				elapsedMs: 1
			}]);

		await scanner.scanCompareUpdate("/library");

		expect(fillLocalSpy).not.toHaveBeenCalled();
		expect(fillWebSpy).not.toHaveBeenCalled();
		expect(insertSpy).not.toHaveBeenCalled();
		expect(cleanupSpy).toHaveBeenCalledTimes(1);
		expect(specialArtifactSpy).toHaveBeenCalledTimes(1);
		expect(specialArtifactSpy.mock.calls[0][0]).toHaveLength(2);
		expect(specialArtifactSpy.mock.calls[0][0].map((file) => file.fileKind)).toEqual([
			FileKind.EPUB,
			FileKind.AUDIOBOOK
		]);
		expect(comicCacheSpy).toHaveBeenCalledTimes(1);
		expect(comicCacheSpy.mock.calls[0][0]).toHaveLength(1);
		expect(comicCacheSpy.mock.calls[0][0][0]).toEqual(expect.objectContaining({
			coverId: "cover-comic-dir",
			sourceType: "directory",
			requiresZipArtifact: true
		}));
	});

	it("removes orphan cache directories while preserving live coverIds and the staging root", async () => {
		const cacheRoot = await fs.mkdtemp(path.join(os.tmpdir(), "libretorio-cache-gc-"));
		tempCacheRoots.push(cacheRoot);
		config.production.paths.cache = cacheRoot;
		await fs.ensureDir(path.join(cacheRoot, ".scanner-build"));
		await fs.ensureDir(path.join(cacheRoot, "cover-live"));
		await fs.writeFile(path.join(cacheRoot, "cover-live", "_scanner_state.json"), "{}");
		await fs.ensureDir(path.join(cacheRoot, "cover-orphan"));
		await fs.writeFile(path.join(cacheRoot, "cover-orphan", "stale.cache"), "stale");

		jest.spyOn(FileRepository.getInstance(), "getAllCoverIds").mockResolvedValue(["cover-live"]);

		const summary = await (scanner as any).runCacheGarbageCollection();

		expect(summary).toEqual(expect.objectContaining({
			cacheDirsTotal: 2,
			liveCoverIds: 1,
			candidates: 1,
			removed: 1
		}));
		await expect(fs.pathExists(path.join(cacheRoot, "cover-live"))).resolves.toBe(true);
		await expect(fs.pathExists(path.join(cacheRoot, ".scanner-build"))).resolves.toBe(true);
		await expect(fs.pathExists(path.join(cacheRoot, "cover-orphan"))).resolves.toBe(false);
	});

	it("includes cache artifact snapshot metrics in the final summary", async () => {
		const existingComicFile = {
			id: 45,
			name: "summary.cbz",
			parentPath: "/library",
			parentHash: "parent-summary",
			fileHash: "hash-summary",
			size: "10 MB",
			coverId: "cover-summary",
			fileKind: FileKind.FILE
		};
		const consoleSpy = jest.spyOn(console, "log").mockImplementation(() => undefined);

		jest.spyOn(CacheArtifactSnapshotService.getInstance(), "rebuildSnapshotFromCache").mockResolvedValue({
			totalCacheDirs: 5,
			rows: 5,
			readerReady: 4,
			partialReady: 1,
			errorStates: 1,
			zipOnly: 1,
			legacyReaderReady: 1,
			published: true,
			elapsedMs: 12
		});
		jest.spyOn(ScanRootRepository.getInstance(), "getScanRootByPath")
			.mockResolvedValue({id: 15, path: "/library"} as never);
		jest.spyOn(comicCacheUtils, "cleanupCacheBuildRoot").mockResolvedValue(0);
		jest.spyOn(scanner, "scan").mockResolvedValue({
			root: "/library",
			scan: {
				directories: {
					name: "library",
					hash: "root-hash",
					directories: []
				},
				files: [existingComicFile]
			}
		});
		jest.spyOn(FileRepository.getInstance(), "removeFileByParentHash").mockResolvedValue(0);
		jest.spyOn(FileRepository.getInstance(), "getFilesForCacheBuild").mockResolvedValue([existingComicFile]);
		jest.spyOn(FileRepository.getInstance(), "getAllCoverIds").mockResolvedValue(["cover-summary"]);
		jest.spyOn(FileRepository.getInstance(), "removeFileByFileHash").mockResolvedValue(0);
		jest.spyOn(ScanRootRepository.getInstance(), "updateScanRoot").mockResolvedValue(undefined as never);
		jest.spyOn(SpecialDirectoryArtifactService.getInstance(), "ensureArtifactsForFiles").mockResolvedValue([]);
		jest.spyOn(ComicChunkCacheService.getInstance(), "ensureCacheForSources").mockResolvedValue([]);

		await scanner.scanCompareUpdate("/library");

		const joinedLogs = consoleSpy.mock.calls.map((call) => String(call[0])).join("\n");
		expect(joinedLogs).toContain("cacheSnapshotRows=\"5\"");
		expect(joinedLogs).toContain("cacheSnapshotReaderReady=\"4\"");
		expect(joinedLogs).toContain("cacheSnapshotPartial=\"1\"");
		expect(joinedLogs).toContain("cacheSnapshotError=\"1\"");
		expect(joinedLogs).toContain("cacheSnapshotZipOnly=\"1\"");
		expect(joinedLogs).toContain("cacheSnapshotLegacy=\"1\"");
		expect(joinedLogs).toContain("cacheSnapshotPublished=\"true\"");
	});
});
