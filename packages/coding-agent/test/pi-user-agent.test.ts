import { afterEach, describe, expect, it, vi } from "vitest";
import { getPiUserAgent } from "../src/utils/pi-user-agent.js";

describe("getPiUserAgent", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("formats the user agent expected by pi.dev", () => {
		const runtime = process.versions.bun ? `bun/${process.versions.bun}` : `node/${process.version}`;
		const userAgent = getPiUserAgent("1.2.3");

		expect(userAgent).toBe(`pi/1.2.3 (${process.platform}; ${runtime}; ${process.arch})`);
		expect(userAgent).toMatch(/^pi\/[^\s()]+ \([^;()]+;\s*[^;()]+;\s*[^()]+\)$/);
	});

	it("reports a node runtime when not running under bun", () => {
		vi.stubGlobal("process", {
			...process,
			versions: { ...process.versions, bun: undefined },
			version: "v20.0.0",
			platform: "linux",
			arch: "x64",
		});

		expect(getPiUserAgent("9.9.9")).toBe("pi/9.9.9 (linux; node/v20.0.0; x64)");
	});

	it("reports a bun runtime when running under bun", () => {
		vi.stubGlobal("process", {
			...process,
			versions: { ...process.versions, bun: "1.1.0" },
			platform: "darwin",
			arch: "arm64",
		});

		expect(getPiUserAgent("9.9.9")).toBe("pi/9.9.9 (darwin; bun/1.1.0; arm64)");
	});
});
