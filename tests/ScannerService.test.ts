import { afterEach, beforeEach, describe, expect, it, jest } from "@jest/globals";

import { FileKind } from "(src)/models/interfaces/File";
import { FileRepository } from "(src)/repositories/FileRepository";
import { ScanRootRepository } from "(src)/repositories/ScanRootRepository";
import { ComicChunkCacheService } from "(src)/services/ComicChunkCacheService";
import { ScannerService } from "(src)/services/ScannerService";
import { SpecialDirectoryArtifactService } from "(src)/services/SpecialDirectoryArtifactService";
import * as comicCacheUtils from "(src)/utils/comicCacheUtils";

describe("ScannerService orchestration", () => {
	let scanner: ScannerService;

	beforeEach(() => {
		scanner = ScannerService.getInstance();
	});

	afterEach(() => {
		jest.restoreAllMocks();
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
		expect(joinedLogs).toContain("Phase 1 complete metadataCompleted=\"0\" inserted=\"0\" failed=\"0\".");
		expect(joinedLogs).toContain("Preparing cache candidate inputs scanFiles=\"1\" existingDbFiles=\"1\" newInsertedFiles=\"0\".");
		expect(joinedLogs).toContain("Resolving comic cache candidates scope=\"existing\" total=\"1\".");
		expect(joinedLogs).toContain("Candidate resolution progress scope=\"existing\" completed=\"1/1\" eligible=\"1\" skipped=\"0\" path=\"/library/backlog.cbz\".");
		expect(joinedLogs).toContain("Candidate resolution complete scope=\"existing\" total=\"1\" eligible=\"1\" skipped=\"0\"");
		expect(joinedLogs).toContain("Resolving comic cache candidates scope=\"new\" total=\"0\".");
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
});
