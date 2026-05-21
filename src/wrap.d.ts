/**
 * Plugin host adapter — wraps a Plugin to defend opencode's runtime against
 * common plugin authoring mistakes and emit structured telemetry.
 */
import { type FleetContext } from "@mazac-fox/opencode-fleet-contracts";
import type { AnyHooks, FleetContextSource, WrapOptions } from "./types.ts";
export declare function wrapPlugin<I, O>(plugin: (input: I, options?: O) => Promise<unknown>, opts: WrapOptions): (input: I, options?: O) => Promise<AnyHooks>;
export declare function extractFleetContext(metadata: unknown, args: unknown): {
    context: FleetContext;
    source: FleetContextSource;
};
export declare function extractFleetContextFromUnknown(...values: unknown[]): FleetContext;
