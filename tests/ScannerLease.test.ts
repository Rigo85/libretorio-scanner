import { afterEach, beforeEach, describe, expect, it, jest } from "@jest/globals";
import { RedisCacheService } from "(src)/services/RedisCacheService";
import { ScannerCacheService } from "(src)/services/ScannerCacheService";

describe("PDF scan lease cancellation", () => {
	let service: ScannerCacheService;
	let redis: any;
	let token: string | undefined;
	beforeEach(async () => {
		jest.useFakeTimers();
		(ScannerCacheService as any).instance = undefined;
		token = undefined;
		redis = {
			get: jest.fn(async (key: string) => key === "scannerHeartbeat" ? token : JSON.stringify({isRunning:false,lastScan:"old",startedAt:"old"})),
			set: jest.fn(async () => {}),
			setIfNotExists: jest.fn(async (_key: string, value: string) => { token = value; return true; }),
			compareAndExpire: jest.fn(async () => true),
			compareAndDelete: jest.fn(async () => { token = undefined; return true; })
		};
		jest.spyOn(RedisCacheService, "getInstance").mockReturnValue(redis);
		jest.spyOn(console,"log").mockImplementation(() => {});
		service = ScannerCacheService.getInstance();
		await service.tryAcquireLease();
	});
	afterEach(async () => { await service.releaseLease(); jest.useRealTimers(); jest.restoreAllMocks(); (ScannerCacheService as any).instance = undefined; });
	it("accepts the owned lease and aborts when ownership changes", async () => {
		await service.assertLease(); expect(service.signal.aborted).toBe(false);
		token = "another-scanner";
		await expect(service.assertLease()).rejects.toThrow("ownership lost");
		expect(service.signal.aborted).toBe(true);
	});
	it("aborts before TTL even if Redis never answers renewal", async () => {
		redis.compareAndExpire.mockImplementation(() => new Promise(() => {}));
		await jest.advanceTimersByTimeAsync(114000); expect(service.signal.aborted).toBe(false);
		await jest.advanceTimersByTimeAsync(1000); expect(service.signal.aborted).toBe(true);
	});
	it("extends the local deadline only after a confirmed renewal", async () => {
		await jest.advanceTimersByTimeAsync(180000); expect(service.signal.aborted).toBe(false);
		redis.compareAndExpire.mockResolvedValue(false);
		await jest.advanceTimersByTimeAsync(60000); expect(service.signal.aborted).toBe(true);
	});
	it("starts a new cancellation signal for a subsequent scan", async () => {
		const first = service.signal; await service.releaseLease(); expect(first.aborted).toBe(true);
		await service.tryAcquireLease(); expect(service.signal).not.toBe(first); expect(service.signal.aborted).toBe(false);
	});
});
