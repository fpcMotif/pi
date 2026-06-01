import { describe, expect, it } from "vitest";
import {
	formatNoApiKeyFoundMessage,
	formatNoModelSelectedMessage,
	formatNoModelsAvailableMessage,
	getProviderLoginHelp,
} from "../src/core/auth-guidance.js";

describe("auth-guidance", () => {
	it("getProviderLoginHelp returns formatted help text", () => {
		const help = getProviderLoginHelp();
		expect(help).toContain("/login");
		expect(help).toContain("providers.md");
		expect(help).toContain("models.md");
	});

	it("formatNoModelsAvailableMessage includes login help", () => {
		const msg = formatNoModelsAvailableMessage();
		expect(msg).toContain("No models available");
		expect(msg).toContain("/login");
	});

	it("formatNoModelSelectedMessage includes /model hint", () => {
		const msg = formatNoModelSelectedMessage();
		expect(msg).toContain("No model selected");
		expect(msg).toContain("/model");
	});

	it("formatNoApiKeyFoundMessage uses provider name when given", () => {
		const msg = formatNoApiKeyFoundMessage("anthropic");
		expect(msg).toContain("anthropic");
		expect(msg).not.toContain("the selected model");
	});

	it("formatNoApiKeyFoundMessage uses 'the selected model' for unknown provider", () => {
		const msg = formatNoApiKeyFoundMessage("unknown");
		expect(msg).toContain("the selected model");
	});
});
