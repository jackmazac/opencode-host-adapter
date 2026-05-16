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
} from "@mazac-fox/opencode-fleet-contracts";
import { argDigest, emit, errorPayload } from "./telemetry.ts";
import { validateToolArgs } from "./tool-args.ts";
import type { AnyHooks, FleetContextSource, ToolFailureResult, WrapOptions } from "./types.ts";
import { fail, validateToolDefinition } from "./validate.ts";

type WrappedTool = {
  description: string;
  args: Record<string, unknown>;
  execute: (args: unknown, context: unknown) => Promise<unknown>;
};

type OpenCodePassthrough = { sessionID?: string; callID?: string };

type ExecutionOutcome = { kind: "ok"; value: unknown } | { kind: "error"; error: unknown };

const TRACE_KEY = "trace_id";

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
    installOutputShapeGuards(wrappedHooks);

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

export function extractFleetContextFromUnknown(...values: unknown[]): FleetContext {
  const raw: Record<string, unknown> = {};
  for (const value of values) collectFleetContextFields(raw, value);
  const decoded = decodeFleetContext(raw);
  if (!decoded.ok) return emptyFleetContext();
  if (!hasFleetContextValue(decoded.value)) return emptyFleetContext();
  return decoded.value;
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

  const wrappedExecute = async (args: unknown, context: unknown): Promise<unknown> => {
    const start = performance.now();
    const opencode = readOpenCodePassthrough(context);
    const traceId = readTraceId(context);
    const toolCallId = newToolCallId();
    const fleet = prepareToolFleetContext(context, args, toolCallId);

    const validatedArgs = validateToolArgs(toolName, def.args, args);
    if (!validatedArgs.ok) {
      const telemetryError = errorPayload(validatedArgs.error);
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

    const executeContext = withExecutionContext(
      context,
      opts.propagateFleetContext === false ? undefined : fleet.context,
    );
    let outcome: ExecutionOutcome;
    try {
      outcome = await runOriginalExecute(
        originalExecute,
        validatedArgs.value,
        executeContext.value,
      );
    } finally {
      executeContext.cleanup();
    }
    if (outcome.kind === "error") {
      const telemetryError = errorPayload(outcome.error);
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

async function runOriginalExecute(
  execute: (...args: unknown[]) => unknown,
  args: unknown,
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
    output: message,
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
    spine_seq: context.spine_seq,
    artifact_ref: context.artifact_ref,
    lifecycle_object_id: context.lifecycle_object_id,
    concord_event_id: context.concord_event_id,
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
    sanitizeStringArrayField(o, "system");
  };
}

function installOutputShapeGuards(wrappedHooks: AnyHooks): void {
  const chatParams = wrappedHooks["chat.params"];
  if (chatParams) {
    wrappedHooks["chat.params"] = async (i, o) => {
      await chatParams(i, o);
      if (!isRecord(o.options)) o.options = {};
    };
  }

  const chatHeaders = wrappedHooks["chat.headers"];
  if (chatHeaders) {
    wrappedHooks["chat.headers"] = async (i, o) => {
      await chatHeaders(i, o);
      if (isRecord(o)) sanitizeStringRecordField(o, "headers");
    };
  }

  const shellEnv = wrappedHooks["shell.env"];
  if (shellEnv) {
    wrappedHooks["shell.env"] = async (i, o) => {
      await shellEnv(i, o);
      if (isRecord(o)) sanitizeStringRecordField(o, "env");
    };
  }

  const compacting = wrappedHooks["experimental.session.compacting"];
  if (compacting) {
    wrappedHooks["experimental.session.compacting"] = async (i, o) => {
      await compacting(i, o);
      if (isRecord(o)) {
        sanitizeStringArrayField(o, "context");
        sanitizeOptionalStringField(o, "prompt");
      }
    };
  }

  const autocontinue = wrappedHooks["experimental.compaction.autocontinue"];
  if (autocontinue) {
    wrappedHooks["experimental.compaction.autocontinue"] = async (i, o) => {
      const previous = isRecord(o) && typeof o.enabled === "boolean" ? o.enabled : true;
      await autocontinue(i, o);
      if (isRecord(o)) sanitizeBooleanField(o, "enabled", previous);
    };
  }

  const textComplete = wrappedHooks["experimental.text.complete"];
  if (textComplete) {
    wrappedHooks["experimental.text.complete"] = async (i, o) => {
      const previous = isRecord(o) && typeof o.text === "string" ? o.text : "";
      await textComplete(i, o);
      if (isRecord(o)) sanitizeStringField(o, "text", previous);
    };
  }

  const toolDefinition = wrappedHooks["tool.definition"];
  if (toolDefinition) {
    wrappedHooks["tool.definition"] = async (i, o) => {
      const previous = isRecord(o) && typeof o.description === "string" ? o.description : "";
      await toolDefinition(i, o);
      if (isRecord(o)) sanitizeStringField(o, "description", previous);
    };
  }
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
    // Merge the real input args (from the hook's `input` parameter) with any
    // caller-provided output overrides so neither set is dropped.
    // o.args is the output side — often `{}` in OpenCode's default hook call.
    // i.args (when present) carries the actual tool input (patchText, filePath, etc.).
    // If both are absent, fleet metadata is still injected as {metadata:{fleet:...}}.
    const baseArgs = mergeToolExecuteBeforeHookArgs(i.args, o.args);
    const fleet = prepareToolFleetContext(
      { metadata: readMetadataCandidate(baseArgs) },
      baseArgs,
      toolCallId,
    );
    o.args = withFleetMetadata(baseArgs, fleet.context);
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
    if (!isRecord(o.options)) o.options = {};
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
  fleet: FleetContext | undefined,
): WrappedExecutionContext {
  const composed = composeAbortSignal(context);
  const signalFields = composed.signal
    ? { abort: composed.signal, signal: composed.signal }
    : undefined;
  let value: unknown;
  if (!isRecord(context)) {
    value = fleet
      ? { metadata: { fleet: fleetContextToJson(fleet) }, ...signalFields }
      : { ...signalFields };
    return { value, cleanup: composed.cleanup };
  }
  if (!fleet) return { value: { ...context, ...signalFields }, cleanup: composed.cleanup };
  value = {
    ...context,
    ...signalFields,
    metadata: mergeExecutionMetadata(context.metadata, fleet),
  };
  return { value, cleanup: composed.cleanup };
}

type WrappedExecutionContext = { value: unknown; cleanup: () => void };

type ComposedAbortSignal = { signal: AbortSignal | undefined; cleanup: () => void };

function composeAbortSignal(context: unknown): ComposedAbortSignal {
  const signals: AbortSignal[] = [];
  const addSignal = (signal: unknown): void => {
    if (signal instanceof AbortSignal && !signals.includes(signal)) signals.push(signal);
  };
  if (isRecord(context)) {
    addSignal(context.abort);
    addSignal(context.signal);
  }

  if (signals.length === 0) return { signal: undefined, cleanup: () => {} };
  if (signals.length === 1) return { signal: signals[0], cleanup: () => {} };

  const controller = new AbortController();
  const listeners: Array<{ source: AbortSignal; listener: () => void }> = [];
  const abortFrom = (source: AbortSignal): void => {
    if (!controller.signal.aborted) controller.abort(source.reason);
  };

  for (const source of signals) {
    if (source.aborted) {
      abortFrom(source);
      continue;
    }
    const listener = () => abortFrom(source);
    listeners.push({ source, listener });
    source.addEventListener("abort", listener, { once: true });
  }

  return {
    signal: controller.signal,
    cleanup: () => {
      for (const entry of listeners) entry.source.removeEventListener("abort", entry.listener);
    },
  };
}

type MetadataReporter = (input: unknown) => unknown;

function mergeExecutionMetadata(metadata: unknown, fleet: FleetContext): unknown {
  if (isMetadataReporter(metadata)) return wrapMetadataReporter(metadata, fleet);
  return mergeMetadataFleet(metadata, fleet);
}

function isMetadataReporter(value: unknown): value is MetadataReporter {
  return typeof value === "function";
}

function wrapMetadataReporter(reporter: MetadataReporter, fleet: FleetContext): MetadataReporter {
  const fleetJson = fleetContextToJson(fleet);
  const wrapped: MetadataReporter = (input: unknown) => {
    if (!isRecord(input)) return reporter(input);
    const inputMetadata = input.metadata;
    if (!isRecord(inputMetadata)) {
      return reporter({ ...input, metadata: { fleet: fleetJson } });
    }
    const currentFleet = isRecord(inputMetadata.fleet) ? inputMetadata.fleet : {};
    return reporter({
      ...input,
      metadata: { ...inputMetadata, fleet: { ...currentFleet, ...fleetJson } },
    });
  };
  Object.defineProperty(wrapped, "fleet", {
    value: fleetJson,
    enumerable: true,
    configurable: true,
  });
  return wrapped;
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

function collectFleetContextFields(target: Record<string, unknown>, value: unknown): void {
  if (!isRecord(value)) return;
  copyFleetContextFields(target, value);
  const metadata = readMetadataCandidate(value);
  if (isRecord(metadata)) copyFleetContextFields(target, metadata);
  const fleet = readFleetCandidate(value) ?? readFleetCandidate(metadata);
  if (isRecord(fleet)) copyFleetContextFields(target, fleet);
  const properties = value.properties;
  if (isRecord(properties)) collectFleetContextFields(target, properties);
}

function copyFleetContextFields(
  target: Record<string, unknown>,
  source: Record<string, unknown>,
): void {
  for (const key of [
    "workspace_id",
    "workspaceId",
    "plan_id",
    "planId",
    "plan_slug",
    "planSlug",
    "wave_id",
    "waveId",
    "agent_run_id",
    "agentRunId",
    "correlation_id",
    "correlationId",
    "tool_call_id",
    "toolCallId",
    "spine_seq",
    "spineSeq",
    "artifact_ref",
    "artifactRef",
    "lifecycle_object_id",
    "lifecycleObjectId",
    "concord_event_id",
    "concordEventId",
    "fleet_run_id",
    "fleetRunId",
  ]) {
    const value = source[key];
    if (value !== undefined) target[key] = value;
  }
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

function newTraceId(): string {
  return `trc_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

function sanitizeStringField(
  record: Record<string, unknown>,
  field: string,
  fallback: string,
): void {
  if (typeof record[field] !== "string") record[field] = fallback;
}

function sanitizeOptionalStringField(record: Record<string, unknown>, field: string): void {
  const value = record[field];
  if (value !== undefined && typeof value !== "string") delete record[field];
}

function sanitizeBooleanField(
  record: Record<string, unknown>,
  field: string,
  fallback: boolean,
): void {
  if (typeof record[field] !== "boolean") record[field] = fallback;
}

function sanitizeStringArrayField(record: Record<string, unknown>, field: string): void {
  const value = record[field];
  record[field] = Array.isArray(value)
    ? value.filter((entry) => typeof entry === "string" && entry.length > 0)
    : [];
}

function sanitizeStringRecordField(record: Record<string, unknown>, field: string): void {
  const value = record[field];
  if (!isRecord(value)) {
    record[field] = {};
    return;
  }
  const clean: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === "string") clean[key] = entry;
  }
  record[field] = clean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/**
 * Same merge semantics as {@link installFleetHookPropagation}: tool arguments may appear on
 * the hook input, the hook output, or both; output keys win on overlap.
 */
export function mergeToolExecuteBeforeHookArgs(
  inputHookArgs: unknown,
  outputHookArgs: unknown,
): Record<string, unknown> {
  const inputArgs = isRecord(inputHookArgs) ? inputHookArgs : undefined;
  const outputArgs = isRecord(outputHookArgs) ? outputHookArgs : undefined;
  return inputArgs && outputArgs
    ? { ...inputArgs, ...outputArgs }
    : (inputArgs ?? outputArgs ?? {});
}
