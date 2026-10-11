import { execFile } from "child_process";
import { promisify } from "util";
import path from "path";

const execute = promisify(execFile);
const containers = new Map([
	["application/x-libretorio-id3", "id3"],
	["audio/mpeg", "mp3"], ["audio/mp4", "mov"], ["video/mp4", "mov"], ["video/quicktime", "mov"],
	["audio/x-m4a", "mov"], ["audio/x-m4b", "mov"],
	["audio/wav", "wav"], ["audio/vnd.wave", "wav"], ["audio/x-wav", "wav"],
	["audio/ogg", "ogg"], ["video/ogg", "ogg"], ["application/ogg", "ogg"], ["audio/opus", "ogg"],
	["audio/flac", "flac"], ["audio/x-flac", "flac"],
	["video/matroska", "matroska"], ["video/x-matroska", "matroska"], ["audio/x-matroska", "matroska"],
	["video/webm", "matroska"], ["audio/webm", "matroska"]
]);

export interface AudioContentDetection {
	container?: string;
	error?: string;
}

export class AudioContentDetector {
	constructor(private readonly binary = "/usr/bin/file", private readonly timeout = 5000) {}

	async detect(files: string[]): Promise<AudioContentDetection[]> {
		if (!files.length) return [];
		if (files.length > 64) throw new Error("Content detection batch exceeds 64 files");
		const sources = files.map(file => path.resolve(file));
		const env = {...process.env};
		env["LC_ALL"] = "C";
		const magic = `${path.join(__dirname, "audio-candidate.magic")}:/usr/share/misc/magic.mgc`;
		try {
			// Keep document/text recognition; only eligible audio names reach this process.
			// NUL-delimited filename/result pairs also support names containing newlines.
			const {stdout} = await execute("/usr/bin/prlimit", ["--as=268435456", "--cpu=3", "--nofile=64", "--", this.binary,
				"-h", "-r", "-0", "-0", "--mime-type", "-P", "bytes=16384", "-m", magic,
				"-e", "compress",
				"--", ...sources], {timeout: this.timeout, killSignal: "SIGKILL", maxBuffer: 1024 * 1024,
				env});
			const fields = stdout.split("\0");
			if (fields.pop() !== "" || fields.length !== sources.length * 2) throw new Error("Invalid content detector response");
			return sources.map((source, index) => {
				if (fields[index * 2] !== source) throw new Error("Content detector response path mismatch");
				const mime = fields[index * 2 + 1].trim().toLowerCase();
				if (!/^[a-z0-9.+-]+\/[a-z0-9.+-]+$/.test(mime)) return {error: mime.slice(0, 1000)};
				// Unknown binary data is not evidence of MP3: FFprobe must identify it itself.
				if (["application/octet-stream", "application/x-dosexec"].includes(mime)) return {container: "auto"};
				return {container: containers.get(mime)};
			});
		} catch (error) {
			// Isolate a bad input or timed-out subprocess without losing healthy siblings.
			if (sources.length > 1) {
				const middle = Math.floor(sources.length / 2);
				return [...await this.detect(sources.slice(0, middle)), ...await this.detect(sources.slice(middle))];
			}
			return [{error: error instanceof Error ? error.message.slice(0, 2000) : String(error)}];
		}
	}
}
