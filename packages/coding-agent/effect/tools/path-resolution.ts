import nodePath from "node:path";

/**
 * Resolve a tool's `path` parameter against the session's `cwd`:
 *
 * - `undefined` or `""` → `cwd` itself (the default-to-cwd contract used by
 *   `ls` / `find` / `grep`).
 * - An absolute path is returned unchanged.
 * - Anything else is resolved relative to `cwd` via `node:path` `resolve`.
 *
 * Tools whose schema makes `path` required (`read`, `write`, `edit`) still
 * pass through here cleanly because non-empty strings skip the cwd-default
 * branch and fall through to the isAbsolute/resolve dispatch the required-
 * path variant used.
 */
export const resolvePath = (cwd: string, input: string | undefined): string =>
	input === undefined || input === "" ? cwd : nodePath.isAbsolute(input) ? input : nodePath.resolve(cwd, input);
