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
      execute: (args: Record<string, unknown>, context: unknown) => Promise<unknown>;
    }
  >;
  event?: (input: { event: unknown }) => Promise<void>;
  config?: (input: unknown) => Promise<void>;
  "chat.message"?: (input: unknown, output: unknown) => Promise<void>;
  "chat.params"?: (
    input: unknown,
    output: { temperature?: number; topP?: number; topK?: number; maxOutputTokens?: number; options?: Record<string, unknown> },
  ) => Promise<void>;
  "chat.headers"?: (input: unknown, output: unknown) => Promise<void>;
  "permission.ask"?: (input: unknown, output: unknown) => Promise<void>;
  "command.execute.before"?: (input: unknown, output: unknown) => Promise<void>;
  "tool.execute.before"?: (
    input: { tool: string; sessionID: string; callID: string },
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
};

export type ToolLike = {
  description?: unknown;
  args?: unknown;
  execute?: unknown;
};

export type ToolValidationResult =
  | { ok: true }
  | { ok: false; errors: string[] };

export type ToolDefinitionResolved = {
  description: string;
  args: Record<string, unknown>;
  execute: (...args: unknown[]) => unknown;
};
