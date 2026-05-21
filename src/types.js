/**
 * Public types for the host adapter.
 *
 * IMPORTANT: This module deliberately does NOT re-export the Plugin /
 * PluginInput / Hooks types from `@opencode-ai/plugin`. Doing so would
 * create a nominal-typing collision when the consumer (engram, conductor,
 * etc.) installs `@opencode-ai/plugin` in a different node_modules tree
 * than this package. The collision manifests as TS2345 errors complaining
 * about two `Global` types with the same name being unrelated, because
 * the `_client` protected member causes nominal typing.
 *
 * Instead, host-adapter accepts any function that matches the Plugin
 * shape structurally via the `AnyPlugin` type below. This keeps the
 * wrapper usable across all version-compatible consumers without
 * requiring them to share a single physical install.
 */
export function assertToolFailureResult(value) {
    if (!isRecord(value))
        throw new Error("expected ToolFailureResult object");
    requireStringField(value, "output");
    if (value.ok !== false)
        throw new Error("ToolFailureResult.ok must be false");
    if (value.schema_version !== 1)
        throw new Error("ToolFailureResult.schema_version must be 1");
    requireStringField(value, "plugin");
    requireStringField(value, "tool");
    requireStringField(value, "message");
    if (!isRecord(value.error))
        throw new Error("ToolFailureResult.error must be an object");
    requireStringField(value.error, "name");
    requireStringField(value.error, "message");
    optionalStringField(value.error, "code");
    optionalBooleanField(value.error, "retryable");
    requireNullableStringField(value, "workspace_id");
    requireNullableStringField(value, "plan_id");
    requireNullableStringField(value, "plan_slug");
    requireNullableStringField(value, "wave_id");
    requireNullableStringField(value, "agent_run_id");
    requireNullableStringField(value, "correlation_id");
    requireNullableStringField(value, "tool_call_id");
    requireNullableNumberField(value, "spine_seq");
    requireNullableStringField(value, "artifact_ref");
    requireNullableStringField(value, "lifecycle_object_id");
    requireNullableStringField(value, "concord_event_id");
    requireNullableStringField(value, "fleet_run_id");
}
function requireStringField(record, field) {
    if (typeof record[field] !== "string")
        throw new Error(`${field} must be a string`);
}
function requireNullableStringField(record, field) {
    const value = record[field];
    if (value !== null && typeof value !== "string") {
        throw new Error(`${field} must be a string or null`);
    }
}
function requireNullableNumberField(record, field) {
    const value = record[field];
    if (value !== null && typeof value !== "number") {
        throw new Error(`${field} must be a number or null`);
    }
}
function optionalStringField(record, field) {
    const value = record[field];
    if (value !== undefined && typeof value !== "string") {
        throw new Error(`${field} must be a string when present`);
    }
}
function optionalBooleanField(record, field) {
    const value = record[field];
    if (value !== undefined && typeof value !== "boolean") {
        throw new Error(`${field} must be a boolean when present`);
    }
}
function isRecord(value) {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
