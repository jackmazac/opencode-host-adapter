/**
 * Stable error taxonomy for Host Adapter boundary failures.
 */
export declare const ERROR_TOOL_ARGS_INVALID = "E_TOOL_ARGS_INVALID";
export declare const ERROR_TIMEOUT = "E_TIMEOUT";
export type HostAdapterErrorCode = typeof ERROR_TOOL_ARGS_INVALID | typeof ERROR_TIMEOUT;
export declare class ToolArgsValidationError extends Error {
    readonly code = "E_TOOL_ARGS_INVALID";
    readonly retryable = false;
    constructor(message: string);
}
