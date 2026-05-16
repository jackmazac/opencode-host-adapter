# @mazac-fox/opencode-host-adapter — agent guide

## Scope

The defensive boundary between OpenCode and every fleet plugin. Keep it narrow: validation, wrapping, telemetry, contract testing. No product logic belongs here.

Host Adapter is the most cross-cutting package in the fleet. Every plugin (`conductor`, `engram`, `concord`, `codemem`) imports it. A change here ripples everywhere — treat each PR accordingly.

## Canonical contracts

IDs, telemetry envelope, artifact references, and health reports live in `@mazac-fox/opencode-fleet-contracts`. Host Adapter re-exports them. Do **not** redefine contract shapes here — import them from the contracts package. Duplicating a shape creates silent drift when the canonical definition changes.

## What agents do here

- Extend `WrapOptions` with new opt-in options (always add as optional, never remove existing keys).
- Improve telemetry envelope coverage (new `kind` values, richer error payloads).
- Improve the `runPluginContractTests` harness (more assertion phases, better error messages for plugin authors).
- Add defensive primitives that multiple plugins are currently reimplementing (e.g., retry logic, metadata normalization at the boundary).
- Tighten tool arg validation (new `validateToolDefinition` checks, better error messages).
- Fix wrapping bugs — especially anything touching `tool.execute.before` propagation (see regression note below).

## What agents do NOT do here

- **No product logic.** No memory, no locks, no code graph, no plans, no session state. Those live in their respective plugins.
- **No silent telemetry drops.** If a telemetry emit fails, log to stderr. Never throw from a telemetry path. Never silently discard an event.
- **No default behavior changes without a migration story.** User-visible or output-shape behavior changes need an opt-in flag or major-version migration. Safety hardening that converts host crashes into structured failures may be default-on when contract tests and docs are updated.
- **No public export renames.** `wrapPlugin`, `validateToolDefinitions`, `runPluginContractTests`, `ToolFailureResult`, `WrapOptions`, `assertToolFailureResult` — every plugin imports these. Renaming without a major version bump is a breaking change.
- **No Zod in arg schemas.** We actively catch this bug in the validator (`args: z.object({...})` instead of plain object literal). Don't introduce Zod usage in Host Adapter tooling itself.
- **No network calls.** Host Adapter is a local safety layer. It writes to disk (telemetry) and reads from context. Nothing more.

## Critical invariants

### Telemetry never throws

Every telemetry emit path has its own try/catch. Errors from disk-full / permission-denied / file-too-long go to `process.stderr` and are swallowed. This rule lives in `CONTRIBUTING.md` and is enforced by code review. A broken telemetry path must never break a plugin hook.

### `legacyErrorString: true` restores pre-Wave-1 behavior

Plugins that haven't migrated to consuming `ToolFailureResult` can set `legacyErrorString: true` to get the old `❌ [plugin].toolName failed: ...` string. This opt-out must always work. Do not make `ToolFailureResult` the only path without a major version bump.

### `propagateFleetContext: true` is the default

This default enables correlation threading for all fleet plugins. If your change disrupts the flow of `correlation_id`, `tool_call_id`, or other IDs through context, gate the change behind a new flag with `false` as default before shipping.

### Tool args preserved byte-identical through fleet metadata injection

Wave 1 hotfix `eb3f323` fixed a bug where input tool args (`patchText`, `filePath`, `oldString`, `content`, etc.) were replaced by a metadata-only object during fleet context injection. The fix merges `inputArgs` before the overlay. If you touch `tool.execute.before` propagation, the three regression tests in `test/wrap.test.ts` (`apply_patch`, `edit`, `write`) must still pass.

### Runtime tool args are always validated

Wrapped tools validate every runtime `args` object against the tool's declared raw-shape schemas before `execute` runs. Invalid payloads return `ToolFailureResult` with `error.code = "E_TOOL_ARGS_INVALID"`. Do not add an opt-out; this boundary prevents handler-level crashes such as `undefined is not an object`, `r.split`, path helpers receiving `undefined`, or file writes receiving missing content.

### Cancellation signals are preserved, not invented

Host Adapter does not impose arbitrary tool execution deadlines. It preserves the public OpenCode `ctx.abort` signal and keeps `ctx.signal` as a compatibility alias for existing internal consumers. Plugin and runtime owners are responsible for cancellation policy. Plugins must observe caller-provided `ctx.abort` before long loops, daemon waits, file walks, or large archive streams.

### OpenCode ToolContext shape is preserved

OpenCode's public tool context includes `abort: AbortSignal` and `metadata(input): void`. Do not replace `ctx.metadata` with a plain metadata object, and do not hide caller cancellation behind non-public fields. When injecting fleet context, wrap `ctx.metadata()` so calls are enriched with `metadata.fleet`, and keep the original caller context unmutated. If you compose abort signals, clean up listeners in `finally` after execution completes.

### Error taxonomy is stable

Boundary failures use exported constants from `src/errors.ts`. Use `ERROR_TOOL_ARGS_INVALID` and `ERROR_TIMEOUT` in tests instead of string literals when practical. New Host Adapter error codes must be documented in the README's Error Taxonomy table and covered by either `runPluginContractTests` or focused unit tests.

### Structured failures are OpenCode ToolResults

`ToolFailureResult` must always include `output: string` mirroring `message`. OpenCode's public tool result contract is `string | { output: string; metadata?: ... }`; returning a plain structured object without `output` can crash result rendering (`undefined is not an object (evaluating 'r.split')`). Keep this covered in wrapper and contract tests.

### Hook boundary policy

Hooks must never receive less information after Host Adapter decoration than OpenCode supplied originally. If a hook injects metadata, merge it with caller-provided input/output values; never replace the entire args object with metadata-only state. Hook wrappers should catch plugin throws, emit `hook.failed`, and avoid crashing OpenCode unless the hook's public contract explicitly requires propagation.

For simple OpenCode output contracts, sanitize after plugin hooks run: string arrays keep only non-empty strings, string maps keep only string values, optional strings are removed when invalid, and required display strings fall back to their previous value. Do not let a plugin mutation leave `system`, `headers`, `env`, `context`, `enabled`, `text`, or `description` in a shape OpenCode cannot consume. Do not mutate shared `tool.execute.after` result objects; downstream plugins and the provider stream consume those exact shapes.

## Type safety rules

- **No `as` on unknown data.** Use `isRecord()` guards, `typeof` checks, and custom type predicates. Tests may use `// @ts-expect-error` to construct intentionally-malformed inputs for runtime guard testing.
- **Extend `AnyHooks` before reading new hook fields.** If you need a new field from hook input, add it to the `AnyHooks` type in `src/types.ts` first. Don't cast `input as { myField: string }`.
- **`ToolFailureResult` is constructed via validated paths, not casts.** Use `assertToolFailureResult` to narrow at runtime — don't manufacture the shape with `as ToolFailureResult`.

## Fleet position

```
OpenCode runtime
       │
       ▼
┌─────────────────────────────────────────────┐
│        @mazac-fox/opencode-host-adapter      │
│  validate → wrap → telemetry                 │
│  ← re-exports fleet-contracts               │
└───────────────┬─────────────────────────────┘
                │  wrapPlugin(Plugin, { name })
    ┌───────────┼───────────────┐
    ▼           ▼               ▼
conductor    engram    concord / codemem
```

Every plugin calls `wrapPlugin(TheirPlugin, { name: "..." })` and gets validation, structured failures, fleet context propagation, signal preservation, and telemetry for free.

## Validation before commit

```bash
# In this repo:
bun run typecheck
bun test

# Downstream smoke (changes here ripple to every plugin):
cd ~/Developer/opencode-conductor && bun run check
cd ~/Developer/engram && bun run check
cd ~/Developer/codemem && bun run verify
cd ~/Developer/opencode-fleet && bun run check
```

The downstream smoke step is not optional when you change `WrapOptions`, `ToolFailureResult`, `AnyHooks`, or the `tool.execute.before` propagation path.

## Recent regressions

**Wave 1 hotfix `eb3f323`** — input tool args were dropped during fleet metadata injection. The `tool.execute.before` hook was overlaying the entire `output.args` with a metadata object, replacing `patchText`/`filePath`/`oldString`/`content`. Fixed by merging `inputArgs` before the overlay. Three tests in `test/wrap.test.ts` explicitly cover this (`apply_patch`, `edit`, `write` tool names). If you touch the propagation path, run those tests first.

**ToolContext regression `866a361`** — Host Adapter injected cancellation as `ctx.signal` and replaced public `ctx.metadata()` with an object containing fleet metadata. OpenCode tools expect `ctx.abort` and callable `ctx.metadata(input)`. Fixed by preserving caller-provided `ctx.abort`, keeping `ctx.signal` as an alias, wrapping `ctx.metadata()` to merge `metadata.fleet`, and cleaning composed-signal listeners in `finally`. Regression tests in `test/wrap.test.ts` cover public abort preservation and metadata function preservation.

## Coordination

Changes here affect every plugin. Before shipping:

1. Expand `runPluginContractTests` or add targeted tests to cover the new behavior.
2. Run the downstream smoke commands above for at least Conductor and Engram.
3. Update the README's `WrapOptions` table, `ToolFailureResult` section, or Telemetry section as appropriate.
4. Bump `schema_version` in `@mazac-fox/opencode-fleet-contracts` ONLY if the `FleetTelemetryEnvelope` shape is breaking — additive fields do not require a bump.
5. After publishing, downstream plugins should bump their dep ranges.

## Migration policy

Host Adapter changes fall into two buckets:

- Safety hardening: catches malformed plugin/runtime behavior earlier and returns structured failures. These may be default-on when they preserve public result shapes and are covered in `runPluginContractTests`.
- Shape migrations: rename exports, alter `ToolFailureResult`, change telemetry envelope semantics, or remove compatibility flags. These require explicit migration notes and usually a major version bump.

## Links

- Canonical plan: `~/Developer/opencode-conductor/.opencode/plans/fleet-correlation.md`
- Contracts package: `~/Developer/opencode-fleet-contracts/README.md`
- Authoring rules: `CONTRIBUTING.md` (this repo)
