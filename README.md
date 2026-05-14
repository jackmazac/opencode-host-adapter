# @mazac-fox/opencode-host-adapter

**Defensive boundary** for OpenCode plugins: validate tool definitions and runtime args, wrap execution with structured failures and timeouts, propagate **fleet correlation** IDs, normalize hook outputs, and append canonical **NDJSON telemetry**.

Re-exports **`@mazac-fox/opencode-fleet-contracts`** (`fleetContracts` / `/contracts`).

## What it does

- `wrapPlugin(plugin, { name, ... })` — production path for fleet plugins.
- `runPluginContractTests` — loadability, tool shape, telemetry, arg validation harness.
- `validateToolDefinitions` — CI preflight without loading OpenCode.

No product logic (memory, locks, plans, graphs). Boundary options, error codes, and invariants: **`CONTRIBUTING.md`**, **`AGENTS.md`**.

## Quick start

```bash
bun add @mazac-fox/opencode-host-adapter
```

```ts
import { wrapPlugin } from "@mazac-fox/opencode-host-adapter";

export default wrapPlugin(MyPlugin, { name: "my-plugin" });
```

## Development

```bash
bun install
bun run typecheck
bun test
```

Breaking boundary behavior: extend tests first; ripple to Conductor, Engram, Codemem, Fleet as needed. **`AGENTS.md`**.

## License

MIT
