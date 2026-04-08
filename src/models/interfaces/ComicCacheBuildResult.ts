export interface ComicCacheBuildResult {
	coverId: string;
	status: "ready" | "skipped" | "error";
	buildOutcome?: "complete" | "partial";
	totalPages: number;
	chunkCount: number;
	droppedPages?: number;
	warningCount?: number;
	zipPath?: string;
	error?: string;
	elapsedMs: number;
}
