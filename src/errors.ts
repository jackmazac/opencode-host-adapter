/**
 * Stable error taxonomy for Host Adapter boundary failures.
 */

export const ERROR_TOOL_ARGS_INVALID = "E_TOOL_ARGS_INVALID";
export const ERROR_TIMEOUT = "E_TIMEOUT";

export type HostAdapterErrorCode = typeof ERROR_TOOL_ARGS_INVALID | typeof ERROR_TIMEOUT;

export class ToolArgsValidationError extends Error {
  readonly code = ERROR_TOOL_ARGS_INVALID;
  readonly retryable = false;

  constructor(message: string) {
    super(message);
    this.name = "ToolArgsValidationError";
  }
}
