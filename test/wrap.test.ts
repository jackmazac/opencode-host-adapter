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
import {
  assertToolFailureResult,
  ERROR_TIMEOUT,
  ERROR_TOOL_ARGS_INVALID,
  argDigest,
  extractFleetContextFromUnknown,
  fleetContracts,
  mergeToolExecuteBeforeHookArgs,
  validateToolDefinitions,
  wrapPlugin,
} from "../src/index.ts";

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

type TestExecute = (args: unknown, context: unknown) => Promise<unknown>;

function readTelemetry(path: string): Array<Record<string, unknown>> {
  return readFileSync(path, "utf8")
    .trim()
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line))
    .filter(isRecord);
}

function telemetryByKind(path: string, kind: string): Array<Record<string, unknown>> {
  return readTelemetry(path).filter((entry) => entry.kind === kind);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getExecute(toolEntry: unknown, name: string): TestExecute {
  if (!isRecord(toolEntry) || typeof toolEntry.execute !== "function") {
    throw new Error(`${name} tool not registered`);
  }
  const execute = toolEntry.execute;
  return async (args: unknown, context: unknown) => execute(args, context);
}

function readToolCallId(value: unknown): unknown {
  if (!isRecord(value)) return undefined;
  if (!isRecord(value.metadata)) return undefined;
  if (!isRecord(value.metadata.fleet)) return undefined;
  return value.metadata.fleet.tool_call_id;
}

function readSignal(value: unknown): AbortSignal | undefined {
  if (!isRecord(value)) return undefined;
  return value.signal instanceof AbortSignal ? value.signal : undefined;
}

function readAbort(value: unknown): AbortSignal | undefined {
  if (!isRecord(value)) return undefined;
  return value.abort instanceof AbortSignal ? value.abort : undefined;
}

function readErrorField(value: unknown, field: string): unknown {
  if (!isRecord(value)) return undefined;
  if (!isRecord(value.error)) return undefined;
  return value.error[field];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
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
    expect(
      validateToolDefinitions({ a: { args: { x: z.string() }, execute: async () => "ok" } }, "p")
        .ok,
    ).toBe(false);
    expect(
      validateToolDefinitions({ a: { description: "x", args: { x: z.string() } } }, "p").ok,
    ).toBe(false);
    expect(
      validateToolDefinitions({ a: { description: "x", execute: async () => "ok" } }, "p").ok,
    ).toBe(false);
    expect(
      validateToolDefinitions(
        { a: { description: "x", args: { x: "not a schema" }, execute: async () => "ok" } },
        "p",
      ).ok,
    ).toBe(false);
  });
});

describe("extractFleetContextFromUnknown", () => {
  test("merges fleet fields from args, context metadata, and event properties", () => {
    const context = {
      metadata: {
        fleet: {
          correlation_id: "corr_01ARZ3NDEKTSV4RRFFQ69G5FAV",
          wave_id: "W3",
        },
      },
    };
    const args = { plan_slug: "fleet-correlation" };
    const event = { properties: { lifecycle_object_id: "source-file:src/index.ts" } };

    const ctx = extractFleetContextFromUnknown(args, context, event);

    expect(String(ctx.plan_slug)).toBe("fleet-correlation");
    expect(String(ctx.correlation_id)).toBe("corr_01ARZ3NDEKTSV4RRFFQ69G5FAV");
    expect(String(ctx.wave_id)).toBe("W3");
    expect(String(ctx.lifecycle_object_id)).toBe("source-file:src/index.ts");
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

  test("argDigest is bounded and non-throwing for large or circular args", () => {
    const circular: Record<string, unknown> = { token: "secret", patchText: "x".repeat(50_000) };
    circular.self = circular;
    const digest = argDigest(circular);
    expect(digest.keys).toContain("token");
    expect(digest.keys).toContain("patchText");
    expect(digest.types.self).toBe("object");
    expect(digest.size).toBe(-1);

    const manyKeys: Record<string, unknown> = {};
    for (let i = 0; i < 100; i += 1) manyKeys[`k${i}`] = i;
    expect(argDigest(manyKeys).keys.length).toBe(32);
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

  test("wraps tool execute so thrown errors return structured failures by default", async () => {
    const path = trackTemp(tempTelemetry());
    const lifecycle = fleetContracts.parseLifecycleObjectId("source-file:src/index.ts");
    const concord = fleetContracts.parseConcordEventId("concord:42");
    if (!lifecycle.ok) throw new Error(lifecycle.reason);
    if (!concord.ok) throw new Error(concord.reason);
    const hash = "a".repeat(64);
    const artifact = fleetContracts.buildArtifactRef({
      kind: "fleet_report",
      path: "reports/fleet.json",
      hash,
    }).ref;
    const fleet = {
      workspace_id: fleetContracts.newWorkspaceId("/tmp/crashy"),
      plan_id: fleetContracts.newPlanId(),
      plan_slug: "fleet-correlation",
      wave_id: "W1",
      agent_run_id: fleetContracts.newAgentRunId(),
      correlation_id: fleetContracts.newCorrelationId(),
      spine_seq: 7,
      artifact_ref: artifact,
      lifecycle_object_id: lifecycle.value,
      concord_event_id: concord.value,
      fleet_run_id: fleetContracts.newFleetRunId(),
    };
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
    const execute = getExecute(crashRaw, "crash");
    const result = await execute({ msg: "hi" }, { metadata: { fleet } });
    assertToolFailureResult(result);
    expect(result.plugin).toBe("crashy");
    expect(result.tool).toBe("crash");
    expect(result.message).toBe("❌ [crashy].crash failed: inside");
    expect(result.output).toBe(result.message);
    expect(result.error.message).toBe("inside");
    expect(result.schema_version).toBe(1);
    expect(result.workspace_id).toBe(fleet.workspace_id);
    expect(result.plan_id).toBe(fleet.plan_id);
    expect(result.plan_slug).toBe(fleet.plan_slug);
    expect(result.wave_id).toBe(fleet.wave_id);
    expect(result.agent_run_id).toBe(fleet.agent_run_id);
    expect(result.correlation_id).toBe(fleet.correlation_id);
    expect(result.tool_call_id).not.toBeNull();
    if (result.tool_call_id === null) throw new Error("tool_call_id missing");
    expect(result.tool_call_id).toMatch(/^tool_/);
    expect(result.spine_seq).toBe(fleet.spine_seq);
    expect(result.artifact_ref).toBe(fleet.artifact_ref);
    expect(result.lifecycle_object_id).toBe(fleet.lifecycle_object_id);
    expect(result.concord_event_id).toBe(fleet.concord_event_id);
    expect(result.fleet_run_id).toBe(fleet.fleet_run_id);
    expect(readFileSync(path, "utf8")).toContain('"tool.failed"');
  });

  test("validates runtime tool args before calling execute", async () => {
    const path = trackTemp(tempTelemetry());
    let called = false;
    const wrapped = wrapPlugin(
      async () => ({
        tool: {
          required: {
            description: "requires msg",
            args: { msg: z.string() },
            execute: async () => {
              called = true;
              return "should not run";
            },
          },
        },
      }),
      { name: "validator", telemetryPath: path },
    );
    const hooks = await wrapped(stubInput);
    const requiredRaw = hooks.tool?.required;
    const execute = getExecute(requiredRaw, "required");

    const result = await execute(undefined, {});

    assertToolFailureResult(result);
    expect(called).toBe(false);
    expect(result.plugin).toBe("validator");
    expect(result.tool).toBe("required");
    expect(result.output).toBe(result.message);
    expect(result.error.name).toBe("ToolArgsValidationError");
    expect(result.error.code).toBe(ERROR_TOOL_ARGS_INVALID);
    expect(result.error.retryable).toBe(false);
    expect(result.error.message).toContain('arg "msg"');
    expect(readFileSync(path, "utf8")).toContain('"tool.failed"');
  });

  test("normalizes missing args to empty object for optional-only tools", async () => {
    const path = trackTemp(tempTelemetry());
    let observed: unknown;
    const wrapped = wrapPlugin(
      async () => ({
        tool: {
          optional: {
            description: "optional msg",
            args: { msg: z.string().optional() },
            execute: async (args: unknown) => {
              observed = args;
              return "ok";
            },
          },
        },
      }),
      { name: "validator", telemetryPath: path },
    );
    const hooks = await wrapped(stubInput);
    const optionalRaw = hooks.tool?.optional;
    const execute = getExecute(optionalRaw, "optional");

    const result = await execute(undefined, {});

    expect(result).toBe("ok");
    expect(observed).toEqual({});
    expect(readFileSync(path, "utf8")).toContain('"tool.executed"');
  });

  test("legacyErrorString restores old tool failure string", async () => {
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
      { name: "crashy", telemetryPath: path, legacyErrorString: true },
    );
    const hooks = await wrapped(stubInput);
    const crashRaw = hooks.tool?.crash;
    const execute = getExecute(crashRaw, "crash");
    const result = await execute({ msg: "hi" }, {});
    expect(result).toBe("❌ [crashy].crash failed: inside");
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

  test("repairs non-array system transform output", async () => {
    const path = trackTemp(tempTelemetry());
    const wrapped = wrapPlugin(
      async () => ({
        "experimental.chat.system.transform": async (
          _input: unknown,
          output: { system: unknown },
        ) => {
          output.system = "not an array";
        },
      }),
      { name: "transformer", telemetryPath: path },
    );
    const hooks = await wrapped(stubInput);
    const transform = hooks["experimental.chat.system.transform"];
    if (!transform) throw new Error("transform hook not registered");
    const out = { system: ["original"] };
    await transform({ sessionID: "s", model: {} }, out);
    expect(out.system).toEqual([]);
  });

  test("repairs simple OpenCode hook output shapes", async () => {
    const path = trackTemp(tempTelemetry());
    const wrapped = wrapPlugin(
      async () => ({
        "chat.headers": async (_input: unknown, output: Record<string, unknown>) => {
          output.headers = { ok: "yes", bad: 1 };
        },
        "shell.env": async (_input: unknown, output: Record<string, unknown>) => {
          output.env = "bad";
        },
        "experimental.session.compacting": async (
          _input: unknown,
          output: Record<string, unknown>,
        ) => {
          output.context = ["keep", undefined, ""];
          output.prompt = 1;
        },
        "experimental.compaction.autocontinue": async (
          _input: unknown,
          output: Record<string, unknown>,
        ) => {
          output.enabled = "bad";
        },
        "experimental.text.complete": async (_input: unknown, output: Record<string, unknown>) => {
          output.text = undefined;
        },
        "tool.definition": async (_input: unknown, output: Record<string, unknown>) => {
          output.description = null;
        },
      }),
      { name: "shape-guard", telemetryPath: path },
    );
    const hooks = await wrapped(stubInput);
    const headers = { headers: {} };
    await hooks["chat.headers"]?.({ sessionID: "s" }, headers);
    expect(headers.headers).toEqual({ ok: "yes" });
    const env: Record<string, unknown> = { env: { PATH: "/bin" } };
    await hooks["shell.env"]?.({ cwd: "/tmp" }, env);
    expect(env.env).toEqual({});
    const compacting: Record<string, unknown> = { context: [], prompt: "old" };
    await hooks["experimental.session.compacting"]?.({ sessionID: "s" }, compacting);
    expect(compacting.context).toEqual(["keep"]);
    expect("prompt" in compacting).toBe(false);
    const autocontinue = { enabled: true };
    await hooks["experimental.compaction.autocontinue"]?.({ sessionID: "s" }, autocontinue);
    expect(autocontinue.enabled).toBe(true);
    const complete = { text: "previous" };
    await hooks["experimental.text.complete"]?.({ sessionID: "s" }, complete);
    expect(complete.text).toBe("previous");
    const definition = { description: "previous", parameters: {} };
    await hooks["tool.definition"]?.({ toolID: "read" }, definition);
    expect(definition.description).toBe("previous");
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
    const wrapped = wrapPlugin(async () => ({ tool: { codemem_check: badTool } }), {
      name: "codemem-style",
      telemetryPath: path,
    });
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
    if (!isRecord(meta)) throw new Error("metadata not set");
    const traceId = meta.trace_id;
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
    const execute = getExecute(pingRaw, "ping");
    await execute({}, { sessionID: "s", callID: "c", metadata: { trace_id: "trc_test" } });
    const log = readFileSync(path, "utf8");
    expect(log).toContain('"tool.executed"');
    expect(log).toContain('"trace_id":"trc_test"');
  });

  test("canonical envelope emission validates through fleet contracts", async () => {
    const path = trackTemp(tempTelemetry());
    const wrapped = wrapPlugin(
      async () => ({
        tool: { ping: { description: "ping", args: {}, execute: async () => "pong" } },
      }),
      { name: "canonical", telemetryPath: path },
    );
    const hooks = await wrapped(stubInput);
    const pingRaw = hooks.tool?.ping;
    const execute = getExecute(pingRaw, "ping");
    await execute({}, { sessionID: "s", callID: "c" });
    const executed = telemetryByKind(path, "tool.executed").at(-1);
    expect(executed).toBeDefined();
    const validation = fleetContracts.validateTelemetryEnvelope(executed);
    expect(validation.ok).toBe(true);
  });

  test("correlation_id from context.metadata.fleet flows to envelope", async () => {
    const path = trackTemp(tempTelemetry());
    const correlationId = fleetContracts.newCorrelationId();
    const wrapped = wrapPlugin(
      async () => ({
        tool: { ping: { description: "ping", args: {}, execute: async () => "pong" } },
      }),
      { name: "correlator", telemetryPath: path },
    );
    const hooks = await wrapped(stubInput);
    const pingRaw = hooks.tool?.ping;
    const execute = getExecute(pingRaw, "ping");
    await execute({}, { metadata: { fleet: { correlation_id: correlationId } } });
    const executed = telemetryByKind(path, "tool.executed").at(-1);
    expect(executed?.correlation_id).toBe(String(correlationId));
  });

  test("missing correlation_id generates a canonical correlation id", async () => {
    const path = trackTemp(tempTelemetry());
    const wrapped = wrapPlugin(
      async () => ({
        tool: { ping: { description: "ping", args: {}, execute: async () => "pong" } },
      }),
      { name: "generator", telemetryPath: path },
    );
    const hooks = await wrapped(stubInput);
    const pingRaw = hooks.tool?.ping;
    const execute = getExecute(pingRaw, "ping");
    await execute({}, {});
    const executed = telemetryByKind(path, "tool.executed").at(-1);
    expect(typeof executed?.correlation_id).toBe("string");
    expect(fleetContracts.parseCorrelationId(String(executed?.correlation_id)).ok).toBe(true);
  });

  test("fresh tool_call_id is generated per invocation", async () => {
    const path = trackTemp(tempTelemetry());
    const wrapped = wrapPlugin(
      async () => ({
        tool: { ping: { description: "ping", args: {}, execute: async () => "pong" } },
      }),
      { name: "tool-caller", telemetryPath: path },
    );
    const hooks = await wrapped(stubInput);
    const pingRaw = hooks.tool?.ping;
    const execute = getExecute(pingRaw, "ping");
    await execute({}, {});
    await execute({}, {});
    const executed = telemetryByKind(path, "tool.executed");
    const first = executed.at(-2)?.tool_call_id;
    const second = executed.at(-1)?.tool_call_id;
    expect(typeof first).toBe("string");
    expect(typeof second).toBe("string");
    expect(first).not.toBe(second);
    expect(fleetContracts.parseToolCallId(String(first)).ok).toBe(true);
    expect(fleetContracts.parseToolCallId(String(second)).ok).toBe(true);
  });

  test("defaultTimeoutMs returns E_TIMEOUT structured failure", async () => {
    const path = trackTemp(tempTelemetry());
    const wrapped = wrapPlugin(
      async () => ({
        tool: {
          slow_tool: {
            description: "slow",
            args: {},
            execute: async () => {
              await sleep(300);
              return "late";
            },
          },
        },
      }),
      { name: "timeout", telemetryPath: path, defaultTimeoutMs: 100 },
    );
    const hooks = await wrapped(stubInput);
    const slowRaw = hooks.tool?.slow_tool;
    const execute = getExecute(slowRaw, "slow");
    const result = await execute({}, {});
    assertToolFailureResult(result);
    expect(result.error.code).toBe(ERROR_TIMEOUT);
    expect(result.error.retryable).toBe(true);
    const failed = telemetryByKind(path, "tool.failed").at(-1);
    expect(readErrorField(failed, "code")).toBe(ERROR_TIMEOUT);
    expect(readErrorField(failed, "retryable")).toBe(true);
  });

  test("toolTimeouts per-tool override takes precedence over global default", async () => {
    const path = trackTemp(tempTelemetry());
    const wrapped = wrapPlugin(
      async () => ({
        tool: {
          slow_tool: {
            description: "slow",
            args: {},
            execute: async () => {
              await sleep(200);
              return "late";
            },
          },
        },
      }),
      {
        name: "timeout",
        telemetryPath: path,
        defaultTimeoutMs: 1000,
        toolTimeouts: { slow_tool: 50 },
      },
    );
    const hooks = await wrapped(stubInput);
    const slowRaw = hooks.tool?.slow_tool;
    const execute = getExecute(slowRaw, "slow");
    const result = await execute({}, {});
    assertToolFailureResult(result);
    expect(result.error.code).toBe(ERROR_TIMEOUT);
  });

  test("AbortSignal is passed to plugins and fires on timeout", async () => {
    let aborted = false;
    const path = trackTemp(tempTelemetry());
    const wrapped = wrapPlugin(
      async () => ({
        tool: {
          slow_tool: {
            description: "slow",
            args: {},
            execute: async (_args: unknown, ctx: unknown) => {
              const signal = readSignal(ctx);
              signal?.addEventListener("abort", () => {
                aborted = true;
              });
              await sleep(200);
              return "late";
            },
          },
        },
      }),
      { name: "abortable", telemetryPath: path, defaultTimeoutMs: 50 },
    );
    const hooks = await wrapped(stubInput);
    const slowRaw = hooks.tool?.slow_tool;
    const execute = getExecute(slowRaw, "slow");
    await execute({}, {});
    expect(aborted).toBe(true);
  });

  test("public OpenCode abort signal fires on timeout", async () => {
    let aborted = false;
    const path = trackTemp(tempTelemetry());
    const wrapped = wrapPlugin(
      async () => ({
        tool: {
          slow_tool: {
            description: "slow",
            args: {},
            execute: async (_args: unknown, ctx: unknown) => {
              const abort = readAbort(ctx);
              abort?.addEventListener("abort", () => {
                aborted = true;
              });
              await sleep(200);
              return "late";
            },
          },
        },
      }),
      { name: "abortable", telemetryPath: path, defaultTimeoutMs: 50 },
    );
    const hooks = await wrapped(stubInput);
    const slowRaw = hooks.tool?.slow_tool;
    const execute = getExecute(slowRaw, "slow");
    const result = await execute({}, { abort: new AbortController().signal });
    assertToolFailureResult(result);
    expect(result.error.code).toBe(ERROR_TIMEOUT);
    expect(aborted).toBe(true);
  });

  test("non-cooperative tools may continue after timeout if they ignore AbortSignal", async () => {
    let settledLate = false;
    const path = trackTemp(tempTelemetry());
    const wrapped = wrapPlugin(
      async () => ({
        tool: {
          ignores_signal: {
            description: "ignores signal",
            args: {},
            execute: async () => {
              await sleep(60);
              settledLate = true;
              return "late";
            },
          },
        },
      }),
      { name: "noncooperative", telemetryPath: path, defaultTimeoutMs: 10 },
    );
    const hooks = await wrapped(stubInput);
    const raw = hooks.tool?.ignores_signal;
    const execute = getExecute(raw, "ignores_signal");
    const result = await execute({}, {});
    assertToolFailureResult(result);
    expect(result.error.code).toBe(ERROR_TIMEOUT);
    expect(settledLate).toBe(false);
    await sleep(80);
    expect(settledLate).toBe(true);
  });

  test("tool execute receives injected context.metadata.fleet without mutating caller context", async () => {
    let observedToolCallId: unknown;
    const path = trackTemp(tempTelemetry());
    const wrapped = wrapPlugin(
      async () => ({
        tool: {
          ping: {
            description: "ping",
            args: {},
            execute: async (_args: unknown, ctx: unknown) => {
              observedToolCallId = readToolCallId(ctx);
              return "pong";
            },
          },
        },
      }),
      { name: "fleet-context", telemetryPath: path },
    );
    const hooks = await wrapped(stubInput);
    const pingRaw = hooks.tool?.ping;
    const execute = getExecute(pingRaw, "ping");
    const originalContext = { metadata: {} };
    await execute({}, originalContext);
    expect(fleetContracts.parseToolCallId(String(observedToolCallId)).ok).toBe(true);
    expect(originalContext.metadata).toEqual({});
  });

  test("tool execute preserves OpenCode metadata function and enriches metadata calls", async () => {
    const calls: unknown[] = [];
    let observedFunctionFleet: unknown;
    const path = trackTemp(tempTelemetry());
    const wrapped = wrapPlugin(
      async () => ({
        tool: {
          ping: {
            description: "ping",
            args: {},
            execute: async (_args: unknown, ctx: unknown) => {
              if (!isRecord(ctx) || typeof ctx.metadata !== "function") {
                throw new Error("metadata function missing");
              }
              observedFunctionFleet = Reflect.get(ctx.metadata, "fleet");
              ctx.metadata({ title: "progress", metadata: { existing: "yes" } });
              return "pong";
            },
          },
        },
      }),
      { name: "fleet-context", telemetryPath: path },
    );
    const hooks = await wrapped(stubInput);
    const pingRaw = hooks.tool?.ping;
    const execute = getExecute(pingRaw, "ping");
    const originalMetadata = (input: unknown): void => {
      calls.push(input);
    };

    const result = await execute({}, { metadata: originalMetadata });

    expect(result).toBe("pong");
    expect(typeof originalMetadata).toBe("function");
    expect(Reflect.get(originalMetadata, "fleet")).toBeUndefined();
    expect(isRecord(observedFunctionFleet)).toBe(true);
    if (!isRecord(observedFunctionFleet)) return;
    expect(fleetContracts.parseToolCallId(String(observedFunctionFleet.tool_call_id)).ok).toBe(
      true,
    );
    expect(calls.length).toBe(1);
    const call = calls[0];
    expect(isRecord(call)).toBe(true);
    if (!isRecord(call) || !isRecord(call.metadata)) return;
    expect(call.metadata.existing).toBe("yes");
    expect(isRecord(call.metadata.fleet)).toBe(true);
    if (!isRecord(call.metadata.fleet)) return;
    expect(fleetContracts.parseToolCallId(String(call.metadata.fleet.tool_call_id)).ok).toBe(true);
  });

  test("tool.execute.before hook receives injected args.metadata.fleet", async () => {
    let observedToolCallId: unknown;
    const path = trackTemp(tempTelemetry());
    const wrapped = wrapPlugin(
      async () => ({
        "tool.execute.before": async (_input: unknown, output: { args: unknown }) => {
          observedToolCallId = readToolCallId(output.args);
        },
        tool: { ping: { description: "ping", args: {}, execute: async () => "pong" } },
      }),
      { name: "before-hook", telemetryPath: path },
    );
    const hooks = await wrapped(stubInput);
    const before = hooks["tool.execute.before"];
    if (!before) throw new Error("before hook not registered");
    await before({ tool: "ping", sessionID: "s", callID: "c" }, { args: {} });
    expect(fleetContracts.parseToolCallId(String(observedToolCallId)).ok).toBe(true);
  });

  // ── Regression: HOTFIX-HA1 — tool.execute.before must preserve input args ──

  test("mergeToolExecuteBeforeHookArgs overlays output onto input", () => {
    expect(
      mergeToolExecuteBeforeHookArgs(
        { filePath: "a.ts", oldString: "x" },
        { filePath: "b.ts", metadata: { trace: "t" } },
      ),
    ).toEqual({ filePath: "b.ts", oldString: "x", metadata: { trace: "t" } });
    expect(mergeToolExecuteBeforeHookArgs(undefined, { x: 1 })).toEqual({ x: 1 });
    expect(mergeToolExecuteBeforeHookArgs({ x: 1 }, undefined)).toEqual({ x: 1 });
    expect(mergeToolExecuteBeforeHookArgs("bad", "also")).toEqual({});
  });

  test("tool.execute.before preserves apply_patch input args when injecting fleet metadata", async () => {
    let observedArgs: unknown;
    const path = trackTemp(tempTelemetry());
    const wrapped = wrapPlugin(
      async () => ({
        "tool.execute.before": async (_input: unknown, output: { args: unknown }) => {
          observedArgs = output.args;
        },
        tool: { apply_patch: { description: "patch", args: {}, execute: async () => "ok" } },
      }),
      { name: "hotfix-ha1-patch", telemetryPath: path },
    );
    const hooks = await wrapped(stubInput);
    const before = hooks["tool.execute.before"];
    if (!before) throw new Error("before hook not registered");
    // Simulate: input carries real tool args; output.args is empty (OpenCode default)
    await before(
      {
        tool: "apply_patch",
        sessionID: "s",
        callID: "c",
        args: { patchText: "hunk content", filePath: "/tmp/x" },
      },
      { args: {} },
    );
    if (!isRecord(observedArgs)) throw new Error("observed args must be a record");
    // Original input args must survive injection
    expect(observedArgs.patchText).toBe("hunk content");
    expect(observedArgs.filePath).toBe("/tmp/x");
    // Fleet metadata must also be present
    expect(fleetContracts.parseToolCallId(String(readToolCallId(observedArgs))).ok).toBe(true);
  });

  test("tool.execute.before preserves edit tool args (filePath, oldString)", async () => {
    let observedArgs: unknown;
    const path = trackTemp(tempTelemetry());
    const wrapped = wrapPlugin(
      async () => ({
        "tool.execute.before": async (_input: unknown, output: { args: unknown }) => {
          observedArgs = output.args;
        },
        tool: { edit: { description: "edit", args: {}, execute: async () => "ok" } },
      }),
      { name: "hotfix-ha1-edit", telemetryPath: path },
    );
    const hooks = await wrapped(stubInput);
    const before = hooks["tool.execute.before"];
    if (!before) throw new Error("before hook not registered");
    await before(
      {
        tool: "edit",
        sessionID: "s",
        callID: "c",
        args: { filePath: "/tmp/foo.ts", oldString: "old code", newString: "new code" },
      },
      { args: {} },
    );
    if (!isRecord(observedArgs)) throw new Error("observed args must be a record");
    expect(observedArgs.filePath).toBe("/tmp/foo.ts");
    expect(observedArgs.oldString).toBe("old code");
    expect(observedArgs.newString).toBe("new code");
    expect(fleetContracts.parseToolCallId(String(readToolCallId(observedArgs))).ok).toBe(true);
  });

  test("tool.execute.before preserves write tool args (content)", async () => {
    let observedArgs: unknown;
    const path = trackTemp(tempTelemetry());
    const wrapped = wrapPlugin(
      async () => ({
        "tool.execute.before": async (_input: unknown, output: { args: unknown }) => {
          observedArgs = output.args;
        },
        tool: { write: { description: "write", args: {}, execute: async () => "ok" } },
      }),
      { name: "hotfix-ha1-write", telemetryPath: path },
    );
    const hooks = await wrapped(stubInput);
    const before = hooks["tool.execute.before"];
    if (!before) throw new Error("before hook not registered");
    await before(
      {
        tool: "write",
        sessionID: "s",
        callID: "c",
        args: { filePath: "/tmp/out.txt", content: "hello world" },
      },
      { args: {} },
    );
    if (!isRecord(observedArgs)) throw new Error("observed args must be a record");
    expect(observedArgs.filePath).toBe("/tmp/out.txt");
    expect(observedArgs.content).toBe("hello world");
    expect(fleetContracts.parseToolCallId(String(readToolCallId(observedArgs))).ok).toBe(true);
  });
});
