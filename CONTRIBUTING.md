# Contributing to @mazac-fox/opencode-host-adapter

This package is the defensive substrate for every other opencode plugin in this ecosystem. Changes here ripple to every consumer; treat them with the corresponding care.

## Setup

```bash
bun install
bun run typecheck && bun test
```

## Authoring rules

### No `as` casts in src/

Type assertions hide real type errors. Use type guards (`typeof`, `in`, custom predicates) and explicit narrowing instead. Tests may use `// @ts-expect-error` to construct intentionally-malformed inputs that test runtime guards.

### Telemetry must never throw

The telemetry sink in `src/telemetry.ts` swallows all errors. If you add new telemetry call sites, do not introduce paths that throw on disk full / permission denied / file too long. Telemetry failures must not break a plugin hook.

### Do not impose tool execution deadlines

Host Adapter is a boundary wrapper, not a scheduler. Preserve caller-provided `ctx.abort` / `ctx.signal`, but do not add arbitrary timeout durations for wrapped plugin tools. Runtime owners and plugin authors own cancellation policy.

### Validation errors must include the exact problem

When `validateToolDefinition` rejects a tool, the error string must:

- Name the offending plugin and tool: `[host:foo] tool "bar" ...`
- Describe what's wrong: `args is a ZodObject ... must be a plain object literal`
- Show how to fix it: `\`{ field1: z.string(), field2: z.number() }\``
- Reference the user-visible symptom: `... crashes opencode's tool registry with "undefined is not an object (evaluating 'n._zod.def')"`

This is the error message a plugin author will see at registration. Be exhaustive.

### Backward compatibility

Once published, the public surface (`wrapPlugin`, `validateToolDefinitions`, `runPluginContractTests`, `runCrossPluginIntegrationTest`) is committed. Add new optional parameters; never remove or rename existing ones without a major version bump.

## Releases

```bash
bun run typecheck
bun test
npm publish
```

After publish, downstream plugins should bump their dep ranges.

## CLI binaries

This package ships two CLIs:

- `opencode-check-no-zod-import` — lints plugin boundary files for forbidden zod imports.
- `opencode-audit-zod` — counts resolved zod versions in a node_modules tree.

Both are designed to be invoked from package.json scripts in downstream plugins. They print actionable error messages and exit non-zero on violation, suitable for CI.
