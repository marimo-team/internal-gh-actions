import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
const contract = fileURLToPath(new URL("../lib/contract.mjs", import.meta.url));
function fixture(t, fault) {
  const dir = mkdtempSync(join(tmpdir(), "consumer-fixture-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const write = (name, value) => writeFileSync(join(dir, name), value);
  const git = (...args) => execFileSync("git", args, { cwd: dir, stdio: "pipe" });
  mkdirSync(join(dir, "scripts"));
  write(
    "package.json",
    JSON.stringify({
      version: "1.2.3",
      scripts: fault === "command" ? {} : { release: "node scripts/release.cjs" },
    }),
  );
  write("mirror.json", '{"version":"1.2.3"}');
  write("lock.json", '{"version":"1.2.3"}');
  write("RELEASING.md", fault === "docs" ? "outdated" : "npm run release patch");
  write(
    "scripts/release.cjs",
    `require('node:child_process').execFileSync('gh', ['release-control','request',process.argv[2]], {env:{...process.env,GITHUB_REPOSITORY:'team/repo'}});`,
  );
  write(
    "scripts/metadata.cjs",
    `const fs=require('node:fs');const p=require('../package.json');if (p.version!==require('../mirror.json').version) throw Error('mirror'); console.log(JSON.stringify(p));`,
  );
  write(
    "scripts/check.cjs",
    `if(require('../package.json').version!==require('../lock.json').version) throw Error('stale lock');`,
  );
  write(
    "scripts/prepare.cjs",
    `const fs=require('node:fs'); const p=require('../package.json');p.version=process.argv[2];fs.writeFileSync('package.json',JSON.stringify(p));
    ${fault === "mirror" ? "" : "fs.writeFileSync('mirror.json',JSON.stringify(p));"}
    ${fault === "lock" ? "" : "fs.writeFileSync('lock.json',JSON.stringify(p));"}
    ${fault === "allowlist" ? "fs.writeFileSync('unexpected.txt','oops');" : ""}`,
  );
  write(
    ".release.json",
    JSON.stringify({
      repository: "team/repo",
      metadata: ["node", "scripts/metadata.cjs"],
      prepare: ["node", "scripts/prepare.cjs"],
      files: ["package.json", "mirror.json", "lock.json"],
      docs: "RELEASING.md",
      command: ["npm", "run", "release"],
      checks: [["node", "scripts/check.cjs"]],
    }),
  );
  git("init", "-q");
  git("add", ".");
  git(
    "-c",
    "user.name=test",
    "-c",
    "user.email=test@example.invalid",
    "-c",
    "core.hooksPath=/dev/null",
    "commit",
    "-qm",
    "fixture",
  );
  const result = spawnSync("node", [contract], { cwd: dir, encoding: "utf8" });
  assert.equal(git("status", "--porcelain").toString(), "", "Source checkout must stay untouched");
  return result;
}
test("exercises commands and all bumps without changing the source checkout", (t) => {
  const result = fixture(t);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.match(/Release contract passed/g).length, 4);
});
for (const fault of ["command", "docs", "mirror", "lock", "allowlist"]) {
  test(`detects consumer ${fault} regression`, (t) => assert.notEqual(fixture(t, fault).status, 0));
}
