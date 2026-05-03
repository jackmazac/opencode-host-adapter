/**
 * @jackmazac/opencode-host-adapter
 *
 * Defensive wrapper for OpenCode plugins. See the README for usage.
 *
 * Quick start:
 *
 *   import { wrapPlugin } from "@jackmazac/opencode-host-adapter";
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

export { wrapPlugin } from "./wrap.ts";
export {
  looksLikeZodSchema,
  validateToolDefinition,
  validateToolDefinitions,
} from "./validate.ts";
export { argDigest, emit, errorPayload, resolveTelemetryPath } from "./telemetry.ts";
export type {
  AnyHooks,
  AnyPlugin,
  ToolDefinitionResolved,
  ToolLike,
  ToolValidationResult,
  WrapOptions,
} from "./types.ts";
