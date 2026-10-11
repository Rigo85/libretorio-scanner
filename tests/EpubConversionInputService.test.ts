import fs from "fs-extra";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it } from "@jest/globals";
import { EpubConversionInputService } from "(src)/services/EpubConversionInputService";
import { inspectDocumentSource, fileDigest } from "(src)/services/DocumentSourceService";

describe("EPUB conversion input", () => {
	let root: string, sourcePath: string, cache: string, work: string;
	const coverId = "11111111-1111-4111-8111-111111111111";
	beforeEach(async () => {
		root = await fs.mkdtemp(path.join(os.tmpdir(), "epub-input-"));
		sourcePath = path.join(root, "book"); cache = path.join(root, "cache"); work = path.join(root, "work");
		await fs.ensureDir(sourcePath); await fs.ensureDir(cache); await fs.ensureDir(work);
		await fs.writeFile(path.join(sourcePath, "chapter.xhtml"), "chapter one");
		await fs.writeFile(path.join(cache, "existing.pdf"), "keep PDF");
		await fs.writeFile(path.join(cache, "cover.webp"), "keep cover");
	});
	afterEach(async () => { await fs.remove(root); });
	const source = () => inspectDocumentSource({id: 1, coverId, name: "book", parentPath: root, fileKind: "EPUB"}, root);
	it("builds a missing ZIP through the existing builder and reuses an unchanged one", async () => {
		const service = new EpubConversionInputService();
		await service.prepare(await source(), coverId, cache, work, async () => {});
		const zip = path.join(cache, coverId + ".zip"), before = await fs.stat(zip);
		expect(await fileDigest(zip)).toBe(await fileDigest(path.join(work, "input.epub")));
		await service.prepare(await source(), coverId, cache, work, async () => {});
		expect((await fs.stat(zip)).ino).toBe(before.ino);
		expect(await fs.readFile(path.join(cache, "existing.pdf"), "utf8")).toBe("keep PDF");
		expect(await fs.readFile(path.join(cache, "cover.webp"), "utf8")).toBe("keep cover");
	});
	it("rebuilds a readable ZIP whose source content changed", async () => {
		const service = new EpubConversionInputService();
		await service.prepare(await source(), coverId, cache, work, async () => {});
		const before = await fileDigest(path.join(cache, coverId + ".zip"));
		await fs.writeFile(path.join(sourcePath, "chapter.xhtml"), "chapter two");
		await service.prepare(await source(), coverId, cache, work, async () => {});
		expect(await fileDigest(path.join(cache, coverId + ".zip"))).not.toBe(before);
	});
	it("repairs a damaged ZIP, but never publishes after lease loss", async () => {
		const zip = path.join(cache, coverId + ".zip"); await fs.writeFile(zip, "damaged");
		const service = new EpubConversionInputService();
		await expect(service.prepare(await source(), coverId, cache, work, async () => { throw new Error("lease lost"); })).rejects.toThrow("lease lost");
		expect(await fs.readFile(zip, "utf8")).toBe("damaged");
		await service.prepare(await source(), coverId, cache, work, async () => {});
		expect(await fileDigest(zip)).toBe(await fileDigest(path.join(work, "input.epub")));
	});
});
