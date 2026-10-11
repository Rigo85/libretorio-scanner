import { execFile } from "child_process";
import { promisify } from "util";
import { open, realpath, stat } from "fs/promises";
import path from "path";
import { AudioContentDetector } from "./AudioContentDetector";

const execute = promisify(execFile);
const finiteTime = (value: unknown): number =>
	(typeof value === "string" && value.trim() !== "") || typeof value === "number" ? Number(value) : NaN;

export interface AudioChapter {
	title: string;
	startTimeInSeconds: number;
	endTimeInSeconds: number;
}

export interface AudioProbeResult {
	status: "ready" | "needs_review" | "skipped";
	duration?: number;
	chapters: AudioChapter[];
	details: { format: string; codec: string; chapterCount: number; warnings: string[]; reason?: string };
}

export async function audioSourceSignature(file: string, root: string): Promise<string> {
	const [resolved, allowed] = await Promise.all([realpath(file), realpath(root)]);
	if (!resolved.startsWith(allowed + path.sep)) throw new Error("Audio source is outside library root");
	const info = await stat(resolved, {bigint: true});
	if (!info.isFile()) throw new Error("Audio source is not a regular file");
	return JSON.stringify([resolved, info.dev, info.ino, info.size, info.mtimeNs, info.ctimeNs].map(String));
}

export function normalizeAudioProbe(value: any, stderr = ""): AudioProbeResult {
	if (!value || value.error || !Array.isArray(value.streams)) throw new Error("Invalid ffprobe response");
	const audio = value.streams.find((stream: any) => stream.codec_type === "audio");
	const video = value.streams.some((stream: any) => stream.codec_type === "video" && stream.disposition?.attached_pic !== 1);
	if (!audio || video) {
		return {status: "skipped", chapters: [], details: {format: String(value.format?.format_name ?? ""),
			codec: String(audio?.codec_name ?? ""), chapterCount: 0, warnings: [], reason: video ? "video" : "no-audio-stream"}};
	}
	const duration = Number(value.format?.duration ?? audio.duration);
	if (!Number.isFinite(duration) || duration <= 0) throw new Error("Audio duration unavailable or invalid");
	const warnings: string[] = stderr.trim() ? [stderr.trim().slice(0, 4000)] : [];
	const input = value.chapters ?? [];
	if (!Array.isArray(input) || input.length > 20000) throw new Error("Invalid chapter collection");
	const chapters: AudioChapter[] = [];
	let invalid = false;
	for (let index = 0; index < input.length; index++) {
		const chapter = input[index];
		const start = finiteTime(chapter?.start_time);
		const end = finiteTime(chapter?.end_time);
		const finalOverflow = index === input.length - 1 && Number.isFinite(end) && end > duration && start < duration;
		const normalizedEnd = finalOverflow ? duration : end;
		const previous = chapters.at(-1);
		if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || start >= duration || normalizedEnd <= start ||
			normalizedEnd > duration + 0.05 || (previous && (start <= previous.startTimeInSeconds || start < previous.endTimeInSeconds - 0.05))) {
			warnings.push(`Invalid chapter interval at index ${index}`);
			invalid = true;
			continue;
		}
		if (finalOverflow) warnings.push(`Final chapter exceeds audio duration at index ${index}: originalEnd=${end}, normalizedEnd=${duration}, excessSeconds=${end - duration}`);
		const title = typeof chapter.tags?.title === "string" ? chapter.tags.title.trim() : "";
		if (!title) warnings.push(`Missing chapter title at index ${index}`);
		chapters.push({title: title.slice(0, 2000) || `Capitulo ${index + 1}`, startTimeInSeconds: start, endTimeInSeconds: normalizedEnd});
	}
	// Do not silently publish a truncated chapter list as a successful extraction.
	return {
		status: warnings.length ? "needs_review" : "ready", duration,
		chapters: invalid ? [] : chapters,
		details: {format: String(value.format?.format_name ?? ""), codec: String(audio.codec_name ?? ""),
			chapterCount: input.length, warnings: warnings.slice(0, 100)}
	};
}

export class AudioProbeService {
	private version?: string;
	private readonly detector = new AudioContentDetector();
	constructor(private readonly binary = process.env.AUDIO_FFPROBE_PATH || "/usr/bin/ffprobe") {}

	async getVersion(): Promise<string> {
		if (!this.version) {
			const {stdout} = await execute(this.binary, ["-version"], {timeout: 10000, maxBuffer: 65536});
			this.version = `libretorio-audio-v1:${stdout.split("\n")[0]}`;
		}
		return this.version;
	}

	async detectContainer(file: string): Promise<string | undefined> {
		const [result] = await this.detectContainers([file]);
		if (result.error) throw new Error(result.error);
		return result.container;
	}

	async detectContainers(files: string[]) {
		return this.detector.detect(files);
	}

	async probe(file: string, detectedContainer?: string): Promise<AudioProbeResult> {
		const container = detectedContainer ?? await this.detectContainer(file);
		if (!container) throw new Error("Unsupported audio container signature");
		if (!["mov", "mp3", "wav", "ogg", "flac", "matroska", "id3", "auto"].includes(container)) throw new Error("Invalid audio demuxer");
		const env = {...process.env};
		env["LC_ALL"] = "C";
		const source = await open(file, "r");
		try {
			// The descriptor path is seekable and has no extension to bias auto-detection.
			const input = `/proc/${process.pid}/fd/${source.fd}`;
			// prlimit constrains this child, never the scanner process or other services.
			const {stdout, stderr} = await execute("/usr/bin/prlimit", ["--as=1073741824", "--cpu=90", "--nofile=64", "--",
				this.binary, "-v", "warning", "-protocol_whitelist", "file", "-format_whitelist", "mov,mp3,wav,ogg,flac,matroska,webm",
				...(["id3", "auto"].includes(container) ? [] : ["-f", container]),
				"-show_error", "-show_entries",
				"format=format_name,duration,probe_score:stream=codec_type,codec_name,duration:stream_disposition=attached_pic:chapter=id,start_time,end_time:chapter_tags=title",
				"-of", "json", "-i", input],
			{timeout: 120000, killSignal: "SIGKILL", maxBuffer: 8 * 1024 * 1024, env});
			const result = JSON.parse(stdout);
			// FFmpeg scores short MP3s with consecutive frames below long streams.
			const minimumScore = result.format?.format_name === "mp3" ? 25 : 50;
			if (container === "auto" && !(Number(result.format?.probe_score) >= minimumScore)) throw new Error("Insufficient confidence identifying audio container");
			return normalizeAudioProbe(result, stderr);
		} finally {
			await source.close();
		}
	}
}
