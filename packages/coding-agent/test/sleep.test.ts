import { describe, expect, it } from "vitest";
import { sleep } from "../src/utils/sleep.js";

describe("sleep", () => {
	it("resolves after the given delay", async () => {
		const start = Date.now();
		await sleep(20);
		const elapsed = Date.now() - start;
		expect(elapsed).toBeGreaterThanOrEqual(15);
	});

	it("rejects immediately if signal already aborted", async () => {
		const ctrl = new AbortController();
		ctrl.abort();
		await expect(sleep(50, ctrl.signal)).rejects.toThrow("Aborted");
	});

	it("rejects when signal aborts during sleep", async () => {
		const ctrl = new AbortController();
		const p = sleep(500, ctrl.signal);
		setTimeout(() => ctrl.abort(), 5);
		await expect(p).rejects.toThrow("Aborted");
	});

	it("ignores signal when not aborted", async () => {
		const ctrl = new AbortController();
		await sleep(5, ctrl.signal);
		expect(ctrl.signal.aborted).toBe(false);
	});
});
