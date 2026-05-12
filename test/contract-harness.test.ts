import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { runPluginContractTests } from "../src/contract-test.ts";

const dir = mkdtempSync(join(tmpdir(), "host-adapter-contract-fixture-"));
const fixturePath = join(dir, "real-plugin.ts");
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const wrapUrl = pathToFileURL(resolve(root, "src/wrap.ts")).href;

writeFileSync(
  fixturePath,
  `
import { wrapPlugin } from ${JSON.stringify(wrapUrl)};

const requiredString = {
  _zod: true,
  safeParse(value) {
    return typeof value === "string"
      ? { success: true, data: value }
      : { success: false, error: { issues: [{ message: "expected string" }] } };
  },
};

export default wrapPlugin(
  async () => ({
    tool: {
      real_required: {
        description: "real exported required arg fixture",
        args: { msg: requiredString },
        execute: async () => "should not run",
      },
    },
  }),
  { name: "real-fixture", telemetryDisabled: true },
);
`,
);

runPluginContractTests({
  pluginPath: pathToFileURL(fixturePath).href,
  pluginName: "real-fixture",
  stubInput: () => ({ client: {}, directory: process.cwd(), project: {}, worktree: process.cwd() }),
  expectedTools: ["real_required"],
  malformedArgCases: [{ tool: "real_required", args: {} }],
});
