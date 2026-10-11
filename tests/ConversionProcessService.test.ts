import { ConversionProcessService } from "(src)/services/ConversionProcessService";
import { describe, expect, it, jest } from "@jest/globals";
import childProcess from "child_process";
import { EventEmitter } from "events";
import { PassThrough } from "stream";

describe("bounded conversion subprocess", () => {
	it("runs arguments without a shell", async () => {
		const processRunner = new ConversionProcessService();
		const result = await processRunner.run(process.execPath, ["-e", "console.log(process.argv[1])", "$(touch forbidden)"], 2000);
		expect(result.stdout.trim()).toBe("$(touch forbidden)");
	});
	it("bounds output", async () => {
		await expect(new ConversionProcessService().run(process.execPath, ["-e", "process.stdout.write('x'.repeat(2*1024*1024))"], 2000))
			.rejects.toMatchObject({code: "output_limit"});
	});
	it("retains terminating signal rather than reporting Exit null", async () => {
		await expect(new ConversionProcessService().run(process.execPath, ["-e", "process.kill(process.pid,'SIGTERM')"], 2000))
			.rejects.toMatchObject({code: "process_signal", diagnostics: {signal: "SIGTERM"}});
	});
	it("retains the exit code and stderr", async () => {
		await expect(new ConversionProcessService().run(process.execPath, ["-e", "console.error('fixture failure');process.exit(7)"], 2000))
			.rejects.toMatchObject({code: "converter", diagnostics: {exitCode: 7, stderr: "fixture failure\n"}});
	});
	it("does not overwrite a log limit when the deadline also expires before close", async () => {
		const child = Object.assign(new EventEmitter(), {stdout: new PassThrough(), stderr: new PassThrough()});
		const spawn = jest.spyOn(childProcess, "spawn").mockReturnValue(child as any);
		jest.useFakeTimers();
		try {
			const pending = new ConversionProcessService().run("fixture", [], 100);
			const rejected = expect(pending).rejects.toMatchObject({code: "output_limit"});
			child.stdout.write(Buffer.alloc(1024 * 1024 + 1));
			jest.advanceTimersByTime(100);
			child.emit("close", undefined, "SIGKILL");
			await rejected;
		} finally { spawn.mockRestore(); jest.useRealTimers(); }
	});
	it("times out and allows another process", async () => {
		const runner = new ConversionProcessService();
		await expect(runner.run(process.execPath, ["-e", "setInterval(()=>{},1000)"], 50)).rejects.toMatchObject({code: "timeout"});
		expect((await runner.run(process.execPath, ["-e", "console.log('ok')"], 2000)).stdout.trim()).toBe("ok");
	});
	it("waits for cancellation and prevents subsequent launches", async () => {
		const runner = new ConversionProcessService();
		const pending = runner.run(process.execPath, ["-e", "setInterval(()=>{},1000)"], 2000);
		const rejected = expect(pending).rejects.toMatchObject({code: "interrupted"});
		await runner.stop(); await rejected;
		await expect(runner.run(process.execPath, ["-e", ""], 2000)).rejects.toMatchObject({code: "interrupted"});
	});
	it("stops a resident-memory overrun without confusing virtual reservations with RAM", async () => {
		await expect(new ConversionProcessService().run(process.execPath,
			["-e", "global.data=Buffer.alloc(64*1024*1024,1);setInterval(()=>{},1000)"], 4000, 16*1024*1024))
			.rejects.toMatchObject({code: "memory_limit"});
	});
});
