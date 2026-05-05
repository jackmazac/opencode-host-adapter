/**
 * Runtime tool argument validation.
 *
 * OpenCode can invoke tool handlers with malformed payloads before TypeScript
 * can help. This module owns that boundary: normalize runtime args, validate
 * each declared raw-shape schema, and return structured non-retryable errors.
 */

import { ToolArgsValidationError } from "./errors.ts";

export type ToolArgs = Record<string, unknown>;

type SchemaParseResult = { success: true; data: unknown } | { success: false; error: unknown };

type SchemaLike = {
  safeParse: (value: unknown) => SchemaParseResult;
};

export function validateToolArgs(
  toolName: string,
  schemaShape: Record<string, unknown>,
  rawArgs: unknown,
): { ok: true; value: ToolArgs } | { ok: false; error: ToolArgsValidationError } {
  const args = normalizeToolArgs(toolName, rawArgs);
  if (!args.ok) return args;

  const validated: ToolArgs = { ...args.value };
  for (const [argName, rawSchema] of Object.entries(schemaShape)) {
    const schema = schemaLike(rawSchema);
    if (!schema) {
      return {
        ok: false,
        error: new ToolArgsValidationError(
          `invalid schema for ${toolName}.${argName}: schema does not support safeParse`,
        ),
      };
    }
    const parsed = schema.safeParse(args.value[argName]);
    if (!parsed.success) {
      return {
        ok: false,
        error: new ToolArgsValidationError(
          `invalid args for ${toolName}: arg "${argName}" ${formatSchemaError(parsed.error)}`,
        ),
      };
    }
    if (parsed.data !== undefined || Object.prototype.hasOwnProperty.call(args.value, argName)) {
      validated[argName] = parsed.data;
    }
  }
  return { ok: true, value: validated };
}

function normalizeToolArgs(
  toolName: string,
  rawArgs: unknown,
): { ok: true; value: ToolArgs } | { ok: false; error: ToolArgsValidationError } {
  if (rawArgs === undefined || rawArgs === null) return { ok: true, value: {} };
  if (!isRecord(rawArgs)) {
    return {
      ok: false,
      error: new ToolArgsValidationError(`invalid args for ${toolName}: args must be an object`),
    };
  }
  return { ok: true, value: rawArgs };
}

function schemaLike(value: unknown): SchemaLike | undefined {
  if (!isRecord(value)) return undefined;
  const safeParse = Reflect.get(value, "safeParse");
  if (typeof safeParse !== "function") return undefined;
  return {
    safeParse(input: unknown): SchemaParseResult {
      const result: unknown = Reflect.apply(safeParse, value, [input]);
      if (isSchemaParseResult(result)) return result;
      return {
        success: false,
        error: new Error("schema safeParse did not return a parse result"),
      };
    },
  };
}

function isSchemaParseResult(value: unknown): value is SchemaParseResult {
  if (!isRecord(value)) return false;
  if (value.success === true) return "data" in value;
  if (value.success === false) return "error" in value;
  return false;
}

function formatSchemaError(error: unknown): string {
  if (!isRecord(error)) return `is invalid: ${String(error)}`;
  const issues = error.issues;
  if (Array.isArray(issues)) {
    const first = issues.find(isRecord);
    if (first) {
      const message = typeof first.message === "string" ? first.message : "is invalid";
      return message.startsWith("is ") ? message : `is invalid: ${message}`;
    }
  }
  const message = typeof error.message === "string" ? error.message : "is invalid";
  return message.startsWith("is ") ? message : `is invalid: ${message}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
