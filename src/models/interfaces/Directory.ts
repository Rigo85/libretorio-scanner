export interface Directory {
	name: string;
	hash: string;
	directories: Directory[];
}
