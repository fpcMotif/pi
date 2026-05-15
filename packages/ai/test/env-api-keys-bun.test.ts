import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// These tests exercise the bun-specific fallback path in env-api-keys.ts
// that reads /proc/self/environ when bun's process.env is empty inside a
// compiled-binary sandbox. The fallback only runs when process.versions?.bun
// is truthy, so we stub process.versions to simulate bun.

const SAVED_BUN = process.versions?.bun;

async function importEnvApiKeysModule(): Promise<typeof import("../src/env-api-keys.js")> {
	const mod = await import("../src/env-api-keys.js");
	for (let i = 0; i < 5; i++) {
		await new Promise((resolve) => setTimeout(resolve, 0));
	}
	return mod;
}

let savedEnv: NodeJS.ProcessEnv;

beforeEach(() => {
	savedEnv = { ...process.env };
});

afterEach(() => {
	// Restore env
	for (const k of Object.keys(process.env)) {
		delete process.env[k];
	}
	for (const [k, v] of Object.entries(savedEnv)) {
		if (v !== undefined) process.env[k] = v;
	}
	// Restore bun version
	if (SAVED_BUN === undefined) {
		// In a non-bun environment, delete bun
		if ((process.versions as any).bun !== undefined) {
			delete (process.versions as any).bun;
		}
	} else {
		(process.versions as any).bun = SAVED_BUN;
	}
	vi.resetModules();
});

// Mock node:fs so we can intercept readFileSync("/proc/self/environ"). The
// mocked module is shared across all tests in this file; each test sets
// fakeFs.procData to the payload it wants returned (or null to make it throw).
const fakeFs = vi.hoisted(() => ({
	procData: null as string | null,
	procThrows: false,
}));

vi.mock("node:fs", async () => {
	const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
	return {
		...actual,
		default: actual,
		readFileSync: ((path: any, encoding?: any) => {
			if (path === "/proc/self/environ") {
				if (fakeFs.procThrows) throw new Error("no /proc");
				if (fakeFs.procData !== null) return fakeFs.procData;
				throw new Error("no proc data set");
			}
			return (actual.readFileSync as any)(path, encoding);
		}) as typeof actual.readFileSync,
	};
});

describe("env-api-keys bun fallback (getProcEnv)", () => {
	beforeEach(() => {
		fakeFs.procData = null;
		fakeFs.procThrows = false;
	});

	it("returns undefined when bun is not set", async () => {
		// Default state: not bun. findEnvKeys should still return when env vars exist.
		const { findEnvKeys, getEnvApiKey } = await importEnvApiKeysModule();
		process.env.OPENAI_API_KEY = "x";
		expect(findEnvKeys("openai")).toEqual(["OPENAI_API_KEY"]);
		expect(getEnvApiKey("openai")).toBe("x");
	});

	it("skips /proc/self/environ when process.env already has entries (bun)", async () => {
		// Simulate bun
		(process.versions as any).bun = "1.0.0";
		// process.env is populated by vitest, so Object.keys(process.env).length > 0
		// thus getProcEnv returns undefined immediately.
		const { getEnvApiKey } = await importEnvApiKeysModule();
		process.env.OPENAI_API_KEY = "bun-key";
		expect(getEnvApiKey("openai")).toBe("bun-key");
	});

	it("reads from /proc/self/environ when process.env is empty (bun sandbox)", async () => {
		(process.versions as any).bun = "1.0.0";
		for (const k of Object.keys(process.env)) {
			delete process.env[k];
		}
		fakeFs.procData = ["OPENAI_API_KEY=secret-bun-key", "OTHER=value", "BROKEN_ENTRY_NO_EQUALS"].join("\0");

		const { findEnvKeys, getEnvApiKey } = await importEnvApiKeysModule();
		expect(findEnvKeys("openai")).toEqual(["OPENAI_API_KEY"]);
		expect(getEnvApiKey("openai")).toBe("secret-bun-key");
	});

	it("silently handles unreadable /proc/self/environ (bun)", async () => {
		(process.versions as any).bun = "1.0.0";
		for (const k of Object.keys(process.env)) {
			delete process.env[k];
		}
		fakeFs.procThrows = true;

		const { getEnvApiKey } = await importEnvApiKeysModule();
		expect(getEnvApiKey("openai")).toBeUndefined();
	});

	it("uses getProcEnv for vertex project / location when env is empty (bun)", async () => {
		(process.versions as any).bun = "1.0.0";
		for (const k of Object.keys(process.env)) {
			delete process.env[k];
		}
		fakeFs.procData = [
			"GOOGLE_CLOUD_PROJECT=proj",
			"GOOGLE_CLOUD_LOCATION=us-central1",
			"GOOGLE_APPLICATION_CREDENTIALS=/dev/null",
		].join("\0");

		const { getEnvApiKey } = await importEnvApiKeysModule();
		// /dev/null exists, so hasVertexAdcCredentials returns true.
		expect(getEnvApiKey("google-vertex")).toBe("<authenticated>");
	});

	it("uses getProcEnv to find AWS credentials when process.env is empty (bun)", async () => {
		(process.versions as any).bun = "1.0.0";
		for (const k of Object.keys(process.env)) {
			delete process.env[k];
		}
		fakeFs.procData = "AWS_PROFILE=default";

		const { getEnvApiKey } = await importEnvApiKeysModule();
		expect(getEnvApiKey("amazon-bedrock")).toBe("<authenticated>");
	});

	it("uses getProcEnv for AWS_ACCESS_KEY_ID + AWS_SECRET_ACCESS_KEY pair (bun)", async () => {
		(process.versions as any).bun = "1.0.0";
		for (const k of Object.keys(process.env)) {
			delete process.env[k];
		}
		fakeFs.procData = ["AWS_ACCESS_KEY_ID=AKIA", "AWS_SECRET_ACCESS_KEY=secret"].join("\0");

		const { getEnvApiKey } = await importEnvApiKeysModule();
		expect(getEnvApiKey("amazon-bedrock")).toBe("<authenticated>");
	});

	it("uses getProcEnv for AWS_BEARER_TOKEN_BEDROCK / container creds / web identity (bun)", async () => {
		(process.versions as any).bun = "1.0.0";
		for (const k of Object.keys(process.env)) {
			delete process.env[k];
		}
		fakeFs.procData = "AWS_BEARER_TOKEN_BEDROCK=token";
		const mod = await importEnvApiKeysModule();
		expect(mod.getEnvApiKey("amazon-bedrock")).toBe("<authenticated>");

		// Reset the proc cache by re-importing the module
		vi.resetModules();
		fakeFs.procData = "AWS_CONTAINER_CREDENTIALS_RELATIVE_URI=/creds";
		const mod2 = await importEnvApiKeysModule();
		expect(mod2.getEnvApiKey("amazon-bedrock")).toBe("<authenticated>");

		vi.resetModules();
		fakeFs.procData = "AWS_CONTAINER_CREDENTIALS_FULL_URI=http://x/creds";
		const mod3 = await importEnvApiKeysModule();
		expect(mod3.getEnvApiKey("amazon-bedrock")).toBe("<authenticated>");

		vi.resetModules();
		fakeFs.procData = "AWS_WEB_IDENTITY_TOKEN_FILE=/var/run/token";
		const mod4 = await importEnvApiKeysModule();
		expect(mod4.getEnvApiKey("amazon-bedrock")).toBe("<authenticated>");
	});

	it("falls back to GCLOUD_PROJECT via getProcEnv for google-vertex (bun)", async () => {
		(process.versions as any).bun = "1.0.0";
		for (const k of Object.keys(process.env)) {
			delete process.env[k];
		}
		fakeFs.procData = [
			"GCLOUD_PROJECT=fallback",
			"GOOGLE_CLOUD_LOCATION=us-central1",
			"GOOGLE_APPLICATION_CREDENTIALS=/dev/null",
		].join("\0");

		const { getEnvApiKey } = await importEnvApiKeysModule();
		expect(getEnvApiKey("google-vertex")).toBe("<authenticated>");
	});
});
