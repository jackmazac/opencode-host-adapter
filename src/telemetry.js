/**
 * NDJSON telemetry sink.
 *
 * Writes one JSON object per line to a rolling lifecycle file. Failures
 * NEVER throw — telemetry must not break a plugin hook.
 *
 * Default destination: ~/.local/share/opencode/log/plugin-lifecycle.jsonl
 * Override via WrapOptions.telemetryPath or the
 * OPENCODE_HOST_ADAPTER_TELEMETRY env var.
 */
import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { validateTelemetryEnvelope, } from "@mazac-fox/opencode-fleet-contracts";
const DEFAULT_PATH = join(homedir(), ".local", "share", "opencode", "log", "plugin-lifecycle.jsonl");
const ID_FIELDS = [
    "workspace_id",
    "plan_id",
    "plan_slug",
    "wave_id",
    "agent_run_id",
    "correlation_id",
    "tool_call_id",
    "spine_seq",
    "artifact_ref",
    "lifecycle_object_id",
    "concord_event_id",
    "fleet_run_id",
];
export function resolveTelemetryPath(opts) {
    if (opts.telemetryPath)
        return opts.telemetryPath;
    if (process.env.OPENCODE_HOST_ADAPTER_TELEMETRY)
        return process.env.OPENCODE_HOST_ADAPTER_TELEMETRY;
    return DEFAULT_PATH;
}
export function emitFleet(envelope, options) {
    if (options?.telemetryDisabled)
        return;
    emitRawEnvelope(envelope, options ?? {});
}
export function emit(opts, event) {
    if (opts.telemetryDisabled)
        return;
    try {
        emitRawEnvelope(toCompatibilityEnvelope(opts, event), opts);
    }
    catch (error) {
        reportTelemetryFailure(opts.name, error);
    }
}
function emitRawEnvelope(raw, opts) {
    try {
        const validation = validateTelemetryEnvelope(raw);
        if (!validation.ok) {
            console.error(`[host-adapter] telemetry envelope validation failed: ${validation.errors.join("; ")}`);
            return;
        }
        const dest = resolveTelemetryPath(opts);
        appendLine(dest, JSON.stringify(raw));
    }
    catch (error) {
        reportTelemetryFailure(undefined, error);
    }
}
function appendLine(dest, line) {
    try {
        const dir = dirname(dest);
        if (!existsSync(dir)) {
            mkdirSync(dir, { recursive: true });
        }
        appendFileSync(dest, `${line}\n`);
    }
    catch (error) {
        reportTelemetryFailure(undefined, error);
    }
}
function toCompatibilityEnvelope(opts, event) {
    const kind = stringOr(event.kind, "plugin.event");
    const status = statusForEvent(event, kind);
    const raw = {
        schema_version: 1,
        ts: timestampForEvent(event.ts),
        kind,
        plugin: stringOr(event.plugin, opts.name),
        status,
        workspace_id: null,
        plan_id: null,
        plan_slug: null,
        wave_id: null,
        agent_run_id: null,
        correlation_id: null,
        tool_call_id: null,
        spine_seq: null,
        artifact_ref: null,
        lifecycle_object_id: null,
        concord_event_id: null,
        fleet_run_id: null,
    };
    copyKnownEnvelopeFields(event, raw);
    copySafeExtras(event, raw);
    return raw;
}
function copyKnownEnvelopeFields(event, raw) {
    for (const field of ID_FIELDS) {
        if (field in event)
            raw[field] = event[field];
    }
    if (typeof event.tool === "string")
        raw.tool = event.tool;
    if (typeof event.durationMs === "number")
        raw.durationMs = event.durationMs;
    const error = telemetryError(event.error);
    if (error)
        raw.error = error;
    const opencode = opencodePassthrough(event);
    if (opencode)
        raw.opencode = opencode;
}
function copySafeExtras(event, raw) {
    if ("argDigest" in event)
        raw.argDigest = event.argDigest;
    if ("toolCount" in event)
        raw.toolCount = event.toolCount;
    if ("hookKinds" in event)
        raw.hookKinds = event.hookKinds;
    if (typeof event.hook === "string")
        raw.hook = event.hook;
    if (typeof event.message === "string" && raw.error === undefined) {
        raw.error = { message: event.message };
    }
    if (typeof event.trace_id === "string")
        raw.trace_id = event.trace_id;
}
function opencodePassthrough(event) {
    if (isRecord(event.opencode)) {
        const out = {};
        if (typeof event.opencode.sessionID === "string")
            out.sessionID = event.opencode.sessionID;
        if (typeof event.opencode.callID === "string")
            out.callID = event.opencode.callID;
        return Object.keys(out).length > 0 ? out : undefined;
    }
    const out = {};
    if (typeof event.sessionID === "string")
        out.sessionID = event.sessionID;
    if (typeof event.callID === "string")
        out.callID = event.callID;
    return Object.keys(out).length > 0 ? out : undefined;
}
function timestampForEvent(value) {
    if (typeof value === "string")
        return value;
    if (typeof value === "number" && Number.isFinite(value))
        return new Date(value).toISOString();
    return new Date().toISOString();
}
function statusForEvent(event, kind) {
    if (event.status === "ok" || event.status === "error")
        return event.status;
    if (kind.endsWith(".failed") || kind === "plugin.validation_failed")
        return "error";
    return "ok";
}
function stringOr(value, fallback) {
    if (typeof value === "string" && value.length > 0)
        return value;
    return fallback;
}
export function errorPayload(error) {
    const payload = error instanceof Error
        ? { message: error.message, name: error.name }
        : { message: String(error) };
    if (error instanceof Error && error.stack)
        payload.stack = error.stack.slice(0, 4000);
    if (isRecord(error)) {
        if (typeof error.code === "string")
            payload.code = error.code;
        if (typeof error.retryable === "boolean")
            payload.retryable = error.retryable;
    }
    return payload;
}
function telemetryError(input) {
    if (!isRecord(input))
        return undefined;
    if (typeof input.message !== "string" || input.message.trim().length === 0)
        return undefined;
    const out = {
        message: input.message,
    };
    if (typeof input.name === "string")
        out.name = input.name;
    if (typeof input.code === "string")
        out.code = input.code;
    if (typeof input.retryable === "boolean")
        out.retryable = input.retryable;
    return out;
}
export function argDigest(args) {
    if (!args || typeof args !== "object")
        return { keys: [], types: {}, size: 0 };
    const keys = Object.keys(args).slice(0, 32);
    const types = {};
    for (const k of keys) {
        const v = Reflect.get(args, k);
        types[k] = Array.isArray(v) ? "array" : v === null ? "null" : typeof v;
    }
    let size = 0;
    try {
        size = JSON.stringify(args).length;
    }
    catch {
        size = -1;
    }
    return { keys, types, size };
}
function reportTelemetryFailure(plugin, error) {
    try {
        const prefix = plugin ? `[host:${plugin}]` : "[host-adapter]";
        const message = error instanceof Error ? error.message : String(error);
        console.error(`${prefix} telemetry emit failed: ${message}`);
    }
    catch {
        // Telemetry failures must never break a plugin hook.
    }
}
function isRecord(value) {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
