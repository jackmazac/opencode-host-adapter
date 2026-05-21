/**
 * NDJSON telemetry sink.
 *
 * Writes one JSON object per line to a rolling lifecycle file. Failures
 * NEVER throw — telemetry must not break a plugin hook.
 *
 * Default destination: ~/.local/share/opencode/log/plugin-lifecycle.jsonl
 * Override via WrapOptions.telemetryPath or the
 * OPENCODE_HOST_ADAPTER_TELEMETRY env var.
 */
import { type FleetTelemetryEnvelope } from "@mazac-fox/opencode-fleet-contracts";
import type { WrapOptions } from "./types.ts";
export declare function resolveTelemetryPath(opts: Pick<WrapOptions, "telemetryPath">): string;
export declare function emitFleet(envelope: FleetTelemetryEnvelope, options?: {
    telemetryPath?: string;
    telemetryDisabled?: boolean;
}): void;
export declare function emit(opts: WrapOptions, event: Record<string, unknown>): void;
export declare function errorPayload(error: unknown): {
    message: string;
    stack?: string;
    name?: string;
    code?: string;
    retryable?: boolean;
};
export declare function argDigest(args: unknown): {
    keys: string[];
    types: Record<string, string>;
    size: number;
};
