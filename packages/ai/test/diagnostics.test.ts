import { describe, expect, it, vi } from "vitest";
import {
	appendAssistantMessageDiagnostic,
	createAssistantMessageDiagnostic,
	extractDiagnosticError,
	formatThrownValue,
} from "../src/utils/diagnostics.js";

describe("diagnostics helpers", () => {
	it("formats thrown values and appends diagnostics without losing existing entries", () => {
		vi.setSystemTime(123);
		const codedError = Object.assign(new Error("coded"), { code: "E_CODED" });
		const first = createAssistantMessageDiagnostic("coded", codedError, { phase: "test" });
		const second = createAssistantMessageDiagnostic("plain", "string failure");
		const target = { diagnostics: [first] };

		appendAssistantMessageDiagnostic(target, second);

		expect(formatThrownValue(new Error(""))).toBe("Error");
		expect(formatThrownValue("plain string")).toBe("plain string");
		expect(formatThrownValue(42)).toBe("42");
		expect(extractDiagnosticError("plain failure")).toEqual({
			name: "ThrownValue",
			message: "plain failure",
		});
		expect(first).toMatchObject({
			type: "coded",
			timestamp: 123,
			details: { phase: "test" },
			error: { name: "Error", message: "coded", code: "E_CODED" },
		});
		expect(target.diagnostics).toEqual([first, second]);
	});

	it("falls back across sparse Error fields and initializes missing diagnostic arrays", () => {
		const anonymous = new Error("");
		anonymous.name = "";
		const numericCode = Object.assign(new Error("numeric"), { code: 429 });
		const opaqueCode = Object.assign(new Error("opaque"), { code: { nested: true } });
		const target: { diagnostics?: ReturnType<typeof createAssistantMessageDiagnostic>[] } = {};
		const diagnostic = createAssistantMessageDiagnostic("numeric", numericCode);

		appendAssistantMessageDiagnostic(target, diagnostic);

		expect(extractDiagnosticError(anonymous)).toMatchObject({ message: "" });
		expect(extractDiagnosticError(numericCode)).toMatchObject({ message: "numeric", code: 429 });
		expect(extractDiagnosticError(opaqueCode)).toMatchObject({ message: "opaque", code: undefined });
		expect(target.diagnostics).toEqual([diagnostic]);
	});
});
