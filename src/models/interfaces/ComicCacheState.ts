import { ComicArchiveFormat, ComicSourceType } from "(src)/models/interfaces/EligibleComicSource";

export interface ComicCacheState {
	version: 1;
	status: "building" | "ready" | "error";
	buildOutcome?: "complete" | "partial";
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
	droppedPages?: number;
	warningCount?: number;
	lastWarnings?: string[];
	lastError?: string;
}
