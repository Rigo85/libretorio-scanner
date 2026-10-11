import fs from "fs-extra";
import path from "path";
import { ConversionCandidate, ConversionError, ConversionState, ConversionSummary, conversionInfrastructureErrorCodes } from "(src)/models/interfaces/DocumentConversion";
import { DocumentConversionRepository } from "(src)/repositories/DocumentConversionRepository";
import { config } from "(src)/config/configuration";
import { Logger } from "(src)/helpers/Logger";
import { DocumentConverterService } from "./DocumentConverterService";
import { conversionCacheDirectory, fileDigest, fileSignature, inspectDocumentSource } from "./DocumentSourceService";
import { EpubConversionInputService } from "./EpubConversionInputService";
import { classifyConversionFailure } from "./ConversionFailureClassifier";

const logger = new Logger("DocumentConversion");

export class DocumentConversionService {
	private static active?: DocumentConversionService;
	private completion?: Promise<ConversionSummary>;
	private stopped = false;
	constructor(private readonly repository = new DocumentConversionRepository(),
		private readonly converter = new DocumentConverterService(),
		private readonly cache = config.production.paths.cache,
		private readonly batchSize = Number(process.env.PDF_CONVERSION_BATCH_SIZE || 50),
		private readonly diagnosticsRoot = process.env.PDF_CONVERSION_DIAGNOSTICS_DIR || path.resolve(__dirname, "../../logs/pdf-conversions")) {}

	static async run(root: number, library: string, guard: () => Promise<void>, signal: AbortSignal): Promise<ConversionSummary> {
		if (this.active) throw new ConversionError("overlap", "PDF phase already active", true);
		const service = new DocumentConversionService();
		this.active = service;
		const abort = () => {
			void service.stop();
		};
		signal.addEventListener("abort", abort, {once: true});
		try {
			if (signal.aborted) await service.stop();
			service.completion = service.process(root, library, guard);
			return await service.completion;
		} finally {
			signal.removeEventListener("abort", abort);
			this.active = undefined;
		}
	}

	private async stop(): Promise<void> {
		this.stopped = true;
		await this.converter.processes.stop();
	}

	static async stopActive(): Promise<void> {
		const active = this.active;
		if (active) {
			await active.stop();
			await active.completion?.catch((): void => {});
		}
	}

	private async check(guard: () => Promise<void>): Promise<void> {
		if (this.stopped) throw new ConversionError("interrupted", "PDF phase stopped", true);
		await guard();
		if (this.stopped) throw new ConversionError("interrupted", "PDF phase stopped", true);
	}

	async process(root: number, library: string, guard: () => Promise<void>): Promise<ConversionSummary> {
		await this.check(guard);
		if (!Number.isInteger(this.batchSize) || this.batchSize < 1 || this.batchSize > 500) throw new Error("Invalid conversion batch size");
		const roots = [await fs.realpath(library), await fs.realpath(this.cache)];
		const devices: string[] = [];
		for (const root of roots) {
			const stat = await fs.stat(root);
			devices.push(`${stat.dev}:${stat.ino}`);
		}
		const leaseGuard = guard;
		guard = async () => {
			await leaseGuard();
			for (let index = 0; index < roots.length; index++) {
				try {
					const stat = await fs.stat(roots[index]);
					if (`${stat.dev}:${stat.ino}` !== devices[index]) throw new Error("Storage root changed");
				} catch (error) {
					throw new ConversionError("storage_root", `${roots[index]}: ${error.message}`, true);
				}
			}
		};
		const window = await this.repository.window(root);
		const run = await this.repository.start(root, window.upper, window.total);
		const summary: ConversionSummary = {total: window.total, checked: 0, reused: 0, recovered: 0, converted: 0,
			failed: 0, deferred: 0, tools: {}, rejectedBeforeConversion: 0,
			inventory: {ready: 0, failed: 0, retryDue: 0, retryScheduled: 0, retryExhausted: 0, needsIntervention: 0, byTool: {}}};
		const started = Date.now();
		logger.info("pdf-conversion:start", {run, root, upperId: window.upper, total: window.total, batchSize: this.batchSize});
		try {
			let after = 0;
			while (true) {
				await this.check(guard);
				const batch = await this.repository.page(root, after, window.upper, this.batchSize);
				if (!batch.length) break;
				for (const candidate of batch) {
					if (candidate.id <= after || candidate.id > window.upper) throw new Error("Invalid conversion cursor");
					await this.check(guard);
					const outcome = await this.convertOne(candidate, library, run, guard, summary);
					summary[outcome]++;
					summary.checked++;
					after = candidate.id;
					await this.repository.progress(run, summary);
					const {inventory: _inventory, ...progress} = summary;
					logger.info("pdf-conversion:progress", {run, archiveId: candidate.id, outcome,
						...progress, remainingToCheck: Math.max(0, summary.total - summary.checked)});
				}
			}
			const status = summary.failed || summary.deferred ? "completed_with_errors" : "completed";
			await this.repository.progress(run, summary, status);
			logger.info("pdf-conversion:complete", {run, status, ...summary, elapsedMs: Date.now() - started});
			logger.info("pdf-conversion:inventory", {run, checked: summary.checked, ...summary.inventory});
			return summary;
		} catch (error) {
			await this.repository.progress(run, summary, this.stopped ? "interrupted" : "failed", error.message)
				.catch(failure => logger.error("pdf-conversion:summary-write-failed", failure.message));
			logger.error("pdf-conversion:phase-failed", {run, error: error.message, ...summary});
			throw error;
		}
	}

	private async convertOne(candidate: ConversionCandidate, library: string, run: string,
		guard: () => Promise<void>, summary: ConversionSummary): Promise<"reused" | "recovered" | "converted" | "failed" | "deferred"> {
		const old = candidate.conversion;
		let state: ConversionState = {status: "processing", attempts: Math.min(3, (old?.attempts || 0) + 1),
			recipe: this.converter.recipe, legacyBackup: old?.legacyBackup, scriptReviewVersion: 1};
		let work: string | undefined;
		let generated: string | undefined;
		let started = Date.now();
		let stage = "inspect", toolExecuted = false;
		const record = (outcome: "reused" | "recovered" | "converted" | "failed" | "deferred", current: ConversionState) => {
			const inventory = summary.inventory!;
			const tool = inventory.byTool[current.tool || "unassigned"] ||= {ready: 0, failed: 0, categories: {}};
			if (current.status === "ready") {
				inventory.ready++; tool.ready++;
			} else {
				inventory.failed++; tool.failed++;
				const category = current.classification?.category || classifyConversionFailure(
					{code: current.errorCode, message: current.error || ""}, "historical", current.tool).category;
				tool.categories[category] = (tool.categories[category] || 0) + 1;
				if (current.attempts >= 3) inventory.retryExhausted++;
				else if (!current.retryAfter) inventory.needsIntervention++;
				else if (Date.parse(current.retryAfter) > Date.now()) inventory.retryScheduled++;
				else inventory.retryDue++;
			}
			return outcome;
		};
		const diagnostics = async (error?: string) => {
			if (!work) return;
			const data: Record<string, unknown> = {archiveId: candidate.id, run, error};
			for (const name of ["process-error.json", "converter-diagnostics.json", "cover-recovery.json", "pdf-normalization.json", "script-review.json"]) {
				const file = path.join(work, name);
				if (await fs.pathExists(file)) data[name] = await fs.readFile(file, "utf8");
			}
			if (Object.keys(data).length === 3 && !error) return;
			await fs.ensureDir(this.diagnosticsRoot);
			const directory = path.join(await fs.realpath(this.diagnosticsRoot), run);
			await fs.ensureDir(directory);
			if (await fs.realpath(directory) !== directory) throw new ConversionError("cache_path", "Diagnostic directory is a symlink", true);
			await fs.writeJson(path.join(directory, `${candidate.id}.json`), data);
		};
		const persist = async () => {
			await this.check(guard);
			try {
				await this.repository.save(candidate.id, run, state);
			} catch (error) {
				throw new ConversionError("database", error.message, true);
			}
		};
		try {
			const source = await inspectDocumentSource(candidate, library);
			state.sourceSignature = source.signature;
			const directory = await conversionCacheDirectory(this.cache, candidate.coverId);
			const pdf = path.join(directory, `${candidate.coverId}.pdf`);
			const outputSignature = await fileSignature(pdf);
			const sameSource = old?.sourceSignature === source.signature && old?.recipe === state.recipe;
			if (sameSource && old.status === "ready" && outputSignature && outputSignature === old.outputSignature) return record("reused", old);
			state.recoveryRejectedHash = sameSource ? old.recoveryRejectedHash : undefined;
			const staging = path.join(await fs.realpath(this.cache), ".scanner-build");
			await fs.ensureDir(staging);
			if (await fs.realpath(staging) !== staging) throw new ConversionError("cache_path", "Staging is a symlink", true);
			work = await fs.mkdtemp(path.join(staging, `pdf-${candidate.id}-`));
			// A digest recorded before rename makes publication recoverable without trusting an old PDF.
			if (sameSource && outputSignature && old.outputHash && old.outputHash !== old.recoveryRejectedHash && await fileDigest(pdf) === old.outputHash) {
				stage = "recover";
				let pages: number | undefined;
				try {
					pages = await this.converter.validate(pdf, work);
				} catch (error) {
					if (error.code !== "invalid_pdf" || error.fatal) throw error;
					state.recoveryRejectedHash = old.outputHash;
					logger.info("pdf-conversion:recovery-rejected", {run, archiveId: candidate.id, code: error.code, error: error.message});
				}
				if (await fileSignature(pdf) !== outputSignature || (await inspectDocumentSource(candidate, library)).signature !== source.signature) {
					throw new ConversionError("source_changed", "Source or PDF changed during recovery");
				}
				if (pages !== undefined) {
					state = {...old, status: "ready", pages, outputSignature, error: undefined, errorCode: undefined, retryAfter: undefined,
						classification: undefined, recoveryRejectedHash: undefined};
					await persist();
					return record("recovered", state);
				}
			}
			const reviewScripts = source.extension === "epub" && old?.status === "failed" && old.errorCode === "missing_resource" &&
				!old.scriptReviewVersion && DocumentConverterService.hasReviewableScriptWarning(old.error || "");
			if (sameSource && !reviewScripts && old.status !== "ready" && (old.attempts >= 3 || old.status === "failed" &&
				(!old.retryAfter || Date.parse(old.retryAfter) > Date.now()))) {
				if (state.recoveryRejectedHash !== old.recoveryRejectedHash) {
					state = {...old, recoveryRejectedHash: state.recoveryRejectedHash};
					await persist();
				}
				return record("deferred", old);
			}
			state.attempts = sameSource && !reviewScripts && old.status !== "ready" ? old.attempts + 1 : 1;
			// Preserve unidentified PDFs once; they are not accepted as current conversions.
			if (!old && outputSignature) {
				const digest = await fileDigest(pdf);
				// A root-level backup survives a later replacement of the coverId directory by ZIP publication.
				const backup = path.join(this.cache, `${candidate.coverId}.legacy-${digest}.pdf`);
				if (!await fs.pathExists(backup)) {
					const temporaryBackup = path.join(work, "legacy.pdf");
					await fs.copyFile(pdf, temporaryBackup, fs.constants.COPYFILE_EXCL);
					if (await fileDigest(temporaryBackup) !== digest) throw new ConversionError("source_changed", "Legacy PDF changed while backing up");
					await this.check(guard);
					await fs.rename(temporaryBackup, backup);
				} else if (!await fileSignature(backup) || await fileDigest(backup) !== digest) {
					throw new ConversionError("legacy_backup", "Existing legacy backup is invalid", true);
				}
				state.legacyBackup = backup;
				logger.info("pdf-conversion:legacy-backup", {run, archiveId: candidate.id, backup, digest});
			}
			state.tool = this.converter.tool(source);
			stage = "tool_setup";
			state.toolVersion = await this.converter.version(source, work);
			await persist();
			started = Date.now();
			logger.info("pdf-conversion:item-start", {run, archiveId: candidate.id, path: source.path,
				tool: state.tool, version: state.toolVersion, attempt: state.attempts});
			if (source.directory) await new EpubConversionInputService().prepare(source, candidate.coverId, directory, work, () => this.check(guard));
			stage = "inspect";
			const result = await this.converter.convert(source, work, () => {
				toolExecuted = true; stage = "convert";
			});
			generated = result.output;
			if (path.dirname(generated) !== work) throw new ConversionError("output_path", "Converter output escapes staging", true);
			if (!await fileSignature(generated)) {
				throw Object.assign(new ConversionError("converter_no_output", "Converter did not produce a regular nonempty PDF"), {diagnostics: result.diagnostics});
			}
			stage = "validate";
			state.pages = await this.converter.validate(generated, work);
			state.recoveries = result.recoveries;
			if (await fs.pathExists(path.join(work, "pdf-normalization.json"))) state.recoveries = [...(state.recoveries || []), "qpdf-normalization"];
			await diagnostics();
			state.outputHash = await fileDigest(generated);
			state.warnings = result.warnings;
			if ((await inspectDocumentSource(candidate, library)).signature !== source.signature) {
				throw new ConversionError("source_changed", "Source changed while converting");
			}
			await persist();
			await this.check(guard);
			stage = "publish";
			await fs.rename(generated, pdf);
			generated = undefined;
			state.outputSignature = await fileSignature(pdf);
			if (!state.outputSignature) throw new ConversionError("publication", "Published PDF disappeared", true);
			state.status = "ready";
			state.recoveryRejectedHash = undefined;
			await persist();
			const counts = summary.tools[state.tool] ||= {converted: 0, failed: 0, elapsedMs: 0};
			counts.converted++;
			counts.elapsedMs += Date.now() - started;
			return record("converted", state);
		} catch (error) {
			await diagnostics(String(error.message));
			if (this.stopped || ["database", "source_changed"].includes(error.code) && error.fatal) throw error;
			const fatal = error.fatal || conversionInfrastructureErrorCodes.has(error.code);
			state.status = "failed";
			state.errorCode = error.code || "document";
			state.error = String(error.message).slice(0, 4000);
			state.classification = classifyConversionFailure(error, stage, state.tool, toolExecuted);
			state.retryAfter = ["timeout", "source_changed", "ENOENT"].includes(state.errorCode) && state.attempts < 3
				? new Date(Date.now() + 60 * 60 * 1000).toISOString() : undefined;
			await persist();
			if (state.tool && toolExecuted) {
				const counts = summary.tools[state.tool] ||= {converted: 0, failed: 0, elapsedMs: 0};
				counts.failed++;
				counts.elapsedMs += Date.now() - started;
			}
			if (!toolExecuted) summary.rejectedBeforeConversion!++;
			logger.error("pdf-conversion:item-failed", {run, archiveId: candidate.id, code: state.errorCode,
				classification: state.classification, error: state.error});
			if (fatal) throw error;
			return record("failed", state);
		} finally {
			if (work) await fs.rm(work, {recursive: true, force: true});
		}
	}
}
