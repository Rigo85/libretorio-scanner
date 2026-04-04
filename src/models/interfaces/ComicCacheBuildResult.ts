export interface ComicCacheBuildResult {
	coverId: string;
	status: "ready" | "skipped" | "error";
	totalPages: number;
	chunkCount: number;
	zipPath?: string;
	error?: string;
	elapsedMs: number;
}
