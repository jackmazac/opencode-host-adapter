/**
 * Plugin contract test harness.
 *
 * Reusable in any plugin's test suite to assert it satisfies the contract
 * opencode expects:
 *
 *   - Loads without throwing.
 *   - Default export is a function.
 *   - Returns a hooks object.
 *   - Every tool definition is well-formed (passes validateToolDefinition).
 *   - Tool args are ZodRawShape, not ZodObject (the codemem bug).
 *   - No collisions across tool names.
 *
 * Usage in a plugin's `test/contract.test.ts`:
 *
 *   import { describe } from "bun:test";
 *   import { runPluginContractTests } from "@jackmazac/opencode-host-adapter/contract-test";
 *
 *   runPluginContractTests({
 *     pluginPath: import.meta.resolveSync("../src/index.ts"),
 *     pluginName: "my-plugin",
 *     stubInput: () => ({ ... }),
 *   });
 */

import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  newAgentRunId,
  newCorrelationId,
  parseToolCallId,
  validateTelemetryEnvelope,
} from "@jackmazac/opencode-fleet-contracts";
import { ERROR_TOOL_ARGS_INVALID } from "./errors.ts";
import { wrapPlugin } from "./wrap.ts";
import { assertToolFailureResult } from "./types.ts";
import { validateToolDefinitions } from "./validate.ts";

export { assertToolFailureResult } from "./types.ts";

export type ContractTestOptions = {
  /** Absolute path or import.meta-resolved URL of the plugin entry. */
  pluginPath: string;

  /** Stable plugin name used in error messages. */
  pluginName: string;

  /** Returns a stub PluginInput suitable for invoking the plugin factory. */
  stubInput: () => unknown;

  /**
   * Optional override for the export name (default: "default").
   * Most plugins use `export default ...` and don't need to set this.
   */
  exportName?: string;

  /**
   * When provided, the test asserts the plugin registers AT LEAST these
   * tool names. Useful as a regression guard.
   */
  expectedTools?: string[];

  /**
   * When provided, the test asserts the plugin registers EXACTLY these
   * tool names (rejects extras and missing). Stricter than expectedTools.
   */
  exactTools?: string[];
};

export function runPluginContractTests(opts: ContractTestOptions): void {
  describe(`plugin contract: ${opts.pluginName}`, () => {
    test("module loads without throwing", async () => {
      await expect(import(opts.pluginPath)).resolves.toBeDefined();
    });

    test("default export is a function", async () => {
      const mod = await import(opts.pluginPath);
      const exportName = opts.exportName ?? "default";
      const factory = (mod as Record<string, unknown>)[exportName];
      expect(typeof factory).toBe("function");
    });

    test("factory returns a hooks object", async () => {
      const mod = await import(opts.pluginPath);
      const exportName = opts.exportName ?? "default";
      const factoryRaw = (mod as Record<string, unknown>)[exportName];
      if (typeof factoryRaw !== "function") {
        throw new Error(`expected ${exportName} to be a function`);
      }
      const factory = factoryRaw as (input: unknown, options?: unknown) => unknown;
      const result = await factory(opts.stubInput(), {});
      expect(typeof result).toBe("object");
      expect(result).not.toBeNull();
    });

    test("every tool definition is well-formed (no codemem-style ZodObject args)", async () => {
      const mod = await import(opts.pluginPath);
      const exportName = opts.exportName ?? "default";
      const factoryRaw = (mod as Record<string, unknown>)[exportName];
      if (typeof factoryRaw !== "function") return;
      const factory = factoryRaw as (
        input: unknown,
        options?: unknown,
      ) => Promise<{ tool?: unknown }>;
      const hooks = await factory(opts.stubInput(), {});
      const validation = validateToolDefinitions(hooks?.tool, opts.pluginName);
      if (!validation.ok) {
        throw new Error(`tool validation failed:\n  ${validation.errors.join("\n  ")}`);
      }
      expect(validation.ok).toBe(true);
    });

    if (opts.expectedTools) {
      const expectedTools = opts.expectedTools;
      test(`registers expected tools: ${expectedTools.join(", ")}`, async () => {
        const tools = await loadTools(opts);
        for (const expected of expectedTools) {
          expect(Object.keys(tools)).toContain(expected);
        }
      });
    }

    if (opts.exactTools) {
      const exactTools = opts.exactTools;
      test(`registers exactly: ${exactTools.join(", ")}`, async () => {
        const tools = await loadTools(opts);
        const names = Object.keys(tools).sort();
        const sortedExpected = [...exactTools].sort();
        expect(names).toEqual(sortedExpected);
      });
    }

    test("wrapped mock tool emits canonical fleet telemetry", async () => {
      const telemetryPath = tempTelemetryPath();
      const correlationId = newCorrelationId();
      const agentRunId = newAgentRunId();
      const wrapped = wrapPlugin(
        async () => ({
          tool: {
            noop: { description: "noop", args: {}, execute: async () => "ok" },
          },
        }),
        { name: opts.pluginName, telemetryPath },
      );
      const hooks = await wrapped(opts.stubInput());
      const tool = hooks.tool?.noop;
      if (!isRecord(tool) || typeof tool.execute !== "function") {
        throw new Error("noop tool not registered");
      }
      await tool.execute(
        {},
        { metadata: { fleet: { correlation_id: correlationId, agent_run_id: agentRunId } } },
      );

      const envelope = readLastNdjsonObject(telemetryPath);
      const validation = validateTelemetryEnvelope(envelope);
      expect(validation.ok).toBe(true);
      if (!validation.ok) throw new Error(validation.errors.join("; "));
      expect(String(validation.value.correlation_id)).toBe(String(correlationId));
      expect(String(validation.value.agent_run_id)).toBe(String(agentRunId));
      expect(validation.value.tool_call_id).not.toBeNull();
      if (validation.value.tool_call_id === null) throw new Error("tool_call_id missing");
      expect(parseToolCallId(String(validation.value.tool_call_id)).ok).toBe(true);
    });

    test("wrapped mock tool returns structured failure by default and legacy string when opted out", async () => {
      const structuredPath = tempTelemetryPath();
      const structured = wrapPlugin(
        async () => ({
          tool: {
            crash: {
              description: "crash",
              args: {},
              execute: async () => {
                throw new Error("contract boom");
              },
            },
          },
        }),
        { name: opts.pluginName, telemetryPath: structuredPath },
      );
      const structuredHooks = await structured(opts.stubInput());
      const structuredTool = structuredHooks.tool?.crash;
      if (!isRecord(structuredTool) || typeof structuredTool.execute !== "function") {
        throw new Error("crash tool not registered");
      }
      const structuredResult = await structuredTool.execute({}, {});
      assertToolFailureResult(structuredResult);
      expect(structuredResult.output).toBe(structuredResult.message);
      expect(structuredResult.error.message).toBe("contract boom");

      const legacy = wrapPlugin(
        async () => ({
          tool: {
            crash: {
              description: "crash",
              args: {},
              execute: async () => {
                throw new Error("legacy boom");
              },
            },
          },
        }),
        { name: opts.pluginName, telemetryPath: tempTelemetryPath(), legacyErrorString: true },
      );
      const legacyHooks = await legacy(opts.stubInput());
      const legacyTool = legacyHooks.tool?.crash;
      if (!isRecord(legacyTool) || typeof legacyTool.execute !== "function") {
        throw new Error("legacy crash tool not registered");
      }
      const legacyResult = await legacyTool.execute({}, {});
      expect(typeof legacyResult).toBe("string");
      expect(legacyResult).toBe(`❌ [${opts.pluginName}].crash failed: legacy boom`);
    });

    test("wrapped mock tool rejects malformed runtime args before execute", async () => {
      let called = false;
      const wrapped = wrapPlugin(
        async () => ({
          tool: {
            required: {
              description: "requires msg",
              args: { msg: requiredStringSchema() },
              execute: async () => {
                called = true;
                return "should not run";
              },
            },
          },
        }),
        { name: opts.pluginName, telemetryPath: tempTelemetryPath() },
      );
      const hooks = await wrapped(opts.stubInput());
      const requiredTool = hooks.tool?.required;
      if (!isRecord(requiredTool) || typeof requiredTool.execute !== "function") {
        throw new Error("required tool not registered");
      }

      const result = await requiredTool.execute(undefined, {});

      assertToolFailureResult(result);
      expect(called).toBe(false);
      expect(result.output).toBe(result.message);
      expect(result.error.name).toBe("ToolArgsValidationError");
      expect(result.error.code).toBe(ERROR_TOOL_ARGS_INVALID);
      expect(result.error.retryable).toBe(false);
      expect(result.error.message).toContain('arg "msg"');
    });
  });
}

async function loadTools(opts: ContractTestOptions): Promise<Record<string, unknown>> {
  const mod = await import(opts.pluginPath);
  const exportName = opts.exportName ?? "default";
  const factoryRaw = (mod as Record<string, unknown>)[exportName];
  if (typeof factoryRaw !== "function") return {};
  const factory = factoryRaw as (
    input: unknown,
    options?: unknown,
  ) => Promise<{ tool?: Record<string, unknown> }>;
  const hooks = await factory(opts.stubInput(), {});
  return hooks?.tool ?? {};
}

/**
 * Cross-plugin integration smoke test.
 *
 * Loads multiple plugins simultaneously and asserts:
 *   - Each plugin loads cleanly.
 *   - No tool name collisions across the whole set.
 *
 * Usage:
 *
 *   runCrossPluginIntegrationTest({
 *     plugins: [
 *       { name: "engram", path: "/path/to/engram/src/index.ts" },
 *       { name: "conductor", path: "/path/to/conductor/src/index.ts" },
 *     ],
 *     stubInput: () => ({ ... }),
 *   });
 */
export type IntegrationTestOptions = {
  plugins: Array<{ name: string; path: string }>;
  stubInput: () => unknown;
};

export function runCrossPluginIntegrationTest(opts: IntegrationTestOptions): void {
  describe("cross-plugin integration", () => {
    test("all plugins load and tool names are unique", async () => {
      const seen = new Map<string, string[]>();
      for (const { name, path } of opts.plugins) {
        const mod = await import(path);
        const factoryRaw = (mod as Record<string, unknown>).default;
        if (typeof factoryRaw !== "function") {
          throw new Error(`${name}: default export is not a function`);
        }
        const factory = factoryRaw as (
          input: unknown,
          options?: unknown,
        ) => Promise<{ tool?: Record<string, unknown> }>;
        const hooks = await factory(opts.stubInput(), {});
        const validation = validateToolDefinitions(hooks?.tool, name);
        if (!validation.ok) {
          throw new Error(`${name} tool validation failed: ${validation.errors.join("; ")}`);
        }
        for (const toolName of Object.keys(hooks?.tool ?? {})) {
          const owners = seen.get(toolName) ?? [];
          owners.push(name);
          seen.set(toolName, owners);
        }
      }

      const collisions: string[] = [];
      for (const [toolName, owners] of seen.entries()) {
        if (owners.length > 1) {
          collisions.push(`${toolName} → ${owners.join(", ")}`);
        }
      }
      if (collisions.length > 0) {
        throw new Error(`tool name collisions detected:\n  ${collisions.join("\n  ")}`);
      }
      expect(collisions.length).toBe(0);
    });
  });
}

function tempTelemetryPath(): string {
  return join(mkdtempSync(join(tmpdir(), "host-adapter-contract-")), "lifecycle.jsonl");
}

function readLastNdjsonObject(path: string): unknown {
  const lines = readFileSync(path, "utf8").trim().split("\n");
  const last = lines.at(-1);
  if (!last) throw new Error("telemetry file was empty");
  return JSON.parse(last);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function requiredStringSchema(): Record<string, unknown> {
  return {
    _zod: true,
    safeParse(
      value: unknown,
    ): { success: true; data: string } | { success: false; error: unknown } {
      if (typeof value === "string") return { success: true, data: value };
      return { success: false, error: { issues: [{ message: "expected string" }] } };
    },
  };
}
