import fs from "fs-extra";
import path from "path";

import { File, FileKind } from "(src)/models/interfaces/File";
import { ComicArchiveFormat, EligibleComicSource } from "(src)/models/interfaces/EligibleComicSource";
import { Logger } from "(src)/helpers/Logger";

const logger = new Logger("ArchiveDetection");

const EXTENSION_BACKENDS = new Map<string, ComicArchiveFormat>([
	[".cbr", "rar"],
	[".rar", "rar"],
	[".cbz", "zip"],
	[".zip", "zip"],
	[".cb7", "7z"],
	[".7z", "7z"],
	[".cbt", "tar"],
	[".tar", "tar"],
	[".tgz", "tar"],
	[".tbz2", "tar"],
	[".txz", "tar"]
]);

export function detectArchiveFormatByPathOrMagic(filePath: string): ComicArchiveFormat | undefined {
	try {
		if (!filePath || !fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
			return detectArchiveFormatByExtension(filePath);
		}

		const fd = fs.openSync(filePath, "r");
		try {
			const header = Buffer.alloc(262);
			const bytesRead = fs.readSync(fd, header, 0, header.length, 0);

			if (bytesRead >= 7) {
				const rar4 = Buffer.from([0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0x00]);
				const rar5 = Buffer.from([0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0x01, 0x00]);
				if (header.subarray(0, 7).equals(rar4) || (bytesRead >= 8 && header.subarray(0, 8).equals(rar5))) {
					return "rar";
				}
			}

			if (bytesRead >= 4) {
				const signature = header.readUInt32LE(0);
				if (signature === 0x04034b50 || signature === 0x06054b50 || signature === 0x08074b50) {
					return "zip";
				}
			}

			if (bytesRead >= 6) {
				const sevenz = Buffer.from([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c]);
				if (header.subarray(0, 6).equals(sevenz)) {
					return "7z";
				}
			}

			if (bytesRead >= 262) {
				const ustar = header.subarray(257, 262).toString("ascii");
				if (ustar === "ustar") {
					return "tar";
				}
			}

			if (bytesRead >= 2 && header[0] === 0x1f && header[1] === 0x8b) {
				return "tar";
			}

			if (bytesRead >= 3 && header[0] === 0x42 && header[1] === 0x5a && header[2] === 0x68) {
				return "tar";
			}

			if (bytesRead >= 6) {
				const xz = Buffer.from([0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00]);
				if (header.subarray(0, 6).equals(xz)) {
					return "tar";
				}
			}
		} finally {
			fs.closeSync(fd);
		}
	} catch (error) {
		logger.error(`detectArchiveFormatByPathOrMagic "${filePath}":`, error);
	}

	return detectArchiveFormatByExtension(filePath);
}

export function detectArchiveFormatByExtension(filePath: string): ComicArchiveFormat | undefined {
	const ext = path.extname(filePath || "").toLowerCase();
	return EXTENSION_BACKENDS.get(ext);
}

export function isEligibleComicSource(file: File): boolean {
	return toEligibleComicSource(file) !== undefined;
}

export function toEligibleComicSource(file: File): EligibleComicSource | undefined {
	const sourcePath = path.join(file.parentPath, file.name);

	if (file.fileKind === FileKind.COMIC_MANGA) {
		return {
			dbId: file.id,
			coverId: file.coverId,
			fileHash: file.fileHash,
			name: file.name,
			parentPath: file.parentPath,
			fileKind: file.fileKind,
			sourcePath,
			sourceType: "directory",
			requiresZipArtifact: true
		};
	}

	if (file.fileKind !== FileKind.FILE) {
		return undefined;
	}

	const archiveFormat = detectArchiveFormatByPathOrMagic(sourcePath);
	if (!archiveFormat) {
		return undefined;
	}

	return {
		dbId: file.id,
		coverId: file.coverId,
		fileHash: file.fileHash,
		name: file.name,
		parentPath: file.parentPath,
		fileKind: file.fileKind,
		sourcePath,
		sourceType: "archive-file",
		archiveFormat,
		requiresZipArtifact: false
	};
}
