import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { delimiter, join } from "path";
import { afterEach, describe, expect, test } from "vitest";
import {
	detectInstallMethod,
	getSelfUpdateCommand,
	getSelfUpdateUnavailableInstruction,
	getUpdateInstruction,
} from "../src/config.js";

const execPathDescriptor = Object.getOwnPropertyDescriptor(process, "execPath");
const originalPath = process.env.PATH;
const originalPiPackageDir = process.env.PI_PACKAGE_DIR;
let tempDir: string | undefined;

function setExecPath(value: string): void {
	Object.defineProperty(process, "execPath", {
		value,
		configurable: true,
	});
}

afterEach(() => {
	if (execPathDescriptor) {
		Object.defineProperty(process, "execPath", execPathDescriptor);
	}
	if (originalPath === undefined) {
		delete process.env.PATH;
	} else {
		process.env.PATH = originalPath;
	}
	if (originalPiPackageDir === undefined) {
		delete process.env.PI_PACKAGE_DIR;
	} else {
		process.env.PI_PACKAGE_DIR = originalPiPackageDir;
	}
	if (tempDir) {
		chmodSync(tempDir, 0o700);
		rmSync(tempDir, { recursive: true, force: true });
		tempDir = undefined;
	}
});

function createNpmPrefixInstall(template = "pi-prefix-"): { prefix: string; packageDir: string } {
	const prefix = mkdtempSync(join(tmpdir(), template));
	const root = join(prefix, "lib", "node_modules");
	const scopeDir = join(root, "@earendil-works");
	const packageDir = join(scopeDir, "pi-coding-agent");
	mkdirSync(packageDir, { recursive: true });
	tempDir = prefix;
	process.env.PI_PACKAGE_DIR = packageDir;
	setExecPath(join(packageDir, "dist", "cli.js"));
	return { prefix, packageDir };
}

function createBunGlobalInstall(): { packageDir: string } {
	const temp = mkdtempSync(join(tmpdir(), "pi-bun-"));
	const prefix = join(temp, ".bun");
	const bunBin = join(prefix, "bin");
	const root = join(prefix, "install", "global", "node_modules");
	const scopeDir = join(root, "@earendil-works");
	const packageDir = join(scopeDir, "pi-coding-agent");
	mkdirSync(packageDir, { recursive: true });
	mkdirSync(bunBin, { recursive: true });
	writeFileSync(join(bunBin, process.platform === "win32" ? "bun.cmd" : "bun"), createFakeBunScript(bunBin));
	chmodSync(join(bunBin, process.platform === "win32" ? "bun.cmd" : "bun"), 0o755);
	tempDir = temp;
	process.env.PATH = `${bunBin}${delimiter}${originalPath ?? ""}`;
	process.env.PI_PACKAGE_DIR = packageDir;
	setExecPath(join(packageDir, "dist", "cli.js"));
	return { packageDir };
}

function createBunWindowsHomeGlobalInstall(): { packageDir: string } {
	const temp = mkdtempSync(join(tmpdir(), "pi-bun-home-"));
	const prefix = join(temp, ".bun");
	const bunBin = join(prefix, "bin");
	const root = join(temp, "node_modules");
	const scopeDir = join(root, "@earendil-works");
	const packageDir = join(scopeDir, "pi-coding-agent");
	mkdirSync(packageDir, { recursive: true });
	mkdirSync(bunBin, { recursive: true });
	writeFileSync(join(bunBin, "bun.cmd"), createFakeBunScript(bunBin));
	chmodSync(join(bunBin, "bun.cmd"), 0o755);
	tempDir = temp;
	process.env.PATH = `${bunBin}${delimiter}${originalPath ?? ""}`;
	process.env.PI_PACKAGE_DIR = packageDir;
	setExecPath(join(packageDir, "dist", "cli.js"));
	return { packageDir };
}

function createFakeBunScript(bunBin: string): string {
	if (process.platform === "win32") {
		return `@echo off\r\nif "%1"=="pm" if "%2"=="bin" if "%3"=="-g" echo ${bunBin}\r\n`;
	}
	const escapedBunBin = bunBin.replaceAll("'", "'\\''");
	return `#!/bin/sh\nif [ "$1" = "pm" ] && [ "$2" = "bin" ] && [ "$3" = "-g" ]; then\n\tprintf '%s\\n' '${escapedBunBin}'\n\texit 0\nfi\nexit 1\n`;
}

describe("detectInstallMethod", () => {
	test("does not self-update legacy pnpm install paths", () => {
		setExecPath(
			"C:\\Users\\Admin\\Documents\\pnpm-repository\\global\\5\\.pnpm\\@earendil-works+pi-coding-agent@0.67.68\\node_modules\\@earendil-works\\pi-coding-agent\\dist\\cli.js",
		);

		expect(detectInstallMethod()).toBe("unknown");
		expect(getSelfUpdateCommand("@earendil-works/pi-coding-agent")).toBeUndefined();
		expect(getUpdateInstruction("@earendil-works/pi-coding-agent")).toBe(
			"Update @earendil-works/pi-coding-agent using the package manager, wrapper, or source checkout that provides this installation.",
		);
	});

	test("does not self-update legacy yarn install paths", () => {
		setExecPath("/Users/f/.yarn/@earendil-works/pi-coding-agent/dist/cli.js");

		expect(detectInstallMethod()).toBe("unknown");
		expect(getSelfUpdateCommand("@earendil-works/pi-coding-agent")).toBeUndefined();
		expect(getUpdateInstruction("@earendil-works/pi-coding-agent")).toBe(
			"Update @earendil-works/pi-coding-agent using the package manager, wrapper, or source checkout that provides this installation.",
		);
	});

	test("does not self-update unknown wrapper installs", () => {
		setExecPath("/usr/local/bin/node");

		expect(detectInstallMethod()).toBe("unknown");
		expect(getSelfUpdateCommand("@earendil-works/pi-coding-agent")).toBeUndefined();
		expect(getUpdateInstruction("@earendil-works/pi-coding-agent")).toBe(
			"Update @earendil-works/pi-coding-agent using the package manager, wrapper, or source checkout that provides this installation.",
		);
	});

	test("does not self-update legacy npm-style installs", () => {
		createNpmPrefixInstall();

		expect(detectInstallMethod()).toBe("unknown");
		expect(getSelfUpdateCommand("@earendil-works/pi-coding-agent")).toBeUndefined();
		expect(getUpdateInstruction("@earendil-works/pi-coding-agent")).toBe(
			"Update @earendil-works/pi-coding-agent using the package manager, wrapper, or source checkout that provides this installation.",
		);
	});

	test("does not infer Windows npm custom prefixes from package paths", () => {
		const packageDir = "C:\\Users\\Admin\\npm prefix\\node_modules\\@earendil-works\\pi-coding-agent";
		process.env.PI_PACKAGE_DIR = packageDir;
		setExecPath(`${packageDir}\\dist\\cli.js`);

		expect(detectInstallMethod()).toBe("unknown");
		expect(getUpdateInstruction("@earendil-works/pi-coding-agent")).toBe(
			"Update @earendil-works/pi-coding-agent using the package manager, wrapper, or source checkout that provides this installation.",
		);
	});

	test("self-updates bun global installs from bun pm bin", () => {
		createBunGlobalInstall();

		const command = getSelfUpdateCommand("@earendil-works/pi-coding-agent");

		expect(detectInstallMethod()).toBe("bun");
		expect(command).toEqual({
			command: "bun",
			args: ["install", "-g", "@earendil-works/pi-coding-agent"],
			display: "bun install -g @earendil-works/pi-coding-agent",
		});
	});

	test("does not suggest Bun self-update commands for unmanaged Bun-shaped installs", () => {
		const temp = mkdtempSync(join(tmpdir(), "pi-unmanaged-bun-"));
		const packageDir = join(temp, "install", "global", "node_modules", "@earendil-works", "pi-coding-agent");
		mkdirSync(packageDir, { recursive: true });
		tempDir = temp;
		process.env.PI_PACKAGE_DIR = packageDir;
		setExecPath(join(packageDir, "dist", "cli.js"));

		expect(detectInstallMethod()).toBe("bun");
		expect(getSelfUpdateCommand("@earendil-works/pi-coding-agent")).toBeUndefined();
		expect(getUpdateInstruction("@earendil-works/pi-coding-agent")).toBe(
			"This installation is not managed by a global bun install. Update it with the package manager, wrapper, or source checkout that provides it.",
		);
	});

	test.skipIf(process.platform !== "win32")("self-updates bun Windows home node_modules installs", () => {
		createBunWindowsHomeGlobalInstall();

		const command = getSelfUpdateCommand("@earendil-works/pi-coding-agent");

		expect(detectInstallMethod()).toBe("bun");
		expect(command).toEqual({
			command: "bun",
			args: ["install", "-g", "@earendil-works/pi-coding-agent"],
			display: "bun install -g @earendil-works/pi-coding-agent",
		});
	});

	test("self-updates renamed bun global installs by removing the old package first", () => {
		createBunGlobalInstall();

		const command = getSelfUpdateCommand("@mariozechner/pi-coding-agent", "@new-scope/pi");

		expect(detectInstallMethod()).toBe("bun");
		expect(command).toEqual({
			command: "bun",
			args: ["install", "-g", "@new-scope/pi"],
			display: "bun uninstall -g @mariozechner/pi-coding-agent && bun install -g @new-scope/pi",
			steps: [
				{
					command: "bun",
					args: ["uninstall", "-g", "@mariozechner/pi-coding-agent"],
					display: "bun uninstall -g @mariozechner/pi-coding-agent",
				},
				{
					command: "bun",
					args: ["install", "-g", "@new-scope/pi"],
					display: "bun install -g @new-scope/pi",
				},
			],
		});
	});

	test.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
		"does not self-update legacy npm-style installs when the path is not writable",
		() => {
			const { packageDir } = createNpmPrefixInstall();
			chmodSync(packageDir, 0o500);

			expect(getSelfUpdateCommand("@earendil-works/pi-coding-agent")).toBeUndefined();
			expect(getSelfUpdateUnavailableInstruction("@earendil-works/pi-coding-agent")).toBe(
				"Update @earendil-works/pi-coding-agent using the package manager, wrapper, or source checkout that provides this installation.",
			);
		},
	);
});
