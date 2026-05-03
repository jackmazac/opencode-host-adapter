/**
 * Host adapter unit tests.
 *
 * Adapted from the original ~/.config/opencode/plugin/_host/host-adapter.test.ts
 * with additional coverage for the trace_id propagation feature.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { tool } from "@opencode-ai/plugin";
import { validateToolDefinitions, wrapPlugin } from "../src/index.ts";

const z = tool.schema;

function tempTelemetry(): string {
  const dir = mkdtempSync(join(tmpdir(), "host-adapter-test-"));
  return join(dir, "lifecycle.jsonl");
}

const tempPaths: string[] = [];
function trackTemp(path: string): string {
  tempPaths.push(path);
  return path;
}

afterEach(() => {
  while (tempPaths.length > 0) {
    const p = tempPaths.pop();
    if (!p) continue;
    try {
      rmSync(p.replace(/\/lifecycle\.jsonl$/, ""), { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
});

const stubInput = {
  client: {} as never,
  project: { id: "p", worktree: "/tmp", time: { created: 1 } } as never,
  directory: "/tmp",
  worktree: "/tmp",
  experimental_workspace: { register: () => {} } as never,
  serverUrl: new URL("http://localhost"),
  $: (() => {}) as never,
};

describe("validateToolDefinitions", () => {
  test("rejects codemem-style ZodObject args (the n._zod.def bug)", () => {
    const tools = {
      bad: {
        description: "bad tool",
        args: z.object({ x: z.string() }),
        execute: async () => "ok",
      },
    };
    const result = validateToolDefinitions(tools, "test-plugin");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors[0]).toContain("ZodObject");
    expect(result.errors[0]).toContain("object literal");
  });

  test("accepts correct ZodRawShape args", () => {
    const tools = {
      good: {
        description: "good tool",
        args: { x: z.string(), y: z.number().optional() },
        execute: async () => "ok",
      },
    };
    expect(validateToolDefinitions(tools, "test-plugin").ok).toBe(true);
  });

  test("accepts empty args object", () => {
    const tools = { noargs: { description: "no args", args: {}, execute: async () => "ok" } };
    expect(validateToolDefinitions(tools, "test-plugin").ok).toBe(true);
  });

  test("rejects missing description / execute / args / non-schema arg", () => {
    expect(validateToolDefinitions({ a: { args: { x: z.string() }, execute: async () => "ok" } }, "p").ok).toBe(false);
    expect(validateToolDefinitions({ a: { description: "x", args: { x: z.string() } } }, "p").ok).toBe(false);
    expect(validateToolDefinitions({ a: { description: "x", execute: async () => "ok" } }, "p").ok).toBe(false);
    expect(
      validateToolDefinitions({ a: { description: "x", args: { x: "not a schema" }, execute: async () => "ok" } }, "p").ok,
    ).toBe(false);
  });
});

describe("wrapPlugin", () => {
  test("emits plugin.loaded telemetry on success", async () => {
    const path = trackTemp(tempTelemetry());
    const wrapped = wrapPlugin(
      async () => ({
        tool: {
          ping: { description: "ping", args: { msg: z.string() }, execute: async () => "pong" },
        },
      }),
      { name: "test", telemetryPath: path },
    );
    await wrapped(stubInput);
    const content = readFileSync(path, "utf8");
    expect(content).toContain('"plugin.loaded"');
    expect(content).toContain('"test"');
    expect(content).toContain('"toolCount":1');
  });

  test("emits plugin.failed when plugin throws", async () => {
    const path = trackTemp(tempTelemetry());
    const wrapped = wrapPlugin(
      async () => {
        throw new Error("boom");
      },
      { name: "explosive", telemetryPath: path },
    );
    await expect(wrapped(stubInput)).rejects.toThrow("boom");
    expect(readFileSync(path, "utf8")).toContain('"plugin.failed"');
  });

  test("wraps tool execute so thrown errors return as strings", async () => {
    const path = trackTemp(tempTelemetry());
    const wrapped = wrapPlugin(
      async () => ({
        tool: {
          crash: {
            description: "always crashes",
            args: { msg: z.string() },
            execute: async () => {
              throw new Error("inside");
            },
          },
        },
      }),
      { name: "crashy", telemetryPath: path },
    );
    const hooks = await wrapped(stubInput);
    const crashRaw = hooks.tool?.crash;
    if (!crashRaw || typeof crashRaw !== "object") throw new Error("crash tool not registered");
    const execute = (crashRaw as { execute: (args: unknown, context: unknown) => Promise<unknown> }).execute;
    const result = await execute({ msg: "hi" }, {});
    expect(typeof result).toBe("string");
    if (typeof result !== "string") return;
    expect(result).toContain("crashy");
    expect(result).toContain("crash");
    expect(result).toContain("inside");
    expect(readFileSync(path, "utf8")).toContain('"tool.failed"');
  });

  test("filters null/undefined out of system transform output", async () => {
    const path = trackTemp(tempTelemetry());
    const wrapped = wrapPlugin(
      async () => ({
        "experimental.chat.system.transform": async (
          _input: unknown,
          output: { system: string[] },
        ) => {
          // Simulate a plugin that pushes malformed entries; the adapter must filter them.
          const dirty: unknown[] = [undefined, null, "real entry", ""];
          for (const entry of dirty) {
            output.system.push(entry as string);
          }
        },
      }),
      { name: "transformer", telemetryPath: path },
    );
    const hooks = await wrapped(stubInput);
    const transform = hooks["experimental.chat.system.transform"];
    if (!transform) throw new Error("transform hook not registered");
    const out = { system: [] as string[] };
    await transform({ sessionID: "s", model: {} }, out);
    expect(out.system).toEqual(["real entry"]);
  });

  test("rejects codemem-style ZodObject args at registration", async () => {
    const path = trackTemp(tempTelemetry());
    // The codemem bug is statically caught by TypeScript with strict configs,
    // but runtime guarding is still required for plugins built with looser tsconfigs
    // (which is exactly how codemem shipped the bug to production). Construct the
    // bad shape through unknown so TS doesn't reject it at the call site.
    const badTool: unknown = {
      description: "the bug",
      args: z.object({ maxFindings: z.number() }),
      execute: async () => "ok",
    };
    const wrapped = wrapPlugin(
      async () => ({ tool: { codemem_check: badTool } }),
      { name: "codemem-style", telemetryPath: path },
    );
    const hooks = await wrapped(stubInput);
    expect(Object.keys(hooks.tool ?? {})).toEqual([]);
    expect(readFileSync(path, "utf8")).toContain("plugin.validation_failed");
  });

  test("trace_id propagation: chat.params injects metadata.trace_id", async () => {
    const path = trackTemp(tempTelemetry());
    const wrapped = wrapPlugin(
      async () => ({
        tool: { ping: { description: "ping", args: {}, execute: async () => "pong" } },
      }),
      { name: "tracer", telemetryPath: path, propagateTraceId: true },
    );
    const hooks = await wrapped(stubInput);
    const chatParams = hooks["chat.params"];
    if (!chatParams) throw new Error("chat.params hook not registered");
    const output: {
      temperature: number;
      topP: number;
      topK: number;
      maxOutputTokens: number | undefined;
      options: Record<string, unknown>;
    } = {
      temperature: 0.7,
      topP: 1,
      topK: 1,
      maxOutputTokens: undefined,
      options: {},
    };
    await chatParams({ sessionID: "s", agent: "a", model: {}, provider: {}, message: {} }, output);
    const meta = output.options.metadata;
    expect(meta).toBeDefined();
    if (!meta || typeof meta !== "object") throw new Error("metadata not set");
    const traceId = (meta as Record<string, unknown>).trace_id;
    expect(typeof traceId).toBe("string");
    expect(String(traceId).startsWith("trc_")).toBe(true);
  });

  test("trace_id flows into tool.executed telemetry", async () => {
    const path = trackTemp(tempTelemetry());
    const wrapped = wrapPlugin(
      async () => ({
        tool: { ping: { description: "ping", args: {}, execute: async () => "pong" } },
      }),
      { name: "tracer", telemetryPath: path, propagateTraceId: true },
    );
    const hooks = await wrapped(stubInput);
    const pingRaw = hooks.tool?.ping;
    if (!pingRaw || typeof pingRaw !== "object") throw new Error("ping not registered");
    const execute = (pingRaw as { execute: (args: unknown, context: unknown) => Promise<unknown> }).execute;
    await execute({}, { sessionID: "s", callID: "c", metadata: { trace_id: "trc_test" } });
    const log = readFileSync(path, "utf8");
    expect(log).toContain('"tool.executed"');
    expect(log).toContain('"trace_id":"trc_test"');
  });
});
