import fs from "fs-extra";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it, jest } from "@jest/globals";

import { config } from "(src)/config/configuration";
import { FileKind } from "(src)/models/interfaces/File";
import { getChunkPath, getStatePath } from "(src)/utils/comicCacheUtils";
import {
	detectArchiveFormatByPathOrMagic,
	resolveEligibleComicSource,
	toEligibleComicSource
} from "(src)/utils/archiveDetectionUtils";

describe("archiveDetectionUtils", () => {
	let tempDir: string;
	let originalCachePath: string;

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "libretorio-archive-detect-"));
		originalCachePath = config.production.paths.cache;
		config.production.paths.cache = path.join(tempDir, "cache");
	});

	afterEach(async () => {
		jest.restoreAllMocks();
		config.production.paths.cache = originalCachePath;
		await fs.rm(tempDir, {recursive: true, force: true});
	});

	it("prioritizes magic bytes over extension", async () => {
		const filePath = path.join(tempDir, "mismatch.cbr");
		await fs.writeFile(filePath, Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00]));

		expect(detectArchiveFormatByPathOrMagic(filePath)).toBe("zip");
	});

	it("falls back to extension when the file does not exist", () => {
		const filePath = path.join(tempDir, "chapter.cb7");
		expect(detectArchiveFormatByPathOrMagic(filePath)).toBe("7z");
	});

	it("detects ace by extension when the file does not exist", () => {
		const filePath = path.join(tempDir, "chapter.cba");
		expect(detectArchiveFormatByPathOrMagic(filePath)).toBe("ace");
	});

	it("builds an eligible source only for declared comic extensions", async () => {
		const filePath = path.join(tempDir, "volume.cbz");
		await fs.writeFile(filePath, Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00]));

		const eligible = toEligibleComicSource({
			id: 99,
			name: "volume.cbz",
			parentPath: tempDir,
			parentHash: "parent",
			fileHash: "hash",
			size: "10 B",
			coverId: "cover-1",
			fileKind: FileKind.FILE
		});

		expect(eligible).toEqual(expect.objectContaining({
			dbId: 99,
			coverId: "cover-1",
			sourceType: "archive-file",
			archiveFormat: "zip",
			requiresZipArtifact: false
		}));
	});

	it("rejects generic archive extensions even when their magic bytes are valid", async () => {
		const filePath = path.join(tempDir, "volume.zip");
		await fs.writeFile(filePath, Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00]));

		const resolution = await resolveEligibleComicSource({
			id: 101,
			name: "volume.zip",
			parentPath: tempDir,
			parentHash: "parent",
			fileHash: "hash-zip",
			size: "1 KB",
			coverId: "cover-zip",
			fileKind: FileKind.FILE
		});

		expect(resolution.result).toBe("skipped");
		expect(resolution.reason).toBe("unsupported-format");
		expect(resolution.source).toBeUndefined();
	});

	it("rejects generic ace extensions even when the file contains valid ace magic", async () => {
		const filePath = path.join(tempDir, "novel.ace");
		await fs.writeFile(
			filePath,
			Buffer.concat([
				Buffer.from("TJS\0\0\0"),
				Buffer.from("**ACE**", "ascii"),
				Buffer.alloc(32, 0)
			])
		);

		expect(detectArchiveFormatByPathOrMagic(filePath)).toBe("ace");

		const resolution = await resolveEligibleComicSource({
			id: 1011,
			name: "novel.ace",
			parentPath: tempDir,
			parentHash: "parent",
			fileHash: "hash-ace-ebook",
			size: "1 KB",
			coverId: "cover-ace-ebook",
			fileKind: FileKind.FILE
		});

		expect(resolution.result).toBe("skipped");
		expect(resolution.reason).toBe("unsupported-format");
		expect(resolution.source).toBeUndefined();
	});

	it("rejects declared comic extensions when magic bytes are invalid", async () => {
		const filePath = path.join(tempDir, "issue.cbz");
		await fs.writeFile(filePath, Buffer.from("not-an-archive"));

		const resolution = await resolveEligibleComicSource({
			id: 102,
			name: "issue.cbz",
			parentPath: tempDir,
			parentHash: "parent",
			fileHash: "hash-invalid-cbz",
			size: "1 KB",
			coverId: "cover-invalid-cbz",
			fileKind: FileKind.FILE
		});

		expect(resolution.result).toBe("skipped");
		expect(resolution.reason).toBe("invalid-comic-magic");
		expect(resolution.source).toBeUndefined();

		const state = await fs.readJson(getStatePath("cover-invalid-cbz")) as {
			status: string;
			sourcePath: string;
			sourceType: string;
			lastError?: string;
		};
		expect(state.status).toBe("error");
		expect(state.sourceType).toBe("archive-file");
		expect(state.sourcePath).toBe(filePath);
		expect(state.lastError).toContain("Declared comic extension does not match");
	});

	it("accepts cbr files with a wrapped rar signature after a leading preamble", async () => {
		const filePath = path.join(tempDir, "issue.cbr");
		await fs.writeFile(
			filePath,
			Buffer.concat([
				Buffer.from("Content-Type: application/octet-stream\r\n\r\n"),
				Buffer.from([0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0x00])
			])
		);

		const resolution = await resolveEligibleComicSource({
			id: 1021,
			name: "issue.cbr",
			parentPath: tempDir,
			parentHash: "parent",
			fileHash: "hash-wrapped-rar",
			size: "1 KB",
			coverId: "cover-wrapped-rar",
			fileKind: FileKind.FILE
		});

		expect(resolution.result).toBe("eligible");
		expect(resolution.reason).toBe("direct-comic-extension");
		expect(resolution.source).toEqual(expect.objectContaining({
			sourceType: "archive-file",
			archiveFormat: "rar"
		}));
	});

	it("accepts cbr self-extracting rar archives by extension fallback", async () => {
		const filePath = path.join(tempDir, "issue.cbr");
		await fs.writeFile(
			filePath,
			Buffer.concat([
				Buffer.from([0x4d, 0x5a]),
				Buffer.alloc(64, 0)
			])
		);

		const resolution = await resolveEligibleComicSource({
			id: 1022,
			name: "issue.cbr",
			parentPath: tempDir,
			parentHash: "parent",
			fileHash: "hash-sfx-rar",
			size: "1 KB",
			coverId: "cover-sfx-rar",
			fileKind: FileKind.FILE
		});

		expect(resolution.result).toBe("eligible");
		expect(resolution.reason).toBe("direct-comic-extension");
		expect(resolution.source).toEqual(expect.objectContaining({
			sourceType: "archive-file",
			archiveFormat: "rar"
		}));
	});

	it("detects ace magic inside a disguised cbr header", async () => {
		const filePath = path.join(tempDir, "issue.cbr");
		await fs.writeFile(
			filePath,
			Buffer.concat([
				Buffer.from("TJS\0\0\0"),
				Buffer.from("**ACE**", "ascii"),
				Buffer.alloc(32, 0)
			])
		);

		const resolution = await resolveEligibleComicSource({
			id: 1023,
			name: "issue.cbr",
			parentPath: tempDir,
			parentHash: "parent",
			fileHash: "hash-ace-disguised",
			size: "1 KB",
			coverId: "cover-ace-disguised",
			fileKind: FileKind.FILE
		});

		expect(resolution.result).toBe("eligible");
		expect(resolution.reason).toBe("direct-comic-extension");
		expect(resolution.source).toEqual(expect.objectContaining({
			sourceType: "archive-file",
			archiveFormat: "ace"
		}));
	});

	it("uses the backend detected by magic bytes for declared comic extensions", async () => {
		const filePath = path.join(tempDir, "issue.cbz");
		await fs.writeFile(filePath, Buffer.from([0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0x00]));

		const resolution = await resolveEligibleComicSource({
			id: 103,
			name: "issue.cbz",
			parentPath: tempDir,
			parentHash: "parent",
			fileHash: "hash-mismatch",
			size: "1 KB",
			coverId: "cover-mismatch",
			fileKind: FileKind.FILE
		});

		expect(resolution.result).toBe("eligible");
		expect(resolution.reason).toBe("direct-comic-extension");
		expect(resolution.source).toEqual(expect.objectContaining({
			sourceType: "archive-file",
			archiveFormat: "rar"
		}));
	});

	it("reuses ready state for declared comic sources", async () => {
		const filePath = path.join(tempDir, "bundle.cbr");
		await fs.writeFile(filePath, Buffer.from([0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0x00]));
		const statePath = getStatePath("cover-bundle-rar");
		await fs.ensureDir(path.dirname(statePath));
		await fs.writeJson(statePath, {
			version: 1,
			status: "ready",
			sourcePath: filePath,
			sourceType: "archive-file",
			archiveFormat: "rar",
			fileHash: "hash-bundle-rar",
			createdAt: new Date().toISOString(),
			updatedAt: new Date().toISOString(),
			chunkCount: 3,
			totalPages: 40,
			zipReady: false,
			chunksReady: true
		});
		await fs.writeFile(getChunkPath("cover-bundle-rar", 0), "{\"index\":0}");
		await fs.writeFile(getChunkPath("cover-bundle-rar", 1), "{\"index\":1}");
		await fs.writeFile(getChunkPath("cover-bundle-rar", 2), "{\"index\":2}");

		const resolution = await resolveEligibleComicSource({
			id: 104,
			name: "bundle.cbr",
			parentPath: tempDir,
			parentHash: "parent",
			fileHash: "hash-bundle-rar",
			size: "1 KB",
			coverId: "cover-bundle-rar",
			fileKind: FileKind.FILE
		});

		expect(resolution.result).toBe("eligible");
		expect(resolution.reason).toBe("ready-state");
		expect(resolution.source).toEqual(expect.objectContaining({
			archiveFormat: "rar"
		}));
	});
});
