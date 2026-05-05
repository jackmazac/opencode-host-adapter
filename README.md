# @jackmazac/opencode-host-adapter

Defensive wrapper for [OpenCode](https://opencode.ai) plugins: validates tool definitions, wraps `tool.execute` in try/catch with structured failures, enforces per-tool timeouts, filters system-transform output, propagates fleet correlation IDs through hooks, and emits canonical NDJSON telemetry. Catches the codemem-style `n._zod.def` crash at registration with an actionable error.

## Why this layer exists

OpenCode loads plugins in the same process as its core runtime. A bad plugin crashes unrelated subsystems via OpenCode's Effect-based pipeline. This layer defends the boundary — every fleet plugin is wrapped here before OpenCode sees it, so a misbehaving plugin fails safely and leaves a structured trace instead of taking down the host.

Re-exports `@jackmazac/opencode-fleet-contracts` so plugin authors get the canonical fleet ID model, telemetry envelope, artifact references, and health report types through a single dependency.

## Install

```bash
bun add @jackmazac/opencode-host-adapter
```

## Usage

```ts
import { type Plugin, tool } from "@opencode-ai/plugin";
import { wrapPlugin } from "@jackmazac/opencode-host-adapter";

const z = tool.schema;

const MyPlugin: Plugin = async (input) => ({
  tool: {
    my_tool: tool({
      description: "Does a thing",
      args: { foo: z.string(), count: z.number().optional() },
      async execute(args, ctx) {
        return `did the thing for ${args.foo}`;
      },
    }),
  },
});

export default wrapPlugin(MyPlugin, {
  name: "my-plugin",
  propagateFleetContext: true,   // default — threads correlation IDs
  defaultTimeoutMs: 120_000,     // default — 2-minute global timeout
});
```

Fleet plugins (Conductor, Engram, etc.) use the exact same pattern:

```ts
export default wrapPlugin(ConductorPlugin, { name: "conductor" });
```

## What the wrapper does

- **Validates tool definitions at load.** Asserts `args` is a plain object literal (not a `ZodObject`), `description` is a non-empty string, and `execute` is a function. Catches `args: z.object({...})` at registration with a clear error before OpenCode introspects the malformed tool.
- **Validates runtime tool args.** Each call is checked against the declared `args` schemas before `execute` runs. Invalid payloads return `ToolFailureResult` with `error.code = "E_TOOL_ARGS_INVALID"`.
- **Catches `execute` throws and returns `ToolFailureResult`.** A thrown error returns a structured object (`ok: false`, plugin name, tool name, error detail, all correlation IDs) instead of propagating into OpenCode's Effect pipeline. Set `legacyErrorString: true` to restore the old display string while a consumer migrates.
- **Enforces per-tool timeouts via `AbortSignal`.** Default 2 minutes. The signal is passed on `ctx.signal`. A timeout emits `error.code = "E_TIMEOUT"` and `retryable = true`.
- **Propagates fleet correlation IDs.** With `propagateFleetContext: true` (default), reads IDs from `ctx.metadata.fleet`, flat snake_case metadata, or `args.metadata`. Missing `correlation_id` is generated; every call also gets a fresh `tool_call_id`. The wrapped `ctx` is shallow-copied — the caller's object is not mutated.
- **Emits canonical NDJSON telemetry** for every lifecycle event. Argument payloads are never logged; only key/type/size digests are emitted.
- **Filters bad `experimental.chat.system.transform` output.** `null`, `undefined`, and empty strings are removed from `o.system`.
- **Wraps `tool.execute.after`** so synchronous throws are swallowed to stderr instead of crashing the host.

## WrapOptions

| Option | Type | Default | Description |
|---|---|---|---|
| `name` | `string` | **required** | Plugin name used in telemetry and error messages. |
| `strict` | `boolean` | `false` | Throw instead of degrading on validation failure. |
| `telemetryPath` | `string` | `~/.local/share/opencode/log/plugin-lifecycle.jsonl` | Override telemetry destination. Also respects `OPENCODE_HOST_ADAPTER_TELEMETRY` env var. |
| `telemetryDisabled` | `boolean` | `false` | Disable telemetry entirely. Useful for tests. |
| `propagateTraceId` | `boolean` | `false` | Legacy: inject and propagate a `trace_id` through `chat.params` and `tool.execute.before`. |
| `propagateFleetContext` | `boolean` | `true` | Thread canonical fleet IDs through `context.metadata.fleet`. |
| `defaultTimeoutMs` | `number` | `120_000` | Global timeout in milliseconds per tool execution. |
| `toolTimeouts` | `Record<string, number>` | — | Per-tool overrides; take precedence over `defaultTimeoutMs`. |
| `legacyErrorString` | `boolean` | `false` | Return old `❌ [plugin].tool failed: message` string instead of `ToolFailureResult`. |

## ToolFailureResult

```ts
type ToolFailureResult = {
  ok: false;
  schema_version: 1;
  plugin: string;
  tool: string;
  message: string;                           // display-friendly
  error: { name: string; message: string; code?: string; retryable?: boolean };
  // all correlation IDs — null when not available in context
  workspace_id: string | null;
  plan_id: string | null;
  plan_slug: string | null;
  wave_id: string | null;
  agent_run_id: string | null;
  correlation_id: string | null;
  tool_call_id: string | null;
  fleet_run_id: string | null;
};
```

Use `assertToolFailureResult(value)` (exported from root) to narrow an unknown return value at runtime.

## Telemetry

Every wrapped lifecycle event emits a canonical `FleetTelemetryEnvelope` line to NDJSON at `~/.local/share/opencode/log/plugin-lifecycle.jsonl`. Override with `WrapOptions.telemetryPath` or `OPENCODE_HOST_ADAPTER_TELEMETRY`.

Envelope fields: `schema_version` (1), `ts` (ISO 8601), `kind` (`plugin.loaded | plugin.failed | plugin.validation_failed | tool.executed | tool.failed | hook.failed | trace.propagated`), `plugin`, `tool`, `durationMs`, `status` (`ok | error | timeout`), `error` (structured), and all 12 correlation IDs (`workspace_id`, `plan_id`, `plan_slug`, `wave_id`, `agent_run_id`, `correlation_id`, `tool_call_id`, `spine_seq`, `artifact_ref`, `lifecycle_object_id`, `concord_event_id`, `fleet_run_id`) — all nullable.

**Privacy**: argument payloads are never logged; `argDigest` emits only key names, type tags, and byte sizes. Telemetry never throws — every emit path swallows errors to stderr.

## Fleet contracts

Host Adapter re-exports `@jackmazac/opencode-fleet-contracts` through two shapes:

**Namespace (recommended when you already import `wrapPlugin`):**

```ts
import { wrapPlugin, fleetContracts } from "@jackmazac/opencode-host-adapter";
fleetContracts.validateTelemetryEnvelope(envelope);
const runId = fleetContracts.newAgentRunId();
```

**Subpath (flat re-export):**

```ts
import { validateTelemetryEnvelope, newAgentRunId } from "@jackmazac/opencode-host-adapter/contracts";
```

Both resolve to the same module instance (verified in `test/compat.test.ts`). The contracts package defines: branded ID types with ULID generation for all 12 correlation fields; `FleetTelemetryEnvelope`; 14 artifact reference kinds (content-addressed); `HealthReport` used by every fleet CLI. See `~/Developer/opencode-fleet-contracts/README.md` for the full API.

## Contract test harness

Drop `runPluginContractTests` into any plugin's test suite:

```ts
import { runPluginContractTests } from "@jackmazac/opencode-host-adapter/contract-test";

runPluginContractTests({
  pluginPath: import.meta.resolveSync("../src/index.ts"),
  pluginName: "my-plugin",
  stubInput: () => ({
    client: {} as never,
    project: { id: "p", worktree: "/tmp", time: { created: 1 } } as never,
    directory: "/tmp",
    worktree: "/tmp",
    experimental_workspace: { register: () => {} } as never,
    serverUrl: new URL("http://localhost"),
    $: (() => {}) as never,
  }),
  expectedTools: ["my_tool"],
  // exactTools: ["my_tool"],  // assert no extra tools exist
});
```

Asserts: module loads, default export is a function, plugin resolves hooks, all listed tools are present with well-formed definitions, canonical telemetry is emitted, and structured failures work via injected context.

## Standalone validator

For preflight scripts and CI:

```ts
import { validateToolDefinitions } from "@jackmazac/opencode-host-adapter";

const result = validateToolDefinitions(hooks.tool, "my-plugin");
if (!result.ok) {
  console.error(result.errors.join("\n"));
  process.exit(1);
}
```

`extractFleetContext(ctx)` is also exported for plugins that need to inspect or log the resolved fleet IDs before calling their own logic.

## Binaries

- `opencode-check-no-zod-import` — enforce no direct zod imports at the plugin boundary (lints plugin files for forbidden zod imports).
- `opencode-audit-zod` — audit tool arg schemas; counts resolved zod versions in a node_modules tree.

Both print actionable error messages and exit non-zero on violation, suitable for CI.

## Development

```bash
bun install
bun run typecheck
bun test    # expect 34 tests across 2 files
```

## License

MIT
