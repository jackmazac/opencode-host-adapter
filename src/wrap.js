/**
 * Plugin host adapter — wraps a Plugin to defend opencode's runtime against
 * common plugin authoring mistakes and emit structured telemetry.
 */
import { decodeFleetContext, emptyFleetContext, fleetContextToJson, newCorrelationId, newToolCallId, newWorkspaceId, } from "@mazac-fox/opencode-fleet-contracts";
import { ERROR_TIMEOUT } from "./errors.js";
import { argDigest, emit, errorPayload } from "./telemetry.js";
import { validateToolArgs } from "./tool-args.js";
import { fail, validateToolDefinition } from "./validate.js";
const TRACE_KEY = "trace_id";
const DEFAULT_TIMEOUT_MS = 120_000;
export function wrapPlugin(plugin, opts) {
    return async (input, options) => {
        const start = performance.now();
        let hooks;
        try {
            hooks = validateHooks(await plugin(input, options), opts);
        }
        catch (error) {
            emit(opts, {
                kind: "plugin.failed",
                plugin: opts.name,
                durationMs: performance.now() - start,
                error: errorPayload(error),
            });
            throw error;
        }
        const wrappedHooks = { ...hooks };
        const wrappedTools = wrapTools(hooks.tool, opts);
        if (wrappedTools)
            wrappedHooks.tool = wrappedTools;
        installSystemTransformFilter(wrappedHooks);
        installAfterHookGuard(wrappedHooks, opts);
        if (opts.propagateFleetContext !== false)
            installFleetHookPropagation(wrappedHooks, opts);
        if (opts.propagateTraceId)
            installTraceIdPropagation(wrappedHooks, opts);
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
export function extractFleetContext(metadata, args) {
    const metadataFleet = readFleetCandidate(metadata);
    const decodedMetadataFleet = decodeCandidate(metadataFleet);
    if (decodedMetadataFleet)
        return { context: decodedMetadataFleet, source: "metadata" };
    const decodedMetadataFlat = decodeCandidate(metadata);
    if (decodedMetadataFlat)
        return { context: decodedMetadataFlat, source: "metadata" };
    const argsMetadata = readMetadataCandidate(args);
    const argsFleet = readFleetCandidate(argsMetadata);
    const decodedArgsFleet = decodeCandidate(argsFleet);
    if (decodedArgsFleet)
        return { context: decodedArgsFleet, source: "args" };
    const decodedArgsFlat = decodeCandidate(argsMetadata);
    if (decodedArgsFlat)
        return { context: decodedArgsFlat, source: "args" };
    return { context: emptyFleetContext(), source: "generated" };
}
export function extractFleetContextFromUnknown(...values) {
    const raw = {};
    for (const value of values)
        collectFleetContextFields(raw, value);
    const decoded = decodeFleetContext(raw);
    if (!decoded.ok)
        return emptyFleetContext();
    if (!hasFleetContextValue(decoded.value))
        return emptyFleetContext();
    return decoded.value;
}
function validateHooks(hooks, opts) {
    if (!isRecord(hooks)) {
        fail(opts, `[host:${opts.name}] plugin returned non-object hooks: ${typeof hooks}`);
        return {};
    }
    return hooks;
}
function wrapTools(toolMap, opts) {
    if (!toolMap)
        return undefined;
    if (!isRecord(toolMap)) {
        fail(opts, `[host:${opts.name}] hooks.tool is not an object: ${typeof toolMap}`);
        return undefined;
    }
    const out = {};
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
function wrapToolExecute(toolName, def, opts) {
    const originalExecute = def.execute;
    const wrappedExecute = async (args, context) => {
        const start = performance.now();
        const opencode = readOpenCodePassthrough(context);
        const traceId = readTraceId(context);
        const toolCallId = newToolCallId();
        const fleet = prepareToolFleetContext(context, args, toolCallId);
        const timeoutMs = timeoutForTool(toolName, opts);
        const controller = new AbortController();
        const executeContext = withExecutionContext(context, controller.signal, opts.propagateFleetContext === false ? undefined : fleet.context);
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
        const outcome = await runWithTimeout(originalExecute, validatedArgs.value, executeContext, timeoutMs, controller);
        if (outcome.kind === "error" || outcome.kind === "timeout") {
            const telemetryError = outcome.kind === "timeout" ? outcome.error : errorPayload(outcome.error);
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
async function runWithTimeout(execute, args, context, timeoutMs, controller) {
    let timeoutId;
    const execution = runOriginalExecute(execute, args, context);
    const timeout = new Promise((resolve) => {
        timeoutId = setTimeout(() => {
            controller.abort();
            resolve({
                kind: "timeout",
                error: {
                    name: "TimeoutError",
                    message: `tool execution timed out after ${timeoutMs}ms`,
                    code: ERROR_TIMEOUT,
                    retryable: true,
                },
            });
        }, timeoutMs);
    });
    try {
        return await Promise.race([execution, timeout]);
    }
    finally {
        if (timeoutId !== undefined)
            clearTimeout(timeoutId);
    }
}
async function runOriginalExecute(execute, args, context) {
    try {
        return { kind: "ok", value: await execute(args, context) };
    }
    catch (error) {
        return { kind: "error", error };
    }
}
function failureReturn(opts, toolName, telemetryError, context) {
    const message = `❌ [${opts.name}].${toolName} failed: ${telemetryError.message}`;
    if (opts.legacyErrorString === true)
        return message;
    const error = {
        name: telemetryError.name ?? "Error",
        message: telemetryError.message,
    };
    if (telemetryError.code !== undefined)
        error.code = telemetryError.code;
    if (telemetryError.retryable !== undefined)
        error.retryable = telemetryError.retryable;
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
function prepareToolFleetContext(context, args, toolCallId) {
    const metadata = isRecord(context) ? context.metadata : undefined;
    const extracted = extractFleetContext(metadata, args);
    const source = extracted.context.correlation_id
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
function installSystemTransformFilter(wrappedHooks) {
    const original = wrappedHooks["experimental.chat.system.transform"];
    if (!original)
        return;
    wrappedHooks["experimental.chat.system.transform"] = async (i, o) => {
        await original(i, o);
        sanitizeStringArrayField(o, "system");
    };
}
function installOutputShapeGuards(wrappedHooks) {
    const chatParams = wrappedHooks["chat.params"];
    if (chatParams) {
        wrappedHooks["chat.params"] = async (i, o) => {
            await chatParams(i, o);
            if (!isRecord(o.options))
                o.options = {};
        };
    }
    const chatHeaders = wrappedHooks["chat.headers"];
    if (chatHeaders) {
        wrappedHooks["chat.headers"] = async (i, o) => {
            await chatHeaders(i, o);
            if (isRecord(o))
                sanitizeStringRecordField(o, "headers");
        };
    }
    const shellEnv = wrappedHooks["shell.env"];
    if (shellEnv) {
        wrappedHooks["shell.env"] = async (i, o) => {
            await shellEnv(i, o);
            if (isRecord(o))
                sanitizeStringRecordField(o, "env");
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
            if (isRecord(o))
                sanitizeBooleanField(o, "enabled", previous);
        };
    }
    const textComplete = wrappedHooks["experimental.text.complete"];
    if (textComplete) {
        wrappedHooks["experimental.text.complete"] = async (i, o) => {
            const previous = isRecord(o) && typeof o.text === "string" ? o.text : "";
            await textComplete(i, o);
            if (isRecord(o))
                sanitizeStringField(o, "text", previous);
        };
    }
    const toolDefinition = wrappedHooks["tool.definition"];
    if (toolDefinition) {
        wrappedHooks["tool.definition"] = async (i, o) => {
            const previous = isRecord(o) && typeof o.description === "string" ? o.description : "";
            await toolDefinition(i, o);
            if (isRecord(o))
                sanitizeStringField(o, "description", previous);
        };
    }
}
function installAfterHookGuard(wrappedHooks, opts) {
    const original = wrappedHooks["tool.execute.after"];
    if (!original)
        return;
    wrappedHooks["tool.execute.after"] = async (i, o) => {
        try {
            await original(i, o);
        }
        catch (error) {
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
function installFleetHookPropagation(wrappedHooks, opts) {
    const originalSystem = wrappedHooks["experimental.chat.system.transform"];
    if (originalSystem) {
        wrappedHooks["experimental.chat.system.transform"] = async (i, o) => {
            await originalSystem(withHookFleetMetadata(i), o);
        };
    }
    const originalBefore = wrappedHooks["tool.execute.before"];
    if (!originalBefore)
        return;
    wrappedHooks["tool.execute.before"] = async (i, o) => {
        const toolCallId = newToolCallId();
        // Merge the real input args (from the hook's `input` parameter) with any
        // caller-provided output overrides so neither set is dropped.
        // o.args is the output side — often `{}` in OpenCode's default hook call.
        // i.args (when present) carries the actual tool input (patchText, filePath, etc.).
        // If both are absent, fleet metadata is still injected as {metadata:{fleet:...}}.
        const inputArgs = isRecord(i.args) ? i.args : undefined;
        const outputArgs = isRecord(o.args) ? o.args : undefined;
        const baseArgs = inputArgs && outputArgs ? { ...inputArgs, ...outputArgs } : (inputArgs ?? outputArgs ?? {});
        const fleet = prepareToolFleetContext({ metadata: readMetadataCandidate(baseArgs) }, baseArgs, toolCallId);
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
function withHookFleetMetadata(input) {
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
function installTraceIdPropagation(wrappedHooks, opts) {
    const originalChatParams = wrappedHooks["chat.params"];
    wrappedHooks["chat.params"] = async (i, o) => {
        if (originalChatParams)
            await originalChatParams(i, o);
        if (!isRecord(o.options))
            o.options = {};
        if (!o.options)
            o.options = {};
        const meta = o.options.metadata;
        if (!isRecord(meta)) {
            o.options.metadata = { [TRACE_KEY]: newTraceId() };
            return;
        }
        if (!meta[TRACE_KEY])
            meta[TRACE_KEY] = newTraceId();
    };
    const originalBefore = wrappedHooks["tool.execute.before"];
    wrappedHooks["tool.execute.before"] = async (i, o) => {
        if (originalBefore)
            await originalBefore(i, o);
        const metadata = readMetadataCandidate(o.args);
        if (!isRecord(metadata) || typeof metadata[TRACE_KEY] !== "string")
            return;
        emit(opts, {
            kind: "trace.propagated",
            plugin: opts.name,
            tool: i.tool,
            opencode: { sessionID: i.sessionID, callID: i.callID },
            trace_id: metadata[TRACE_KEY],
        });
    };
}
function withExecutionContext(context, signal, fleet) {
    if (!isRecord(context)) {
        if (fleet)
            return { metadata: { fleet: fleetContextToJson(fleet) }, signal };
        return { signal };
    }
    if (!fleet)
        return { ...context, signal };
    return { ...context, metadata: mergeMetadataFleet(context.metadata, fleet), signal };
}
function withFleetMetadata(value, fleet) {
    if (!isRecord(value))
        return { metadata: { fleet: fleetContextToJson(fleet) } };
    return { ...value, metadata: mergeMetadataFleet(value.metadata, fleet) };
}
function mergeMetadataFleet(metadata, fleet) {
    const fleetJson = fleetContextToJson(fleet);
    if (!isRecord(metadata))
        return { fleet: fleetJson };
    const currentFleet = isRecord(metadata.fleet) ? metadata.fleet : {};
    return { ...metadata, fleet: { ...currentFleet, ...fleetJson } };
}
function decodeCandidate(candidate) {
    if (!isRecord(candidate))
        return undefined;
    const decoded = decodeFleetContext(candidate);
    if (!decoded.ok)
        return undefined;
    if (!hasFleetContextValue(decoded.value))
        return undefined;
    return decoded.value;
}
function hasFleetContextValue(context) {
    return Object.values(fleetContextToJson(context)).some((value) => value !== null);
}
function readFleetCandidate(value) {
    if (!isRecord(value))
        return undefined;
    return value.fleet;
}
function readMetadataCandidate(value) {
    if (!isRecord(value))
        return undefined;
    return value.metadata;
}
function collectFleetContextFields(target, value) {
    if (!isRecord(value))
        return;
    copyFleetContextFields(target, value);
    const metadata = readMetadataCandidate(value);
    if (isRecord(metadata))
        copyFleetContextFields(target, metadata);
    const fleet = readFleetCandidate(value) ?? readFleetCandidate(metadata);
    if (isRecord(fleet))
        copyFleetContextFields(target, fleet);
    const properties = value.properties;
    if (isRecord(properties))
        collectFleetContextFields(target, properties);
}
function copyFleetContextFields(target, source) {
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
        if (value !== undefined)
            target[key] = value;
    }
}
function readOpenCodePassthrough(context) {
    if (!isRecord(context))
        return undefined;
    const out = {};
    if (typeof context.sessionID === "string")
        out.sessionID = context.sessionID;
    if (typeof context.callID === "string")
        out.callID = context.callID;
    return Object.keys(out).length > 0 ? out : undefined;
}
function readTraceId(context) {
    if (!isRecord(context))
        return undefined;
    if (!isRecord(context.metadata))
        return undefined;
    return typeof context.metadata[TRACE_KEY] === "string" ? context.metadata[TRACE_KEY] : undefined;
}
function timeoutForTool(toolName, opts) {
    const override = opts.toolTimeouts?.[toolName];
    const configured = override ?? opts.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS;
    return Number.isFinite(configured) && configured >= 0 ? configured : DEFAULT_TIMEOUT_MS;
}
function newTraceId() {
    return `trc_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}
function sanitizeStringField(record, field, fallback) {
    if (typeof record[field] !== "string")
        record[field] = fallback;
}
function sanitizeOptionalStringField(record, field) {
    const value = record[field];
    if (value !== undefined && typeof value !== "string")
        delete record[field];
}
function sanitizeBooleanField(record, field, fallback) {
    if (typeof record[field] !== "boolean")
        record[field] = fallback;
}
function sanitizeStringArrayField(record, field) {
    const value = record[field];
    record[field] = Array.isArray(value)
        ? value.filter((entry) => typeof entry === "string" && entry.length > 0)
        : [];
}
function sanitizeStringRecordField(record, field) {
    const value = record[field];
    if (!isRecord(value)) {
        record[field] = {};
        return;
    }
    const clean = {};
    for (const [key, entry] of Object.entries(value)) {
        if (typeof entry === "string")
            clean[key] = entry;
    }
    record[field] = clean;
}
function isRecord(value) {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
