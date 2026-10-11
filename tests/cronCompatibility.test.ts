import { afterEach, describe, expect, it } from "@jest/globals";
import { createTask, getTasks, schedule, validate } from "node-cron";

afterEach(async () => {
	for (const task of getTasks().values()) {
		await task.destroy();
	}
});

describe("node-cron runtime compatibility", () => {
	it("preserves the hourly scanner schedule without executing at startup", () => {
		let runs = 0;
		expect(validate("0 */1 * * *")).toBe(true);
		const task = schedule("0 */1 * * *", () => { runs++; }, {timezone: "America/Lima"});
		expect(runs).toBe(0);
		expect(task.getNextRun()?.getUTCMinutes()).toBe(0);
	});

	it("honors Lima time independently of the process timezone", () => {
		const task = schedule("0 3 * * *", () => {}, {timezone: "America/Lima"});
		expect(task.getNextRun()?.getUTCHours()).toBe(8);
	});

	it("can stop and restart a task without duplicating its registration", async () => {
		const task = createTask("* * * * *", () => {});
		expect(task.getStatus()).toBe("stopped");
		await task.start();
		await task.start();
		expect(getTasks().size).toBe(1);
		await task.stop();
		expect(task.getStatus()).toBe("stopped");
	});
});
