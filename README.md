# @jackmazac/opencode-host-adapter

Defensive wrapper for [OpenCode](https://opencode.ai) plugins. Catches the common authoring bugs that produce runtime crashes in opencode's tool registry, wraps tool execution so individual tool failures don't kill the host, filters bad system-transform output, and emits structured ndjson telemetry.

## Why

OpenCode loads plugins in the same process as its core runtime. A single malformed plugin can crash unrelated subsystems via opencode's Effect-based pipeline. The most common failure surfaces as:

```
TypeError: undefined is not an object (evaluating 'n._zod.def')
```

That error happens when a plugin author writes `args: z.object({...})` instead of `args: { ... }`. The host adapter catches this at registration with an actionable error message, BEFORE opencode tries to introspect the malformed tool.

## Install

```bash
bun add @jackmazac/opencode-host-adapter
# or
npm install @jackmazac/opencode-host-adapter
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

export default wrapPlugin(MyPlugin, { name: "my-plugin" });
```

## What the adapter does

1. **Validates every tool definition** before opencode sees it.
   - Asserts `args` is a plain object literal of zod schemas (not a `ZodObject`).
   - Asserts `description` is a non-empty string.
   - Asserts `execute` is a function.
   - Catches the `args: z.object({...})` bug at registration with a clear error.

2. **Wraps tool `execute` in try/catch.** A thrown error returns a structured `ToolFailureResult` object by default instead of propagating into opencode's Effect pipeline. Set `legacyErrorString: true` to restore the old `❌ [plugin].toolName failed: ...` string while a consumer migrates.

3. **Filters bad entries from `experimental.chat.system.transform` output.** `null`, `undefined`, and empty strings in `o.system` are removed.

4. **Wraps `tool.execute.after`** so synchronous throws are logged and swallowed instead of crashing the host.

5. **Emits structured ndjson telemetry** to `~/.local/share/opencode/log/plugin-lifecycle.jsonl` using the canonical `FleetTelemetryEnvelope` shape:
   - `plugin.loaded`, `plugin.failed`, `plugin.validation_failed`
   - `tool.executed`, `tool.failed`
   - `hook.failed`
   - `trace.propagated` (for legacy `trace_id` and fleet context propagation)

   Argument digests are key/type/size only; full payloads are never logged.

## Options

```ts
type WrapOptions = {
  /** Stable plugin name used in telemetry and error messages. */
  name: string;

  /** Throw instead of degrading on validation failure. Default false. */
  strict?: boolean;

  /** Override telemetry destination. Default ~/.local/share/opencode/log/plugin-lifecycle.jsonl. */
  telemetryPath?: string;

  /** Disable telemetry entirely. */
  telemetryDisabled?: boolean;

  /** Inject and propagate trace_id through chat.params and tool.execute.before. */
  propagateTraceId?: boolean;

  /** Propagate canonical fleet IDs through context.metadata.fleet. Default true. */
  propagateFleetContext?: boolean;

  /** Global wrapped tool timeout in milliseconds. Default 120_000. */
  defaultTimeoutMs?: number;

  /** Per-tool timeout overrides in milliseconds. */
  toolTimeouts?: Record<string, number>;

  /** Return legacy failure strings instead of ToolFailureResult. Default false. */
  legacyErrorString?: boolean;
};
```

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

## Contract test harness

Drop into your plugin's test suite:

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
});
```

## License

MIT

## Fleet Contracts

Host Adapter re-exports `@jackmazac/opencode-fleet-contracts` so plugin authors can get the canonical fleet ID model, telemetry envelope, artifact references, and health report types without adding a second dependency. Two import shapes:

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

Both resolve to the same module instance (verified in `test/compat.test.ts`). Namespace form avoids any future naming collision with Host Adapter's own surface.

### What the contracts package defines

- **IDs** — `workspace_id / plan_id / plan_slug / wave_id / agent_run_id / correlation_id / tool_call_id / spine_seq / artifact_ref / lifecycle_object_id / concord_event_id / fleet_run_id`. Branded types + ULID generation + legacy parsers.
- **Telemetry envelope** — single canonical shape; every fleet plugin emits the same fields through Host Adapter.
- **Artifact references** — 14 kinds, content-addressed, canonical string form `artifact:<kind>:<url-encoded path>:sha256:<hex>`.
- **Health report** — `{status: "ok"|"warn"|"fail", checks[], summary, ...}` used by every `{plugin} doctor|status|check --json` and `opencode-fleet doctor`.

See the contracts package README (`~/Developer/opencode-fleet-contracts/README.md` or the published docs) for full API.

## Wave 1: ID threading + structured failures + timeouts

Wave 1 makes Host Adapter the fleet boundary for correlation. Wrapped tool executions now read fleet IDs from `context.metadata.fleet` first, then flat snake_case metadata fields, then matching fields under `args.metadata`. If a `correlation_id` is missing, Host Adapter generates one with the contracts package; every tool execution also receives a fresh `tool_call_id`, and missing `workspace_id` is derived from the current worktree path. With `propagateFleetContext` enabled (the default), the wrapped `ctx` passed to the plugin is shallow-copied and overlaid with `ctx.metadata.fleet` so downstream code can observe the canonical IDs without mutating the caller's object.

Telemetry is now contract-valid `FleetTelemetryEnvelope` NDJSON. The sink path and `OPENCODE_HOST_ADAPTER_TELEMETRY` override are unchanged, and argument payloads are still never logged directly; only the existing key/type/size digest is emitted as an adapter-local extension.

Tool failures return `ToolFailureResult` by default: `{ ok:false, schema_version:1, plugin, tool, message, error, ...ids }`. Consumers that still assert on the old display string can temporarily pass `legacyErrorString: true`; new code should consume the structured object and display its `message` field.

Tool execution is timeout-protected. The default is `120_000` ms, configurable globally with `defaultTimeoutMs` or per tool with `toolTimeouts`. The adapter passes an `AbortSignal` on `ctx.signal`; plugins that opt in can stop early when it aborts. A timeout returns/emits `error.code = "E_TIMEOUT"` and `retryable = true`.
