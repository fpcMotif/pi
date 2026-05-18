import { describe, expect, it } from "vitest";
import { createEventBus } from "../src/core/event-bus.js";
import { createExtensionRuntime, loadExtensionFromFactory } from "../src/core/extensions/loader.js";
import type { ExtensionFactory } from "../src/core/extensions/types.js";

const loadInlineExtension = async (factory: ExtensionFactory) =>
	loadExtensionFromFactory(factory, process.cwd(), createEventBus(), createExtensionRuntime());

describe("extension UI capabilities", () => {
	it("records required and optional UI capability declarations", async () => {
		const extension = await loadInlineExtension((pi) => {
			pi.declareUICapabilities({ required: ["dialogs"], optional: ["editor"] });
		});

		expect(extension.uiCapabilityDeclaration).toEqual({ required: ["dialogs"], optional: ["editor"] });
	});

	it("copies declarations so callers cannot mutate loaded extension metadata", async () => {
		const required = ["dialogs"] as const;
		const optional = ["editor"] as const;
		const extension = await loadInlineExtension((pi) => {
			pi.declareUICapabilities({ required: [...required], optional: [...optional] });
		});

		expect(extension.uiCapabilityDeclaration.required).not.toBe(required);
		expect(extension.uiCapabilityDeclaration.optional).not.toBe(optional);
	});
});
