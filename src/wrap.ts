/**
 * Plugin host adapter — wraps a Plugin to defend opencode's runtime against
 * common plugin authoring mistakes and emit structured telemetry.
 *
 * Defenses:
 *   1. Validates each tool definition before opencode sees it (catches the
 *      `args: z.object({...})` bug at registration with a clear error).
 *   2. Wraps each tool's `execute` in try/catch so thrown errors return as
 *      structured strings instead of propagating into opencode's Effect
 *      pipeline (where they can crash unrelated subsystems).
 *   3. Filters null/undefined out of `system: string[]` arrays in
 *      `experimental.chat.system.transform` outputs.
 *   4. Logs and swallows synchronous throws in `tool.execute.after`.
 *
 * Telemetry:
 *   - plugin.loaded / plugin.failed
 *   - tool.executed / tool.failed (with arg digests; never full payloads)
 *   - hook.failed (when an after-hook throws)
 *   - plugin.validation_failed (when a tool definition is rejected)
 *
 * Optional trace_id propagation (opts.propagateTraceId):
 *   - Injects a trace_id into each chat.params turn.
 *   - Mirrors trace_id into tool execution telemetry.
 *   - Lets you correlate orchestrator → subagent → tool chains.
 */

import { argDigest, emit, errorPayload } from "./telemetry.ts";
import type { AnyHooks, AnyPlugin, WrapOptions } from "./types.ts";
import { fail, validateToolDefinition } from "./validate.ts";

type WrappedTool = {
  description: string;
  args: Record<string, unknown>;
  execute: (args: Record<string, unknown>, context: unknown) => Promise<unknown>;
};

type WrappedToolContext = {
  sessionID?: string;
  callID?: string;
  metadata?: { trace_id?: string };
};

const TRACE_KEY = "trace_id";

export function wrapPlugin<I, O>(
  plugin: (input: I, options?: O) => Promise<unknown>,
  opts: WrapOptions,
): (input: I, options?: O) => Promise<AnyHooks> {
  return async (input: I, options?: O): Promise<AnyHooks> => {
    const start = performance.now();
    let hooks: AnyHooks;
    try {
      const raw = await plugin(input, options);
      hooks = (raw ?? {}) as AnyHooks;
    } catch (error) {
      emit(opts, {
        kind: "plugin.failed",
        plugin: opts.name,
        ts: Date.now(),
        durationMs: performance.now() - start,
        error: errorPayload(error),
      });
      throw error;
    }

    const validated = validateHooks(hooks, opts);
    const wrappedTools = wrapTools(validated.tool, opts);

    const wrappedHooks: AnyHooks = { ...validated };
    if (wrappedTools) wrappedHooks.tool = wrappedTools;

    if (validated["experimental.chat.system.transform"]) {
      const original = validated["experimental.chat.system.transform"];
      wrappedHooks["experimental.chat.system.transform"] = async (i, o) => {
        await original(i, o);
        if (Array.isArray(o.system)) {
          o.system = o.system.filter(
            (entry) => typeof entry === "string" && entry.length > 0,
          );
        }
      };
    }

    if (validated["tool.execute.after"]) {
      const original = validated["tool.execute.after"];
      wrappedHooks["tool.execute.after"] = async (i, o) => {
        try {
          await original(i, o);
        } catch (error) {
          emit(opts, {
            kind: "hook.failed",
            plugin: opts.name,
            hook: "tool.execute.after",
            tool: i.tool,
            sessionID: i.sessionID,
            ts: Date.now(),
            error: errorPayload(error),
          });
        }
      };
    }

    if (opts.propagateTraceId) {
      installTraceIdPropagation(validated, wrappedHooks, opts);
    }

    emit(opts, {
      kind: "plugin.loaded",
      plugin: opts.name,
      ts: Date.now(),
      durationMs: performance.now() - start,
      toolCount: wrappedTools ? Object.keys(wrappedTools).length : 0,
      hookKinds: Object.keys(validated).filter((k) => k !== "tool"),
    });

    return wrappedHooks;
  };
}

function validateHooks(hooks: unknown, opts: WrapOptions): AnyHooks {
  if (!hooks || typeof hooks !== "object") {
    fail(opts, `[host:${opts.name}] plugin returned non-object hooks: ${typeof hooks}`);
    return {};
  }
  return hooks as AnyHooks;
}

function wrapTools(
  toolMap: AnyHooks["tool"],
  opts: WrapOptions,
): Record<string, WrappedTool> | undefined {
  if (!toolMap) return undefined;
  if (typeof toolMap !== "object") {
    fail(opts, `[host:${opts.name}] hooks.tool is not an object: ${typeof toolMap}`);
    return undefined;
  }

  const out: Record<string, WrappedTool> = {};
  for (const [name, def] of Object.entries(toolMap)) {
    const result = validateToolDefinition(name, def, { name: opts.name });
    if (!result.ok) {
      fail(opts, result.error);
      emit(opts, {
        kind: "plugin.validation_failed",
        plugin: opts.name,
        ts: Date.now(),
        message: result.error,
      });
      continue;
    }
    out[name] = wrapToolExecute(name, result.resolved, opts);
  }
  return out;
}

function wrapToolExecute(
  toolName: string,
  def: { description: string; args: Record<string, unknown>; execute: (...args: unknown[]) => unknown },
  opts: WrapOptions,
): WrappedTool {
  const originalExecute = def.execute;

  const wrappedExecute = async (
    args: Record<string, unknown>,
    context: unknown,
  ): Promise<unknown> => {
    const start = performance.now();
    const ctx = (context && typeof context === "object" ? context : {}) as WrappedToolContext;
    const traceId = ctx.metadata?.trace_id;
    let result: unknown;
    try {
      result = await originalExecute(args, context);
    } catch (error) {
      const failed: Record<string, unknown> = {
        kind: "tool.failed",
        plugin: opts.name,
        tool: toolName,
        ts: Date.now(),
        durationMs: performance.now() - start,
        argDigest: argDigest(args),
        error: errorPayload(error),
      };
      if (ctx.sessionID) failed.sessionID = ctx.sessionID;
      if (ctx.callID) failed.callID = ctx.callID;
      if (traceId) failed[TRACE_KEY] = traceId;
      emit(opts, failed);
      return `❌ [${opts.name}].${toolName} failed: ${
        error instanceof Error ? error.message : String(error)
      }`;
    }

    const ok: Record<string, unknown> = {
      kind: "tool.executed",
      plugin: opts.name,
      tool: toolName,
      ts: Date.now(),
      durationMs: performance.now() - start,
      status: "ok",
      argDigest: argDigest(args),
    };
    if (ctx.sessionID) ok.sessionID = ctx.sessionID;
    if (ctx.callID) ok.callID = ctx.callID;
    if (traceId) ok[TRACE_KEY] = traceId;
    emit(opts, ok);

    return result;
  };

  return {
    description: def.description,
    args: def.args,
    execute: wrappedExecute,
  };
}

/**
 * Inject a trace_id into chat.params and propagate it through
 * tool.execute.before. Together with the per-call telemetry, this lets
 * you reconstruct an orchestrator → subagent → tool chain from the
 * lifecycle log alone.
 */
function installTraceIdPropagation(
  validated: AnyHooks,
  wrappedHooks: AnyHooks,
  opts: WrapOptions,
): void {
  const originalChatParams = validated["chat.params"];
  wrappedHooks["chat.params"] = async (i, o) => {
    if (originalChatParams) await originalChatParams(i, o);
    if (!o.options || typeof o.options !== "object") return;
    const meta = (o.options as Record<string, unknown>).metadata;
    if (!meta || typeof meta !== "object") {
      (o.options as Record<string, unknown>).metadata = { [TRACE_KEY]: newTraceId() };
      return;
    }
    const m = meta as Record<string, unknown>;
    if (!m[TRACE_KEY]) m[TRACE_KEY] = newTraceId();
  };

  const originalBefore = validated["tool.execute.before"];
  wrappedHooks["tool.execute.before"] = async (i, o) => {
    if (originalBefore) await originalBefore(i, o);
    const args = o.args as Record<string, unknown> | undefined;
    if (!args || typeof args !== "object") return;
    if (!args.metadata || typeof args.metadata !== "object") return;
    const meta = args.metadata as Record<string, unknown>;
    if (meta[TRACE_KEY]) {
      emit(opts, {
        kind: "trace.propagated",
        plugin: opts.name,
        tool: i.tool,
        sessionID: i.sessionID,
        callID: i.callID,
        ts: Date.now(),
        [TRACE_KEY]: meta[TRACE_KEY],
      });
    }
  };
}

function newTraceId(): string {
  return `trc_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}
