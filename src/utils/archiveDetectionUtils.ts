import fs from "fs-extra";
import path from "path";

import { File, FileKind } from "(src)/models/interfaces/File";
import { config } from "(src)/config/configuration";
import { ComicArchiveFormat, EligibleComicSource } from "(src)/models/interfaces/EligibleComicSource";
import { Logger } from "(src)/helpers/Logger";
import { ComicCacheStateService } from "(src)/services/ComicCacheStateService";
import { NativeComicCacheWorkerService } from "(src)/services/NativeComicCacheWorkerService";
import { getStatePath } from "(src)/utils/comicCacheUtils";

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

const DIRECT_COMIC_EXTENSIONS = new Set([
	".cbz",
	".cbr",
	".cb7",
	".cbt"
]);

const GENERIC_ARCHIVE_EXTENSIONS = new Set([
	".zip",
	".rar",
	".7z",
	".tar",
	".tgz",
	".tbz2",
	".txz"
]);

export type ComicEligibilityReason =
	"special-directory"
	| "direct-comic-extension"
	| "ready-state"
	| "probe-accepted"
	| "probe-disabled"
	| "probe-unavailable"
	| "ignored-persisted"
	| "ignored-multipart-tail"
	| "ignored-below-min-images"
	| "ignored-no-images"
	| "ignored-no-entries"
	| "unsupported-format"
	| "unsupported-file-kind";

export interface ComicEligibilityResolution {
	result: "eligible" | "skipped";
	reason: ComicEligibilityReason;
	source?: EligibleComicSource;
	probeEntriesScanned?: number;
	probeImageCount?: number;
}

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

export async function resolveEligibleComicSource(file: File): Promise<ComicEligibilityResolution> {
	const sourcePath = path.join(file.parentPath, file.name);

	if (file.fileKind === FileKind.COMIC_MANGA) {
		return {
			result: "eligible",
			reason: "special-directory",
			source: {
				dbId: file.id,
				coverId: file.coverId,
				fileHash: file.fileHash,
				name: file.name,
				parentPath: file.parentPath,
				fileKind: file.fileKind,
				sourcePath,
				sourceType: "directory",
				requiresZipArtifact: true
			}
		};
	}

	if (file.fileKind !== FileKind.FILE) {
		return {
			result: "skipped",
			reason: "unsupported-file-kind"
		};
	}

	if (isMultipartArchiveTail(file.name)) {
		return {
			result: "skipped",
			reason: "ignored-multipart-tail"
		};
	}

	const archiveFormat = detectArchiveFormatByPathOrMagic(sourcePath);
	if (!archiveFormat) {
		return {
			result: "skipped",
			reason: "unsupported-format"
		};
	}

	const reusableState = await ComicCacheStateService.getInstance().read(getStatePath(file.coverId));
	if (canReuseReadyState(reusableState, file, archiveFormat)) {
		return {
			result: "eligible",
			reason: "ready-state",
			source: buildArchiveSource(file, sourcePath, archiveFormat)
		};
	}

	if (hasDirectComicExtension(file.name)) {
		return {
			result: "eligible",
			reason: "direct-comic-extension",
			source: buildArchiveSource(file, sourcePath, archiveFormat)
		};
	}

	if (!isGenericArchiveExtension(file.name)) {
		return {
			result: "skipped",
			reason: "unsupported-format"
		};
	}

	const probeConfig = config.production.scan.cacheProbe;
	if (!probeConfig.enabled) {
		return {
			result: "eligible",
			reason: "probe-disabled",
			source: buildArchiveSource(file, sourcePath, archiveFormat)
		};
	}

	if (canReuseIgnoredState(reusableState, file, archiveFormat)) {
		return {
			result: "skipped",
			reason: mapIgnoredReason(reusableState?.ignoreReason),
			probeEntriesScanned: reusableState?.probeEntriesScanned,
			probeImageCount: reusableState?.probeImageCount
		};
	}

	const probeResult = await NativeComicCacheWorkerService.getInstance().probeArchiveForComic(
		sourcePath,
		file.coverId,
		archiveFormat,
		{
			maxEntries: probeConfig.maxEntries,
			minImages: probeConfig.minImages
		}
	);

	const detectedArchiveFormat = probeResult.detectedBackend || archiveFormat;
	if (probeResult.accepted) {
		return {
			result: "eligible",
			reason: probeResult.reason === "probe_unavailable" || probeResult.reason === "probe_failed"
				? "probe-unavailable"
				: "probe-accepted",
			source: buildArchiveSource(file, sourcePath, detectedArchiveFormat),
			probeEntriesScanned: probeResult.entriesScanned,
			probeImageCount: probeResult.imageCount
		};
	}

	const ignoredReason = normalizeProbeIgnoreReason(probeResult.reason);
	await ComicCacheStateService.getInstance().markIgnored(getStatePath(file.coverId), {
		sourcePath,
		sourceType: "archive-file",
		archiveFormat: detectedArchiveFormat,
		fileHash: file.fileHash,
		reason: ignoredReason,
		probeEntriesScanned: probeResult.entriesScanned,
		probeImageCount: probeResult.imageCount,
		probeMaxEntries: probeConfig.maxEntries,
		probeMinImages: probeConfig.minImages
	});
	logger.info(
		`probe-ignore coverId="${file.coverId}" reason="${ignoredReason}" entries="${probeResult.entriesScanned}" images="${probeResult.imageCount}" path="${sourcePath}".`
	);

	return {
		result: "skipped",
		reason: mapIgnoredReason(ignoredReason),
		probeEntriesScanned: probeResult.entriesScanned,
		probeImageCount: probeResult.imageCount
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

function isGenericArchiveExtension(fileName: string): boolean {
	return GENERIC_ARCHIVE_EXTENSIONS.has(path.extname(fileName || "").toLowerCase());
}

function isMultipartArchiveTail(fileName: string): boolean {
	const normalized = (fileName || "").toLowerCase();
	const partMatch = normalized.match(/\.part0*([0-9]+)\.(rar|zip|7z|tar)$/);
	if (partMatch) {
		return parseInt(partMatch[1], 10) > 1;
	}

	return /\.r\d+$/.test(normalized);
}

function canReuseReadyState(
	state: {
		status?: string;
		fileHash?: string;
		archiveFormat?: ComicArchiveFormat;
	} | undefined,
	file: File,
	archiveFormat: ComicArchiveFormat
): boolean {
	return state?.status === "ready"
		&& state.fileHash === file.fileHash
		&& (state.archiveFormat === undefined || state.archiveFormat === archiveFormat);
}

function canReuseIgnoredState(
	state: {
		status?: string;
		fileHash?: string;
		archiveFormat?: ComicArchiveFormat;
		probeMaxEntries?: number;
		probeMinImages?: number;
	} | undefined,
	file: File,
	archiveFormat: ComicArchiveFormat
): boolean {
	return state?.status === "ignored"
		&& state.fileHash === file.fileHash
		&& (state.archiveFormat === undefined || state.archiveFormat === archiveFormat)
		&& state.probeMaxEntries === config.production.scan.cacheProbe.maxEntries
		&& state.probeMinImages === config.production.scan.cacheProbe.minImages;
}

function normalizeProbeIgnoreReason(reason: string | undefined): string {
	if (reason === "no_images") {
		return "no_images";
	}
	if (reason === "no_entries") {
		return "no_entries";
	}
	return "below_min_images";
}

function mapIgnoredReason(reason: string | undefined): ComicEligibilityReason {
	if (reason === "no_images") {
		return "ignored-no-images";
	}
	if (reason === "no_entries") {
		return "ignored-no-entries";
	}
	return "ignored-below-min-images";
}
