import { describe, expect, it } from "vitest";
import type { SettingsManager } from "../src/core/settings-manager.js";
import { isInstallTelemetryEnabled } from "../src/core/telemetry.js";

function makeSettings(enableInstallTelemetry: boolean): SettingsManager {
	return {
		getEnableInstallTelemetry: () => enableInstallTelemetry,
	} as unknown as SettingsManager;
}

describe("isInstallTelemetryEnabled", () => {
	it("honors env=1 as truthy", () => {
		expect(isInstallTelemetryEnabled(makeSettings(false), "1")).toBe(true);
	});

	it("honors env=true as truthy", () => {
		expect(isInstallTelemetryEnabled(makeSettings(false), "true")).toBe(true);
		expect(isInstallTelemetryEnabled(makeSettings(false), "TRUE")).toBe(true);
	});

	it("honors env=yes as truthy", () => {
		expect(isInstallTelemetryEnabled(makeSettings(false), "yes")).toBe(true);
		expect(isInstallTelemetryEnabled(makeSettings(false), "YES")).toBe(true);
	});

	it("treats env=0 as falsy (not undefined)", () => {
		// "0" overrides settings to false
		expect(isInstallTelemetryEnabled(makeSettings(true), "0")).toBe(false);
	});

	it("treats other env values as falsy", () => {
		expect(isInstallTelemetryEnabled(makeSettings(true), "no")).toBe(false);
		expect(isInstallTelemetryEnabled(makeSettings(true), "false")).toBe(false);
		expect(isInstallTelemetryEnabled(makeSettings(true), "other")).toBe(false);
	});

	it("treats empty env as falsy override", () => {
		// Empty string is defined but falsy
		expect(isInstallTelemetryEnabled(makeSettings(true), "")).toBe(false);
	});

	it("uses settings when env is undefined", () => {
		expect(isInstallTelemetryEnabled(makeSettings(true), undefined)).toBe(true);
		expect(isInstallTelemetryEnabled(makeSettings(false), undefined)).toBe(false);
	});
});
