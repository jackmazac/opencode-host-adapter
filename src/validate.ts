/**
 * Tool definition validation.
 *
 * Catches the codemem-style bug at registration time:
 *   args: z.object({...})    ← WRONG (causes opencode TypeError on registration)
 *   args: { foo: z.string() } ← RIGHT (ZodRawShape literal)
 *
 * Also enforces:
 *   - description is a non-empty string
 *   - execute is a function
 *   - each arg value is a zod schema (has _zod or _def)
 */

import type { ToolDefinitionResolved, ToolLike, ToolValidationResult, WrapOptions } from "./types.ts";

export function looksLikeZodSchema(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return Boolean(v._zod) || Boolean(v._def);
}

export function validateToolDefinition(
  toolName: string,
  def: unknown,
  opts: { name: string },
): { ok: true; resolved: ToolDefinitionResolved } | { ok: false; error: string } {
  const t = def as ToolLike;
  if (!t || typeof t !== "object") {
    return {
      ok: false,
      error: `[host:${opts.name}] tool "${toolName}" is not an object: ${typeof t}`,
    };
  }

  if (typeof t.description !== "string" || t.description.length === 0) {
    return {
      ok: false,
      error: `[host:${opts.name}] tool "${toolName}" missing/empty description`,
    };
  }

  if (typeof t.execute !== "function") {
    return {
      ok: false,
      error: `[host:${opts.name}] tool "${toolName}" execute is not a function`,
    };
  }

  if (t.args === undefined || t.args === null) {
    return {
      ok: false,
      error: `[host:${opts.name}] tool "${toolName}" missing args (must be a Record<string, ZodSchema> object literal)`,
    };
  }

  if (typeof t.args !== "object") {
    return {
      ok: false,
      error: `[host:${opts.name}] tool "${toolName}" args is not an object: ${typeof t.args}`,
    };
  }

  if (looksLikeZodSchema(t.args)) {
    return {
      ok: false,
      error:
        `[host:${opts.name}] tool "${toolName}" args is a ZodObject (or other zod schema). ` +
        "It must be a plain object literal: `{ field1: z.string(), field2: z.number() }`, " +
        "NOT `z.object({ ... })`. " +
        "This is the codemem-style bug that crashes opencode's tool registry with " +
        "\"undefined is not an object (evaluating 'n._zod.def')\".",
    };
  }

  for (const [argName, argSchema] of Object.entries(t.args as Record<string, unknown>)) {
    if (!looksLikeZodSchema(argSchema)) {
      return {
        ok: false,
        error: `[host:${opts.name}] tool "${toolName}" arg "${argName}" is not a zod schema (no _zod or _def): typeof=${typeof argSchema}`,
      };
    }
  }

  return {
    ok: true,
    resolved: t as ToolDefinitionResolved,
  };
}

/**
 * Standalone validator for the entire tool map.
 *
 * Used by the preflight script and contract tests.
 */
export function validateToolDefinitions(
  tools: unknown,
  pluginName: string,
): ToolValidationResult {
  if (!tools) return { ok: true };
  if (typeof tools !== "object") {
    return { ok: false, errors: [`[${pluginName}] hooks.tool is not an object`] };
  }

  const errors: string[] = [];
  for (const [name, def] of Object.entries(tools as Record<string, unknown>)) {
    const result = validateToolDefinition(name, def, { name: pluginName });
    if (!result.ok) errors.push(result.error);
  }
  return errors.length === 0 ? { ok: true } : { ok: false, errors };
}

export function fail(opts: Pick<WrapOptions, "strict" | "name">, message: string): void {
  if (opts.strict) {
    throw new Error(message);
  }
  console.error(message);
}
