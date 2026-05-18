import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import type { AssistantMessage, Tool, ToolCall } from "../src/types.js";
import {
	appendAssistantMessageDiagnostic,
	createAssistantMessageDiagnostic,
	extractDiagnosticError,
	formatThrownValue,
} from "../src/utils/diagnostics.js";
import {
	AssistantMessageEventStream,
	createAssistantMessageEventStream,
	EventStream,
} from "../src/utils/event-stream.js";
import { parseJsonWithRepair, parseStreamingJson, repairJson } from "../src/utils/json-parse.js";
import { getOverflowPatterns, isContextOverflow } from "../src/utils/overflow.js";
import { StringEnum } from "../src/utils/typebox-helpers.js";
import { validateToolArguments, validateToolCall } from "../src/utils/validation.js";

function usage(): AssistantMessage["usage"] {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

describe("diagnostics", () => {
	it("formatThrownValue handles errors, strings, and other values", () => {
		expect(formatThrownValue(new Error("boom"))).toBe("boom");
		// An error with an empty message falls back to its name.
		const named = new Error("");
		named.name = "WeirdError";
		expect(formatThrownValue(named)).toBe("WeirdError");
		expect(formatThrownValue("plain string")).toBe("plain string");
		expect(formatThrownValue(42)).toBe("42");
		expect(formatThrownValue({ a: 1 })).toBe("[object Object]");
	});

	it("extractDiagnosticError describes thrown non-errors", () => {
		expect(extractDiagnosticError("oops")).toEqual({ name: "ThrownValue", message: "oops" });
		expect(extractDiagnosticError(123)).toEqual({ name: "ThrownValue", message: "123" });
	});

	it("extractDiagnosticError keeps name, message, stack and string/number codes", () => {
		const stringCodeError = Object.assign(new Error("string code"), { code: "ENOENT" });
		const stringResult = extractDiagnosticError(stringCodeError);
		expect(stringResult.name).toBe("Error");
		expect(stringResult.message).toBe("string code");
		expect(stringResult.stack).toBeDefined();
		expect(stringResult.code).toBe("ENOENT");

		const numberCodeError = Object.assign(new Error("number code"), { code: 500 });
		expect(extractDiagnosticError(numberCodeError).code).toBe(500);
	});

	it("extractDiagnosticError drops non-string/number codes and empty messages", () => {
		const objectCodeError = Object.assign(new Error(""), { code: { nested: true } });
		objectCodeError.name = "CodeError";
		const result = extractDiagnosticError(objectCodeError);
		// Empty message falls back to the error name; object codes are discarded.
		expect(result.message).toBe("CodeError");
		expect(result.code).toBeUndefined();
	});

	it("createAssistantMessageDiagnostic and appendAssistantMessageDiagnostic build a diagnostics list", () => {
		const diagnostic = createAssistantMessageDiagnostic("provider_error", new Error("bad"), { attempt: 1 });
		expect(diagnostic.type).toBe("provider_error");
		expect(diagnostic.timestamp).toBeGreaterThan(0);
		expect(diagnostic.error?.message).toBe("bad");
		expect(diagnostic.details).toEqual({ attempt: 1 });

		const message: { diagnostics?: ReturnType<typeof createAssistantMessageDiagnostic>[] } = {};
		appendAssistantMessageDiagnostic(message, diagnostic);
		expect(message.diagnostics).toEqual([diagnostic]);

		const second = createAssistantMessageDiagnostic("retry", "recovered");
		appendAssistantMessageDiagnostic(message, second);
		expect(message.diagnostics).toEqual([diagnostic, second]);
	});
});

describe("EventStream", () => {
	it("delivers queued events and resolves the final result", async () => {
		const s = new EventStream<{ value: number; final?: boolean }, number>(
			(event) => event.final === true,
			(event) => event.value,
		);
		s.push({ value: 1 });
		s.push({ value: 2, final: true });
		s.push({ value: 3 }); // ignored after done

		const collected: number[] = [];
		for await (const event of s) {
			collected.push(event.value);
		}
		expect(collected).toEqual([1, 2]);
		await expect(s.result()).resolves.toBe(2);
	});

	it("delivers events to a consumer waiting ahead of the producer", async () => {
		const s = new EventStream<{ value: number; final?: boolean }, number>(
			(event) => event.final === true,
			(event) => event.value,
		);

		const iterator = s[Symbol.asyncIterator]();
		const firstPromise = iterator.next();
		s.push({ value: 10 });
		const first = await firstPromise;
		expect(first).toEqual({ value: { value: 10 }, done: false });

		const secondPromise = iterator.next();
		s.end();
		const second = await secondPromise;
		expect(second.done).toBe(true);
	});

	it("end() resolves the final result and wakes waiting consumers", async () => {
		const s = new EventStream<number, string>(
			() => false,
			() => "never",
		);
		const iterator = s[Symbol.asyncIterator]();
		const pending = iterator.next();
		s.end("ended-result");
		expect((await pending).done).toBe(true);
		await expect(s.result()).resolves.toBe("ended-result");
	});

	it("AssistantMessageEventStream resolves on done and on error events", async () => {
		const doneStream = createAssistantMessageEventStream();
		const doneMessage: AssistantMessage = {
			role: "assistant",
			content: [],
			api: "faux",
			provider: "faux",
			model: "faux-1",
			usage: usage(),
			stopReason: "stop",
			timestamp: 1,
		};
		doneStream.push({ type: "done", reason: "stop", message: doneMessage });
		doneStream.end();
		await expect(doneStream.result()).resolves.toBe(doneMessage);

		const errorStream = new AssistantMessageEventStream();
		const errorMessage: AssistantMessage = { ...doneMessage, stopReason: "error", errorMessage: "bad" };
		errorStream.push({ type: "error", reason: "error", error: errorMessage });
		errorStream.end();
		await expect(errorStream.result()).resolves.toBe(errorMessage);
	});
});

describe("json-parse", () => {
	it("repairJson leaves valid JSON untouched", () => {
		const valid = '{"a":1,"b":"text"}';
		expect(repairJson(valid)).toBe(valid);
	});

	it("repairJson escapes raw control characters inside strings", () => {
		const withControls = '{"a":"line1\nline2\ttabbed"}';
		const repaired = repairJson(withControls);
		expect(repaired).toBe('{"a":"line1\\nline2\\ttabbed"}');
		expect(JSON.parse(repaired)).toEqual({ a: "line1\nline2\ttabbed" });
	});

	it("repairJson escapes every named control character and arbitrary control points", () => {
		const raw = `{"k":"a\bb\fc\rde"}`;
		const repaired = repairJson(raw);
		expect(repaired).toBe('{"k":"a\\bb\\fc\\rd\\u0001e"}');
		expect(JSON.parse(repaired)).toEqual({ k: "a\bb\fc\rde" });
	});

	it("repairJson doubles backslashes before invalid escape characters", () => {
		// `\x` is not a valid JSON escape, so the backslash must be doubled.
		const raw = '{"path":"a\\xb"}';
		const repaired = repairJson(raw);
		expect(repaired).toBe('{"path":"a\\\\xb"}');
		expect(JSON.parse(repaired)).toEqual({ path: "a\\xb" });
	});

	it("repairJson keeps valid escapes including unicode escapes", () => {
		const raw = '{"s":"tab\\tquote\\"slash\\/unicode\\u0041"}';
		expect(repairJson(raw)).toBe(raw);
		expect(JSON.parse(repairJson(raw))).toEqual({ s: 'tab\tquote"slash/unicodeA' });
	});

	it("repairJson handles a malformed unicode escape and a trailing backslash", () => {
		// \uZZZZ has no valid 4-hex digits; `u` is still a recognized escape
		// char so the sequence is emitted as-is rather than fully repaired.
		const badUnicode = '{"s":"\\uZZZZ"}';
		expect(repairJson(badUnicode)).toBe('{"s":"\\uZZZZ"}');

		// A backslash with no following character is doubled to a literal pair.
		const trailingBackslash = '{"s":"ends with backslash\\';
		const repaired = repairJson(trailingBackslash);
		expect(repaired.endsWith("\\\\")).toBe(true);
	});

	it("parseJsonWithRepair parses directly when valid and via repair when not", () => {
		expect(parseJsonWithRepair('{"x":1}')).toEqual({ x: 1 });
		expect(parseJsonWithRepair('{"x":"a\nb"}')).toEqual({ x: "a\nb" });
	});

	it("parseJsonWithRepair rethrows when repair does not change the input", () => {
		// `not json` has no string literals to repair, so repairJson returns it
		// unchanged and the original SyntaxError is rethrown.
		expect(() => parseJsonWithRepair("not json")).toThrow(SyntaxError);
	});

	it("parseStreamingJson returns an empty object for empty or whitespace input", () => {
		expect(parseStreamingJson("")).toEqual({});
		expect(parseStreamingJson("   ")).toEqual({});
		expect(parseStreamingJson(undefined)).toEqual({});
	});

	it("parseStreamingJson parses complete JSON", () => {
		expect(parseStreamingJson('{"done":true}')).toEqual({ done: true });
	});

	it("parseStreamingJson completes truncated JSON via partial parsing", () => {
		expect(parseStreamingJson('{"path":"README.md","content":"hel')).toEqual({
			path: "README.md",
			content: "hel",
		});
		expect(parseStreamingJson('{"items":[1,2,3')).toEqual({ items: [1, 2, 3] });
	});

	it("parseStreamingJson returns {} when a truncated JSON string contains a raw control character", () => {
		// JSON.parse rejects the raw newline. jsonrepair + partial-json cannot
		// reliably recover a *truncated* string that also contains an unescaped
		// control character, so parseStreamingJson falls back to {}.
		const partialWithControl = '{"text":"line1\nline2 continues';
		expect(parseStreamingJson(partialWithControl)).toEqual({});
	});

	it("parseStreamingJson returns an empty object when nothing can be parsed", () => {
		expect(parseStreamingJson("@@@not@@@parseable@@@")).toEqual({});
	});
});

describe("overflow detection", () => {
	it("getOverflowPatterns returns a fresh copy of the pattern list", () => {
		const first = getOverflowPatterns();
		const second = getOverflowPatterns();
		expect(first).not.toBe(second);
		expect(first.length).toBe(second.length);
		expect(first.every((p) => p instanceof RegExp)).toBe(true);
	});

	it("detects error-message overflow across provider phrasings", () => {
		const phrasings = [
			"prompt is too long: 213462 tokens > 200000 maximum",
			'413 {"error":{"type":"request_too_large"}}',
			"Your input exceeds the context window of this model",
			"The input token count (1196265) exceeds the maximum number of tokens allowed",
			"This model's maximum prompt length is 131072 but the request contains 537812 tokens",
			"Please reduce the length of the messages or completion",
			"This endpoint's maximum context length is 8000 tokens",
			"The input (9000 tokens) is longer than the model's context length (8000 tokens).",
			"prompt token count of 9000 exceeds the limit of 8000",
			"400 status code (no body)",
		];
		for (const errorMessage of phrasings) {
			const message: AssistantMessage = {
				role: "assistant",
				content: [],
				api: "openai-completions",
				provider: "openai",
				model: "m",
				usage: usage(),
				stopReason: "error",
				errorMessage,
				timestamp: 1,
			};
			expect(isContextOverflow(message), errorMessage).toBe(true);
		}
	});

	it("does not flag formatted Bedrock throttling errors as overflow", () => {
		// formatBedrockError rewrites raw "ThrottlingException: ..." to the
		// "Throttling error: ..." prefix that the non-overflow exclusion list
		// matches, so the substring "too many tokens" no longer triggers
		// overflow detection.
		const message: AssistantMessage = {
			role: "assistant",
			content: [],
			api: "amazon-bedrock",
			provider: "amazon-bedrock",
			model: "m",
			usage: usage(),
			stopReason: "error",
			errorMessage: "Throttling error: Too many tokens, please wait before trying again.",
			timestamp: 1,
		};
		expect(isContextOverflow(message)).toBe(false);
	});

	it("does not flag a non-overflow error message", () => {
		const message: AssistantMessage = {
			role: "assistant",
			content: [],
			api: "openai-completions",
			provider: "openai",
			model: "m",
			usage: usage(),
			stopReason: "error",
			errorMessage: "Invalid API key",
			timestamp: 1,
		};
		expect(isContextOverflow(message)).toBe(false);
	});

	it("returns false for a successful message with no context window provided", () => {
		const message: AssistantMessage = {
			role: "assistant",
			content: [],
			api: "openai-completions",
			provider: "openai",
			model: "m",
			usage: { ...usage(), input: 999999 },
			stopReason: "stop",
			timestamp: 1,
		};
		expect(isContextOverflow(message)).toBe(false);
	});

	it("detects silent overflow when input usage exceeds the context window", () => {
		const overflow: AssistantMessage = {
			role: "assistant",
			content: [],
			api: "openai-completions",
			provider: "zai",
			model: "m",
			usage: { ...usage(), input: 90000, cacheRead: 20000 },
			stopReason: "stop",
			timestamp: 1,
		};
		expect(isContextOverflow(overflow, 100000)).toBe(true);

		const withinWindow: AssistantMessage = {
			...overflow,
			usage: { ...usage(), input: 1000, cacheRead: 0 },
		};
		expect(isContextOverflow(withinWindow, 100000)).toBe(false);
	});

	it("detects length-stop overflow when truncated input fills the context window", () => {
		const lengthOverflow: AssistantMessage = {
			role: "assistant",
			content: [],
			api: "openai-completions",
			provider: "xiaomi",
			model: "m",
			usage: { ...usage(), input: 99500, output: 0 },
			stopReason: "length",
			timestamp: 1,
		};
		expect(isContextOverflow(lengthOverflow, 100000)).toBe(true);

		// Length stop but with output produced is not an overflow signal.
		const lengthWithOutput: AssistantMessage = {
			...lengthOverflow,
			usage: { ...usage(), input: 99500, output: 10 },
		};
		expect(isContextOverflow(lengthWithOutput, 100000)).toBe(false);

		// Length stop with zero output but input well under the window.
		const lengthSmallInput: AssistantMessage = {
			...lengthOverflow,
			usage: { ...usage(), input: 100, output: 0 },
		};
		expect(isContextOverflow(lengthSmallInput, 100000)).toBe(false);
	});
});

describe("typebox-helpers StringEnum", () => {
	it("builds a string enum schema with the provided values", () => {
		const schema = StringEnum(["add", "subtract"]);
		expect(schema).toMatchObject({ type: "string", enum: ["add", "subtract"] });
		expect(schema).not.toHaveProperty("description");
		expect(schema).not.toHaveProperty("default");
	});

	it("includes description and default when supplied", () => {
		const schema = StringEnum(["a", "b", "c"], { description: "pick one", default: "b" });
		expect(schema).toMatchObject({
			type: "string",
			enum: ["a", "b", "c"],
			description: "pick one",
			default: "b",
		});
	});
});

describe("validation - validateToolCall", () => {
	it("finds the tool by name and validates its arguments", () => {
		const tools: Tool[] = [
			{
				name: "echo",
				description: "Echo",
				parameters: Type.Object({ text: Type.String() }),
			},
		];
		const toolCall: ToolCall = {
			type: "toolCall",
			id: "tool-1",
			name: "echo",
			arguments: { text: "hi" },
		};
		expect(validateToolCall(tools, toolCall)).toEqual({ text: "hi" });
	});

	it("throws when the named tool is not registered", () => {
		const toolCall: ToolCall = {
			type: "toolCall",
			id: "tool-1",
			name: "missing",
			arguments: {},
		};
		expect(() => validateToolCall([], toolCall)).toThrow('Tool "missing" not found');
	});

	it("validateToolArguments throws a formatted error including the received arguments", () => {
		const tool: Tool = {
			name: "echo",
			description: "Echo",
			parameters: Type.Object({ text: Type.String() }),
		};
		// Empty arguments fail the required-property check even after
		// Value.Convert runs (there's nothing to coerce). 123 → "123" would
		// still validate, so we instead omit the required field entirely.
		const toolCall: ToolCall = {
			type: "toolCall",
			id: "tool-1",
			name: "echo",
			arguments: {} as Record<string, unknown>,
		};
		expect(() => validateToolArguments(tool, toolCall)).toThrow(/Validation failed for tool "echo"/);
		expect(() => validateToolArguments(tool, toolCall)).toThrow(/Received arguments/);
	});
});
