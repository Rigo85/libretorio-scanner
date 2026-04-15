import fs from "fs-extra";
import path from "path";

import { File, FileKind } from "(src)/models/interfaces/File";
import { ComicArchiveFormat, EligibleComicSource } from "(src)/models/interfaces/EligibleComicSource";
import { Logger } from "(src)/helpers/Logger";
import { ComicCacheStateService } from "(src)/services/ComicCacheStateService";
import { getStatePath, validateChunkCacheShallow } from "(src)/utils/comicCacheUtils";

const logger = new Logger("ArchiveDetection");

const EXTENSION_BACKENDS = new Map<string, ComicArchiveFormat>([
	[".cba", "ace"],
	[".cbr", "rar"],
	[".cbz", "zip"],
	[".cb7", "7z"],
	[".cbt", "tar"]
]);

const DIRECT_COMIC_EXTENSIONS = new Set([
	".cba",
	".cbz",
	".cbr",
	".cb7",
	".cbt"
]);

export type ComicEligibilityReason =
	"special-directory"
	| "direct-comic-extension"
	| "ready-state"
	| "invalid-comic-magic"
	| "unsupported-format"
	| "unsupported-file-kind";

export interface ComicEligibilityResolution {
	result: "eligible" | "skipped";
	reason: ComicEligibilityReason;
	source?: EligibleComicSource;
}

export function detectArchiveFormatByPathOrMagic(filePath: string): ComicArchiveFormat | undefined {
	return detectArchiveFormatByMagic(filePath) || detectArchiveFormatByExtension(filePath);
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

	if (file.fileKind !== FileKind.FILE || !hasDirectComicExtension(file.name)) {
		return undefined;
	}

	const archiveFormat = detectComicArchiveFormat(sourcePath, file.name);
	if (!archiveFormat) {
		return undefined;
	}

	return buildArchiveSource(file, sourcePath, archiveFormat);
}

export async function resolveEligibleComicSource(file: File): Promise<ComicEligibilityResolution> {
	const sourcePath = path.join(file.parentPath, file.name);

	if (file.fileKind === FileKind.COMIC_MANGA) {
		const source: EligibleComicSource = {
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
		const readyResolution = await resolveReadyReusableSource(file, source);
		if (readyResolution) {
			return readyResolution;
		}

		return {
			result: "eligible",
			reason: "special-directory",
			source
		};
	}

	if (file.fileKind !== FileKind.FILE) {
		return {
			result: "skipped",
			reason: "unsupported-file-kind"
		};
	}

	if (!hasDirectComicExtension(file.name)) {
		return {
			result: "skipped",
			reason: "unsupported-format"
		};
	}

	const archiveFormat = detectComicArchiveFormat(sourcePath, file.name);
	if (!archiveFormat) {
		await ComicCacheStateService.getInstance().markError(
			getStatePath(file.coverId),
			{
				sourcePath,
				sourceType: "archive-file",
				fileHash: file.fileHash
			},
			`Declared comic extension does not match a supported archive signature: "${sourcePath}".`
		);
		return {
			result: "skipped",
			reason: "invalid-comic-magic"
		};
	}

	logComicExtensionMismatch(file, sourcePath, archiveFormat);
	const source = buildArchiveSource(file, sourcePath, archiveFormat);
	const readyResolution = await resolveReadyReusableSource(file, source);
	if (readyResolution) {
		return readyResolution;
	}

	return {
		result: "eligible",
		reason: "direct-comic-extension",
		source
	};
}

function buildArchiveSource(
	file: File,
	sourcePath: string,
	archiveFormat: ComicArchiveFormat
): EligibleComicSource {
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

function hasDirectComicExtension(fileName: string): boolean {
	return DIRECT_COMIC_EXTENSIONS.has(path.extname(fileName || "").toLowerCase());
}

function detectComicArchiveFormat(filePath: string, fileName: string): ComicArchiveFormat | undefined {
	const detectedByMagic = detectArchiveFormatByMagic(filePath);
	if (detectedByMagic) {
		return detectedByMagic;
	}

	const declaredBackend = hasDirectComicExtension(fileName)
		? detectArchiveFormatByExtension(fileName)
		: undefined;

	if (!filePath || !fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
		return declaredBackend;
	}

	if (declaredBackend === "rar" && hasWrappedRarSignature(filePath)) {
		logger.info(
			`Comic archive magic fallback declaredExtension="${path.extname(fileName || "").toLowerCase()}" backend="rar" path="${filePath}".`
		);
		return declaredBackend;
	}

	return undefined;
}

function hasWrappedRarSignature(filePath: string): boolean {
	try {
		const fd = fs.openSync(filePath, "r");
		try {
			const header = Buffer.alloc(4096);
			const bytesRead = fs.readSync(fd, header, 0, header.length, 0);
			if (bytesRead < 2) {
				return false;
			}

			if (header[0] === 0x4d && header[1] === 0x5a) {
				return true;
			}

			const rar4 = Buffer.from([0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0x00]);
			const rar5 = Buffer.from([0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0x01, 0x00]);
			return header.subarray(0, bytesRead).includes(rar4) || header.subarray(0, bytesRead).includes(rar5);
		} finally {
			fs.closeSync(fd);
		}
	} catch (error) {
		logger.error(`hasWrappedRarSignature "${filePath}":`, error);
		return false;
	}
}

function detectArchiveFormatByMagic(filePath: string): ComicArchiveFormat | undefined {
	try {
		if (!filePath || !fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
			return undefined;
		}

		const fd = fs.openSync(filePath, "r");
		try {
			const header = Buffer.alloc(512);
			const bytesRead = fs.readSync(fd, header, 0, header.length, 0);

			if (bytesRead >= 7) {
				const ace = Buffer.from("**ACE**", "ascii");
				if (header.subarray(0, bytesRead).includes(ace)) {
					return "ace";
				}
			}

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
		logger.error(`detectArchiveFormatByMagic "${filePath}":`, error);
	}

	return undefined;
}

function canReuseReadyState(
	state: {
		status?: string;
		fileHash?: string;
		archiveFormat?: ComicArchiveFormat;
	} | undefined,
	file: File,
	archiveFormat?: ComicArchiveFormat
): boolean {
	return state?.status === "ready"
		&& state.fileHash === file.fileHash
		&& (
			archiveFormat === undefined
				? state.archiveFormat === undefined
				: (state.archiveFormat === undefined || state.archiveFormat === archiveFormat)
		);
}

async function resolveReadyReusableSource(
	file: File,
	source: EligibleComicSource
): Promise<ComicEligibilityResolution | undefined> {
	const reusableState = await ComicCacheStateService.getInstance().read(getStatePath(file.coverId));
	if (!canReuseReadyState(reusableState, file, source.archiveFormat)) {
		return undefined;
	}

	const validation = await validateChunkCacheShallow(file.coverId, source.requiresZipArtifact, undefined, reusableState);
	if (!validation.valid) {
		return undefined;
	}

	return {
		result: "eligible",
		reason: "ready-state",
		source
	};
}

function logComicExtensionMismatch(file: File, sourcePath: string, detectedBackend: ComicArchiveFormat): void {
	const declaredExtension = path.extname(file.name || "").toLowerCase();
	const declaredBackend = detectArchiveFormatByExtension(file.name || "");
	if (!declaredBackend || declaredBackend === detectedBackend) {
		return;
	}

	logger.info(
		`Comic extension/backend mismatch coverId="${file.coverId}" declaredExtension="${declaredExtension}" detectedBackend="${detectedBackend}" path="${sourcePath}".`
	);
}
