import fs from "fs-extra";
import os from "os";
import path from "path";
import {EventEmitter} from "events";
import unzipper from "unzipper";
import {afterEach, beforeEach, describe, expect, it, jest} from "@jest/globals";
import {config} from "(src)/config/configuration";
import {FileKind} from "(src)/models/interfaces/File";
import {SpecialDirectoryArtifactService} from "(src)/services/SpecialDirectoryArtifactService";
import * as zipUtils from "(src)/utils/comicCacheUtils";
import * as stateUtils from "(src)/utils/specialZipState";

const archiverUtils = require("archiver-utils") as {dateify: (value: unknown) => Date};
const archiverCore = require("archiver/lib/core") as {prototype: {directory: (...args: unknown[]) => unknown}};

describe("ZIP freshness and publication (real files, no database)", () => {
	let temporary: string;
	let source: string;
	let oldCache: string;
	let zip: string;
	const file = {name: "audio", parentPath: "", parentHash: "p", fileHash: "f", size: "0 B", coverId: "zip-test", fileKind: FileKind.AUDIOBOOK};
	const run = () => SpecialDirectoryArtifactService.getInstance().ensureArtifactForFile(file);
	const originalDate = new Date("2025-01-01T12:15:17.500Z");

	beforeEach(async () => {
		// fs dates come from Node's realm; archiver's instanceof Date fails inside Jest's VM.
		const dateify = archiverUtils.dateify;
		jest.spyOn(archiverUtils, "dateify").mockImplementation(value => dateify(
			Object.prototype.toString.call(value) === "[object Date]" ? new Date((value as Date).getTime()) : value
		));
		temporary = await fs.mkdtemp(path.join(os.tmpdir(), "special-zip-state-"));
		oldCache = config.production.paths.cache;
		config.production.paths.cache = path.join(temporary, "cache");
		file.parentPath = temporary;
		source = path.join(temporary, file.name);
		await fs.ensureDir(source);
		await fs.writeFile(path.join(source, "one.mp3"), "first track");
		await fs.utimes(path.join(source, "one.mp3"), originalDate, originalDate);
		zip = zipUtils.getZipPath(file.coverId);
	});

	afterEach(async () => {
		jest.restoreAllMocks();
		config.production.paths.cache = oldCache;
		await fs.remove(temporary);
	});

	it("creates, records provenance, and reuses without rewriting", async () => {
		expect((await run()).action).toBe("created");
		const signature = await stateUtils.specialZipSignature(zip);
		expect(await fs.readJson(stateUtils.specialZipStatePath(zip))).toMatchObject({version: 1, status: "ready", origin: "generated"});
		const generator = jest.spyOn(zipUtils, "generateDirectoryZipArtifact");
		expect((await run()).action).toBe("reused");
		expect(generator).not.toHaveBeenCalled();
		expect(await stateUtils.specialZipSignature(zip)).toBe(signature);
	});

	it.each(["add", "delete", "rename", "resize", "same-size-preserved-mtime"])("rebuilds after %s, then reuses", async (change) => {
		await fs.writeFile(path.join(source, "two.mp3"), "second track");
		await run();
		const original = path.join(source, "one.mp3");
		if (change === "add") await fs.writeFile(path.join(source, "three.mp3"), "third");
		if (change === "delete") await fs.remove(original);
		if (change === "rename") await fs.rename(original, path.join(source, "renamed.mp3"));
		if (change === "resize") await fs.appendFile(original, " more data");
		if (change === "same-size-preserved-mtime") {
			await fs.writeFile(original, "other track");
			await fs.utimes(original, originalDate, originalDate);
		}
		expect(await run()).toMatchObject({action: "rebuilt", reason: "source-changed"});
		expect(await stateUtils.specialZipMatchesSource(zip, await stateUtils.inspectSpecialZipSource(source))).toBe(true);
		expect((await run()).action).toBe("reused");
	});

	it("adopts a matching legacy ZIP without extracting or rewriting it", async () => {
		await zipUtils.generateDirectoryZipArtifact(source, file.coverId);
		const before = await stateUtils.specialZipSignature(zip);
		expect(await run()).toMatchObject({action: "adopted", reason: "legacy-inventory"});
		expect(await stateUtils.specialZipSignature(zip)).toBe(before);
		expect((await fs.readJson(stateUtils.specialZipStatePath(zip))).origin).toBe("legacy");
		expect((await run()).action).toBe("reused");
	});

	it.each(["name", "size", "time"])("rebuilds a legacy ZIP with a %s mismatch", async (change) => {
		await zipUtils.generateDirectoryZipArtifact(source, file.coverId);
		const original = path.join(source, "one.mp3");
		if (change === "name") await fs.rename(original, path.join(source, "renamed.mp3"));
		if (change === "size") await fs.appendFile(original, "changed");
		if (change === "time") await fs.utimes(original, new Date(), new Date());
		expect(await run()).toMatchObject({action: "rebuilt", reason: "inventory-mismatch"});
	});

	it.each(["1970-01-01T00:00:00Z", "2025-01-01T12:15:17.999Z", "2050-01-01T00:00:00Z"])("handles ZIP date precision/clamping: %s", async (date) => {
		await fs.utimes(path.join(source, "one.mp3"), new Date(date), new Date(date));
		await zipUtils.generateDirectoryZipArtifact(source, file.coverId);
		expect((await run()).action).toBe("adopted");
		expect((await run()).action).toBe("reused");
	});

	it.each([1.9991, 1.9995, 1.9999, 2.0001])("matches native stat Date rounding near a DOS boundary: %s", async (offset) => {
		await fs.utimes(path.join(source, "one.mp3"), 1735689600 + offset, 1735689600 + offset);
		await zipUtils.generateDirectoryZipArtifact(source, file.coverId);
		expect(await stateUtils.specialZipMatchesSource(zip, await stateUtils.inspectSpecialZipSource(source))).toBe(true);
		expect((await run()).action).toBe("adopted");
	});

	it("rebuilds when the ZIP is replaced manually even with identical bytes", async () => {
		await run();
		await fs.copyFile(zip, `${zip}.replacement`);
		await fs.rename(`${zip}.replacement`, zip);
		expect(await run()).toMatchObject({action: "rebuilt", reason: "zip-changed"});
	});

	it("recreates a deleted ZIP despite an existing ready record", async () => {
		await run();
		await fs.remove(zip);
		expect(await run()).toMatchObject({action: "created", reason: "missing-zip"});
	});

	it.each(["{", JSON.stringify({version: 1, status: "publishing"})])("does not adopt legacy after corrupt or incomplete state: %s", async (state) => {
		await zipUtils.generateDirectoryZipArtifact(source, file.coverId);
		await fs.writeFile(stateUtils.specialZipStatePath(zip), state);
		expect((await run()).action).toBe("rebuilt");
		expect((await run()).action).toBe("reused");
	});

	it("preserves unrelated cache files on rebuild", async () => {
		await run();
		const pdf = path.join(path.dirname(zip), "existing.pdf");
		await fs.writeFile(pdf, "do not touch");
		await fs.writeFile(path.join(source, "two.mp3"), "new");
		expect((await run()).action).toBe("rebuilt");
		expect(await fs.readFile(pdf, "utf8")).toBe("do not touch");
	});

	it("handles nested EPUB resources and empty directories", async () => {
		await fs.ensureDir(path.join(source, "OEBPS", "empty"));
		await fs.writeFile(path.join(source, "OEBPS", "chapter.xhtml"), "text");
		expect((await run()).status).toBe("ready");
		await fs.writeFile(path.join(source, "OEBPS", "chapter.xhtml"), "new text");
		expect((await run()).action).toBe("rebuilt");
		expect((await run()).action).toBe("reused");
	});

	it("rejects links rather than silently ignoring or following them", async () => {
		await run();
		const previous = await fs.readFile(zip);
		await fs.symlink(path.join(source, "one.mp3"), path.join(source, "linked.mp3"));
		expect((await run()).status).toBe("error");
		expect(await fs.readFile(zip)).toEqual(previous);
	});

	it("does not publish when the source changes during generation", async () => {
		await run();
		const previous = await fs.readFile(zip);
		await fs.writeFile(path.join(source, "two.mp3"), "new");
		const generate = zipUtils.generateDirectoryZipArtifact;
		jest.spyOn(zipUtils, "generateDirectoryZipArtifact").mockImplementation(async (...args) => {
			const result = await generate(...args);
			await fs.writeFile(path.join(source, "one.mp3"), "other track");
			await fs.utimes(path.join(source, "one.mp3"), originalDate, originalDate);
			return result;
		});
		expect((await run()).status).toBe("error");
		expect(await fs.readFile(zip)).toEqual(previous);
	});

	it("rejects a generated ZIP with omitted files", async () => {
		await run();
		const previous = await fs.readFile(zip);
		await fs.writeFile(path.join(source, "two.mp3"), "new");
		jest.spyOn(zipUtils, "generateDirectoryZipArtifact").mockImplementation(async (_source, id, staging) => {
			const target = zipUtils.getZipPath(id, staging);
			await fs.writeFile(target, previous);
			return {zipPath: target, sizeBytes: previous.length};
		});
		expect((await run()).status).toBe("error");
		expect(await fs.readFile(zip)).toEqual(previous);
	});

	it("keeps the old ZIP if replacement fails and retries instead of adopting", async () => {
		await run();
		const previous = await fs.readFile(zip);
		await fs.writeFile(path.join(source, "two.mp3"), "new");
		const rename = fs.rename.bind(fs);
		const spy = jest.spyOn(fs, "rename").mockImplementation((async (from: string, to: string) => {
			if (to === zip) throw new Error("simulated replacement failure");
			return rename(from, to);
		}) as typeof fs.rename);
		expect((await run()).status).toBe("error");
		expect(await fs.readFile(zip)).toEqual(previous);
		expect((await fs.readJson(stateUtils.specialZipStatePath(zip))).status).toBe("publishing");
		spy.mockRestore();
		expect(await run()).toMatchObject({action: "rebuilt", reason: "incomplete-state"});
	});

	it("recovers after ZIP publication but before ready state is written", async () => {
		await run();
		await fs.writeFile(path.join(source, "two.mp3"), "new");
		const rename = fs.rename.bind(fs);
		let stateWrites = 0;
		const spy = jest.spyOn(fs, "rename").mockImplementation((async (from: string, to: string) => {
			if (to === stateUtils.specialZipStatePath(zip) && ++stateWrites === 2) throw new Error("simulated power loss");
			return rename(from, to);
		}) as typeof fs.rename);
		expect((await run()).status).toBe("error");
		expect(await stateUtils.specialZipMatchesSource(zip, await stateUtils.inspectSpecialZipSource(source))).toBe(true);
		expect((await fs.readJson(stateUtils.specialZipStatePath(zip))).status).toBe("publishing");
		spy.mockRestore();
		expect(await run()).toMatchObject({action: "rebuilt", reason: "incomplete-state"});
		expect((await run()).action).toBe("reused");
	});

	it("treats an archiver omission warning as a failed build", async () => {
		await run();
		const previous = await fs.readFile(zip);
		await fs.writeFile(path.join(source, "two.mp3"), "new");
		jest.spyOn(archiverCore.prototype, "directory").mockImplementation(function (this: EventEmitter) {
			this.emit("warning", new Error("ENOENT: file disappeared during ZIP generation"));
			return this;
		});
		const result = await run();
		expect(result.status).toBe("error");
		expect(result.error).toContain("file disappeared");
		expect(await fs.readFile(zip)).toEqual(previous);
	});

	it("does not change warning policy of other ZIP callers", async () => {
		const directory = archiverCore.prototype.directory;
		jest.spyOn(archiverCore.prototype, "directory").mockImplementation(function (this: EventEmitter, ...args) {
			this.emit("warning", new Error("nonfatal warning for legacy caller"));
			return directory.apply(this, args);
		});
		await expect(zipUtils.generateDirectoryZipArtifact(source, file.coverId)).resolves.toHaveProperty("zipPath", zip);
	});

	it("retains old state and ZIP if the publishing intent cannot be saved", async () => {
		await run();
		const previous = await fs.readFile(zip);
		const previousState = await fs.readFile(stateUtils.specialZipStatePath(zip));
		await fs.writeFile(path.join(source, "two.mp3"), "new");
		const rename = fs.rename.bind(fs);
		jest.spyOn(fs, "rename").mockImplementation((async (from: string, to: string) => {
			if (to === stateUtils.specialZipStatePath(zip)) throw new Error("state write failed");
			return rename(from, to);
		}) as typeof fs.rename);
		expect((await run()).status).toBe("error");
		expect(await fs.readFile(zip)).toEqual(previous);
		expect(await fs.readFile(stateUtils.specialZipStatePath(zip))).toEqual(previousState);
	});

	it("reports an I/O failure without trying to rebuild a supposedly corrupt ZIP", async () => {
		await run();
		const previous = await fs.readFile(zip);
		const generator = jest.spyOn(zipUtils, "generateDirectoryZipArtifact");
		jest.spyOn(unzipper.Open, "file").mockRejectedValue(Object.assign(new Error("ZIP read failed"), {code: "EIO"}));
		expect((await run()).status).toBe("error");
		expect(generator).not.toHaveBeenCalled();
		expect(await fs.readFile(zip)).toEqual(previous);
	});
});
