import { describe, expect, it } from "@jest/globals";
import { classifyConversionFailure } from "(src)/services/ConversionFailureClassifier";

describe("conversion failure classification", () => {
	it.each([
		["unsupported_content", "application/pdf", "source_format_mismatch"],
		["source_empty", "Source file is empty", "source_empty"],
		["output_limit", "Process output exceeded 1 MiB", "log_limit"],
		["timeout", "Process exceeded 900000 ms", "timeout"],
		["memory_limit", "RSS exceeded limit", "memory_limit"],
		["invalid_pdf", "PDF validation failed", "invalid_pdf"],
		["invalid_pdf", "Converter did not produce a regular nonempty PDF", "converter_no_output"],
		["converter", "Unknown failure", "converter"]
	])("classifies %s conservatively", (code, message, category) => {
		expect(classifyConversionFailure({code,message}, "convert").category).toBe(category);
	});
	it("preserves simultaneous HTML causes", () => {
		expect(classifyConversionFailure({code: "converter", message: "Exit 1", diagnostics: {
			stderr: "Unable to connect\nUnable to parse HTML\nUnable to read image", exitCode: 1}}, "convert", "htmldoc", true))
			.toMatchObject({causes: ["external_resource", "html_parse", "image_read"], exitCode: 1, toolExecuted: true});
	});
	it("does not turn an infrastructure failure into a document problem", () => {
		expect(classifyConversionFailure({code: "ENOSPC", message: "Unable to read image"}, "convert", "htmldoc").category).toBe("infrastructure");
	});
	it("does not guess OOM from a signal", () => {
		expect(classifyConversionFailure({code: "process_signal", message: "Signal SIGKILL", diagnostics: {signal: "SIGKILL"}}, "convert"))
			.toMatchObject({category: "process_signal", signal: "SIGKILL"});
	});
	it("separates descriptor exhaustion from missing resources", () => {
		expect(classifyConversionFailure({code: "missing_resource", message: "Too many open files"}, "convert").category).toBe("fd_limit");
	});
});
