/**
 * compat.test.ts
 *
 * Forward-compatibility fixture tests: prove that the event shapes Host Adapter
 * emits today can be decoded / validated through the new contract validators.
 *
 * This test does NOT change any runtime behaviour — it documents the gap between
 * today's Host Adapter output and the canonical envelope, so Wave 1 work has a
 * clear acceptance criteria.
 */
import { describe, expect, test } from "bun:test";

// Primary import path: via the root namespace export of the Host Adapter.
import { fleetContracts } from "../src/index.ts";
const { validateTelemetryEnvelope, decodeFleetContext, makeEnvelope, parseToolCallId } =
  fleetContracts;

// Secondary import path: via the ./contracts subpath.
// Both must resolve to the exact same runtime module (file-identity).
import * as contracts from "../src/contracts.ts";

// ── Shared identity check ────────────────────────────────────────────────────

describe("re-export identity", () => {
  test("contracts subpath and root namespace share the same runtime objects", () => {
    // If the two imports are the same ES module instance, all function
    // references will be ===. This ensures we have one copy, not two.
    expect(contracts.validateTelemetryEnvelope).toBe(fleetContracts.validateTelemetryEnvelope);
    expect(contracts.makeEnvelope).toBe(fleetContracts.makeEnvelope);
    expect(contracts.decodeFleetContext).toBe(fleetContracts.decodeFleetContext);
    expect(contracts.parseToolCallId).toBe(fleetContracts.parseToolCallId);
  });
});

// ── Canonical telemetry envelope fixtures ────────────────────────────────────

describe("validateTelemetryEnvelope — Host Adapter event shapes", () => {
  // (a) plugin.loaded — the minimal Host Adapter lifecycle event
  test("plugin.loaded envelope passes validator when all ID fields are null", () => {
    const fixture = {
      schema_version: 1,
      ts: new Date().toISOString(),
      kind: "plugin.loaded",
      plugin: "conductor",
      status: "ok",
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
    const result = validateTelemetryEnvelope(fixture);
    expect(result.ok).toBe(true);
  });

  // (b) tool.executed with OpenCode passthrough IDs in the opencode slot
  test("tool.executed envelope with opencode passthrough validates", () => {
    const fixture = {
      schema_version: 1,
      ts: new Date().toISOString(),
      kind: "tool.executed",
      plugin: "conductor",
      tool: "memory",
      durationMs: 42,
      status: "ok",
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
      opencode: { sessionID: "ses_abc", callID: "call_xyz" },
    };
    const result = validateTelemetryEnvelope(fixture);
    expect(result.ok).toBe(true);
  });

  // (c) tool.failed with a structured error payload
  test("tool.failed with structured error validates", () => {
    const fixture = {
      schema_version: 1,
      ts: new Date().toISOString(),
      kind: "tool.failed",
      plugin: "codemem",
      tool: "graph_query",
      status: "error",
      error: { message: "boom", name: "Error", code: "E_THROW", retryable: false },
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
    const result = validateTelemetryEnvelope(fixture);
    expect(result.ok).toBe(true);
  });
});

// ── Legacy trace_id gap documentation ────────────────────────────────────────

describe("parseToolCallId — legacy trace_id format", () => {
  // (d) Today's Host Adapter generates trace_id as `trc_<date36>_<rand8>`.
  //     That format does NOT pass parseToolCallId because canonical ToolCallId
  //     requires the `tool_` prefix followed by a ULID.
  //     Wave 1 will change trace_id generation to newToolCallId().
  test("Host Adapter legacy trc_ trace_id is not a canonical ToolCallId", () => {
    const legacyTraceId = "trc_abc_12345678";
    const result = parseToolCallId(legacyTraceId);
    expect(result.ok).toBe(false);
    // The reason should mention the expected prefix or format
    if (!result.ok) {
      expect(typeof result.reason).toBe("string");
      expect(result.reason.length).toBeGreaterThan(0);
    }
  });

  test("canonical tool_ prefixed id with ULID parses correctly", () => {
    // Canonical format: tool_<26-char ULID>
    const canonicalId = "tool_01ARZ3NDEKTSV4RRFFQ69G5FAV";
    const result = parseToolCallId(canonicalId);
    expect(result.ok).toBe(true);
  });
});

// ── FleetContext decode fixtures ──────────────────────────────────────────────

describe("decodeFleetContext", () => {
  // (e) OpenCode's own sessionID / callID live in the envelope's `opencode` slot,
  //     not in the FleetContext. An object with only `opencode` fields should
  //     decode to an empty FleetContext (all IDs null) with ok: true.
  test("opencode sessionID/callID are not fleet IDs — decodes to empty context", () => {
    // NOTE: decodeFleetContext operates on a plain object of fleet ID fields.
    // The opencode slot is NOT part of FleetContext; passing an object with
    // only `opencode.*` keys yields an empty context — all fleet IDs are absent.
    const input = { opencode: { sessionID: "ses_a", callID: "call_b" } };
    const result = decodeFleetContext(input);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.workspace_id).toBeNull();
      expect(result.value.agent_run_id).toBeNull();
      expect(result.value.plan_id).toBeNull();
      expect(result.value.correlation_id).toBeNull();
      expect(result.value.tool_call_id).toBeNull();
    }
  });

  // (g) Snake_case context decode from plain object
  test("snake_case context fields decode to populated FleetContext", () => {
    const input = {
      workspace_id: "ws_0123456789abcdef",
      agent_run_id: "run_01ARZ3NDEKTSV4RRFFQ69G5FAV",
    };
    const result = decodeFleetContext(input);
    expect(result.ok).toBe(true);
    if (result.ok) {
      // Branded types are string at runtime; String() extracts without assertion.
      expect(String(result.value.workspace_id)).toBe("ws_0123456789abcdef");
      expect(String(result.value.agent_run_id)).toBe("run_01ARZ3NDEKTSV4RRFFQ69G5FAV");
      // Fields not provided remain null
      expect(result.value.plan_id).toBeNull();
      expect(result.value.tool_call_id).toBeNull();
    }
  });

  // (h) CamelCase context decode — same IDs, different key style
  test("camelCase context fields decode to the same FleetContext as snake_case", () => {
    const input = {
      workspaceId: "ws_0123456789abcdef",
      agentRunId: "run_01ARZ3NDEKTSV4RRFFQ69G5FAV",
    };
    const result = decodeFleetContext(input);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(String(result.value.workspace_id)).toBe("ws_0123456789abcdef");
      expect(String(result.value.agent_run_id)).toBe("run_01ARZ3NDEKTSV4RRFFQ69G5FAV");
      expect(result.value.plan_id).toBeNull();
      expect(result.value.tool_call_id).toBeNull();
    }
  });
});

// ── makeEnvelope round-trip ───────────────────────────────────────────────────

describe("makeEnvelope — round-trip through validateTelemetryEnvelope", () => {
  // (f) plugin.validation_failed — the envelope created by makeEnvelope must
  //     pass validateTelemetryEnvelope (which makeEnvelope already calls
  //     internally, but this test verifies the re-export chain produces a
  //     valid shape when invoked through the Host Adapter surface).
  test("plugin.validation_failed round-trips through makeEnvelope + validate", () => {
    const envelope = makeEnvelope({
      kind: "plugin.validation_failed",
      plugin: "example",
      status: "error",
      error: { message: "args is ZodObject, not raw shape" },
    });
    // makeEnvelope throws on invalid input, so if we reach here it already
    // validated. The explicit re-validation confirms the subpath export
    // returns a type-consistent shape.
    const result = validateTelemetryEnvelope(envelope);
    expect(result.ok).toBe(true);
  });
});
