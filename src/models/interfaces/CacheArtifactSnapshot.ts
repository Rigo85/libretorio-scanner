export interface CacheArtifactStateRow {
	coverId: string;
	readerReady: boolean;
	zipReady: boolean;
	status?: "building" | "ready" | "error";
	buildOutcome?: "complete" | "partial";
	chunkCount?: number;
	totalPages?: number;
	updatedAt: string;
	lastError?: string;
}

export interface CacheArtifactSnapshotSummary {
	totalCacheDirs: number;
	rows: number;
	readerReady: number;
	partialReady: number;
	errorStates: number;
	zipOnly: number;
	legacyReaderReady: number;
	published: boolean;
	elapsedMs: number;
}
