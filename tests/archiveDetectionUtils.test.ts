import fs from "fs-extra";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it } from "@jest/globals";

import { FileKind } from "(src)/models/interfaces/File";
import { detectArchiveFormatByPathOrMagic, toEligibleComicSource } from "(src)/utils/archiveDetectionUtils";

describe("archiveDetectionUtils", () => {
	let tempDir: string;

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "libretorio-archive-detect-"));
	});

	afterEach(async () => {
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

	it("builds an eligible source for archive files without changing fileKind", async () => {
		const filePath = path.join(tempDir, "volume.zip");
		await fs.writeFile(filePath, Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00]));

		const eligible = toEligibleComicSource({
			id: 99,
			name: "volume.zip",
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
});
