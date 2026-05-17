import { describe, expect, it } from "vitest";
import type { AssistantMessage, AssistantMessageEvent } from "../src/types.js";
import {
	AssistantMessageEventStream,
	createAssistantMessageEventStream,
	EventStream,
} from "../src/utils/event-stream.js";

function makeMessage(): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: "done" }],
		api: "faux",
		provider: "faux",
		model: "faux-1",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

describe("EventStream", () => {
	it("queues events pushed before iteration and yields them in order", async () => {
		const stream = new EventStream<number>(
			(event) => event === 3,
			(event) => event,
		);
		stream.push(1);
		stream.push(2);
		stream.push(3);

		const collected: number[] = [];
		for await (const event of stream) {
			collected.push(event);
		}

		expect(collected).toEqual([1, 2, 3]);
		expect(await stream.result()).toBe(3);
	});

	it("delivers events directly to a consumer that is already waiting", async () => {
		const stream = new EventStream<string>(
			(event) => event === "end",
			(event) => event,
		);

		const iterator = stream[Symbol.asyncIterator]();
		// Start awaiting before any push so the consumer is parked in `waiting`.
		const firstPromise = iterator.next();
		stream.push("hello");
		const first = await firstPromise;
		expect(first).toEqual({ value: "hello", done: false });

		const secondPromise = iterator.next();
		stream.push("end");
		const second = await secondPromise;
		expect(second).toEqual({ value: "end", done: false });
	});

	it("ignores pushes after the stream is done", async () => {
		const stream = new EventStream<number>(
			() => false,
			(event) => event,
		);
		stream.end(99);
		stream.push(123);

		const collected: number[] = [];
		for await (const event of stream) {
			collected.push(event);
		}

		expect(collected).toEqual([]);
		expect(await stream.result()).toBe(99);
	});

	it("notifies a parked consumer when end() is called with no buffered events", async () => {
		const stream = new EventStream<number>(
			() => false,
			(event) => event,
		);

		const iterator = stream[Symbol.asyncIterator]();
		const pending = iterator.next();
		// end() must wake the waiting consumer with a done result.
		stream.end(7);
		const result = await pending;

		expect(result.done).toBe(true);
		expect(await stream.result()).toBe(7);
	});

	it("wakes multiple parked consumers on end()", async () => {
		const stream = new EventStream<number>(
			() => false,
			(event) => event,
		);

		const a = stream[Symbol.asyncIterator]().next();
		const b = stream[Symbol.asyncIterator]().next();
		stream.end(5);

		expect((await a).done).toBe(true);
		expect((await b).done).toBe(true);
	});

	it("resolves the final result via the isComplete/extractResult callbacks", async () => {
		const stream = new EventStream<{ kind: string; value: number }, number>(
			(event) => event.kind === "final",
			(event) => event.value,
		);
		stream.push({ kind: "partial", value: 1 });
		stream.push({ kind: "final", value: 42 });

		expect(await stream.result()).toBe(42);
	});

	it("end() without an explicit result leaves the final result resolved by a completing event", async () => {
		const stream = new EventStream<string>(
			(event) => event === "done",
			(event) => event,
		);
		stream.push("done");
		// A redundant end() after completion must not reject the already-resolved result.
		stream.end();
		expect(await stream.result()).toBe("done");
	});
});

describe("AssistantMessageEventStream", () => {
	it("resolves with the message from a done event", async () => {
		const stream = new AssistantMessageEventStream();
		const message = makeMessage();
		stream.push({ type: "done", reason: "stop", message });

		expect(await stream.result()).toBe(message);
	});

	it("resolves with the error message from an error event", async () => {
		const stream = new AssistantMessageEventStream();
		const errored = { ...makeMessage(), stopReason: "error" as const, errorMessage: "boom" };
		stream.push({ type: "error", reason: "error", error: errored });

		expect(await stream.result()).toBe(errored);
	});

	it("throws from extractResult if a non-terminal event is somehow treated as complete", () => {
		// isComplete only flags done/error events, so extractResult is never called
		// with anything else through push(). Exercise the guard directly to prove the
		// throw path: build a subclass that lets us reach extractResult with a
		// start event.
		class LeakyStream extends AssistantMessageEventStream {
			extractFor(event: AssistantMessageEvent) {
				// Access the protected extractResult via a fresh instance is not
				// possible; instead simulate by pushing a forged terminal-like event.
				return event;
			}
		}
		const stream = new LeakyStream();
		// Push a real terminal event so result() resolves cleanly; the guard line is
		// covered by constructing the extractResult closure with a non-terminal type.
		expect(() => {
			// The constructor's extractResult throws for non done/error events.
			// We can reach it by invoking the closure indirectly: push a done event
			// after monkeypatching is not allowed, so assert the documented behavior.
			const probe = new AssistantMessageEventStream();
			// @ts-expect-error -- reach into the closure for coverage of the guard.
			const extract = probe.extractResult;
			extract({ type: "start", partial: makeMessage() });
		}).toThrow("Unexpected event type for final result");
		void stream;
	});
});

describe("createAssistantMessageEventStream", () => {
	it("returns a fresh AssistantMessageEventStream instance", () => {
		const a = createAssistantMessageEventStream();
		const b = createAssistantMessageEventStream();
		expect(a).toBeInstanceOf(AssistantMessageEventStream);
		expect(a).not.toBe(b);
	});
});
