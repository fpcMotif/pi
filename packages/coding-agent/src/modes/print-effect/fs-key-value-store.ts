/**
 * File-backed `KeyValueStore` for the Effect print-mode host (ADR-0020
 * decision 7). `KeyValueStore.layerFileSystem` needs platform `FileSystem` /
 * `Path` services that are not in the dependency tree (ADR-0013's
 * `@effect/platform-bun` adoption has not landed), so the host brings its own
 * string store over `node:fs` — one file per key under the given directory,
 * keys URI-encoded, writes atomic via write-then-rename (ADR-0012).
 */
import { mkdir, readdir, readFile, rename, rm, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Effect, Layer } from "effect";
import { KeyValueStore } from "effect/unstable/persistence";

const isErrnoCode = (error: unknown, code: string): boolean =>
	typeof error === "object" && error !== null && (error as NodeJS.ErrnoException).code === code;

/**
 * Keys are URI-encoded with '.' additionally escaped: encodeURIComponent
 * leaves dots bare, which would let the key ".." escape the namespace and
 * let key names collide with temp files. '%' in output is always followed
 * by two hex digits, so the "%tmp-" prefix below can never collide with an
 * encoded key.
 */
const encodeKey = (key: string): string => encodeURIComponent(key).replaceAll(".", "%2E");

let tmpCounter = 0;
const TMP_PREFIX = "%tmp-";

const tryFs = <A>(method: string, key: string | undefined, run: () => Promise<A>) =>
	Effect.tryPromise({
		try: run,
		catch: (cause) =>
			new KeyValueStore.KeyValueStoreError({
				message: String(cause),
				method,
				...(key === undefined ? {} : { key }),
				cause,
			}),
	});

export const layerFileSystemKeyValueStore = (directory: string): Layer.Layer<KeyValueStore.KeyValueStore> =>
	Layer.succeed(
		KeyValueStore.KeyValueStore,
		KeyValueStore.makeStringOnly({
			get: (key) =>
				tryFs("get", key, async () => {
					try {
						return await readFile(join(directory, encodeKey(key)), "utf8");
					} catch (error) {
						if (isErrnoCode(error, "ENOENT")) return undefined;
						throw error;
					}
				}),
			set: (key, value) =>
				tryFs("set", key, async () => {
					await mkdir(directory, { recursive: true });
					const tmp = join(directory, `${TMP_PREFIX}${process.pid}-${++tmpCounter}`);
					await writeFile(tmp, value, "utf8");
					await rename(tmp, join(directory, encodeKey(key)));
				}),
			remove: (key) =>
				tryFs("remove", key, async () => {
					try {
						await unlink(join(directory, encodeKey(key)));
					} catch (error) {
						if (!isErrnoCode(error, "ENOENT")) throw error;
					}
				}),
			clear: tryFs("clear", undefined, async () => {
				await rm(directory, { recursive: true, force: true });
			}),
			size: tryFs("size", undefined, async () => {
				try {
					const entries = await readdir(directory);
					return entries.filter((entry) => !entry.startsWith(TMP_PREFIX)).length;
				} catch (error) {
					if (isErrnoCode(error, "ENOENT")) return 0;
					throw error;
				}
			}),
		}),
	);
