import { describe, expect, test } from "bun:test";
import {
  ERROR_TOOL_ARGS_INVALID,
  ToolArgsValidationError,
  validateToolArgs,
} from "../src/index.ts";

describe("validateToolArgs", () => {
  test("normalizes missing args to empty object", () => {
    const result = validateToolArgs("optional", { msg: optionalStringSchema() }, undefined);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toEqual({});
  });

  test("rejects non-object runtime args", () => {
    const result = validateToolArgs("bad", {}, "not an object");

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBeInstanceOf(ToolArgsValidationError);
    expect(result.error.code).toBe(ERROR_TOOL_ARGS_INVALID);
    expect(result.error.retryable).toBe(false);
    expect(result.error.message).toContain("args must be an object");
  });

  test("rejects missing required schema fields with field-level messages", () => {
    const result = validateToolArgs("required", { msg: requiredStringSchema() }, {});

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.name).toBe("ToolArgsValidationError");
    expect(result.error.message).toContain('arg "msg"');
    expect(result.error.message).toContain("expected string");
  });

  test("returns parsed schema output without adding omitted optional keys", () => {
    const result = validateToolArgs(
      "coerce",
      { count: numberFromStringSchema(), msg: optionalStringSchema() },
      { count: "3" },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toEqual({ count: 3 });
    expect(Object.prototype.hasOwnProperty.call(result.value, "msg")).toBe(false);
  });
});

function requiredStringSchema(): Record<string, unknown> {
  return {
    safeParse(
      value: unknown,
    ): { success: true; data: string } | { success: false; error: unknown } {
      if (typeof value === "string") return { success: true, data: value };
      return { success: false, error: { issues: [{ message: "expected string" }] } };
    },
  };
}

function optionalStringSchema(): Record<string, unknown> {
  return {
    safeParse(
      value: unknown,
    ): { success: true; data: string | undefined } | { success: false; error: unknown } {
      if (value === undefined) return { success: true, data: undefined };
      if (typeof value === "string") return { success: true, data: value };
      return { success: false, error: { issues: [{ message: "expected string" }] } };
    },
  };
}

function numberFromStringSchema(): Record<string, unknown> {
  return {
    safeParse(
      value: unknown,
    ): { success: true; data: number } | { success: false; error: unknown } {
      const parsed = typeof value === "string" ? Number(value) : NaN;
      if (Number.isFinite(parsed)) return { success: true, data: parsed };
      return { success: false, error: { issues: [{ message: "expected numeric string" }] } };
    },
  };
}
