// EPUB uses its native reader; only these formats participate in the scan's PDF phase.
export const documentExtensions = ["doc", "docx", "ppt", "pptx", "xls", "xlsx", "rtf", "txt", "md", "html", "htm", "lit"];
export const conversionInfrastructureErrorCodes = new Set(["ENOSPC", "EDQUOT", "EROFS", "EIO", "ENODEV"]);

export interface ConversionClassification {
	version: number;
	stage: string;
	category: string;
	causes: string[];
	toolExecuted?: boolean;
	exitCode?: number;
	signal?: string;
}

export interface ConversionState {
	status: "processing" | "ready" | "failed";
	attempts: number;
	retryAfter?: string;
	sourceSignature?: string;
	recipe?: string;
	outputSignature?: string;
	outputHash?: string;
	pages?: number;
	tool?: string;
	toolVersion?: string;
	errorCode?: string;
	error?: string;
	warnings?: string;
	recoveries?: string[];
	legacyBackup?: string;
	scriptReviewVersion?: number;
	classification?: ConversionClassification;
	recoveryRejectedHash?: string;
}

export interface ConversionCandidate {
	id: number;
	name: string;
	parentPath: string;
	coverId: string;
	fileKind: string;
	conversion?: ConversionState;
}

export interface ConversionSummary {
	total: number;
	checked: number;
	reused: number;
	recovered: number;
	converted: number;
	failed: number;
	deferred: number;
	tools: Record<string, {converted: number; failed: number; elapsedMs: number}>;
	inventory?: {
		ready: number;
		failed: number;
		retryDue: number;
		retryScheduled: number;
		retryExhausted: number;
		needsIntervention: number;
		byTool: Record<string, {ready: number; failed: number; categories: Record<string, number>}>;
	};
	rejectedBeforeConversion?: number;
}

export class ConversionError extends Error {
	diagnostics?: {stdout?: string; stderr?: string; exitCode?: number; signal?: string};
	constructor(public readonly code: string, message: string, public readonly fatal = false) {
		super(message);
	}
}
