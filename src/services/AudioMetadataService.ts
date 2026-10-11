import fs from "fs/promises";
import path from "path";
import { File, FileKind } from "(src)/models/interfaces/File";
import { AudioMetadataRepository } from "(src)/repositories/AudioMetadataRepository";
import { AudioProbeService, AudioProbeResult, audioSourceSignature } from "(src)/services/AudioProbeService";
import { Logger } from "(src)/helpers/Logger";

const logger = new Logger("AudioMetadata");
const key = (id: number, relative: string) => JSON.stringify([id, relative]);
const audioExtensions = new Set([".mp3", ".wav", ".m4a", ".m4b", ".ogg", ".flac"]);
export const isAudioCandidate = (name: string): boolean => audioExtensions.has(path.extname(name).toLowerCase());
interface Candidate { id: number; relative: string; source: string; signature: string }

export class AudioMetadataService {
	constructor(private readonly repository = new AudioMetadataRepository(), private readonly probe = new AudioProbeService()) {}

	async process(files: File[], root: string) {
		const summary = {archives: 0, checked: 0, extensionSkipped: 0, headersInspected: 0, detected: 0, extracted: 0,
			reusedOrDeferred: 0, withoutChapters: 0, review: 0, skipped: 0, skippedReused: 0, failed: 0};
		const version = await this.probe.getVersion();
		const known = new Map((await this.repository.list()).map(row => [key(row.archiveId, row.relativePath), row]));
		const allowed = await fs.realpath(root);
		const archives = new Set<number>();
		const startedAt = Date.now();
		let lastProgress = startedAt;
		let pending: Candidate[] = [];
		const progress = (source: string, force = false) => {
			if (force || Date.now() - lastProgress >= 5000 || summary.checked % 1000 === 0) {
				lastProgress = Date.now();
				logger.info(`audio-metadata:progress ${JSON.stringify({...summary, currentPath: source, elapsedMs: lastProgress - startedAt})}`);
			}
		};
		const detected = (id: number) => {
			summary.detected++;
			archives.add(id);
			summary.archives = archives.size;
		};
		const flush = async () => {
			if (!pending.length) return;
			const batch = pending;
			pending = [];
			const contents = await this.probe.detectContainers(batch.map(item => item.source));
			summary.headersInspected += batch.length;
			for (let index = 0; index < batch.length; index++) {
				const item = batch[index], content = contents[index];
				let token: string | undefined;
				try {
					if (!content || content.error) throw new Error(content?.error || "Missing content detection result");
					if (!content.container && !known.has(key(item.id, item.relative))) {
						summary.skipped++;
						continue;
					}
					if (item.signature !== await audioSourceSignature(item.source, allowed)) throw new Error("Source changed during detection");
					token = await this.repository.claim(item.id, item.relative, item.signature, version);
					if (!token) {
						summary.reusedOrDeferred++;
						continue;
					}
					const started = Date.now();
					const result: AudioProbeResult = content.container ? await this.probe.probe(item.source, content.container)
						: {status: "skipped", chapters: [], details: {format: "", codec: "", chapterCount: 0, warnings: [], reason: "non-audio-content"}};
					if (item.signature !== await audioSourceSignature(item.source, allowed)) throw new Error("Source changed during extraction");
					if (!await this.repository.complete(item.id, item.relative, token, result)) throw new Error("Extraction ownership expired or changed");
					if (result.status === "skipped") summary.skipped++;
					else {
						detected(item.id);
						summary.extracted++;
						if (result.status === "needs_review") summary.review++;
						else if (!result.chapters.length) summary.withoutChapters++;
					}
					logger.info(`audio-metadata:item ${JSON.stringify({archiveId: item.id, relative: item.relative, status: result.status,
						chapters: result.chapters.length, duration: result.duration, reason: result.details.reason,
						warnings: result.details.warnings, elapsedMs: Date.now() - started})}`);
				} catch (error) {
					summary.failed++;
					const message = error instanceof Error ? error.message : String(error);
					if (token) await this.repository.fail(item.id, item.relative, token, message);
					logger.error(`audio-metadata:failed ${JSON.stringify({archiveId: item.id, relative: item.relative, source: item.source, error: message.slice(0, 4000)})}`);
				}
				progress(item.source);
			}
		};
		logger.info(`audio-metadata:start extractor="${version}"`);
		for (const file of files) {
			if (!file.id || (file.fileKind !== FileKind.AUDIOBOOK && file.fileKind !== FileKind.FILE)) continue;
			const base = path.join(file.parentPath, file.name);
			// Select candidates before filesystem access; content still determines the format.
			if (file.fileKind === FileKind.FILE && !isAudioCandidate(file.name)) {
				summary.checked++; summary.extensionSkipped++; summary.skipped++;
				progress(base);
				continue;
			}
			try {
				const resolved = await fs.realpath(base);
				if (!resolved.startsWith(allowed + path.sep)) throw new Error("Audio archive is outside library root");
				const entries = file.fileKind === FileKind.AUDIOBOOK
					? (await fs.readdir(base, {withFileTypes: true})).filter(e => e.isFile()).map(e => e.name).sort() : [""];
				for (const relative of entries) {
					const source = relative ? path.join(base, relative) : base;
					summary.checked++;
					if (!isAudioCandidate(relative || file.name)) {
						summary.extensionSkipped++; summary.skipped++;
						progress(source);
						continue;
					}
					try {
						const signature = await audioSourceSignature(source, allowed);
						const previous = known.get(key(file.id, relative));
						if (previous?.sourceSignature === signature && previous.extractorVersion === version &&
							["ready", "needs_review", "skipped"].includes(previous.status)) {
							if (previous.status === "skipped") {
								summary.skipped++; summary.skippedReused++;
							} else {
								detected(file.id); summary.reusedOrDeferred++;
							}
						} else pending.push({id: file.id, relative, source, signature});
						if (pending.length === 64) await flush();
					} catch (error) {
						summary.failed++;
						logger.error(`audio-metadata:source-failed ${JSON.stringify({archiveId: file.id, relative, source})}`, error);
					}
					progress(source);
				}
				// Physical absence is reconciled only after successful enumeration.
				if (file.fileKind === FileKind.AUDIOBOOK) await this.repository.removeMissing(file.id, entries);
			} catch (error) {
				summary.failed++;
				logger.error(`audio-metadata:archive-failed id="${file.id}"`, error);
			}
		}
		await flush();
		progress("", true);
		logger.info(`audio-metadata:complete ${JSON.stringify({...summary, elapsedMs: Date.now() - startedAt})}`);
		return summary;
	}
}
