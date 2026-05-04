/**
 * Plugin host adapter — wraps a Plugin to defend opencode's runtime against
 * common plugin authoring mistakes and emit structured telemetry.
 */

import {
  decodeFleetContext,
  emptyFleetContext,
  fleetContextToJson,
  newCorrelationId,
  newToolCallId,
  newWorkspaceId,
  type FleetContext,
  type ToolCallId,
} from "@jackmazac/opencode-fleet-contracts";
import { argDigest, emit, errorPayload } from "./telemetry.ts";
import type { AnyHooks, FleetContextSource, ToolFailureResult, WrapOptions } from "./types.ts";
import { fail, validateToolDefinition } from "./validate.ts";

type WrappedTool = {
  description: string;
  args: Record<string, unknown>;
  execute: (args: Record<string, unknown>, context: unknown) => Promise<unknown>;
};

type OpenCodePassthrough = { sessionID?: string; callID?: string };

type ExecutionOutcome =
  | { kind: "ok"; value: unknown }
  | { kind: "error"; error: unknown }
  | { kind: "timeout"; error: { name: string; message: string; code: string; retryable: boolean } };

const TRACE_KEY = "trace_id";
const DEFAULT_TIMEOUT_MS = 120_000;

export function wrapPlugin<I, O>(
  plugin: (input: I, options?: O) => Promise<unknown>,
  opts: WrapOptions,
): (input: I, options?: O) => Promise<AnyHooks> {
  return async (input: I, options?: O): Promise<AnyHooks> => {
    const start = performance.now();
    let hooks: AnyHooks;
    try {
      hooks = validateHooks(await plugin(input, options), opts);
    } catch (error) {
      emit(opts, {
        kind: "plugin.failed",
        plugin: opts.name,
        durationMs: performance.now() - start,
        error: errorPayload(error),
      });
      throw error;
    }

    const wrappedHooks: AnyHooks = { ...hooks };
    const wrappedTools = wrapTools(hooks.tool, opts);
    if (wrappedTools) wrappedHooks.tool = wrappedTools;

    installSystemTransformFilter(wrappedHooks);
    installAfterHookGuard(wrappedHooks, opts);
    if (opts.propagateFleetContext !== false) installFleetHookPropagation(wrappedHooks, opts);
    if (opts.propagateTraceId) installTraceIdPropagation(wrappedHooks, opts);

    emit(opts, {
      kind: "plugin.loaded",
      plugin: opts.name,
      durationMs: performance.now() - start,
      toolCount: wrappedTools ? Object.keys(wrappedTools).length : 0,
      hookKinds: Object.keys(hooks).filter((k) => k !== "tool"),
    });

    return wrappedHooks;
  };
}

export function extractFleetContext(
  metadata: unknown,
  args: unknown,
): { context: FleetContext; source: FleetContextSource } {
  const metadataFleet = readFleetCandidate(metadata);
  const decodedMetadataFleet = decodeCandidate(metadataFleet);
  if (decodedMetadataFleet) return { context: decodedMetadataFleet, source: "metadata" };

  const decodedMetadataFlat = decodeCandidate(metadata);
  if (decodedMetadataFlat) return { context: decodedMetadataFlat, source: "metadata" };

  const argsMetadata = readMetadataCandidate(args);
  const argsFleet = readFleetCandidate(argsMetadata);
  const decodedArgsFleet = decodeCandidate(argsFleet);
  if (decodedArgsFleet) return { context: decodedArgsFleet, source: "args" };

  const decodedArgsFlat = decodeCandidate(argsMetadata);
  if (decodedArgsFlat) return { context: decodedArgsFlat, source: "args" };

  return { context: emptyFleetContext(), source: "generated" };
}

function validateHooks(hooks: unknown, opts: WrapOptions): AnyHooks {
  if (!isRecord(hooks)) {
    fail(opts, `[host:${opts.name}] plugin returned non-object hooks: ${typeof hooks}`);
    return {};
  }
  return hooks;
}

function wrapTools(
  toolMap: AnyHooks["tool"],
  opts: WrapOptions,
): Record<string, WrappedTool> | undefined {
  if (!toolMap) return undefined;
  if (!isRecord(toolMap)) {
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
        error: { message: result.error },
      });
      continue;
    }
    out[name] = wrapToolExecute(name, result.resolved, opts);
  }
  return out;
}

function wrapToolExecute(
  toolName: string,
  def: {
    description: string;
    args: Record<string, unknown>;
    execute: (...args: unknown[]) => unknown;
  },
  opts: WrapOptions,
): WrappedTool {
  const originalExecute = def.execute;

  const wrappedExecute = async (
    args: Record<string, unknown>,
    context: unknown,
  ): Promise<unknown> => {
    const start = performance.now();
    const opencode = readOpenCodePassthrough(context);
    const traceId = readTraceId(context);
    const toolCallId = newToolCallId();
    const fleet = prepareToolFleetContext(context, args, toolCallId);
    const timeoutMs = timeoutForTool(toolName, opts);
    const controller = new AbortController();
    const executeContext = withExecutionContext(
      context,
      controller.signal,
      opts.propagateFleetContext === false ? undefined : fleet.context,
    );

    const outcome = await runWithTimeout(
      originalExecute,
      args,
      executeContext,
      timeoutMs,
      controller,
    );
    if (outcome.kind === "error" || outcome.kind === "timeout") {
      const telemetryError =
        outcome.kind === "timeout" ? outcome.error : errorPayload(outcome.error);
      emit(opts, {
        kind: "tool.failed",
        plugin: opts.name,
        tool: toolName,
        durationMs: performance.now() - start,
        argDigest: argDigest(args),
        error: telemetryError,
        opencode,
        trace_id: traceId,
        ...fleetContextToJson(fleet.context),
      });
      return failureReturn(opts, toolName, telemetryError, fleet.context);
    }

    emit(opts, {
      kind: "tool.executed",
      plugin: opts.name,
      tool: toolName,
      durationMs: performance.now() - start,
      status: "ok",
      argDigest: argDigest(args),
      opencode,
      trace_id: traceId,
      ...fleetContextToJson(fleet.context),
    });

    return outcome.value;
  };

  return {
    description: def.description,
    args: def.args,
    execute: wrappedExecute,
  };
}

async function runWithTimeout(
  execute: (...args: unknown[]) => unknown,
  args: Record<string, unknown>,
  context: unknown,
  timeoutMs: number,
  controller: AbortController,
): Promise<ExecutionOutcome> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const execution = runOriginalExecute(execute, args, context);
  const timeout = new Promise<ExecutionOutcome>((resolve) => {
    timeoutId = setTimeout(() => {
      controller.abort();
      resolve({
        kind: "timeout",
        error: {
          name: "TimeoutError",
          message: `tool execution timed out after ${timeoutMs}ms`,
          code: "E_TIMEOUT",
          retryable: true,
        },
      });
    }, timeoutMs);
  });
  try {
    return await Promise.race([execution, timeout]);
  } finally {
    if (timeoutId !== undefined) clearTimeout(timeoutId);
  }
}

async function runOriginalExecute(
  execute: (...args: unknown[]) => unknown,
  args: Record<string, unknown>,
  context: unknown,
): Promise<ExecutionOutcome> {
  try {
    return { kind: "ok", value: await execute(args, context) };
  } catch (error) {
    return { kind: "error", error };
  }
}

function failureReturn(
  opts: WrapOptions,
  toolName: string,
  telemetryError: { message: string; name?: string; code?: string; retryable?: boolean },
  context: FleetContext,
): string | ToolFailureResult {
  const message = `❌ [${opts.name}].${toolName} failed: ${telemetryError.message}`;
  if (opts.legacyErrorString === true) return message;
  const error: { name: string; message: string; code?: string; retryable?: boolean } = {
    name: telemetryError.name ?? "Error",
    message: telemetryError.message,
  };
  if (telemetryError.code !== undefined) error.code = telemetryError.code;
  if (telemetryError.retryable !== undefined) error.retryable = telemetryError.retryable;
  return {
    ok: false,
    schema_version: 1,
    plugin: opts.name,
    tool: toolName,
    message,
    error,
    workspace_id: context.workspace_id,
    plan_id: context.plan_id,
    plan_slug: context.plan_slug,
    wave_id: context.wave_id,
    agent_run_id: context.agent_run_id,
    correlation_id: context.correlation_id,
    tool_call_id: context.tool_call_id,
    fleet_run_id: context.fleet_run_id,
  };
}

function prepareToolFleetContext(
  context: unknown,
  args: unknown,
  toolCallId: ToolCallId,
): { context: FleetContext; source: FleetContextSource } {
  const metadata = isRecord(context) ? context.metadata : undefined;
  const extracted = extractFleetContext(metadata, args);
  const source: FleetContextSource = extracted.context.correlation_id
    ? extracted.source
    : "generated";
  return {
    source,
    context: {
      workspace_id: extracted.context.workspace_id ?? newWorkspaceId(process.cwd()),
      plan_id: extracted.context.plan_id,
      plan_slug: extracted.context.plan_slug,
      wave_id: extracted.context.wave_id,
      agent_run_id: extracted.context.agent_run_id,
      correlation_id: extracted.context.correlation_id ?? newCorrelationId(),
      tool_call_id: toolCallId,
      spine_seq: extracted.context.spine_seq,
      artifact_ref: extracted.context.artifact_ref,
      lifecycle_object_id: extracted.context.lifecycle_object_id,
      concord_event_id: extracted.context.concord_event_id,
      fleet_run_id: extracted.context.fleet_run_id,
    },
  };
}

function installSystemTransformFilter(wrappedHooks: AnyHooks): void {
  const original = wrappedHooks["experimental.chat.system.transform"];
  if (!original) return;
  wrappedHooks["experimental.chat.system.transform"] = async (i, o) => {
    await original(i, o);
    if (Array.isArray(o.system)) {
      o.system = o.system.filter((entry) => typeof entry === "string" && entry.length > 0);
    }
  };
}

function installAfterHookGuard(wrappedHooks: AnyHooks, opts: WrapOptions): void {
  const original = wrappedHooks["tool.execute.after"];
  if (!original) return;
  wrappedHooks["tool.execute.after"] = async (i, o) => {
    try {
      await original(i, o);
    } catch (error) {
      const extracted = extractFleetContext(undefined, i.args);
      emit(opts, {
        kind: "hook.failed",
        plugin: opts.name,
        hook: "tool.execute.after",
        tool: i.tool,
        error: errorPayload(error),
        opencode: { sessionID: i.sessionID, callID: i.callID },
        ...fleetContextToJson(extracted.context),
      });
    }
  };
}

function installFleetHookPropagation(wrappedHooks: AnyHooks, opts: WrapOptions): void {
  const originalSystem = wrappedHooks["experimental.chat.system.transform"];
  if (originalSystem) {
    wrappedHooks["experimental.chat.system.transform"] = async (i, o) => {
      await originalSystem(withHookFleetMetadata(i), o);
    };
  }

  const originalBefore = wrappedHooks["tool.execute.before"];
  if (!originalBefore) return;
  wrappedHooks["tool.execute.before"] = async (i, o) => {
    const toolCallId = newToolCallId();
    const fleet = prepareToolFleetContext(
      { metadata: readMetadataCandidate(o.args) },
      o.args,
      toolCallId,
    );
    o.args = withFleetMetadata(o.args, fleet.context);
    await originalBefore(i, o);
    emit(opts, {
      kind: "trace.propagated",
      plugin: opts.name,
      tool: i.tool,
      status: "ok",
      opencode: { sessionID: i.sessionID, callID: i.callID },
      ...fleetContextToJson(fleet.context),
    });
  };
}

function withHookFleetMetadata(input: unknown): unknown {
  const toolCallId = newToolCallId();
  const fleet = prepareToolFleetContext(input, input, toolCallId);
  return withFleetMetadata(input, fleet.context);
}

/**
 * Inject a trace_id into chat.params and propagate it through
 * tool.execute.before. Together with the per-call telemetry, this lets
 * you reconstruct an orchestrator → subagent → tool chain from the
 * lifecycle log alone.
 */
function installTraceIdPropagation(wrappedHooks: AnyHooks, opts: WrapOptions): void {
  const originalChatParams = wrappedHooks["chat.params"];
  wrappedHooks["chat.params"] = async (i, o) => {
    if (originalChatParams) await originalChatParams(i, o);
    if (!o.options) o.options = {};
    const meta = o.options.metadata;
    if (!isRecord(meta)) {
      o.options.metadata = { [TRACE_KEY]: newTraceId() };
      return;
    }
    if (!meta[TRACE_KEY]) meta[TRACE_KEY] = newTraceId();
  };

  const originalBefore = wrappedHooks["tool.execute.before"];
  wrappedHooks["tool.execute.before"] = async (i, o) => {
    if (originalBefore) await originalBefore(i, o);
    const metadata = readMetadataCandidate(o.args);
    if (!isRecord(metadata) || typeof metadata[TRACE_KEY] !== "string") return;
    emit(opts, {
      kind: "trace.propagated",
      plugin: opts.name,
      tool: i.tool,
      opencode: { sessionID: i.sessionID, callID: i.callID },
      trace_id: metadata[TRACE_KEY],
    });
  };
}

function withExecutionContext(
  context: unknown,
  signal: AbortSignal,
  fleet: FleetContext | undefined,
): unknown {
  if (!isRecord(context)) {
    if (fleet) return { metadata: { fleet: fleetContextToJson(fleet) }, signal };
    return { signal };
  }
  if (!fleet) return { ...context, signal };
  return { ...context, metadata: mergeMetadataFleet(context.metadata, fleet), signal };
}

function withFleetMetadata(value: unknown, fleet: FleetContext): unknown {
  if (!isRecord(value)) return { metadata: { fleet: fleetContextToJson(fleet) } };
  return { ...value, metadata: mergeMetadataFleet(value.metadata, fleet) };
}

function mergeMetadataFleet(metadata: unknown, fleet: FleetContext): Record<string, unknown> {
  const fleetJson = fleetContextToJson(fleet);
  if (!isRecord(metadata)) return { fleet: fleetJson };
  const currentFleet = isRecord(metadata.fleet) ? metadata.fleet : {};
  return { ...metadata, fleet: { ...currentFleet, ...fleetJson } };
}

function decodeCandidate(candidate: unknown): FleetContext | undefined {
  if (!isRecord(candidate)) return undefined;
  const decoded = decodeFleetContext(candidate);
  if (!decoded.ok) return undefined;
  if (!hasFleetContextValue(decoded.value)) return undefined;
  return decoded.value;
}

function hasFleetContextValue(context: FleetContext): boolean {
  return Object.values(fleetContextToJson(context)).some((value) => value !== null);
}

function readFleetCandidate(value: unknown): unknown {
  if (!isRecord(value)) return undefined;
  return value.fleet;
}

function readMetadataCandidate(value: unknown): unknown {
  if (!isRecord(value)) return undefined;
  return value.metadata;
}

function readOpenCodePassthrough(context: unknown): OpenCodePassthrough | undefined {
  if (!isRecord(context)) return undefined;
  const out: OpenCodePassthrough = {};
  if (typeof context.sessionID === "string") out.sessionID = context.sessionID;
  if (typeof context.callID === "string") out.callID = context.callID;
  return Object.keys(out).length > 0 ? out : undefined;
}

function readTraceId(context: unknown): string | undefined {
  if (!isRecord(context)) return undefined;
  if (!isRecord(context.metadata)) return undefined;
  return typeof context.metadata[TRACE_KEY] === "string" ? context.metadata[TRACE_KEY] : undefined;
}

function timeoutForTool(toolName: string, opts: WrapOptions): number {
  const override = opts.toolTimeouts?.[toolName];
  const configured = override ?? opts.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS;
  return Number.isFinite(configured) && configured >= 0 ? configured : DEFAULT_TIMEOUT_MS;
}

function newTraceId(): string {
  return `trc_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
