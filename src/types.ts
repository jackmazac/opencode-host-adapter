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

import type { FleetContext } from "@mazac-fox/opencode-fleet-contracts";

/**
 * A minimum Plugin-shaped function. Consumers pass their own typed
 * Plugin and TypeScript infers the parameter types from the call site.
 */
export type AnyPlugin = (input: unknown, options?: unknown) => Promise<unknown>;

/**
 * Hooks shape used internally by the wrapper. Mirrors the `@opencode-ai/plugin`
 * Hooks interface but uses unknown placeholders so foreign-instance
 * Plugin types still satisfy it structurally.
 */
export type AnyHooks = {
  tool?: Record<
    string,
    {
      description: string;
      args: Record<string, unknown>;
      execute: (args: unknown, context: unknown) => Promise<unknown>;
    }
  >;
  event?: (input: { event: unknown }) => Promise<void>;
  config?: (input: unknown) => Promise<void>;
  "chat.message"?: (input: unknown, output: unknown) => Promise<void>;
  "chat.params"?: (
    input: unknown,
    output: {
      temperature?: number;
      topP?: number;
      topK?: number;
      maxOutputTokens?: number;
      options?: Record<string, unknown>;
    },
  ) => Promise<void>;
  "chat.headers"?: (input: unknown, output: unknown) => Promise<void>;
  "permission.ask"?: (input: unknown, output: unknown) => Promise<void>;
  "command.execute.before"?: (input: unknown, output: unknown) => Promise<void>;
  "tool.execute.before"?: (
    input: { tool: string; sessionID: string; callID: string; args?: unknown },
    output: { args: unknown },
  ) => Promise<void>;
  "shell.env"?: (input: unknown, output: unknown) => Promise<void>;
  "tool.execute.after"?: (
    input: { tool: string; sessionID: string; callID: string; args: unknown },
    output: { title: string; output: string; metadata: unknown },
  ) => Promise<void>;
  "experimental.chat.messages.transform"?: (input: unknown, output: unknown) => Promise<void>;
  "experimental.chat.system.transform"?: (
    input: unknown,
    output: { system: string[] },
  ) => Promise<void>;
  "experimental.session.compacting"?: (input: unknown, output: unknown) => Promise<void>;
  "experimental.compaction.autocontinue"?: (input: unknown, output: unknown) => Promise<void>;
  "experimental.text.complete"?: (input: unknown, output: unknown) => Promise<void>;
  "tool.definition"?: (input: unknown, output: unknown) => Promise<void>;
  auth?: unknown;
  provider?: unknown;
};

export type FleetContextSource = "args" | "metadata" | "generated";

export type WrapOptions = {
  /** Stable plugin name used in telemetry and error messages. */
  name: string;

  /**
   * When true, throws on validation failure instead of logging and returning
   * partial hooks. Default false (degrade gracefully).
   */
  strict?: boolean;

  /** Override telemetry destination (mostly for tests). */
  telemetryPath?: string;

  /**
   * Disable telemetry emission entirely. Useful for tests or environments
   * where the log directory is read-only.
   */
  telemetryDisabled?: boolean;

  /**
   * When true, propagate a `trace_id` through chat.params and
   * tool.execute.before so all telemetry for one orchestrator turn shares
   * the same id. Default false (opt-in to avoid surprising hook semantics).
   */
  propagateTraceId?: boolean;

  /**
   * Propagate canonical fleet IDs through `context.metadata.fleet` before
   * invoking wrapped tools and selected hooks. Default true.
   */
  propagateFleetContext?: boolean;

  /**
   * Return the legacy `❌ [plugin].tool failed: message` string when wrapped
   * tool execution fails. Default false, which returns ToolFailureResult.
   */
  legacyErrorString?: boolean;
};

export type ToolFailureResult = {
  output: string;
  ok: false;
  schema_version: 1;
  plugin: string;
  tool: string;
  message: string;
  error: { name: string; message: string; code?: string; retryable?: boolean };
  workspace_id: string | null;
  plan_id: string | null;
  plan_slug: string | null;
  wave_id: string | null;
  agent_run_id: string | null;
  correlation_id: string | null;
  tool_call_id: string | null;
  spine_seq: number | null;
  artifact_ref: string | null;
  lifecycle_object_id: string | null;
  concord_event_id: string | null;
  fleet_run_id: string | null;
};

export type ExtractedFleetContext = {
  context: FleetContext;
  source: FleetContextSource;
};

export function assertToolFailureResult(value: unknown): asserts value is ToolFailureResult {
  if (!isRecord(value)) throw new Error("expected ToolFailureResult object");
  requireStringField(value, "output");
  if (value.ok !== false) throw new Error("ToolFailureResult.ok must be false");
  if (value.schema_version !== 1) throw new Error("ToolFailureResult.schema_version must be 1");
  requireStringField(value, "plugin");
  requireStringField(value, "tool");
  requireStringField(value, "message");
  if (!isRecord(value.error)) throw new Error("ToolFailureResult.error must be an object");
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

function requireStringField(record: Record<string, unknown>, field: string): void {
  if (typeof record[field] !== "string") throw new Error(`${field} must be a string`);
}

function requireNullableStringField(record: Record<string, unknown>, field: string): void {
  const value = record[field];
  if (value !== null && typeof value !== "string") {
    throw new Error(`${field} must be a string or null`);
  }
}

function requireNullableNumberField(record: Record<string, unknown>, field: string): void {
  const value = record[field];
  if (value !== null && typeof value !== "number") {
    throw new Error(`${field} must be a number or null`);
  }
}

function optionalStringField(record: Record<string, unknown>, field: string): void {
  const value = record[field];
  if (value !== undefined && typeof value !== "string") {
    throw new Error(`${field} must be a string when present`);
  }
}

function optionalBooleanField(record: Record<string, unknown>, field: string): void {
  const value = record[field];
  if (value !== undefined && typeof value !== "boolean") {
    throw new Error(`${field} must be a boolean when present`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export type ToolLike = {
  description?: unknown;
  args?: unknown;
  execute?: unknown;
};

export type ToolValidationResult = { ok: true } | { ok: false; errors: string[] };

export type ToolDefinitionResolved = {
  description: string;
  args: Record<string, unknown>;
  execute: (...args: unknown[]) => unknown;
};
