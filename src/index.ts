/**
 * @mazac-fox/opencode-host-adapter
 *
 * Defensive wrapper for OpenCode plugins. See the README for usage.
 *
 * Quick start:
 *
 *   import { wrapPlugin } from "@mazac-fox/opencode-host-adapter";
 *   import type { Plugin } from "@opencode-ai/plugin";
 *
 *   const MyPlugin: Plugin = async (input) => {
 *     return {
 *       tool: {
 *         my_tool: {
 *           description: "...",
 *           args: { foo: tool.schema.string() },
 *           async execute(args) { ... },
 *         },
 *       },
 *     };
 *   };
 *
 *   export default wrapPlugin(MyPlugin, { name: "my-plugin" });
 */

export {
  extractFleetContext,
  extractFleetContextFromUnknown,
  mergeToolExecuteBeforeHookArgs,
  wrapPlugin,
} from "./wrap.ts";
export {
  ERROR_TIMEOUT,
  ERROR_TOOL_ARGS_INVALID,
  ToolArgsValidationError,
  type HostAdapterErrorCode,
} from "./errors.ts";
export { looksLikeZodSchema, validateToolDefinition, validateToolDefinitions } from "./validate.ts";
export { argDigest, emit, emitFleet, errorPayload, resolveTelemetryPath } from "./telemetry.ts";
export { validateToolArgs, type ToolArgs } from "./tool-args.ts";
export { assertToolFailureResult } from "./types.ts";
export type {
  AnyHooks,
  AnyPlugin,
  ExtractedFleetContext,
  FleetContextSource,
  ToolDefinitionResolved,
  ToolFailureResult,
  ToolLike,
  ToolTimeoutOverrides,
  ToolValidationResult,
  WrapOptions,
} from "./types.ts";

// Fleet contracts re-export — see ./contracts for the subpath export.
// Root namespace export avoids naming conflicts with Host Adapter's own
// types (e.g. ToolValidationResult, WrapOptions) by using a namespace.
export * as fleetContracts from "@mazac-fox/opencode-fleet-contracts";
