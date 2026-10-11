import fs from "fs-extra";
import path from "path";
import os from "os";
import { randomUUID } from "crypto";
import { afterEach, beforeEach, describe, expect, it, jest } from "@jest/globals";
import { DocumentConversionService } from "(src)/services/DocumentConversionService";
import { DocumentConverterService } from "(src)/services/DocumentConverterService";
import { DocumentConversionRepository } from "(src)/repositories/DocumentConversionRepository";
import { ConversionCandidate, ConversionError, ConversionState } from "(src)/models/interfaces/DocumentConversion";
import { conversionCacheDirectory, fileDigest, fileSignature, inspectDocumentSource } from "(src)/services/DocumentSourceService";

describe("sequential PDF phase", () => {
	let root: string, library: string, cache: string;
	let candidates: ConversionCandidate[], states: Map<number, ConversionState>;
	let repository: any, converter: any, service: DocumentConversionService;
	const guard = async () => {};
	beforeEach(async () => {
		root = await fs.mkdtemp(path.join(os.tmpdir(), "pdf-phase-"));
		library = path.join(root, "books"); cache = path.join(root, "cache");
		await fs.ensureDir(library); await fs.ensureDir(cache);
		candidates = []; states = new Map();
		repository = {
			window: jest.fn(async () => ({upper: Math.max(0, ...candidates.map(c => c.id)), total: candidates.length})),
			start: jest.fn(async () => "run"),
			page: jest.fn(async (_root: number, after: number, upper: number, limit: number) => candidates
				.filter(c => c.id > after && c.id <= upper).slice(0, limit).map(c => ({...c, conversion: states.get(c.id)}))),
			save: jest.fn(async (id: number, _run: string, state: ConversionState) => { states.set(id, structuredClone(state)); }),
			progress: jest.fn(async () => {})
		};
		converter = {
			recipe: "test-v1", processes: {stop: jest.fn(async () => {})}, tool: () => "calibre",
			version: jest.fn(async () => "fixture-v1"),
			convert: jest.fn(async (_source: unknown, work: string, onStart?: () => void) => {
				onStart?.();
				const output = path.join(work, "result.pdf"); await fs.writeFile(output, "%PDF-test");
				return {output, warnings: ""};
			}), validate: jest.fn(async () => 2)
		};
		service = new DocumentConversionService(repository as DocumentConversionRepository,
			converter as DocumentConverterService, cache, 2, path.join(root, "diagnostics"));
		jest.spyOn(console, "log").mockImplementation(() => {});
	});
	afterEach(async () => { jest.restoreAllMocks(); await fs.remove(root); });
	async function add(id: number, name = `${id}.txt`, kind = "FILE") {
		const row = {id, name, parentPath: library, coverId: randomUUID(), fileKind: kind};
		candidates.push(row);
		await fs.writeFile(path.join(library, name), `document ${id}`);
		return row;
	}
	const pdf = (row: ConversionCandidate) => path.join(cache, row.coverId, `${row.coverId}.pdf`);

	it("paginates by ID, processes sequentially, reuses without running tools", async () => {
		await add(1); await add(3); await add(9);
		let active = 0, peak = 0;
		const convert = converter.convert.getMockImplementation();
		converter.convert.mockImplementation(async (...args: unknown[]) => {
			peak = Math.max(peak, ++active); await new Promise(r => setTimeout(r, 2));
			const result = await convert(...args); active--; return result;
		});
		const first = await service.process(5, library, guard);
		expect(first).toMatchObject({total: 3, checked: 3, converted: 3, failed: 0});
		expect(peak).toBe(1);
		expect(repository.page.mock.calls.map((c: any[]) => c.slice(1))).toEqual([[0,9,2],[3,9,2],[9,9,2]]);
		converter.convert.mockClear(); converter.validate.mockClear();
		const second = await service.process(5, library, guard);
		expect(second.reused).toBe(3);
		expect(converter.convert).not.toHaveBeenCalled(); expect(converter.validate).not.toHaveBeenCalled();
	});
	it("regenerates ready PDFs removed by a preceding ZIP folder replacement", async () => {
		const row = await add(1); await service.process(5, library, guard);
		await fs.remove(path.dirname(pdf(row))); await fs.ensureDir(path.dirname(pdf(row)));
		await fs.writeFile(path.join(path.dirname(pdf(row)), `${row.coverId}.zip`), "existing ZIP");
		expect((await service.process(5, library, guard)).converted).toBe(1);
		expect(await fs.readFile(path.join(path.dirname(pdf(row)), `${row.coverId}.zip`), "utf8")).toBe("existing ZIP");
	});
	it("regenerates empty or modified outputs and changed sources", async () => {
		const row = await add(1); await service.process(5, library, guard);
		await fs.writeFile(pdf(row), ""); expect((await service.process(5, library, guard)).converted).toBe(1);
		await fs.writeFile(pdf(row), "broken"); expect((await service.process(5, library, guard)).converted).toBe(1);
		await fs.appendFile(path.join(library, row.name), "new");
		expect((await service.process(5, library, guard)).converted).toBe(1);
	});
	it("backs up legacy PDF before regenerating, never overwrites that backup", async () => {
		const row = await add(1); await fs.ensureDir(path.dirname(pdf(row))); await fs.writeFile(pdf(row), "legacy");
		await service.process(5, library, guard);
		const backups = (await fs.readdir(cache)).filter(n => n.includes(".legacy-"));
		expect(backups).toHaveLength(1);
		expect(await fs.readFile(path.join(cache, backups[0]), "utf8")).toBe("legacy");
		await fs.remove(path.dirname(pdf(row)));
		await service.process(5, library, guard);
		expect(await fs.readFile(path.join(cache, backups[0]), "utf8")).toBe("legacy");
		expect(states.get(1)?.legacyBackup).toBe(path.join(cache, backups[0]));
	});
	it("recovers a publication whose ready update failed", async () => {
		const row = await add(1);
		const save = repository.save.getMockImplementation();
		repository.save.mockImplementation(async (...args: any[]) => {
			if (args[2].status === "ready") throw new Error("DB interrupted");
			await save(...args);
		});
		await expect(service.process(5, library, guard)).rejects.toThrow("DB interrupted");
		expect(states.get(1)?.status).toBe("processing"); expect(await fs.pathExists(pdf(row))).toBe(true);
		repository.save.mockImplementation(save); converter.convert.mockClear();
		expect((await service.process(5, library, guard)).recovered).toBe(1);
		expect(converter.convert).not.toHaveBeenCalled();
	});
	it("does not adopt a previous PDF merely because the state says processing", async () => {
		const row = await add(1); await service.process(5, library, guard);
		states.set(1, {...states.get(1)!, status: "processing", outputHash: "not-the-published-hash", attempts: 1});
		expect((await service.process(5, library, guard)).converted).toBe(1);
		expect(await fs.pathExists(pdf(row))).toBe(true);
	});
	it("rebuilds a digest-matching interrupted PDF rejected by validation", async () => {
		const row = await add(1); await service.process(5, library, guard);
		states.set(1, {...states.get(1)!, status: "processing", attempts: 1});
		converter.convert.mockClear();
		converter.validate.mockRejectedValueOnce(new ConversionError("invalid_pdf", "Malformed PDF"));
		expect(await service.process(5, library, guard)).toMatchObject({converted: 1, recovered: 0, failed: 0});
		expect(converter.convert).toHaveBeenCalledTimes(1);
		expect(states.get(1)).toMatchObject({status: "ready", attempts: 2});
		expect(states.get(1)?.recoveryRejectedHash).toBeUndefined();
		expect(await fs.pathExists(pdf(row))).toBe(true);
	});
	it("does not repeatedly recover a rejected PDF when reconstruction fails", async () => {
		const row = await add(1); await service.process(5, library, guard);
		states.set(1, {...states.get(1)!, status: "processing", attempts: 1});
		converter.validate.mockRejectedValueOnce(new ConversionError("invalid_pdf", "Malformed PDF"));
		converter.convert.mockRejectedValueOnce(new ConversionError("converter", "Cannot reconstruct"));
		expect((await service.process(5, library, guard)).failed).toBe(1);
		expect(await fs.pathExists(pdf(row))).toBe(true);
		converter.validate.mockClear(); converter.convert.mockClear();
		expect((await service.process(5, library, guard)).deferred).toBe(1);
		expect(converter.validate).not.toHaveBeenCalled(); expect(converter.convert).not.toHaveBeenCalled();
	});
	it("records a rejected recovery once without bypassing exhausted retries", async () => {
		await add(1); await service.process(5, library, guard);
		states.set(1, {...states.get(1)!, status: "failed", errorCode: "timeout", attempts: 3});
		converter.validate.mockRejectedValueOnce(new ConversionError("invalid_pdf", "Malformed PDF"));
		converter.convert.mockClear();
		expect((await service.process(5, library, guard)).deferred).toBe(1);
		expect(states.get(1)?.recoveryRejectedHash).toBe(states.get(1)?.outputHash);
		converter.validate.mockClear();
		expect((await service.process(5, library, guard)).deferred).toBe(1);
		expect(converter.validate).not.toHaveBeenCalled(); expect(converter.convert).not.toHaveBeenCalled();
	});
	it.each(["storage", "sandbox", "resource_monitor"])("never rebuilds after fatal recovery error %s", async code => {
		await add(1); await service.process(5, library, guard);
		states.set(1, {...states.get(1)!, status: "processing"});
		converter.validate.mockRejectedValueOnce(new ConversionError(code, code, true));
		converter.convert.mockClear();
		await expect(service.process(5, library, guard)).rejects.toMatchObject({code, fatal: true});
		expect(converter.convert).not.toHaveBeenCalled();
	});
	it("reports accumulated failures separately and does not rewrite deferred records", async () => {
		for (const id of [1,2,3,4]) await add(id);
		await service.process(5, library, guard);
		for (const id of [2,3,4]) states.set(id, {...states.get(id)!, status: "failed", outputHash: undefined,
			errorCode: "converter", error: "unchanged failure", attempts: id === 3 ? 3 : 1,
			retryAfter: id === 4 ? new Date(Date.now() + 3600000).toISOString() : undefined});
		const before = structuredClone(states); repository.save.mockClear(); converter.convert.mockClear();
		expect(await service.process(5, library, guard)).toMatchObject({failed: 0, deferred: 3, reused: 1,
			inventory: {ready: 1, failed: 3, retryScheduled: 1, retryExhausted: 1, needsIntervention: 1,
				byTool: {calibre: {ready: 1, failed: 3, categories: {converter: 3}}}}});
		expect(Array.from(states.entries())).toEqual(Array.from(before.entries()));
		expect(repository.save).not.toHaveBeenCalled(); expect(converter.convert).not.toHaveBeenCalled();
	});
	it("classifies missing LibreOffice output without declaring a malformed generated PDF", async () => {
		await add(1); converter.tool = () => "libreoffice";
		converter.convert.mockImplementationOnce(async (_source: unknown, work: string, onStart: () => void) => {
			onStart(); return {output: path.join(work, "absent.pdf"), diagnostics: {stdout: "", stderr: "Error: source file could not be loaded"}};
		});
		expect((await service.process(5, library, guard)).failed).toBe(1);
		expect(states.get(1)).toMatchObject({errorCode: "converter_no_output", classification: {stage: "convert", category: "source_unreadable", toolExecuted: true}});
		expect(converter.validate).not.toHaveBeenCalled();
	});
	it("separates rejected input from converter executions", async () => {
		await add(1); converter.convert.mockRejectedValueOnce(new ConversionError("unsupported_content", "Non-document source content: application/pdf"));
		expect(await service.process(5, library, guard)).toMatchObject({failed: 1, rejectedBeforeConversion: 1, tools: {}});
		expect(states.get(1)?.classification).toMatchObject({category: "source_format_mismatch", toolExecuted: false});
	});
	it("records document errors, continues later IDs, and defers permanent failures", async () => {
		await add(1); await add(2);
		converter.convert.mockRejectedValueOnce(new ConversionError("converter", "damaged document"));
		const first = await service.process(5, library, guard);
		expect(first).toMatchObject({converted: 1, failed: 1, checked: 2});
		expect(repository.progress).toHaveBeenLastCalledWith("run", first, "completed_with_errors");
		const second = await service.process(5, library, guard);
		expect(second).toMatchObject({deferred: 1, reused: 1});
	});
	it("retries a legacy script rejection once, without changing ready outputs or other failures", async () => {
		await add(1, "one.epub"); await add(2); await add(3, "three.epub");
		await service.process(5, library, guard);
		const warning = "Blocking FAKE_PROTOCOL request: clbr://internal.invalid/js/jquery.js with code: Error.UrlNotFound";
		states.set(1, {...states.get(1)!, status: "failed", outputHash: undefined, errorCode: "missing_resource", error: warning, scriptReviewVersion: undefined, attempts: 3});
		states.set(3, {...states.get(3)!, status: "failed", outputHash: undefined, errorCode: "converter", error: "Bad ZIP", scriptReviewVersion: undefined});
		converter.convert.mockClear();
		converter.convert.mockRejectedValueOnce(new ConversionError("missing_resource", "Static review failed"));
		expect(await service.process(5, library, guard)).toMatchObject({failed: 1, reused: 1, deferred: 1});
		expect(converter.convert).toHaveBeenCalledTimes(1);
		expect(states.get(1)).toMatchObject({scriptReviewVersion: 1, attempts: 1});
		converter.convert.mockClear();
		expect(await service.process(5, library, guard)).toMatchObject({reused: 1, deferred: 2});
		expect(converter.convert).not.toHaveBeenCalled();
	});
	it("does not publish a source changed during conversion", async () => {
		const row = await add(1); const convert = converter.convert.getMockImplementation();
		converter.convert.mockImplementation(async (...args: any[]) => {
			await fs.appendFile(path.join(library, row.name), "changed"); return convert(...args);
		});
		expect((await service.process(5, library, guard)).failed).toBe(1);
		expect(states.get(1)?.errorCode).toBe("source_changed"); expect(await fs.pathExists(pdf(row))).toBe(false);
	});
	it.each(["ENOSPC", "EDQUOT", "EROFS", "EIO", "ENODEV"])("stops on infrastructure error %s", async code => {
		await add(1); await add(2); converter.convert.mockRejectedValueOnce(Object.assign(new Error(code), {code}));
		await expect(service.process(5, library, guard)).rejects.toThrow(code);
		expect(converter.convert).toHaveBeenCalledTimes(1);
		expect(states.get(1)).toMatchObject({status: "failed", errorCode: code});
		expect(states.has(2)).toBe(false);
	});
	it.each(["ENOSPC", "EDQUOT", "EROFS", "EIO", "ENODEV"])("stops the phase when actual script evidence persistence fails with %s", async code => {
		const row = await add(1, "one.epub"); await add(2);
		const actual = new DocumentConverterService("/test/calibre");
		jest.spyOn(actual, "version").mockResolvedValue("fixture-v1");
		const sandbox = jest.spyOn(actual as any, "sandbox")
			.mockResolvedValueOnce({stdout: "application/epub+zip", stderr: ""})
			.mockResolvedValueOnce({stdout: "Done", stderr: "Blocking FAKE_PROTOCOL request: clbr://internal.invalid/js/jquery.js with code: Error.UrlNotFound"})
			.mockResolvedValueOnce({stdout: "", stderr: ""})
			.mockResolvedValueOnce({stdout: '{"verified":true,"characters":100}', stderr: ""});
		const failure = Object.assign(new Error(`Cannot save evidence: ${code}`), {code});
		const writeJson = fs.writeJson;
		jest.spyOn(fs, "writeJson").mockImplementation(async (file, data) => {
			if (path.basename(String(file)) === "script-review.json") throw failure;
			await writeJson(file, data);
		});
		service = new DocumentConversionService(repository, actual, cache, 2, path.join(root, "diagnostics"));
		await expect(service.process(5, library, guard)).rejects.toBe(failure);
		expect(states.get(1)).toMatchObject({status: "failed", errorCode: code});
		expect(states.has(2)).toBe(false);
		expect(sandbox).toHaveBeenCalledTimes(4);
		expect(await fs.pathExists(pdf(row))).toBe(false);
		expect(repository.progress.mock.calls.at(-1)[2]).toBe("failed");
		expect((await fs.readJson(path.join(root, "diagnostics", "run", "1.json"))).error).toContain(code);
	});
	it("records readonly source failures and continues, preserving diagnostics", async () => {
		await add(1); await add(2);
		converter.convert.mockRejectedValueOnce(new ConversionError("source_readonly", "Read-only file system: '/input/font.ttf'"));
		expect(await service.process(5, library, guard)).toMatchObject({converted: 1, failed: 1, checked: 2});
		expect(states.get(1)).toMatchObject({status: "failed", errorCode: "source_readonly"});
		const diagnosticPath = path.join(root, "diagnostics", "run", "1.json");
		const diagnostic = await fs.readJson(diagnosticPath);
		expect(diagnostic.error).toContain("/input/font.ttf");
		await fs.remove(path.join(cache, ".scanner-build"));
		expect(await fs.readJson(diagnosticPath)).toEqual(diagnostic);
	});
	it("SQL failure is not exhaustion or successful completion", async () => {
		await add(1); repository.page.mockRejectedValueOnce(new Error("query failed"));
		await expect(service.process(5, library, guard)).rejects.toThrow("query failed");
		expect(repository.progress.mock.calls.at(-1)[2]).toBe("failed");
		expect(converter.convert).not.toHaveBeenCalled();
	});
	it("stops when the library disappears instead of failing every remaining document", async () => {
		await add(1); await add(2);
		converter.convert.mockImplementationOnce(async () => { await fs.remove(library); throw Object.assign(new Error("lost source"), {code: "ENOENT"}); });
		await expect(service.process(5, library, guard)).rejects.toMatchObject({code: "storage_root", fatal: true});
		expect(converter.convert).toHaveBeenCalledTimes(1);
	});
	it("does not recover a PDF if its source changes during validation", async () => {
		const row = await add(1); await service.process(5, library, guard);
		states.set(1, {...states.get(1)!, status: "processing"});
		converter.validate.mockImplementationOnce(async () => { await fs.appendFile(path.join(library, row.name), "edit"); return 2; });
		expect((await service.process(5, library, guard)).failed).toBe(1);
		expect(states.get(1)?.errorCode).toBe("source_changed");
	});
	it("lease loss prevents publication", async () => {
		const row = await add(1); let valid = true;
		const convert = converter.convert.getMockImplementation();
		converter.convert.mockImplementation(async (...args: any[]) => { const result = await convert(...args); valid = false; return result; });
		await expect(service.process(5, library, async () => { if (!valid) throw new Error("lease lost"); })).rejects.toThrow("lease lost");
		expect(await fs.pathExists(pdf(row))).toBe(false);
	});
	it("fingerprints resources in catalogued EPUB directories without reclassification", async () => {
		const dir = path.join(library, "epub"); await fs.ensureDir(path.join(dir, "resources"));
		await fs.writeFile(path.join(dir, "resources", "chapter.xhtml"), "chapter");
		const row = {id: 1, name: "epub", parentPath: library, coverId: randomUUID(), fileKind: "EPUB"};
		const before = await inspectDocumentSource(row, library);
		await fs.appendFile(path.join(dir, "resources", "chapter.xhtml"), "edited");
		expect((await inspectDocumentSource(row, library)).signature).not.toBe(before.signature);
	});
	it("rejects source escapes, cache symlinks and invalid IDs", async () => {
		const row = await add(1); await fs.writeFile(path.join(root, "outside.txt"), "outside");
		await fs.symlink(path.join(root, "outside.txt"), path.join(library, "link.txt"));
		await expect(inspectDocumentSource({...row, name: "link.txt"}, library)).rejects.toThrow("escapes");
		await fs.symlink(root, path.join(cache, row.coverId));
		await expect(conversionCacheDirectory(cache, row.coverId)).rejects.toThrow("symlink");
		await expect(conversionCacheDirectory(cache, "../outside")).rejects.toThrow("coverId");
	});
	it("rejects symlink outputs and hashes incrementally", async () => {
		const row = await add(1); await fs.ensureDir(path.dirname(pdf(row)));
		await fs.symlink(path.join(library, row.name), pdf(row));
		expect(await fileSignature(pdf(row))).toBeUndefined();
		expect(await fileDigest(path.join(library, row.name))).toHaveLength(64);
	});
});
