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

2. **Wraps tool `execute` in try/catch.** A thrown error returns a structured string (`❌ [plugin].toolName failed: ...`) instead of propagating into opencode's Effect pipeline.

3. **Filters bad entries from `experimental.chat.system.transform` output.** `null`, `undefined`, and empty strings in `o.system` are removed.

4. **Wraps `tool.execute.after`** so synchronous throws are logged and swallowed instead of crashing the host.

5. **Emits structured ndjson telemetry** to `~/.local/share/opencode/log/plugin-lifecycle.jsonl`:
   - `plugin.loaded` — `{ts, plugin, durationMs, toolCount, hookKinds}`
   - `plugin.failed` — `{ts, plugin, durationMs, error: {message, stack, name}}`
   - `plugin.validation_failed` — `{ts, plugin, message}`
   - `tool.executed` — `{ts, plugin, tool, durationMs, status, sessionID, callID, argDigest}`
   - `tool.failed` — same as above plus `{error: {message, stack, name}}`
   - `hook.failed` — `{ts, plugin, hook, tool, sessionID, error}`
   - `trace.propagated` — `{ts, plugin, tool, sessionID, callID, trace_id}` (only with `propagateTraceId`)

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
