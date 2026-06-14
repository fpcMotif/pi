// ADR-0017 phase C.5: cover the `*OperationsLive` Layers and the
// read-failure error paths on each ported tool (`ls`, `read`, `write`).
// The existing per-tool tracer-bullet tests use stub Layers and exercise
// the handler logic; this file exercises the actual `node:fs`-backed
// implementations against a real tmpdir, plus the readdir / read /
// write error branches that map the typed FsError into the tool's typed
// failure variant.

import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import nodePath from "node:path";

import { it } from "@effect/vitest";
import { Cause, Effect, Layer } from "effect";
import { afterAll, beforeAll, describe, expect } from "vitest";

import { FsError } from "../../../effect/tools/fs-effect.js";
import { Ls, LsError, LsOperations, LsOperationsLive, lsHandler } from "../../../effect/tools/ls.js";
import { ReadError, ReadOperations, ReadOperationsLive, readHandler } from "../../../effect/tools/read.js";
import { WriteError, WriteOperations, WriteOperationsLive, writeHandler } from "../../../effect/tools/write.js";

// Stub Layers that succeed on the early checks but fail on the final
// operation — drive the `Effect.mapError(... new <Tool>Error("read-failed"
// | "write-failed"))` branches that the Live tests can't reach
// cross-platform without permission games.
const errnoLike = (msg: string | undefined): FsError => {
	const e = new FsError({ message: msg ?? "", code: "EACCES" });
	if (msg === undefined) (e as { message?: unknown }).message = undefined;
	return e;
};

const lsReaddirFailingLayer = (path: string): Layer.Layer<LsOperations> =>
	Layer.succeed(
		LsOperations,
		LsOperations.of({
			exists: () => Effect.succeed(true),
			isDirectory: () => Effect.succeed(true),
			readdir: () => Effect.fail(errnoLike(`readdir on ${path} forbidden`)),
		}),
	);

const readIsFileFailingLayer = (): Layer.Layer<ReadOperations> =>
	Layer.succeed(
		ReadOperations,
		ReadOperations.of({
			exists: () => Effect.succeed(true),
			isFile: () => Effect.fail(errnoLike("stat forbidden")),
			readTextFile: () => Effect.succeed("unused"),
		}),
	);

const writeFailingLayer = (failOn: "mkdir" | "write", useUndefinedMessage = false): Layer.Layer<WriteOperations> =>
	Layer.succeed(
		WriteOperations,
		WriteOperations.of({
			mkdirRecursive: () =>
				failOn === "mkdir" ? Effect.fail(errnoLike(useUndefinedMessage ? undefined : "EACCES mkdir")) : Effect.void,
			writeTextFile: () =>
				failOn === "write" ? Effect.fail(errnoLike(useUndefinedMessage ? undefined : "EACCES write")) : Effect.void,
		}),
	);

let workDir: string;
let nestedDir: string;
let textFile: string;
let largeFile: string;

beforeAll(() => {
	workDir = mkdtempSync(nodePath.join(tmpdir(), "pi-tools-live-"));
	nestedDir = nodePath.join(workDir, "nested");
	mkdirSync(nestedDir);
	textFile = nodePath.join(workDir, "hello.txt");
	largeFile = nodePath.join(workDir, "large.txt");
	writeFileSync(textFile, "line-1\nline-2\nline-3\n", "utf-8");
	writeFileSync(largeFile, Array.from({ length: 50 }, (_, i) => `row-${i + 1}`).join("\n"), "utf-8");
});

afterAll(() => {
	if (workDir && existsSync(workDir)) {
		rmSync(workDir, { recursive: true, force: true });
	}
});

describe("LsOperationsLive — local-filesystem implementation", () => {
	it.effect("exists / isDirectory / readdir return real values from the tmpdir", () =>
		Effect.gen(function* () {
			const ops = yield* LsOperations;
			expect(yield* ops.exists(workDir)).toBe(true);
			expect(yield* ops.exists(nodePath.join(workDir, "no-such"))).toBe(false);
			expect(yield* ops.isDirectory(workDir)).toBe(true);
			expect(yield* ops.isDirectory(textFile)).toBe(false);
			const entries = yield* ops.readdir(workDir);
			expect([...entries].sort()).toEqual(["hello.txt", "large.txt", "nested"]);
		}).pipe(Effect.provide(LsOperationsLive)),
	);

	it.effect("isDirectory error path: statSync throws ENOENT → FsError in error channel", () =>
		Effect.gen(function* () {
			const ops = yield* LsOperations;
			const exit = yield* Effect.exit(ops.isDirectory(nodePath.join(workDir, "nothing-here")));
			expect(exit._tag).toBe("Failure");
			// Must reach the typed catch (FsError) — not a defect.
			const error = exit._tag === "Failure" ? Cause.findErrorOption(exit.cause) : undefined;
			expect(error?._tag).toBe("Some");
			const e = error?._tag === "Some" ? error.value : undefined;
			expect(e).toBeInstanceOf(FsError);
			expect((e as FsError).code).toBe("ENOENT");
		}).pipe(Effect.provide(LsOperationsLive)),
	);

	it.effect("readdir error path: missing path → FsError", () =>
		Effect.gen(function* () {
			const ops = yield* LsOperations;
			const exit = yield* Effect.exit(ops.readdir(nodePath.join(workDir, "absent-dir")));
			expect(exit._tag).toBe("Failure");
		}).pipe(Effect.provide(LsOperationsLive)),
	);

	it.effect("lsHandler over Live ops returns sorted real entries", () =>
		Effect.gen(function* () {
			const result = yield* lsHandler(workDir)({});
			expect(result.path).toBe(workDir);
			expect([...result.entries]).toEqual(["hello.txt", "large.txt", "nested"]);
		}).pipe(Effect.provide(LsOperationsLive)),
	);

	// Drives lsHandler's `isDirectory` mapError → LsError(read-failed). On
	// Live ops, isDirectory only fails when stat fails; we already covered
	// the not-found path via exists=false (the not-found branch). The
	// read-failed branch from isDirectory is reachable only when stat
	// throws on an existing path (e.g., permission denied) — hard to
	// trigger cross-platform without elevated trickery. Skipping that
	// specific mapError line is documented; the corresponding branch in
	// readdir IS reachable via permission denial below.

	it.effect("Ls tool metadata is exposed for introspection", () =>
		Effect.sync(() => {
			expect(Ls.id).toBeDefined();
		}),
	);

	it.effect("lsHandler maps readdir error → LsError(read-failed)", () =>
		Effect.gen(function* () {
			const dir = nodePath.resolve("/synthetic/readdir-fails");
			const exit = yield* Effect.exit(lsHandler(dir)({}));
			expect(exit._tag).toBe("Failure");
			const error = exit._tag === "Failure" ? Cause.findErrorOption(exit.cause) : undefined;
			const e = error?._tag === "Some" ? error.value : undefined;
			expect(e).toBeInstanceOf(LsError);
			expect((e as LsError).reason).toBe("read-failed");
		}).pipe(Effect.provide(lsReaddirFailingLayer(nodePath.resolve("/synthetic/readdir-fails")))),
	);
});

describe("ReadOperationsLive — local-filesystem implementation", () => {
	it.effect("exists / isFile / readTextFile return real values", () =>
		Effect.gen(function* () {
			const ops = yield* ReadOperations;
			expect(yield* ops.exists(textFile)).toBe(true);
			expect(yield* ops.exists(nodePath.join(workDir, "missing"))).toBe(false);
			expect(yield* ops.isFile(textFile)).toBe(true);
			expect(yield* ops.isFile(workDir)).toBe(false);
			const content = yield* ops.readTextFile(textFile);
			expect(content).toBe("line-1\nline-2\nline-3\n");
		}).pipe(Effect.provide(ReadOperationsLive)),
	);

	it.effect("isFile error path: stat on missing path → FsError", () =>
		Effect.gen(function* () {
			const ops = yield* ReadOperations;
			const exit = yield* Effect.exit(ops.isFile(nodePath.join(workDir, "no-stat")));
			expect(exit._tag).toBe("Failure");
		}).pipe(Effect.provide(ReadOperationsLive)),
	);

	it.effect("readTextFile error path: missing path → FsError", () =>
		Effect.gen(function* () {
			const ops = yield* ReadOperations;
			const exit = yield* Effect.exit(ops.readTextFile(nodePath.join(workDir, "no-read")));
			expect(exit._tag).toBe("Failure");
		}).pipe(Effect.provide(ReadOperationsLive)),
	);

	it.effect("readHandler over Live ops slices a real file", () =>
		Effect.gen(function* () {
			const result = yield* readHandler(workDir)({ path: textFile, offset: 2, limit: 1 });
			expect(result.content).toBe("line-2");
			expect(result.totalLines).toBe(4);
			expect(result.truncated).toBe(true);
			expect(result.offsetApplied).toBe(2);
			expect(result.limitApplied).toBe(1);
		}).pipe(Effect.provide(ReadOperationsLive)),
	);

	it.effect("readHandler over Live ops fails with ReadError(not-found) on missing file", () =>
		Effect.gen(function* () {
			const exit = yield* Effect.exit(readHandler(workDir)({ path: nodePath.join(workDir, "ghost.txt") }));
			expect(exit._tag).toBe("Failure");
			const error = exit._tag === "Failure" ? Cause.findErrorOption(exit.cause) : undefined;
			expect(error?._tag).toBe("Some");
			const e = error?._tag === "Some" ? error.value : undefined;
			expect(e).toBeInstanceOf(ReadError);
			expect((e as ReadError).reason).toBe("not-found");
		}).pipe(Effect.provide(ReadOperationsLive)),
	);

	it.effect("readHandler over Live ops fails with ReadError(not-a-file) on a directory path", () =>
		Effect.gen(function* () {
			const exit = yield* Effect.exit(readHandler(workDir)({ path: workDir }));
			expect(exit._tag).toBe("Failure");
			const error = exit._tag === "Failure" ? Cause.findErrorOption(exit.cause) : undefined;
			const e = error?._tag === "Some" ? error.value : undefined;
			expect((e as ReadError).reason).toBe("not-a-file");
		}).pipe(Effect.provide(ReadOperationsLive)),
	);

	it.effect("readHandler maps isFile error → ReadError(read-failed)", () =>
		Effect.gen(function* () {
			const exit = yield* Effect.exit(readHandler("/cwd")({ path: nodePath.resolve("/synthetic/stat-fails") }));
			expect(exit._tag).toBe("Failure");
			const error = exit._tag === "Failure" ? Cause.findErrorOption(exit.cause) : undefined;
			const e = error?._tag === "Some" ? error.value : undefined;
			expect(e).toBeInstanceOf(ReadError);
			expect((e as ReadError).reason).toBe("read-failed");
		}).pipe(Effect.provide(readIsFileFailingLayer())),
	);
});

describe("WriteOperationsLive — local-filesystem implementation", () => {
	it.effect("mkdirRecursive creates nested directories that don't exist", () =>
		Effect.gen(function* () {
			const ops = yield* WriteOperations;
			const target = nodePath.join(workDir, "deep", "nest", "ed");
			yield* ops.mkdirRecursive(target);
			expect(existsSync(target)).toBe(true);
		}).pipe(Effect.provide(WriteOperationsLive)),
	);

	it.effect("mkdirRecursive on an existing directory is idempotent (no error)", () =>
		Effect.gen(function* () {
			const ops = yield* WriteOperations;
			yield* ops.mkdirRecursive(workDir);
			expect(existsSync(workDir)).toBe(true);
		}).pipe(Effect.provide(WriteOperationsLive)),
	);

	it.effect("mkdirRecursive error path: a path component is a file → ENOTDIR FsError", () =>
		Effect.gen(function* () {
			const ops = yield* WriteOperations;
			// hello.txt is a regular file; using it as a path component forces
			// node:fs.mkdirSync(... recursive: true) to throw ENOTDIR.
			const target = nodePath.join(textFile, "no-can-do");
			const exit = yield* Effect.exit(ops.mkdirRecursive(target));
			expect(exit._tag).toBe("Failure");
		}).pipe(Effect.provide(WriteOperationsLive)),
	);

	it.effect("writeTextFile writes a real file readable by the OS", () =>
		Effect.gen(function* () {
			const ops = yield* WriteOperations;
			const target = nodePath.join(workDir, "written.txt");
			yield* ops.writeTextFile(target, "hello from live ops");
			expect(existsSync(target)).toBe(true);
		}).pipe(Effect.provide(WriteOperationsLive)),
	);

	it.effect("writeTextFile error path: invalid path → FsError", () =>
		Effect.gen(function* () {
			const ops = yield* WriteOperations;
			// Writing under a non-existent parent dir without mkdir → fails.
			const target = nodePath.join(workDir, "no", "such", "parent", "file.txt");
			const exit = yield* Effect.exit(ops.writeTextFile(target, "x"));
			expect(exit._tag).toBe("Failure");
		}).pipe(Effect.provide(WriteOperationsLive)),
	);

	it.effect("writeHandler over Live ops writes content under cwd, mkdirs the parent first", () =>
		Effect.gen(function* () {
			const target = nodePath.join("write-handler", "sub", "out.txt");
			const result = yield* writeHandler(workDir)({ path: target, content: "🌱 live!" });
			expect(result.path).toBe(nodePath.resolve(workDir, target));
			expect(result.bytesWritten).toBe(Buffer.byteLength("🌱 live!", "utf-8"));
		}).pipe(Effect.provide(WriteOperationsLive)),
	);

	it.effect("writeHandler maps mkdir error → WriteError(mkdir-failed) with message text", () =>
		Effect.gen(function* () {
			const exit = yield* Effect.exit(writeHandler("/cwd")({ path: "a/b.txt", content: "x" }));
			expect(exit._tag).toBe("Failure");
			const error = exit._tag === "Failure" ? Cause.findErrorOption(exit.cause) : undefined;
			const e = error?._tag === "Some" ? error.value : undefined;
			expect(e).toBeInstanceOf(WriteError);
			expect((e as WriteError).reason).toBe("mkdir-failed");
			expect((e as WriteError).description).toContain("EACCES mkdir");
		}).pipe(Effect.provide(writeFailingLayer("mkdir"))),
	);

	it.effect("writeHandler maps mkdir error → WriteError(mkdir-failed) with 'unknown' when message is undefined", () =>
		Effect.gen(function* () {
			const exit = yield* Effect.exit(writeHandler("/cwd")({ path: "a/b.txt", content: "x" }));
			const error = exit._tag === "Failure" ? Cause.findErrorOption(exit.cause) : undefined;
			const e = error?._tag === "Some" ? error.value : undefined;
			// e.message ?? "unknown" branch: when message is undefined the fallback fires.
			expect((e as WriteError).description).toContain("unknown");
		}).pipe(Effect.provide(writeFailingLayer("mkdir", true))),
	);

	it.effect("writeHandler maps write error → WriteError(write-failed) with message text", () =>
		Effect.gen(function* () {
			const exit = yield* Effect.exit(writeHandler("/cwd")({ path: "a/b.txt", content: "x" }));
			const error = exit._tag === "Failure" ? Cause.findErrorOption(exit.cause) : undefined;
			const e = error?._tag === "Some" ? error.value : undefined;
			expect(e).toBeInstanceOf(WriteError);
			expect((e as WriteError).reason).toBe("write-failed");
			expect((e as WriteError).description).toContain("EACCES write");
		}).pipe(Effect.provide(writeFailingLayer("write"))),
	);

	it.effect("writeHandler maps write error → WriteError(write-failed) with 'unknown' fallback", () =>
		Effect.gen(function* () {
			const exit = yield* Effect.exit(writeHandler("/cwd")({ path: "a/b.txt", content: "x" }));
			const error = exit._tag === "Failure" ? Cause.findErrorOption(exit.cause) : undefined;
			const e = error?._tag === "Some" ? error.value : undefined;
			expect((e as WriteError).description).toContain("unknown");
		}).pipe(Effect.provide(writeFailingLayer("write", true))),
	);
});
