import { describe, expect, it } from "vitest";
import { execCommand } from "../src/core/exec.js";

// node is guaranteed available in the test environment; we drive it with -e so
// the test is cross-platform (no reliance on shell builtins or unix tools).
const NODE = process.execPath;

describe("execCommand", () => {
	it("captures stdout, stderr and exit code of a process", async () => {
		const result = await execCommand(
			NODE,
			["-e", "process.stdout.write('out'); process.stderr.write('err'); process.exit(0)"],
			process.cwd(),
		);

		expect(result.stdout).toBe("out");
		expect(result.stderr).toBe("err");
		expect(result.code).toBe(0);
		expect(result.killed).toBe(false);
	});

	it("reports a non-zero exit code", async () => {
		const result = await execCommand(NODE, ["-e", "process.exit(3)"], process.cwd());

		expect(result.code).toBe(3);
		expect(result.killed).toBe(false);
	});

	it("resolves with code 1 when the binary cannot be spawned", async () => {
		const result = await execCommand("definitely-not-a-real-binary-xyz", [], process.cwd());

		expect(result.code).toBe(1);
		expect(result.killed).toBe(false);
	});

	it("kills a process that exceeds the timeout", async () => {
		const result = await execCommand(NODE, ["-e", "setTimeout(() => {}, 60000)"], process.cwd(), {
			timeout: 50,
		});

		expect(result.killed).toBe(true);
	});

	it("kills a process when the abort signal fires", async () => {
		const controller = new AbortController();
		const promise = execCommand(NODE, ["-e", "setTimeout(() => {}, 60000)"], process.cwd(), {
			signal: controller.signal,
		});
		setTimeout(() => controller.abort(), 20);

		const result = await promise;
		expect(result.killed).toBe(true);
	});

	it("kills immediately when the abort signal is already aborted", async () => {
		const controller = new AbortController();
		controller.abort();

		const result = await execCommand(NODE, ["-e", "setTimeout(() => {}, 60000)"], process.cwd(), {
			signal: controller.signal,
		});

		expect(result.killed).toBe(true);
	});

	it("runs the command in the requested working directory", async () => {
		const result = await execCommand(NODE, ["-e", "process.stdout.write(process.cwd())"], process.cwd());

		expect(result.stdout).toBe(process.cwd());
	});
});
