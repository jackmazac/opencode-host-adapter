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
export function looksLikeZodSchema(value) {
    if (!value || typeof value !== "object")
        return false;
    if (!isRecord(value))
        return false;
    return Boolean(value._zod) || Boolean(value._def);
}
export function validateToolDefinition(toolName, def, opts) {
    if (!isRecord(def)) {
        return {
            ok: false,
            error: `[host:${opts.name}] tool "${toolName}" is not an object: ${typeof def}`,
        };
    }
    const description = def.description;
    if (typeof description !== "string" || description.length === 0) {
        return {
            ok: false,
            error: `[host:${opts.name}] tool "${toolName}" missing/empty description`,
        };
    }
    const execute = def.execute;
    if (!isExecute(execute)) {
        return {
            ok: false,
            error: `[host:${opts.name}] tool "${toolName}" execute is not a function`,
        };
    }
    const args = def.args;
    if (args === undefined || args === null) {
        return {
            ok: false,
            error: `[host:${opts.name}] tool "${toolName}" missing args (must be a Record<string, ZodSchema> object literal)`,
        };
    }
    if (!isRecord(args)) {
        return {
            ok: false,
            error: `[host:${opts.name}] tool "${toolName}" args is not an object: ${typeof args}`,
        };
    }
    if (looksLikeZodSchema(args)) {
        return {
            ok: false,
            error: `[host:${opts.name}] tool "${toolName}" args is a ZodObject (or other zod schema). ` +
                "It must be a plain object literal: `{ field1: z.string(), field2: z.number() }`, " +
                "NOT `z.object({ ... })`. " +
                "This is the codemem-style bug that crashes opencode's tool registry with " +
                "\"undefined is not an object (evaluating 'n._zod.def')\".",
        };
    }
    for (const [argName, argSchema] of Object.entries(args)) {
        if (!looksLikeZodSchema(argSchema)) {
            return {
                ok: false,
                error: `[host:${opts.name}] tool "${toolName}" arg "${argName}" is not a zod schema (no _zod or _def): typeof=${typeof argSchema}`,
            };
        }
    }
    return {
        ok: true,
        resolved: { description, args, execute },
    };
}
/**
 * Standalone validator for the entire tool map.
 *
 * Used by the preflight script and contract tests.
 */
export function validateToolDefinitions(tools, pluginName) {
    if (!tools)
        return { ok: true };
    if (!isRecord(tools)) {
        return { ok: false, errors: [`[${pluginName}] hooks.tool is not an object`] };
    }
    const errors = [];
    for (const [name, def] of Object.entries(tools)) {
        const result = validateToolDefinition(name, def, { name: pluginName });
        if (!result.ok)
            errors.push(result.error);
    }
    return errors.length === 0 ? { ok: true } : { ok: false, errors };
}
function isRecord(value) {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
function isExecute(value) {
    return typeof value === "function";
}
export function fail(opts, message) {
    if (opts.strict) {
        throw new Error(message);
    }
    console.error(message);
}
