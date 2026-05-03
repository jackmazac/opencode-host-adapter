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
import { validateToolDefinitions } from "./validate.ts";

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
      const factory = factoryRaw as (input: unknown, options?: unknown) => Promise<{ tool?: unknown }>;
      const hooks = await factory(opts.stubInput(), {});
      const validation = validateToolDefinitions(hooks?.tool, opts.pluginName);
      if (!validation.ok) {
        throw new Error(
          `tool validation failed:\n  ${validation.errors.join("\n  ")}`,
        );
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
  });
}

async function loadTools(opts: ContractTestOptions): Promise<Record<string, unknown>> {
  const mod = await import(opts.pluginPath);
  const exportName = opts.exportName ?? "default";
  const factoryRaw = (mod as Record<string, unknown>)[exportName];
  if (typeof factoryRaw !== "function") return {};
  const factory = factoryRaw as (input: unknown, options?: unknown) => Promise<{ tool?: Record<string, unknown> }>;
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
        const factory = factoryRaw as (input: unknown, options?: unknown) => Promise<{ tool?: Record<string, unknown> }>;
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
