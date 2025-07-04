import { Directory } from "(src)/models/interfaces/Directory";
import { File } from "(src)/models/interfaces/File";

export interface ScanResult {
	directories: Directory;
	files: File[];
	total?: number;
}
