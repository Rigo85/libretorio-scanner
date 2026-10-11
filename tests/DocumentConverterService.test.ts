import { afterEach, describe, expect, it, jest } from "@jest/globals";
import { DocumentConverterService } from "(src)/services/DocumentConverterService";
import { DocumentSource } from "(src)/services/DocumentSourceService";
import { ConversionError } from "(src)/models/interfaces/DocumentConversion";
import * as sourceFiles from "(src)/services/DocumentSourceService";
import fs from "fs-extra";

jest.mock("fs-extra", () => ({
	__esModule: true,
	default: {
		pathExists: jest.fn(async () => true),
		realpath: jest.fn(async (value: string) => value),
		writeJson: jest.fn(async () => {}),
		rename: jest.fn(async () => {}),
		ensureDir: jest.fn(async () => {})
	}
}));

describe("document converter descriptor limits", () => {
	afterEach(() => jest.restoreAllMocks());
	it("rejects an empty source before inspection or converter execution", async () => {
		const converter = new DocumentConverterService("/test/calibre");
		const run = jest.spyOn(converter.processes, "run");
		const started = jest.fn();
		await expect(converter.convert({path: "/books/empty.lit", inputRoot: "/books", inputName: "empty.lit", extension: "lit",
			signature: "empty", directory: false, size: 0}, "/workdir", started)).rejects.toMatchObject({code: "source_empty"});
		expect(run).not.toHaveBeenCalled(); expect(started).not.toHaveBeenCalled();
	});
	it("does not execute a converter for PDF content behind a TXT extension", async () => {
		const converter = new DocumentConverterService("/test/calibre");
		const run = jest.spyOn(converter.processes, "run").mockResolvedValue({stdout: "application/pdf", stderr: ""});
		const started = jest.fn();
		await expect(converter.convert({path: "/books/book.txt", inputRoot: "/books", inputName: "book.txt", extension: "txt",
			signature: "pdf", directory: false}, "/workdir", started)).rejects.toMatchObject({code: "unsupported_content"});
		expect(run).toHaveBeenCalledTimes(1); expect(started).not.toHaveBeenCalled();
	});
	it("classifies a pdfinfo parser rejection as invalid PDF, retaining diagnostics", async () => {
		const converter = new DocumentConverterService("/test/calibre");
		jest.spyOn(converter.processes, "run").mockRejectedValue(Object.assign(new ConversionError("converter", "Exit 1: damaged PDF"), {
			diagnostics: {stderr: "Syntax Error: Couldn't read xref table", exitCode: 1}}));
		await expect(converter.validate("/cache/book.pdf", "/workdir")).rejects.toMatchObject({code: "invalid_pdf", diagnostics: {exitCode: 1}});
	});
	it.each(["Permission denied", "I/O Error: Couldn't open file", "Cannot allocate memory", "unexpected parser failure"])
	("does not call a validation runtime/access failure a malformed PDF: %s", async stderr => {
		const converter = new DocumentConverterService("/test/calibre");
		jest.spyOn(converter.processes, "run").mockRejectedValue(Object.assign(new ConversionError("converter", stderr), {diagnostics: {stderr, exitCode: 1}}));
		await expect(converter.validate("/cache/book.pdf", "/workdir")).rejects.toMatchObject({code: "converter"});
	});
	it("prioritizes descriptor exhaustion over accompanying parser errors", async () => {
		const converter = new DocumentConverterService("/test/calibre");
		const stderr = "Too many open files\nSyntax Error: Couldn't read xref table";
		jest.spyOn(converter.processes, "run").mockRejectedValue(Object.assign(new ConversionError("converter", stderr), {diagnostics: {stderr, exitCode: 1}}));
		await expect(converter.validate("/cache/book.pdf", "/workdir")).rejects.toMatchObject({code: "fd_limit"});
	});
	it("does not label validation timeouts as malformed PDFs", async () => {
		const converter = new DocumentConverterService("/test/calibre");
		jest.spyOn(converter.processes, "run").mockRejectedValue(new ConversionError("timeout", "deadline"));
		await expect(converter.validate("/cache/book.pdf", "/workdir")).rejects.toMatchObject({code: "timeout"});
	});
	it.each([
		["epub", 2048], ["txt", 2048], ["lit", 2048], ["md", 2048],
		["doc", 256], ["docx", 256], ["xls", 256], ["xlsx", 256],
		["ppt", 256], ["pptx", 256], ["rtf", 256], ["html", 256], ["htm", 256]
	])("uses the intended limit for %s without changing content inspection", async (extension, limit) => {
		const converter = new DocumentConverterService("/test/calibre");
		const run = jest.spyOn(converter.processes, "run").mockResolvedValue({stdout: "text/plain", stderr: ""});
		const source: DocumentSource = {path: `/books/book.${extension}`, inputRoot: "/books",
			inputName: `book.${extension}`, extension: String(extension), signature: "test", directory: false};
		await converter.convert(source, "/workdir");
		expect(run).toHaveBeenCalledTimes(2);
		expect(run.mock.calls[0][1]).toEqual(expect.arrayContaining(["--nofile=256", "/usr/bin/file"]));
		expect(run.mock.calls[1][0]).toBe("/usr/bin/prlimit");
		expect(run.mock.calls[1][1]).toEqual(expect.arrayContaining([
			`--nofile=${limit}`, "--unshare-all", "--cap-drop", "ALL", "--ro-bind", "/books"
		]));
	});
	it("keeps PDF validation at 256 descriptors", async () => {
		const converter = new DocumentConverterService("/test/calibre");
		const run = jest.spyOn(converter.processes, "run").mockResolvedValue({stdout: "Pages: 1\nEncrypted: no\n", stderr: ""});
		expect(await converter.validate("/workdir/result.pdf", "/workdir")).toBe(1);
		expect(run.mock.calls[0][1]).toEqual(expect.arrayContaining(["--nofile=256", "/usr/bin/pdfinfo"]));
	});
	it.each(["Syntax Error: Unterminated string", "Syntax Error (162): Unterminated string",
		"Syntax Error (42): End of file inside dictionary"])("normalizes the bounded recoverable case %s", async stderr => {
		const converter = new DocumentConverterService("/test/calibre");
		const run = jest.spyOn(converter.processes, "run")
			.mockResolvedValue({stdout: "Pages: 11\nEncrypted: no\n", stderr: ""})
			.mockResolvedValueOnce({stdout: "Pages: 11\nEncrypted: no\n", stderr});
		jest.spyOn(sourceFiles, "fileDigest").mockResolvedValue("same text");
		expect(await converter.validate("/workdir/result.pdf", "/workdir")).toBe(11);
		expect(run.mock.calls[1][1]).toContain("/usr/bin/qpdf");
		expect(fs.rename).toHaveBeenCalledWith("/workdir/normalized.pdf", "/workdir/result.pdf");
	});
	it.each([
		["/workdir/result.pdf", "Pages: 11\nEncrypted: yes\n", "Syntax Error (162): Unterminated string"],
		["/cache/result.pdf", "Pages: 11\nEncrypted: no\n", "Syntax Error (162): Unterminated string"],
		["/workdir/result.pdf", "Pages: 11\nEncrypted: no\n", "Syntax Error: Missing image"]
	])("does not repair encrypted, published or unrelated failures: %s %s %s", async (pdf, stdout, stderr) => {
		const converter = new DocumentConverterService("/test/calibre");
		const run = jest.spyOn(converter.processes, "run").mockResolvedValue({stdout, stderr});
		await expect(converter.validate(pdf, "/workdir")).rejects.toMatchObject({code: "invalid_pdf"});
		expect(run).toHaveBeenCalledTimes(1);
	});
	it("rejects normalization when extracted content changes", async () => {
		const converter = new DocumentConverterService("/test/calibre");
		jest.spyOn(converter.processes, "run")
			.mockResolvedValue({stdout: "Pages: 11\nEncrypted: no\n", stderr: ""})
			.mockResolvedValueOnce({stdout: "Pages: 11\nEncrypted: no\n", stderr: "Syntax Error (162): Unterminated string"});
		jest.spyOn(sourceFiles, "fileDigest").mockResolvedValueOnce("before").mockResolvedValueOnce("after");
		await expect(converter.validate("/workdir/result.pdf", "/workdir")).rejects.toThrow("changed extracted text");
	});
	it("rejects omitted resources even when the converter exits successfully", async () => {
		const converter = new DocumentConverterService("/test/calibre");
		jest.spyOn(converter.processes, "run").mockResolvedValueOnce({stdout: "text/plain", stderr: ""})
			.mockResolvedValueOnce({stdout: "Done", stderr: "Too many open files" + " benign".repeat(1000)});
		await expect(converter.convert({path: "/books/book.txt", inputRoot: "/books", inputName: "book.txt", extension: "txt", signature: "test", directory: false}, "/workdir"))
			.rejects.toMatchObject({code: "fd_limit", fatal: false});
	});
	const scriptWarning = "Blocking FAKE_PROTOCOL request: clbr://internal.invalid/js/jquery.js with code: Error.UrlNotFound";
	const epub: DocumentSource = {path: "/books/book.epub", inputRoot: "/books", inputName: "book.epub", extension: "epub", signature: "test", directory: false};
	it("accepts known script warnings only after static text verification, retaining warnings", async () => {
		const converter = new DocumentConverterService("/test/calibre");
		const run = jest.spyOn(converter.processes, "run")
			.mockResolvedValueOnce({stdout: "application/epub+zip", stderr: ""})
			.mockResolvedValueOnce({stdout: "Done", stderr: scriptWarning})
			.mockResolvedValueOnce({stdout: "", stderr: ""})
			.mockResolvedValueOnce({stdout: '{"verified":true,"characters":100}', stderr: ""});
		await expect(converter.convert(epub, "/workdir")).resolves.toMatchObject({warnings: scriptWarning, recoveries: ["verified-static-epub-scripts"]});
		expect(run.mock.calls[2][1]).toContain("/usr/bin/pdftotext");
		expect(run.mock.calls[3][1]).toContain("/opt/calibre/calibre-debug");
	});
	it.each(["Too many open files", "EMFILE", "Failed to load image", "Cannot load image",
		"Blocking FAKE_PROTOCOL request: clbr://internal.invalid/cover.jpg with code: Error.UrlNotFound",
		"Blocking FAKE_PROTOCOL request: clbr://internal.invalid/font.ttf with code: Error.UrlNotFound",
		"Blocking FAKE_PROTOCOL request: clbr://internal.invalid/js/chapter.js with code: Error.UrlNotFound"])
	("keeps a mixed script/resource failure blocked: %s", async other => {
		const converter = new DocumentConverterService("/test/calibre");
		const run = jest.spyOn(converter.processes, "run").mockResolvedValueOnce({stdout: "application/epub+zip", stderr: ""})
			.mockResolvedValueOnce({stdout: "Done", stderr: `${scriptWarning}\n${other}`});
		await expect(converter.convert(epub, "/workdir")).rejects.toMatchObject({code: /Too many open files|EMFILE/.test(other) ? "fd_limit" : "missing_resource"});
		expect(run).toHaveBeenCalledTimes(2);
	});
	it("rejects a script warning when source/PDF text verification fails", async () => {
		const converter = new DocumentConverterService("/test/calibre");
		jest.spyOn(converter.processes, "run").mockResolvedValueOnce({stdout: "application/epub+zip", stderr: ""})
			.mockResolvedValueOnce({stdout: "Done", stderr: scriptWarning})
			.mockResolvedValueOnce({stdout: "", stderr: ""})
			.mockRejectedValueOnce(new ConversionError("converter", "Static EPUB/PDF text differs"));
		await expect(converter.convert(epub, "/workdir")).rejects.toMatchObject({code: "missing_resource"});
	});
	it("does not turn interruption during static review into a document error", async () => {
		const converter = new DocumentConverterService("/test/calibre");
		jest.spyOn(converter.processes, "run").mockResolvedValueOnce({stdout: "application/epub+zip", stderr: ""})
			.mockResolvedValueOnce({stdout: "Done", stderr: scriptWarning})
			.mockRejectedValueOnce(new ConversionError("interrupted", "Conversion cancelled", true));
		await expect(converter.convert(epub, "/workdir")).rejects.toMatchObject({code: "interrupted", fatal: true});
	});
	it.each(["ENOSPC", "EDQUOT", "EROFS", "EIO", "ENODEV"])("preserves %s while saving static review evidence", async code => {
		const converter = new DocumentConverterService("/test/calibre");
		jest.spyOn(converter.processes, "run")
			.mockResolvedValueOnce({stdout: "application/epub+zip", stderr: ""})
			.mockResolvedValueOnce({stdout: "Done", stderr: scriptWarning})
			.mockResolvedValueOnce({stdout: "", stderr: ""})
			.mockResolvedValueOnce({stdout: '{"verified":true,"characters":100}', stderr: ""});
		const failure = Object.assign(new Error(`Cannot save evidence: ${code}`), {code});
		jest.mocked(fs.writeJson).mockImplementationOnce(async () => {}).mockRejectedValueOnce(failure);
		await expect(converter.convert(epub, "/workdir")).rejects.toBe(failure);
		expect(fs.writeJson).toHaveBeenLastCalledWith("/workdir/script-review.json", {verified: true, characters: 100});
	});
	it.each(["ENOSPC", "EDQUOT", "EROFS", "EIO", "ENODEV"])("preserves %s while preparing the static review sandbox", async code => {
		const converter = new DocumentConverterService("/test/calibre");
		const run = jest.spyOn(converter.processes, "run")
			.mockResolvedValueOnce({stdout: "application/epub+zip", stderr: ""})
			.mockResolvedValueOnce({stdout: "Done", stderr: scriptWarning});
		const failure = Object.assign(new Error(`Cannot prepare review: ${code}`), {code});
		jest.mocked(fs.ensureDir).mockImplementationOnce(async () => {}).mockImplementationOnce(async () => {}).mockImplementationOnce(async () => { throw failure; });
		await expect(converter.convert(epub, "/workdir")).rejects.toBe(failure);
		expect(run).toHaveBeenCalledTimes(2);
	});
	it.each([["Read-only file system: '/input/font.ttf'", "source_readonly", false],
		["Read-only file system: '/work/result.pdf'", "storage", true],
		["No space left on device", "storage", true]])("classifies %s without hiding storage faults", async (message, code, fatal) => {
		const converter = new DocumentConverterService("/test/calibre");
		jest.spyOn(converter.processes, "run").mockResolvedValueOnce({stdout: "text/plain", stderr: ""})
			.mockRejectedValueOnce(new ConversionError("converter", String(message)));
		await expect(converter.convert({path: "/books/book.txt", inputRoot: "/books", inputName: "book.txt", extension: "txt", signature: "test", directory: false}, "/workdir"))
			.rejects.toMatchObject({code, fatal});
	});
	it("limits Calibre to 6 GiB and leaves other tools at their configured limit", async () => {
		const converter = new DocumentConverterService("/test/calibre");
		const run = jest.spyOn(converter.processes, "run").mockResolvedValue({stdout: "text/plain", stderr: ""});
		await converter.convert({path: "/books/book.txt", inputRoot: "/books", inputName: "book.txt", extension: "txt", signature: "test", directory: false}, "/workdir");
		expect(run.mock.calls[0][3]).toBe(Number(process.env.PDF_CONVERSION_MEMORY_BYTES || 2147483648));
		expect(run.mock.calls[1][3]).toBe(Number(process.env.PDF_CONVERSION_CALIBRE_MEMORY_BYTES || 6442450944));
	});
});
