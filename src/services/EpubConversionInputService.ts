import fs from "fs-extra";
import path from "path";
import unzipper from "unzipper";
import { createHash } from "crypto";
import { DocumentSource, fileDigest, inspectDocumentSource } from "./DocumentSourceService";
import { ConversionError } from "(src)/models/interfaces/DocumentConversion";
import { generateDirectoryZipArtifact } from "(src)/utils/comicCacheUtils";

export class EpubConversionInputService {
	private async matches(zip: string, source: string): Promise<boolean> {
		if (!await fs.pathExists(zip)) return false;
		if (!(await fs.lstat(zip)).isFile()) throw new ConversionError("cache_path", "EPUB ZIP is not a regular file");
		try {
			const archive = await unzipper.Open.file(zip);
			if (archive.files.length > 50000) throw new ConversionError("resource_limit", "EPUB ZIP has too many entries");
			const expected = new Set<string>();
			const walk = async (directory: string) => {
				for (const entry of await fs.readdir(directory, {withFileTypes: true})) {
					const file = path.join(directory, entry.name);
					if (entry.isDirectory()) await walk(file);
					else if (entry.isFile()) expected.add(path.relative(source, file).split(path.sep).join("/"));
					else throw new ConversionError("source_resource", "Special entry in EPUB source");
				}
			};
			await walk(source);
			for (const entry of archive.files) {
				if (entry.type === "Directory") continue;
				if (!expected.delete(entry.path)) return false;
				const file = path.join(source, entry.path), stat = await fs.stat(file);
				if (entry.uncompressedSize !== stat.size) return false;
				const digest = createHash("sha256");
				let bytes = 0;
				for await (const chunk of entry.stream()) {
					bytes += chunk.length;
					if (bytes > stat.size) throw new ConversionError("resource_limit", "EPUB ZIP entry exceeds source size");
					digest.update(chunk);
				}
				if (bytes !== stat.size || digest.digest("hex") !== await fileDigest(file)) return false;
			}
			return expected.size === 0;
		} catch (error) {
			if (error instanceof ConversionError || ["EIO", "ENOSPC", "EROFS", "EACCES"].includes(error.code)) throw error;
			return false;
		}
	}

	async prepare(source: DocumentSource, coverId: string, cache: string, work: string, guard: () => Promise<void>): Promise<void> {
		const zip = path.join(cache, `${coverId}.zip`);
		const current = async () => {
			const after = await inspectDocumentSource({id: 0, coverId, name: path.basename(source.path), parentPath: path.dirname(source.path), fileKind: "EPUB"}, path.dirname(source.path));
			if (after.signature !== source.signature) throw new ConversionError("source_changed", "EPUB source changed while preparing input");
			await guard();
		};
		if (await this.matches(zip, source.path)) {
			await fs.copyFile(zip, path.join(work, "input.epub"));
		} else {
			const staged = await generateDirectoryZipArtifact(source.path, coverId, path.join(work, "epub-zip"));
			if (!await this.matches(staged.zipPath, source.path)) throw new ConversionError("epub_zip", "Generated EPUB ZIP differs from source");
			await current();
			await fs.copyFile(staged.zipPath, path.join(work, "input.epub"));
			// Replace only the ZIP, never the shared cache directory containing other artifacts.
			await guard();
			await fs.rename(staged.zipPath, zip);
		}
		if (!await this.matches(path.join(work, "input.epub"), source.path)) throw new ConversionError("source_changed", "Copied EPUB ZIP differs from source");
		await current();
	}
}
