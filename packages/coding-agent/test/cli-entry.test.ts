import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The CLI entry modules run side effects at import time (set process.title,
// configure undici, invoke main()). We mock those side-effecting dependencies
// so importing the module exercises the entry code without launching the agent.

describe("src/cli.ts entry point", () => {
	const main = vi.fn();
	const setGlobalDispatcher = vi.fn();
	let titleBefore: string;
	let envBefore: string | undefined;

	beforeEach(() => {
		vi.resetModules();
		main.mockReset();
		setGlobalDispatcher.mockReset();
		titleBefore = process.title;
		envBefore = process.env.PI_CODING_AGENT;
	});

	afterEach(() => {
		process.title = titleBefore;
		if (envBefore === undefined) {
			delete process.env.PI_CODING_AGENT;
		} else {
			process.env.PI_CODING_AGENT = envBefore;
		}
		vi.doUnmock("../src/main.js");
		vi.doUnmock("undici");
	});

	it("configures the process and invokes main with the CLI args", async () => {
		vi.doMock("../src/main.js", () => ({ main }));
		vi.doMock("undici", () => ({
			EnvHttpProxyAgent: class {
				constructor(public opts: unknown) {}
			},
			setGlobalDispatcher,
		}));

		await import("../src/cli.js");

		expect(process.title).toBe("pi");
		expect(process.env.PI_CODING_AGENT).toBe("true");
		expect(setGlobalDispatcher).toHaveBeenCalledTimes(1);
		expect(main).toHaveBeenCalledTimes(1);
		expect(main).toHaveBeenCalledWith(process.argv.slice(2));
	});
});

describe("src/bun/cli.ts entry point", () => {
	const restoreSandboxEnv = vi.fn();
	const cliImported = vi.fn();
	let titleBefore: string;

	beforeEach(() => {
		vi.resetModules();
		restoreSandboxEnv.mockReset();
		cliImported.mockReset();
		titleBefore = process.title;
	});

	afterEach(() => {
		process.title = titleBefore;
		vi.doUnmock("../src/bun/restore-sandbox-env.js");
		vi.doUnmock("../src/cli.js");
	});

	it("restores the sandbox env then loads the CLI", async () => {
		vi.doMock("../src/bun/restore-sandbox-env.js", () => ({ restoreSandboxEnv }));
		vi.doMock("../src/cli.js", () => {
			cliImported();
			return {};
		});

		await import("../src/bun/cli.js");

		expect(process.title).toBe("pi");
		expect(restoreSandboxEnv).toHaveBeenCalledTimes(1);
		expect(cliImported).toHaveBeenCalledTimes(1);
	});
});
