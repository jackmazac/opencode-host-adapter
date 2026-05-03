#!/usr/bin/env bun
/**
 * Lints plugin boundary files to ensure they don't import zod directly.
 *
 * Why: a plugin that imports `z` from a different zod copy than opencode's
 * bundled zod will produce schemas with a foreign brand symbol. Even when
 * versions match, separate physical instances can confuse opencode's
 * tool registry. Plugins must use `tool.schema` from `@opencode-ai/plugin`,
 * which guarantees the same zod instance opencode uses for tool definitions.
 *
 * Allowed:
 *   import { tool } from "@opencode-ai/plugin"
 *   const z = tool.schema
 *
 * Forbidden in plugin boundary files (any file that exports a Plugin or
 * registers a tool):
 *   import { z } from "zod"
 *   import * as z from "zod"
 *
 * Internal validation (config schemas, eval fixtures) may still import
 * zod directly — those schemas never cross the opencode tool boundary.
 *
 * Usage:
 *   bun run @jackmazac/opencode-host-adapter/cli/check-no-zod-import [path...]
 *   bun run @jackmazac/opencode-host-adapter/cli/check-no-zod-import src/index.ts
 *
 * Default path: src/index.ts (the conventional plugin entry).
 *
 * Exit codes:
 *   0  no violations
 *   1  one or more violations
 *   2  invocation error
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const FORBIDDEN_PATTERNS = [
  /^import\s+(?:type\s+)?\{\s*z(?:\s*,\s*[^}]+)?\s*\}\s+from\s+["']zod["']/m,
  /^import\s+\*\s+as\s+z\s+from\s+["']zod["']/m,
  /^import\s+z\s+from\s+["']zod["']/m,
];

const SUFFIXES = [".ts", ".tsx", ".mts", ".cts"];

type Violation = { path: string; line: number; text: string };

function findPluginBoundaryFiles(root: string): string[] {
  const targets: string[] = [];
  const visit = (dir: string) => {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry === "node_modules" || entry === ".git" || entry === "dist") continue;
      const full = join(dir, entry);
      let st;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        visit(full);
        continue;
      }
      if (!SUFFIXES.some((s) => entry.endsWith(s))) continue;
      if (entry.endsWith(".d.ts")) continue;
      if (entry.endsWith(".test.ts") || entry.endsWith(".spec.ts")) continue;
      if (isPluginBoundaryFile(full)) targets.push(full);
    }
  };
  if (statSync(root).isDirectory()) {
    visit(root);
  } else {
    targets.push(root);
  }
  return targets;
}

function isPluginBoundaryFile(path: string): boolean {
  let content: string;
  try {
    content = readFileSync(path, "utf8");
  } catch {
    return false;
  }
  if (/from\s+["']@opencode-ai\/plugin["']/.test(content)) return true;
  if (/from\s+["']@opencode-ai\/plugin\/tool["']/.test(content)) return true;
  return false;
}

function checkFile(path: string): Violation[] {
  const content = readFileSync(path, "utf8");
  const violations: Violation[] = [];
  const lines = content.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;
    for (const pattern of FORBIDDEN_PATTERNS) {
      if (pattern.test(line)) {
        violations.push({ path, line: i + 1, text: line });
        break;
      }
    }
  }
  return violations;
}

function main(): void {
  const inputs = process.argv.slice(2);
  const roots = inputs.length > 0 ? inputs : ["src/index.ts"];
  let scanned = 0;
  let allViolations: Violation[] = [];

  for (const root of roots) {
    if (!existsSync(root)) {
      process.stderr.write(`error: path does not exist: ${root}\n`);
      process.exit(2);
    }
    const files = findPluginBoundaryFiles(root);
    scanned += files.length;
    for (const file of files) {
      allViolations.push(...checkFile(file));
    }
  }

  if (allViolations.length === 0) {
    process.stdout.write(`ok: ${scanned} plugin boundary file(s) scanned, no zod imports.\n`);
    process.exit(0);
  }

  process.stderr.write(
    `error: ${allViolations.length} forbidden zod import(s) in plugin boundary files:\n`,
  );
  for (const v of allViolations) {
    process.stderr.write(`  ${v.path}:${v.line}: ${v.text.trim()}\n`);
  }
  process.stderr.write(
    "\nFix: replace `import { z } from \"zod\"` with " +
      "`import { tool } from \"@opencode-ai/plugin\"; const z = tool.schema`.\n",
  );
  process.stderr.write(
    "Plugin boundary files use opencode's bundled zod via the tool helper. " +
      "Importing zod directly creates a separate instance whose brand symbols " +
      "may not match opencode's introspection.\n",
  );
  process.exit(1);
}

main();
