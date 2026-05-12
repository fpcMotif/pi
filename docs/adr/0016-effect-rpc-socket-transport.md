# RPC mode: `effect/unstable/rpc` with a Socket transport

The `pi rpc` mode is rewritten on `effect/unstable/rpc` and its wire transport changes from **JSONL over stdin/stdout** to **Effect's `Socket` transport** — Unix domain socket on POSIX, named pipe on Windows. Each Rpc verb (`Send`, `Continue`, `Retry`, `Cancel`, `ListSlashCommands`, `OpenSettings`, `ExtensionUIRequest`, ...) is a typed `Rpc` with request / success / error / event Schemas declared via `effect/Schema`. Server handlers are Effects sharing the same `ManagedRuntime` as the interactive mode (ADR-0008). Event streams from `Session.send` (ADR-0009) are surfaced through `Rpc.stream`. Cancellation is structural — interrupting the per-request Fiber via socket close, no more correlation-id-based cancel-by-search.

The transport break is deliberate: 1.0 is already breaking, the JSONL-over-stdio framing was tied to a single-client embedding model, and Socket cleanly supports long-lived headless-daemon use cases, multiple concurrent clients, and bidirectional streaming. Existing consumers of pi-rpc JSONL stdio migrate to the new transport during the 1.0 transition. HTTP / WebSocket / Worker transports are explicitly **not** added in this ADR — they can layer on later if browser-attach or worker-embed becomes a real product requirement.

The previous `rpc-client.ts` (515 LOC for tests + ad-hoc debugging) is replaced by `RpcClient.make({ transport })` exported through `@earendil-works/pi-agent-core/test-support` (ADR-0015), and a `pi rpc-call` CLI subcommand for interactive debugging.

Rejected: keeping the JSONL-over-stdio wire (option 18A) — comfortable but leaves the rewrite carrying ~1.6 KLOC of custom dispatch/framing/correlation that effect-rpc already provides; and HTTP-only transport — fine for browser attach but worse than Socket for the dominant headless-embedding use case.

## Consequences

- Existing JSONL-over-stdio consumers (IDE plugins, automation supervisors) break at 1.0 and must migrate. Migration guide ships with the 1.0 release notes.
- Default socket path: platform-conventional (e.g., `$XDG_RUNTIME_DIR/pi/<session>.sock` on Linux, `\\.\pipe\pi-<session>` on Windows). Configurable via `pi rpc --socket <path>`.
- Server lifecycle: `pi rpc` blocks; SIGINT triggers `ManagedRuntime.dispose()` which closes the socket and finalizes scopes.
- The extension-UI request/response routing survives as typed `Rpc`s on the same Socket channel — extensions can still drive client UI through RPC.
- A reference client implementation lives in `test-support`; not a separately published library.

## Status

accepted
