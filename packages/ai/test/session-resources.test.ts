import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanupSessionResources, registerSessionResourceCleanup } from "../src/session-resources.js";

const unregisters: Array<() => void> = [];

afterEach(() => {
	for (const unregister of unregisters.splice(0)) {
		unregister();
	}
});

function track(cleanup: Parameters<typeof registerSessionResourceCleanup>[0]): () => void {
	const unregister = registerSessionResourceCleanup(cleanup);
	unregisters.push(unregister);
	return unregister;
}

describe("session resource cleanup", () => {
	it("invokes every registered cleanup with the provided sessionId", () => {
		const a = vi.fn();
		const b = vi.fn();
		track(a);
		track(b);

		cleanupSessionResources("session-7");

		expect(a).toHaveBeenCalledWith("session-7");
		expect(b).toHaveBeenCalledWith("session-7");
	});

	it("invokes cleanups with undefined when no sessionId is given", () => {
		const cleanup = vi.fn();
		track(cleanup);

		cleanupSessionResources();

		expect(cleanup).toHaveBeenCalledWith(undefined);
	});

	it("stops invoking a cleanup after it is unregistered", () => {
		const cleanup = vi.fn();
		const unregister = registerSessionResourceCleanup(cleanup);
		unregister();

		cleanupSessionResources("session-x");

		expect(cleanup).not.toHaveBeenCalled();
	});

	it("runs all cleanups even when some throw, then raises an AggregateError", () => {
		const firstError = new Error("first failed");
		const secondError = new Error("second failed");
		const ok = vi.fn();
		track(() => {
			throw firstError;
		});
		track(ok);
		track(() => {
			throw secondError;
		});

		let thrown: unknown;
		try {
			cleanupSessionResources("session-fail");
		} catch (error) {
			thrown = error;
		}

		expect(ok).toHaveBeenCalledWith("session-fail");
		expect(thrown).toBeInstanceOf(AggregateError);
		expect((thrown as AggregateError).errors).toEqual([firstError, secondError]);
		expect((thrown as AggregateError).message).toBe("Failed to cleanup session resources");
	});

	it("does not throw when every cleanup succeeds", () => {
		track(vi.fn());
		expect(() => cleanupSessionResources("session-ok")).not.toThrow();
	});
});
