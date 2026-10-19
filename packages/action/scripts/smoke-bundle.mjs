import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const bundle = join(import.meta.dirname, "..", "dist", "index.js");

if (!existsSync(bundle)) {
  console.error(`missing bundle: ${bundle} (run pnpm build first)`);
  process.exit(1);
}

const source = readFileSync(bundle, "utf8");
const offenders = ["node_modules", "node_modules/", "__dirname"];
for (const needle of offenders) {
  if (source.includes(`require("${needle}`) || source.includes(`from "${needle}`)) {
    console.error(`bundle loads ${needle} at runtime`);
    process.exit(1);
  }
}

const env = {
  ...process.env,
  GITHUB_ACTIONS: "false",
  GITHUB_EVENT_NAME: "push",
  GITHUB_EVENT_PATH: join(tmpdir(), "hammer-smoke-event.json"),
  INPUT_MODEL: "anthropic/claude-sonnet-5-5",
};

const out = execFileSync(process.execPath, [bundle], {
  encoding: "utf8",
  env,
  timeout: 30_000,
});
if (!out.includes("[hammer]")) {
  console.error("bundle did not print the expected no-op line");
  process.exit(1);
}
console.log("smoke ok: no-op exit 0, no node_modules require");
