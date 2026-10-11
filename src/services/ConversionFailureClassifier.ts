import { ConversionClassification, conversionInfrastructureErrorCodes } from "(src)/models/interfaces/DocumentConversion";

export function classifyConversionFailure(error: {code?: string; message: string; fatal?: boolean;
	diagnostics?: {stdout?: string; stderr?: string; exitCode?: number; signal?: string};},
stage: string, tool?: string, toolExecuted?: boolean): ConversionClassification {
	const code = error.code || "document";
	const message = [error.message, error.diagnostics?.stderr, error.diagnostics?.stdout].filter(Boolean).join("\n");
	let category = code;
	const causes: string[] = [];
	if (code === "interrupted") category = "interrupted";
	else if (error.fatal || conversionInfrastructureErrorCodes.has(code)) category = "infrastructure";
	else if (code === "unsupported_content") category = "source_format_mismatch";
	else if (code === "output_limit") category = "log_limit";
	else if (["converter", "missing_resource", "converter_no_output", "invalid_pdf"].includes(code)) {
		if (/Too many open files|\bEMFILE\b/.test(message)) causes.push("fd_limit");
		if (tool === "libreoffice" && /source file could not be loaded/i.test(message)) causes.push("source_unreadable");
		if (tool === "htmldoc") {
			if (/Unable to connect/.test(message)) causes.push("external_resource");
			if (/Unable to parse HTML/.test(message)) causes.push("html_parse");
			if (/Unknown image file format/.test(message)) causes.push("image_format");
			if (/Unable to read image/.test(message)) causes.push("image_read");
		}
		if (causes.length) category = causes[0];
		else if (/Converter did not produce a regular nonempty PDF/.test(message)) category = "converter_no_output";
	}
	if (!causes.length) causes.push(category);
	return {version: 1, stage, category, causes, toolExecuted,
		exitCode: error.diagnostics?.exitCode, signal: error.diagnostics?.signal};
}
