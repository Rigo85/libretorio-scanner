import fs from "fs/promises";
import os from "os";
import path from "path";
import { describe, it, expect, beforeEach, afterEach, jest } from "@jest/globals";
import { AudioMetadataService, isAudioCandidate } from "(src)/services/AudioMetadataService";
import { FileKind } from "(src)/models/interfaces/File";
import { audioSourceSignature } from "(src)/services/AudioProbeService";

describe("audio extraction lifecycle", () => {
	let root: string;
	beforeEach(async () => {root = await fs.mkdtemp(path.join(os.tmpdir(), "audio-service-"));});
	afterEach(async () => {await fs.rm(root, {recursive: true, force: true});});
	const archive = (root: string, name: string, kind = FileKind.FILE) => ({id: 1, name, parentPath: root,
		parentHash: "root", fileHash: "hash", size: "1", coverId: "cover", fileKind: kind});
	const repository = () => ({list: jest.fn<() => Promise<any[]>>().mockResolvedValue([]),
		claim: jest.fn<() => Promise<string | undefined>>().mockResolvedValue("token"), complete: jest.fn(async () => true),
		fail: jest.fn(async () => undefined), removeMissing: jest.fn(async () => undefined)});
	const extractor = () => ({getVersion: jest.fn(async () => "test-v1"),
		detectContainers: jest.fn<(files: string[]) => Promise<any[]>>().mockImplementation(async files => files.map(() => ({container: "mov"}))),
		probe: jest.fn(async () => ({status: "ready", duration: 10, chapters: [], details: {warnings: []}}))});
	it("does not extract reused metadata", async () => {
		await fs.writeFile(path.join(root, "one.m4a"), "sample");
		const repo = repository(), probe = extractor();
		repo.list.mockResolvedValue([{archiveId: 1, relativePath: "", status: "ready", extractorVersion: "test-v1",
			sourceSignature: await audioSourceSignature(path.join(root, "one.m4a"), root)}]);
		const result = await new AudioMetadataService(repo as any, probe as any).process([archive(root, "one.m4a")], root);
		expect(probe.probe).not.toHaveBeenCalled();
		expect(probe.detectContainers).not.toHaveBeenCalled();
		expect(repo.claim).not.toHaveBeenCalled();
		expect(result.reusedOrDeferred).toBe(1);
	});
	it("extracts m4a and m4b children with independent keys", async () => {
		await fs.mkdir(path.join(root, "book"));
		for (const name of ["one.m4a", "two.m4b"]) await fs.writeFile(path.join(root, "book", name), "sample");
		const repo = repository(), probe = extractor();
		const result = await new AudioMetadataService(repo as any, probe as any).process([archive(root, "book", FileKind.AUDIOBOOK)], root);
		expect(result.extracted).toBe(2);
		expect(repo.removeMissing).toHaveBeenCalledWith(1, ["one.m4a", "two.m4b"]);
	});
	it("does not publish a result when source changes during extraction", async () => {
		const file = path.join(root, "one.m4b");
		await fs.writeFile(file, "sample");
		const repo = repository(), probe = extractor();
		probe.probe.mockImplementation(async () => {
			await fs.writeFile(file, "changed source");
			return {status: "ready", duration: 10, chapters: [], details: {warnings: []}};
		});
		const result = await new AudioMetadataService(repo as any, probe as any).process([archive(root, "one.m4b")], root);
		expect(result.failed).toBe(1);
		expect(repo.complete).not.toHaveBeenCalled();
		expect(repo.fail).toHaveBeenCalled();
	});
	it("does not remove cached tracks when directory enumeration fails", async () => {
		const repo = repository(), probe = extractor();
		await new AudioMetadataService(repo as any, probe as any).process([archive(root, "missing", FileKind.AUDIOBOOK)], root);
		expect(repo.removeMissing).not.toHaveBeenCalled();
	});
	it("records parser failures without stopping other files", async () => {
		for (const name of ["one.m4a", "two.m4b"]) await fs.writeFile(path.join(root, name), "sample");
		const repo = repository(), probe = extractor();
		probe.probe.mockRejectedValueOnce(new Error("timeout"));
		const result = await new AudioMetadataService(repo as any, probe as any).process([archive(root, "one.m4a"), {...archive(root, "two.m4b"), id: 2}], root);
		expect(result).toMatchObject({failed: 1, extracted: 1});
	});
	it("selects audio extensions case-insensitively for files and folder children", async () => {
		await fs.mkdir(path.join(root, "book"));
		for (const name of ["track.M4A", "track.FLAC", "notes.pdf"]) await fs.writeFile(path.join(root, "book", name), "sample");
		await fs.writeFile(path.join(root, "standalone.MP3"), "sample");
		const repo = repository(), probe = extractor();
		const result = await new AudioMetadataService(repo as any, probe as any).process([
			archive(root, "book", FileKind.AUDIOBOOK), {...archive(root, "standalone.MP3"), id: 2}
		], root);
		expect(result.extracted).toBe(3);
		expect(result.extensionSkipped).toBe(1);
		expect(repo.removeMissing).toHaveBeenCalledWith(1, ["notes.pdf", "track.FLAC", "track.M4A"]);
		expect(probe.detectContainers.mock.calls.flatMap(call => call[0])).not.toContain(path.join(root, "book", "notes.pdf"));
	});
	it("filters non-audio names before source validation, detector, cache reuse or extraction", async () => {
		const names = ["missing.pdf", "missing.epub", "missing.doc", "missing.ppt", "missing.cbr", "missing.txt",
			"missing.mp4", "missing.mkv", "missing.mp3.zip", "missing"];
		const repo = repository(), probe = extractor();
		repo.list.mockResolvedValue([{archiveId: 1, relativePath: "", status: "ready", extractorVersion: "test-v1", sourceSignature: "old-false-positive"}]);
		const result = await new AudioMetadataService(repo as any, probe as any).process(
			names.map((name, index) => ({...archive(root, name), id: index + 1})), root);
		expect(result).toMatchObject({checked: 10, extensionSkipped: 10, headersInspected: 0, extracted: 0, failed: 0, reusedOrDeferred: 0});
		expect(probe.detectContainers).not.toHaveBeenCalled();
		expect(probe.probe).not.toHaveBeenCalled();
		expect(repo.claim).not.toHaveBeenCalled();
	});
	it.each(["mp3", "wav", "m4a", "m4b", "ogg", "flac"])("includes the existing backend audio extension %s", extension => {
		expect(isAudioCandidate(`track.${extension}`)).toBe(true);
		expect(isAudioCandidate(`track.${extension.toUpperCase()}`)).toBe(true);
	});
	it("does not accept an mp3 filename when the content is not supported media", async () => {
		await fs.writeFile(path.join(root, "fake.mp3"), "not audio");
		const repo = repository(), probe = extractor();
		probe.detectContainers.mockResolvedValue([{}]);
		const result = await new AudioMetadataService(repo as any, probe as any).process([archive(root, "fake.mp3")], root);
		expect(result.detected).toBe(0);
		expect(repo.claim).not.toHaveBeenCalled();
		expect(probe.probe).not.toHaveBeenCalled();
	});
	it("keeps existing rows on detection errors and rejects escaping children before reading contents", async () => {
		await fs.mkdir(path.join(root, "book"));
		await fs.writeFile(path.join(root, "book", "track.mp3"), "sample");
		await fs.symlink("/etc/hosts", path.join(root, "escape.mp3"));
		const repo = repository(), probe = extractor();
		probe.detectContainers.mockResolvedValue([{error: "Read failure"}]);
		const result = await new AudioMetadataService(repo as any, probe as any).process([
			archive(root, "book", FileKind.AUDIOBOOK), {...archive(root, "escape.mp3"), id: 2}
		], root);
		expect(result.failed).toBe(2);
		expect(probe.detectContainers).toHaveBeenCalledTimes(1);
		expect(repo.removeMissing).toHaveBeenCalledWith(1, ["track.mp3"]);
		expect(repo.claim).not.toHaveBeenCalled();
	});
	it("reuses skipped media without reading contents or extracting again", async () => {
		await fs.writeFile(path.join(root, "movie.mp3"), "video");
		const repo = repository(), probe = extractor();
		repo.list.mockResolvedValue([{archiveId: 1, relativePath: "", status: "skipped", extractorVersion: "test-v1",
			sourceSignature: await audioSourceSignature(path.join(root, "movie.mp3"), root)}]);
		const result = await new AudioMetadataService(repo as any, probe as any).process([archive(root, "movie.mp3")], root);
		expect(result).toMatchObject({skipped: 1, skippedReused: 1, failed: 0, extracted: 0});
		expect(probe.detectContainers).not.toHaveBeenCalled();
		expect(probe.probe).not.toHaveBeenCalled();
	});
	it("reclassifies a pending legacy false positive without probing or deleting its row", async () => {
		await fs.writeFile(path.join(root, "archive.mp3"), "PK archive content");
		const repo = repository(), probe = extractor();
		repo.list.mockResolvedValue([{archiveId: 1, relativePath: "", status: "pending", extractorVersion: "test-v1",
			sourceSignature: await audioSourceSignature(path.join(root, "archive.mp3"), root)}]);
		probe.detectContainers.mockResolvedValue([{}]);
		const result = await new AudioMetadataService(repo as any, probe as any).process([archive(root, "archive.mp3")], root);
		expect(result).toMatchObject({skipped: 1, failed: 0, extracted: 0});
		expect(probe.probe).not.toHaveBeenCalled();
		expect(repo.complete).toHaveBeenCalledWith(1, "", "token", expect.objectContaining({
			status: "skipped", chapters: [], details: expect.objectContaining({reason: "non-audio-content"})
		}));
		expect(repo.removeMissing).not.toHaveBeenCalled();
	});
	it("does not classify discarded videos as failed extractions", async () => {
		await fs.writeFile(path.join(root, "movie.mp3"), "video");
		const repo = repository(), probe = extractor();
		probe.probe.mockResolvedValue({status: "skipped", duration: undefined, chapters: [], details: {warnings: []}});
		const result = await new AudioMetadataService(repo as any, probe as any).process([archive(root, "movie.mp3")], root);
		expect(result).toMatchObject({skipped: 1, failed: 0, extracted: 0, detected: 0});
		expect(repo.complete).toHaveBeenCalled();
		expect(repo.fail).not.toHaveBeenCalled();
	});
	it("batches non-audio headers and reports checked files without creating metadata rows", async () => {
		const files = [];
		for (let i = 0; i < 130; i++) {
			const name = `document-${i}.mp3`;
			await fs.writeFile(path.join(root, name), i ? "document" : "");
			files.push({...archive(root, name), id: i + 1});
		}
		const repo = repository(), probe = extractor();
		probe.detectContainers.mockImplementation(async files => files.map(() => ({})));
		const result = await new AudioMetadataService(repo as any, probe as any).process(files, root);
		expect(result).toMatchObject({checked: 130, headersInspected: 130, skipped: 130, failed: 0});
		expect(probe.detectContainers.mock.calls.map(call => call[0].length)).toEqual([64, 64, 2]);
		expect(repo.claim).not.toHaveBeenCalled();
		expect(probe.probe).not.toHaveBeenCalled();
	});
	it("revalidates changed files and changed extractor versions instead of reusing stale results", async () => {
		await fs.writeFile(path.join(root, "audio.mp3"), "new source");
		const repo = repository(), probe = extractor();
		repo.list.mockResolvedValue([{archiveId: 1, relativePath: "", status: "ready", extractorVersion: "old-version",
			sourceSignature: await audioSourceSignature(path.join(root, "audio.mp3"), root)}]);
		await new AudioMetadataService(repo as any, probe as any).process([archive(root, "audio.mp3")], root);
		expect(probe.probe).toHaveBeenCalledTimes(1);
		probe.probe.mockClear();
		repo.list.mockResolvedValue([{archiveId: 1, relativePath: "", status: "ready", extractorVersion: "test-v1", sourceSignature: "old"}]);
		await new AudioMetadataService(repo as any, probe as any).process([archive(root, "audio.mp3")], root);
		expect(probe.probe).toHaveBeenCalledTimes(1);
	});
});
