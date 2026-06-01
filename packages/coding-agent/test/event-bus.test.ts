import { describe, expect, it, vi } from "vitest";
import { createEventBus } from "../src/core/event-bus.js";

describe("createEventBus", () => {
	it("returns a controller with emit/on/clear", () => {
		const bus = createEventBus();
		expect(typeof bus.emit).toBe("function");
		expect(typeof bus.on).toBe("function");
		expect(typeof bus.clear).toBe("function");
	});

	it("delivers events to subscribed handlers", async () => {
		const bus = createEventBus();
		const handler = vi.fn();
		bus.on("test", handler);
		bus.emit("test", { value: 1 });
		// Wait for async handler to fire
		await new Promise((resolve) => setImmediate(resolve));
		expect(handler).toHaveBeenCalledWith({ value: 1 });
	});

	it("unsubscribes via returned function", async () => {
		const bus = createEventBus();
		const handler = vi.fn();
		const off = bus.on("test", handler);
		off();
		bus.emit("test", { value: 1 });
		await new Promise((resolve) => setImmediate(resolve));
		expect(handler).not.toHaveBeenCalled();
	});

	it("catches handler errors and logs them", async () => {
		const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		const bus = createEventBus();
		bus.on("test", () => {
			throw new Error("boom");
		});
		bus.emit("test", {});
		await new Promise((resolve) => setImmediate(resolve));
		expect(errSpy).toHaveBeenCalledWith(expect.stringContaining("Event handler error (test):"), expect.any(Error));
		errSpy.mockRestore();
	});

	it("catches async handler rejection and logs", async () => {
		const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		const bus = createEventBus();
		bus.on("test", async () => {
			throw new Error("async-boom");
		});
		bus.emit("test", {});
		await new Promise((resolve) => setImmediate(resolve));
		expect(errSpy).toHaveBeenCalled();
		errSpy.mockRestore();
	});

	it("clear removes all listeners", async () => {
		const bus = createEventBus();
		const handler = vi.fn();
		bus.on("a", handler);
		bus.on("b", handler);
		bus.clear();
		bus.emit("a", {});
		bus.emit("b", {});
		await new Promise((resolve) => setImmediate(resolve));
		expect(handler).not.toHaveBeenCalled();
	});

	it("supports multiple handlers per channel", async () => {
		const bus = createEventBus();
		const h1 = vi.fn();
		const h2 = vi.fn();
		bus.on("ch", h1);
		bus.on("ch", h2);
		bus.emit("ch", "payload");
		await new Promise((resolve) => setImmediate(resolve));
		expect(h1).toHaveBeenCalledWith("payload");
		expect(h2).toHaveBeenCalledWith("payload");
	});
});
