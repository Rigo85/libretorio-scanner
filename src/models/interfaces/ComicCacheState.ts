import { ComicArchiveFormat, ComicSourceType } from "(src)/models/interfaces/EligibleComicSource";

export interface ComicCacheState {
	version: 1;
	status: "building" | "ready" | "error" | "ignored";
	sourcePath: string;
	sourceType: ComicSourceType;
	archiveFormat?: ComicArchiveFormat;
	fileHash?: string;
	createdAt: string;
	updatedAt: string;
	chunkCount: number;
	totalPages: number;
	zipReady: boolean;
	chunksReady: boolean;
	lastError?: string;
	ignoreReason?: string;
	probeEntriesScanned?: number;
	probeImageCount?: number;
	probeMaxEntries?: number;
	probeMinImages?: number;
}
