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
import type { ToolDefinitionResolved, ToolValidationResult, WrapOptions } from "./types.ts";
export declare function looksLikeZodSchema(value: unknown): boolean;
export declare function validateToolDefinition(toolName: string, def: unknown, opts: {
    name: string;
}): {
    ok: true;
    resolved: ToolDefinitionResolved;
} | {
    ok: false;
    error: string;
};
/**
 * Standalone validator for the entire tool map.
 *
 * Used by the preflight script and contract tests.
 */
export declare function validateToolDefinitions(tools: unknown, pluginName: string): ToolValidationResult;
export declare function fail(opts: Pick<WrapOptions, "strict" | "name">, message: string): void;
