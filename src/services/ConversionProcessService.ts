import { spawn } from "child_process";
import fs from "fs/promises";
import { ConversionError } from "(src)/models/interfaces/DocumentConversion";

export class ConversionProcessService {
	private active?: Promise<{stdout: string; stderr: string}>;
	private kill?: () => void;
	private cancelled = false;

	async stop(): Promise<void> {
		this.cancelled = true;
		this.kill?.();
		await this.active?.catch((): void => {});
	}

	check(): void {
		if (this.cancelled) throw new ConversionError("interrupted", "Conversion cancelled", true);
	}

	async run(binary: string, args: string[], timeoutMs: number, memoryBytes?: number): Promise<{stdout: string; stderr: string}> {
		this.check();
		if (this.active) throw new ConversionError("overlap", "A conversion process is already active", true);
		const task = new Promise<{stdout: string; stderr: string}>((resolve, reject) => {
			const child = spawn(binary, args, {detached: true, stdio: ["ignore", "pipe", "pipe"],
				// eslint-disable-next-line @typescript-eslint/naming-convention
				env: {PATH: "/usr/bin:/bin", LANG: "C.UTF-8", LC_ALL: "C.UTF-8"}});
			let stdout = "", stderr = "", bytes = 0;
			let failure: ConversionError | undefined;
			let closed = false, sampling = false;
			const kill = () => {
				if (!child.pid) return;
				try {
					process.kill(-child.pid, "SIGKILL");
				} catch (error) {
					if (error.code !== "ESRCH") failure = new ConversionError("kill", error.message, true);
				}
			};
			this.kill = kill;
			// RSS is sampled across descendants; virtual reservations in Qt are not resident RAM.
			const memoryTimer = memoryBytes ? setInterval(() => {
				if (sampling || closed || !child.pid) return;
				sampling = true;
				this.residentBytes(child.pid).then(bytes => {
					if (!closed && bytes > memoryBytes) {
						failure ||= new ConversionError("memory_limit", `Process tree RSS exceeded ${memoryBytes} bytes`);
						kill();
					}
				}).catch(error => {
					if (!closed) {
						failure = new ConversionError("resource_monitor", error.message, true);
						kill();
					}
				}).finally(() => {
					sampling = false;
				});
			}, 250) : undefined;
			const timer = setTimeout(() => {
				failure ||= new ConversionError("timeout", `Process exceeded ${timeoutMs} ms`);
				kill();
			}, timeoutMs);
			const receive = (buffer: Buffer, isError: boolean) => {
				bytes += buffer.length;
				if (bytes > 1024 * 1024) {
					failure ||= new ConversionError("output_limit", "Process output exceeded 1 MiB");
					kill();
					return;
				}
				if (isError) stderr += buffer.toString();
				else stdout += buffer.toString();
			};
			child.stdout.on("data", buffer => receive(buffer, false));
			child.stderr.on("data", buffer => receive(buffer, true));
			child.on("error", error => {
				failure = new ConversionError("spawn", error.message, true);
			});
			child.on("close", (code, signal) => {
				closed = true;
				clearTimeout(timer);
				if (memoryTimer) clearInterval(memoryTimer);
				this.kill = undefined;
				if (this.cancelled) reject(new ConversionError("interrupted", "Conversion cancelled", true));
				else if (failure) reject(Object.assign(failure, {diagnostics: {stdout, stderr, exitCode: code ?? undefined, signal: signal || undefined}}));
				else if (code !== 0) reject(Object.assign(new ConversionError(signal ? "process_signal" : "converter",
					`${signal ? `Signal ${signal}` : `Exit ${code}`}: ${stderr.slice(-6000)}\nstdout: ${stdout.slice(-2000)}`),
				{diagnostics: {stdout, stderr, exitCode: code ?? undefined, signal: signal || undefined}}));
				else resolve({stdout, stderr});
			});
		});
		this.active = task;
		try {
			return await task;
		} finally {
			this.active = undefined;
		}
	}

	private async residentBytes(pid: number, visited = new Set<number>()): Promise<number> {
		if (visited.has(pid)) return 0;
		visited.add(pid);
		if (visited.size > 256) throw new Error("Conversion process tree exceeds 256 processes");
		try {
			const status = await fs.readFile(`/proc/${pid}/status`, "utf8");
			let bytes = Number(/^VmRSS:\s+(\d+) kB$/m.exec(status)?.[1] || 0) * 1024;
			for (const task of await fs.readdir(`/proc/${pid}/task`)) {
				let children: string;
				try {
					children = await fs.readFile(`/proc/${pid}/task/${task}/children`, "utf8");
				} catch (error) {
					if (["ENOENT", "ESRCH"].includes(error.code)) continue;
					throw error;
				}
				for (const child of children.trim().split(/\s+/).filter(Boolean)) bytes += await this.residentBytes(Number(child), visited);
			}
			return bytes;
		} catch (error) {
			if (["ENOENT", "ESRCH"].includes(error.code)) return 0;
			throw error;
		}
	}
}
