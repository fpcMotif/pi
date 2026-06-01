import { describe, expect, it } from "vitest";
import {
	appendAssistantMessageDiagnostic,
	createAssistantMessageDiagnostic,
	extractDiagnosticError,
	formatThrownValue,
} from "../src/utils/diagnostics.js";

describe("formatThrownValue", () => {
	it("returns the message for an Error", () => {
		expect(formatThrownValue(new Error("boom"))).toBe("boom");
	});

	it("falls back to the Error name when the message is empty", () => {
		const error = new Error("");
		error.name = "WeirdError";
		expect(formatThrownValue(error)).toBe("WeirdError");
	});

	it("returns strings as-is", () => {
		expect(formatThrownValue("a string failure")).toBe("a string failure");
	});

	it("stringifies non-Error, non-string values", () => {
		expect(formatThrownValue(42)).toBe("42");
		expect(formatThrownValue({ code: 1 })).toBe("[object Object]");
		expect(formatThrownValue(null)).toBe("null");
	});
});

describe("extractDiagnosticError", () => {
	it("wraps non-Error thrown values as ThrownValue", () => {
		expect(extractDiagnosticError("plain failure")).toEqual({
			name: "ThrownValue",
			message: "plain failure",
		});
	});

	it("extracts name, message, stack, and a string code from an Error", () => {
		const error = new Error("disk full") as Error & { code?: unknown };
		error.code = "ENOSPC";
		const info = extractDiagnosticError(error);

		expect(info.name).toBe("Error");
		expect(info.message).toBe("disk full");
		expect(info.stack).toBe(error.stack);
		expect(info.code).toBe("ENOSPC");
	});

	it("keeps a numeric code", () => {
		const error = new Error("http failure") as Error & { code?: unknown };
		error.code = 500;
		expect(extractDiagnosticError(error).code).toBe(500);
	});

	it("drops a non-string, non-number code", () => {
		const error = new Error("weird") as Error & { code?: unknown };
		error.code = { nested: true };
		expect(extractDiagnosticError(error).code).toBeUndefined();
	});

	it("falls back to the Error name when message and name handling kick in", () => {
		const error = new Error("");
		error.name = "TimeoutError";
		const info = extractDiagnosticError(error);
		expect(info.message).toBe("TimeoutError");
		// An empty name string is normalized to undefined.
		const blankNameError = new Error("oops");
		blankNameError.name = "";
		expect(extractDiagnosticError(blankNameError).name).toBeUndefined();
	});
});

describe("createAssistantMessageDiagnostic", () => {
	it("builds a diagnostic with type, timestamp, extracted error, and details", () => {
		const error = new Error("nope");
		const before = Date.now();
		const diagnostic = createAssistantMessageDiagnostic("provider_failure", error, { attempt: 2 });
		const after = Date.now();

		expect(diagnostic.type).toBe("provider_failure");
		expect(diagnostic.timestamp).toBeGreaterThanOrEqual(before);
		expect(diagnostic.timestamp).toBeLessThanOrEqual(after);
		expect(diagnostic.error).toEqual(extractDiagnosticError(error));
		expect(diagnostic.details).toEqual({ attempt: 2 });
	});

	it("omits details when none are provided", () => {
		const diagnostic = createAssistantMessageDiagnostic("x", "bad");
		expect(diagnostic.details).toBeUndefined();
	});
});

describe("appendAssistantMessageDiagnostic", () => {
	it("initializes the diagnostics array when absent", () => {
		const target: { diagnostics?: ReturnType<typeof createAssistantMessageDiagnostic>[] } = {};
		const diagnostic = createAssistantMessageDiagnostic("first", "e1");
		appendAssistantMessageDiagnostic(target, diagnostic);
		expect(target.diagnostics).toEqual([diagnostic]);
	});

	it("appends to an existing diagnostics array immutably", () => {
		const existing = createAssistantMessageDiagnostic("first", "e1");
		const target = { diagnostics: [existing] };
		const originalArray = target.diagnostics;
		const next = createAssistantMessageDiagnostic("second", "e2");

		appendAssistantMessageDiagnostic(target, next);

		expect(target.diagnostics).toEqual([existing, next]);
		expect(target.diagnostics).not.toBe(originalArray);
	});
});
