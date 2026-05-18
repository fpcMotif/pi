// ADR-0017 phase C.7: i18n.ts is mostly a translation-table data file
// plus a single `setTranslations(translations)` call at module init.
// Importing the module executes that call; mocking mini-lit avoids
// needing a real i18n runtime.
import { describe, expect, it, vi } from "vitest";

const { setTranslationsMock } = vi.hoisted(() => ({ setTranslationsMock: vi.fn() }));
vi.mock("@mariozechner/mini-lit", () => ({
	defaultEnglish: {},
	defaultGerman: {},
	setTranslations: setTranslationsMock,
}));
vi.mock("@mariozechner/mini-lit/dist/i18n.js", () => ({}));

import { translations } from "../src/utils/i18n.js";

describe("i18n module init", () => {
	it("exposes a translations object with at least 'en' and 'de' locales", () => {
		expect(typeof translations).toBe("object");
		expect(translations).toHaveProperty("en");
		expect(translations).toHaveProperty("de");
	});

	it("English locale contains expected canonical strings", () => {
		expect(translations.en.Cancel).toBe("Cancel");
		expect(translations.en.Confirm).toBe("Confirm");
		expect(translations.en.Save).toBe("Save");
	});

	it("German locale contains expected canonical strings", () => {
		expect(translations.de.Cancel).toBe("Abbrechen");
		expect(translations.de.Confirm).toBe("Bestätigen");
		expect(translations.de.Save).toBe("Speichern");
	});

	it("setTranslations was invoked at module load", () => {
		// Module-level side effect: `setTranslations(translations)` runs on import.
		expect(setTranslationsMock).toHaveBeenCalledWith(translations);
	});
});
