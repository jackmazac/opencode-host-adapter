/**
 * Stable error taxonomy for Host Adapter boundary failures.
 */
export const ERROR_TOOL_ARGS_INVALID = "E_TOOL_ARGS_INVALID";
export const ERROR_TIMEOUT = "E_TIMEOUT";
export class ToolArgsValidationError extends Error {
    code = ERROR_TOOL_ARGS_INVALID;
    retryable = false;
    constructor(message) {
        super(message);
        this.name = "ToolArgsValidationError";
    }
}
