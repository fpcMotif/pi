/**
 * Shared subprocess runner behind the Live tool backends (`bash`, `find`,
 * `grep`).
 *
 * Each of those tools used to hand-roll the same `Effect.callback` + `spawn`
 * scaffold — stderr capture, error/close resume, ENOENT classification,
 * kill-on-interrupt — with subtly different gaps (unguarded double resumes,
 * unbounded output buffering, no process-group teardown). `spawnCollect` owns
 * that scaffold once:
 *
 * - a `settled` guard so `error`/`close` can never double-resume;
 * - bounded collection: output and stderr are rolling tails capped at
 *   `SPAWN_OUTPUT_CAP_BYTES` (~10x the display budget) with a head-loss flag.
 *   Display truncation downstream (`truncateTail`) keeps far less than the
 *   cap, so model-visible output is unchanged for runs under it; beyond it,
 *   line totals derived from the collected output undercount (accepted);
 * - full teardown: the child is spawned `detached` on POSIX so timeout /
 *   caller-kill / interrupt signal the whole process group (SIGTERM, then a
 *   SIGKILL escalation that is cleared once the child closes);
 * - optional readline line-streaming over stdout (`onLine`), with `"kill"`
 *   as the early-stop protocol for match limits;
 * - an ENOENT → `unavailable` hook so each caller maps spawn failures into
 *   its own typed error.
 *
 * Deliberately NOT built on `effect/unstable/process`: its Node spawner needs
 * `@effect/platform-node`, which is not a dependency of this package.
 */
import { Effect } from "effect";
import { spawn } from "node:child_process";
import { createInterface, type Interface } from "node:readline";

import { DEFAULT_MAX_BYTES } from "./truncate.js";

/** In-memory cap per collected stream; only the most recent tail beyond it is kept. */
export const SPAWN_OUTPUT_CAP_BYTES = DEFAULT_MAX_BYTES * 10;

/** Grace period between the SIGTERM group-kill and the SIGKILL escalation. */
const SIGKILL_ESCALATION_MS = 2000;

/** Append-only accumulator keeping at most `SPAWN_OUTPUT_CAP_BYTES` chars, dropping from the head. */
class RollingTail {
	private chunks: Array<string> = [];
	private size = 0;
	headTruncated = false;

	append(chunk: string): void {
		this.chunks.push(chunk);
		this.size += chunk.length;
		while (this.size > SPAWN_OUTPUT_CAP_BYTES) {
			const head = this.chunks[0];
			const excess = this.size - SPAWN_OUTPUT_CAP_BYTES;
			if (head.length <= excess) {
				this.chunks.shift();
				this.size -= head.length;
			} else {
				this.chunks[0] = head.slice(excess);
				this.size -= excess;
			}
			this.headTruncated = true;
		}
	}

	toString(): string {
		return this.chunks.join("");
	}
}

export interface SpawnCollectOptions<E> {
	readonly command: string;
	readonly args: ReadonlyArray<string>;
	readonly cwd?: string;
	readonly env?: NodeJS.ProcessEnv;
	/** Wall-clock timeout in ms; when it elapses the process group is killed and the outcome carries `timedOut: true`. */
	readonly timeoutMs?: number;
	/** Map a spawn-level failure to the caller's typed error; `unavailable` is true when the binary was not found (ENOENT). */
	readonly mapSpawnError: (error: Error, unavailable: boolean) => E;
	/**
	 * When set, stdout is line-streamed through readline into this callback
	 * instead of being collected into `output`. Return `"kill"` to tear the
	 * child down early (e.g. a match limit was hit); no further lines are
	 * delivered after that.
	 */
	readonly onLine?: (line: string) => void | "kill";
}

export interface SpawnCollectOutcome {
	/** Process exit code, or `null` when the process was killed by a signal. */
	readonly exitCode: number | null;
	/** Rolling tail of combined stdout+stderr in arrival order; always empty when `onLine` is set. */
	readonly output: string;
	/** Rolling tail of stderr alone. */
	readonly stderr: string;
	/** True when the helper killed the process group because `timeoutMs` elapsed. */
	readonly timedOut: boolean;
	/** True when `onLine` returned `"kill"` and the helper tore the child down. */
	readonly killedByCaller: boolean;
	/** True when `output` lost its head to the rolling cap. */
	readonly outputHeadTruncated: boolean;
}

/** Spawn `command` with full teardown and bounded collection; see the module header. */
export const spawnCollect = <E>(options: SpawnCollectOptions<E>): Effect.Effect<SpawnCollectOutcome, E> =>
	Effect.callback<SpawnCollectOutcome, E>((resume) => {
		const posix = process.platform !== "win32";
		// detached puts the child in its own process group on POSIX, so teardown
		// can signal the whole tree instead of just the direct child.
		const child = spawn(options.command, [...options.args], {
			cwd: options.cwd,
			env: options.env,
			stdio: ["ignore", "pipe", "pipe"],
			detached: posix,
		});

		const output = new RollingTail();
		const stderr = new RollingTail();
		let timedOut = false;
		let killedByCaller = false;
		let settled = false;
		let timeoutHandle: NodeJS.Timeout | undefined;
		let escalation: NodeJS.Timeout | undefined;

		const killGroup = (signal: NodeJS.Signals) => {
			if (posix && child.pid !== undefined) {
				try {
					process.kill(-child.pid, signal);
					return;
				} catch {
					// ESRCH race: the group is already gone — fall through to a direct kill.
				}
			}
			if (!child.killed) child.kill(signal);
		};
		const terminate = () => {
			killGroup("SIGTERM");
			if (escalation === undefined) {
				escalation = setTimeout(() => killGroup("SIGKILL"), SIGKILL_ESCALATION_MS);
				// Never hold the event loop open just to escalate a kill.
				escalation.unref();
			}
		};
		const clearTimers = () => {
			if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
			if (escalation !== undefined) clearTimeout(escalation);
		};

		const onLine = options.onLine;
		let rl: Interface | undefined;
		if (onLine !== undefined) {
			rl = createInterface({ input: child.stdout });
			rl.on("line", (line) => {
				if (killedByCaller) return;
				if (onLine(line) === "kill") {
					killedByCaller = true;
					terminate();
				}
			});
		} else {
			child.stdout.on("data", (chunk: Buffer) => {
				output.append(chunk.toString());
			});
		}
		child.stderr.on("data", (chunk: Buffer) => {
			const text = chunk.toString();
			stderr.append(text);
			if (onLine === undefined) output.append(text);
		});

		if (options.timeoutMs !== undefined) {
			timeoutHandle = setTimeout(() => {
				timedOut = true;
				terminate();
			}, options.timeoutMs);
		}

		child.on("error", (error: NodeJS.ErrnoException) => {
			clearTimers();
			rl?.close();
			if (settled) return;
			settled = true;
			resume(Effect.fail(options.mapSpawnError(error, error.code === "ENOENT")));
		});

		child.on("close", (code) => {
			// Timers are cleared before the settled guard: the SIGKILL escalation
			// armed by the interrupt cleanup must not outlive the child either.
			clearTimers();
			rl?.close();
			if (settled) return;
			settled = true;
			resume(
				Effect.succeed({
					exitCode: code,
					output: output.toString(),
					stderr: stderr.toString(),
					timedOut,
					killedByCaller,
					outputHeadTruncated: output.headTruncated,
				}),
			);
		});

		return Effect.sync(() => {
			if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
			rl?.close();
			terminate();
		});
	});
