import { describe, expect, it } from "vitest";
import type { AssistantMessage } from "../src/types.js";
import {
	AssistantMessageEventStream,
	createAssistantMessageEventStream,
	EventStream,
} from "../src/utils/event-stream.js";

type NumberEvent = { type: "value"; value: number } | { type: "done"; result: number };
type DoneNumberEvent = Extract<NumberEvent, { type: "done" }>;

function assistantMessage(stopReason: AssistantMessage["stopReason"] = "stop"): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: "test-api",
		provider: "test-provider",
		model: "test-model",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				total: 0,
			},
		},
		stopReason,
		timestamp: 123,
	};
}

describe("EventStream", () => {
	it("queues pushed events, yields terminal events, and resolves the extracted result", async () => {
		const stream = new EventStream<NumberEvent, number, DoneNumberEvent>(
			(event) => event.type === "done",
			(event) => event.result,
		);

		stream.push({ type: "value", value: 1 });
		stream.push({ type: "done", result: 7 });
		stream.push({ type: "value", value: 99 });

		const events: NumberEvent[] = [];
		for await (const event of stream) {
			events.push(event);
		}

		expect(events).toEqual([
			{ type: "value", value: 1 },
			{ type: "done", result: 7 },
		]);
		await expect(stream.result()).resolves.toBe(7);
	});

	it("delivers pushed events directly to a waiting iterator", async () => {
		const stream = new EventStream<NumberEvent, number, DoneNumberEvent>(
			(event) => event.type === "done",
			(event) => event.result,
		);
		const iterator = stream[Symbol.asyncIterator]();

		const next = iterator.next();
		stream.push({ type: "value", value: 42 });

		await expect(next).resolves.toEqual({ value: { type: "value", value: 42 }, done: false });
		stream.end(42);
		await expect(stream.result()).resolves.toBe(42);
		await expect(iterator.next()).resolves.toEqual({ value: undefined, done: true });
	});

	it("ends waiting iterators without resolving the final result when no result is supplied", async () => {
		const stream = new EventStream<NumberEvent, number, DoneNumberEvent>(
			(event) => event.type === "done",
			(event) => event.result,
		);
		const iterator = stream[Symbol.asyncIterator]();

		const next = iterator.next();
		stream.end();

		await expect(next).resolves.toEqual({ value: undefined, done: true });
		await expect(
			Promise.race([
				stream.result().then(() => "resolved"),
				new Promise<string>((resolve) => setTimeout(() => resolve("pending"), 0)),
			]),
		).resolves.toBe("pending");
	});
});

describe("AssistantMessageEventStream", () => {
	it("resolves done events to their final assistant message", async () => {
		const stream = createAssistantMessageEventStream();
		const message = assistantMessage("stop");

		stream.push({ type: "done", reason: "stop", message });

		await expect(stream.result()).resolves.toBe(message);
	});

	it("resolves error events to their error assistant message", async () => {
		const stream = new AssistantMessageEventStream();
		const message = assistantMessage("error");

		stream.push({ type: "error", reason: "error", error: message });

		await expect(stream.result()).resolves.toBe(message);
	});
});
