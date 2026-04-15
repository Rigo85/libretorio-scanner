import { FileKind } from "(src)/models/interfaces/File";

export type ComicArchiveFormat = "ace" | "rar" | "zip" | "7z" | "tar";
export type ComicSourceType = "directory" | "archive-file";

export interface EligibleComicSource {
	dbId?: number;
	coverId: string;
	fileHash: string;
	name: string;
	parentPath: string;
	fileKind: FileKind;
	sourcePath: string;
	sourceType: ComicSourceType;
	archiveFormat?: ComicArchiveFormat;
	requiresZipArtifact: boolean;
}
