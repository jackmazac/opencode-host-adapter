/**
 * Runtime tool argument validation.
 *
 * OpenCode can invoke tool handlers with malformed payloads before TypeScript
 * can help. This module owns that boundary: normalize runtime args, validate
 * each declared raw-shape schema, and return structured non-retryable errors.
 */
import { ToolArgsValidationError } from "./errors.ts";
export type ToolArgs = Record<string, unknown>;
export declare function validateToolArgs(toolName: string, schemaShape: Record<string, unknown>, rawArgs: unknown): {
    ok: true;
    value: ToolArgs;
} | {
    ok: false;
    error: ToolArgsValidationError;
};
