import assert from "node:assert/strict";
import { test } from "node:test";
import { containerArgs, validatePlan } from "../lib/local-request.mjs";
const file = { path: "package.json", content: '{"version":"1.2.4"}', mode: "100644", type: "blob" };
const settings = { files: ["package.json", "new.json", ".github/workflows/pwn.yml", "../outside"] };
const plan = { current: "1.2.3", next: "1.2.4", files: [file] };
const mode = (path) => path === "new.json" ? "" : "100644";
test("host validates untrusted sandbox output before GitHub writes", () => {
  assert.equal(validatePlan(plan, settings, "patch", mode), plan);
  for (
    const change of [
      { next: "1.2.5" },
      { current: "1.2.4" },
      { files: [] },
      { files: [file, file] },
      ...[
        { path: "../outside" },
        { path: ".github/workflows/pwn.yml" },
        { path: "new.json" },
        { path: "unlisted" },
        { mode: "120000" },
        { mode: "100755" },
        { content: null },
        { content: "\ud800" },
        { type: "commit" },
      ].map((edit) => ({ files: [{ ...file, ...edit }] })),
    ]
  ) assert.throws(() => validatePlan({ ...plan, ...change }, settings, "patch", mode));
});
test("container has no host mounts or forwarded credentials", () => {
  const args = containerArgs("fixture", "image");
  for (
    const forbidden of [
      "--privileged",
      "--volume",
      "-v",
      "--mount",
      "--env-file",
      "--pid=host",
      "--network=host",
    ]
  ) {
    assert.ok(!args.includes(forbidden));
  }
  assert.ok(args.includes("--cap-drop=ALL"));
  assert.ok(args.includes("--security-opt=no-new-privileges"));
  assert.ok(args.includes("--user=1000:1000"));
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--env") {
      assert.match(args[i + 1], /^(HTTP_PROXY|HTTPS_PROXY|ALL_PROXY|NO_PROXY)=$/);
    }
  }
});

test("real sandbox cannot read host credentials and prepares a valid diff", {
  skip: process.env.RELEASE_SANDBOX_TEST !== "1",
  timeout: 1200000,
}, async () => {
  const { sandbox } = await import("../lib/local-request.mjs");
  const { execFileSync } = await import("node:child_process");
  const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const root = mkdtempSync(join(tmpdir(), "sandbox-test-"));
  const fixture = join(root, "fixture");
  mkdirSync(fixture);
  try {
    writeFileSync(join(fixture, "package.json"), '{"version":"1.2.3"}');
    writeFileSync(
      join(fixture, ".release.json"),
      JSON.stringify({
        files: ["package.json"],
        prepare: ["node", "prepare.cjs"],
      }),
    );
    writeFileSync(
      join(fixture, "prepare.cjs"),
      `
      const assert = require('node:assert/strict'), fs = require('node:fs');
      for (const key of ['GH_TOKEN', 'GITHUB_TOKEN', 'SSH_AUTH_SOCK', 'RELEASE_APP_PRIVATE_KEY']) assert.equal(process.env[key], undefined);
      for (const path of ['/var/run/docker.sock', '/root/.config/gh/hosts.yml', '/tmp/home/.config/gh/hosts.yml']) assert.equal(fs.existsSync(path), false);
      fs.writeFileSync('package.json', JSON.stringify({version: process.argv[2]}));
    `,
    );
    const archive = execFileSync("tar", ["-cf", "-", "-C", fixture, "."]);
    const result = sandbox(archive, "patch", root);
    validatePlan(result, { files: ["package.json"] }, "patch", () => "100644");
    assert.equal(result.next, "1.2.4");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
