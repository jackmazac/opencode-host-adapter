#!/usr/bin/env bun
/**
 * Audit zod versions across an opencode plugin's resolved node_modules tree.
 *
 * Fails (exit 1) when more than one zod version is resolved. Even when
 * versions match, separate physical installs produce schemas with separate
 * brand symbols. Some opencode introspection paths tolerate this; others do
 * not. The defensive default is single-instance.
 *
 * Usage:
 *   bun run @jackmazac/opencode-host-adapter/cli/audit-zod
 *   bun run @jackmazac/opencode-host-adapter/cli/audit-zod ./node_modules
 *   bun run @jackmazac/opencode-host-adapter/cli/audit-zod --json
 *
 * Exit codes:
 *   0  exactly one zod version resolved
 *   1  zero or multiple zod versions resolved
 *   2  invocation error
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const args = process.argv.slice(2);
const wantJson = args.includes("--json");
const root = args.find((a) => !a.startsWith("--")) ?? "node_modules";

if (!existsSync(root)) {
  process.stderr.write(`error: path does not exist: ${root}\n`);
  process.exit(2);
}

type ZodInstall = { version: string; path: string };

function findZodInstalls(dir: string): ZodInstall[] {
  const out: ZodInstall[] = [];
  const visit = (current: string, depth: number) => {
    if (depth > 8) return;
    let entries: string[];
    try {
      entries = readdirSync(current);
    } catch {
      return;
    }
    if (entries.includes("zod")) {
      const zodPkg = join(current, "zod", "package.json");
      if (existsSync(zodPkg)) {
        try {
          const pkg = JSON.parse(readFileSync(zodPkg, "utf8"));
          if (typeof pkg.name === "string" && pkg.name === "zod" && typeof pkg.version === "string") {
            out.push({ version: pkg.version, path: join(current, "zod") });
          }
        } catch {
          // skip
        }
      }
    }
    for (const entry of entries) {
      if (entry === ".bin" || entry === ".cache") continue;
      const full = join(current, entry);
      let st;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (!st.isDirectory()) continue;
      if (entry === "node_modules") {
        visit(full, depth + 1);
      } else if (entry.startsWith("@")) {
        visit(full, depth + 1);
      } else if (depth === 0 || entry === "@opencode-ai" || entry === "@codemem" || entry === "@jackmazac") {
        // Walk into known-deep nesting paths.
        const inner = join(full, "node_modules");
        if (existsSync(inner)) visit(inner, depth + 1);
      }
    }
  };
  visit(dir, 0);
  return out;
}

const installs = findZodInstalls(root);
const versions = new Set(installs.map((i) => i.version));

if (wantJson) {
  process.stdout.write(
    JSON.stringify(
      {
        root,
        installs,
        uniqueVersions: Array.from(versions).sort(),
        ok: versions.size === 1,
      },
      null,
      2,
    ) + "\n",
  );
} else if (versions.size === 0) {
  process.stderr.write(`error: no zod installs found under ${root}\n`);
} else if (versions.size === 1) {
  const [v] = Array.from(versions);
  process.stdout.write(`ok: zod ${v} resolved at ${installs.length} location(s)\n`);
  for (const i of installs) {
    process.stdout.write(`  ${i.version}  ${i.path}\n`);
  }
} else {
  process.stderr.write(
    `error: ${versions.size} zod versions resolved (${Array.from(versions).sort().join(", ")}):\n`,
  );
  for (const i of installs) {
    process.stderr.write(`  ${i.version}  ${i.path}\n`);
  }
  process.stderr.write(
    "\nMultiple zod instances can confuse opencode's tool registry. " +
      "Pin a single version in your top-level dependencies.\n",
  );
}

process.exit(versions.size === 1 ? 0 : 1);
