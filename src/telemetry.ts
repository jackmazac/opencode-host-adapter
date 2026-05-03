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

import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { WrapOptions } from "./types.ts";

const DEFAULT_PATH = join(
  homedir(),
  ".local",
  "share",
  "opencode",
  "log",
  "plugin-lifecycle.jsonl",
);

export function resolveTelemetryPath(opts: WrapOptions): string {
  if (opts.telemetryPath) return opts.telemetryPath;
  if (process.env.OPENCODE_HOST_ADAPTER_TELEMETRY)
    return process.env.OPENCODE_HOST_ADAPTER_TELEMETRY;
  return DEFAULT_PATH;
}

export function emit(opts: WrapOptions, event: Record<string, unknown>): void {
  if (opts.telemetryDisabled) return;
  const dest = resolveTelemetryPath(opts);
  try {
    const dir = dirname(dest);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    appendFileSync(dest, JSON.stringify(event) + "\n");
  } catch {
    // Telemetry failures must never break a plugin hook.
  }
}

export function errorPayload(error: unknown): {
  message: string;
  stack?: string;
  name?: string;
} {
  if (error instanceof Error) {
    const result: { message: string; stack?: string; name?: string } = {
      message: error.message,
      name: error.name,
    };
    if (error.stack) result.stack = error.stack.slice(0, 4000);
    return result;
  }
  return { message: String(error) };
}

export function argDigest(
  args: unknown,
): { keys: string[]; types: Record<string, string>; size: number } {
  if (!args || typeof args !== "object") return { keys: [], types: {}, size: 0 };
  const obj = args as Record<string, unknown>;
  const keys = Object.keys(obj).slice(0, 32);
  const types: Record<string, string> = {};
  for (const k of keys) {
    const v = obj[k];
    types[k] = Array.isArray(v) ? "array" : v === null ? "null" : typeof v;
  }
  let size = 0;
  try {
    size = JSON.stringify(args).length;
  } catch {
    size = -1;
  }
  return { keys, types, size };
}
