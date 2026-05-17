import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { closeWatcher, FS_WATCH_RETRY_DELAY_MS, watchWithErrorHandler } from "../src/utils/fs-watch.js";

describe("fs-watch", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `pi-fswatch-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("exports retry delay constant", () => {
		expect(FS_WATCH_RETRY_DELAY_MS).toBe(5000);
	});

	it("closeWatcher tolerates null/undefined", () => {
		expect(() => closeWatcher(null)).not.toThrow();
		expect(() => closeWatcher(undefined)).not.toThrow();
	});

	it("closeWatcher closes a real watcher", () => {
		const file = join(tempDir, "file");
		writeFileSync(file, "content");
		const watcher = watchWithErrorHandler(
			file,
			() => {},
			() => {},
		);
		expect(watcher).not.toBeNull();
		closeWatcher(watcher);
	});

	it("closeWatcher swallows close errors", () => {
		const fakeWatcher = {
			close: () => {
				throw new Error("close failed");
			},
		};
		expect(() => closeWatcher(fakeWatcher as never)).not.toThrow();
	});

	it("watchWithErrorHandler returns null and calls onError when path missing", () => {
		const onError = vi.fn();
		const watcher = watchWithErrorHandler(join(tempDir, "nonexistent"), () => {}, onError);
		expect(watcher).toBeNull();
		expect(onError).toHaveBeenCalled();
	});

	it("watchWithErrorHandler wires error handler on success", () => {
		const file = join(tempDir, "file");
		writeFileSync(file, "data");
		const onError = vi.fn();
		const watcher = watchWithErrorHandler(file, () => {}, onError);
		expect(watcher).not.toBeNull();
		// Manually emit an error to trigger the handler
		watcher?.emit("error", new Error("fake-error"));
		expect(onError).toHaveBeenCalled();
		closeWatcher(watcher);
	});
});
