import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const sha = "a".repeat(40);
const script = fileURLToPath(new URL("../lib/wait-for-workflows.sh", import.meta.url));

function run(t, scenario = "success", overrides = {}) {
  const dir = mkdtempSync(join(tmpdir(), "wait-workflows-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const log = join(dir, "calls.jsonl");
  writeFileSync(log, "");
  writeFileSync(
    join(dir, "gh"),
    `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
const calls = fs.readFileSync(process.env.TEST_LOG, "utf8").trim().split("\\n").filter(Boolean).map(JSON.parse);
fs.appendFileSync(process.env.TEST_LOG, JSON.stringify(args) + "\\n");
const scenario = process.env.TEST_SCENARIO;
if (args[1] === "list") {
  if (scenario === "api-error") process.exit(42);
  if (scenario === "missing" || (scenario === "delayed" && calls.length < 2)) process.exit(0);
  process.stdout.write("123\\n");
} else if (args[1] === "watch") {
  if (scenario === "failure" || scenario === "cancelled") process.exit(1);
} else {
  process.exit(99);
}
`,
    { mode: 0o755 },
  );
  writeFileSync(join(dir, "sleep"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  const result = spawnSync("bash", [script], {
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${dir}${delimiter}${process.env.PATH}`,
      WAIT_WORKFLOWS: "ci.yml\npages.yml\n",
      WAIT_COMMIT: sha,
      WAIT_BRANCH: "main",
      TEST_LOG: log,
      TEST_SCENARIO: scenario,
      ...overrides,
    },
  });
  const calls = readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse);
  return { ...result, calls };
}

test("requires every workflow's exact-commit push run", (t) => {
  const result = run(t);
  assert.equal(result.status, 0, result.stderr);
  const lists = result.calls.filter((args) => args[1] === "list");
  assert.deepEqual(lists.map((args) => args[3]), ["ci.yml", "pages.yml"]);
  for (const args of lists) {
    assert.equal(args[args.indexOf("--commit") + 1], sha);
    assert.equal(args[args.indexOf("--branch") + 1], "main");
    assert.equal(args[args.indexOf("--event") + 1], "push");
  }
  assert.deepEqual(result.calls.filter((args) => args[1] === "watch"), [
    ["run", "watch", "123", "--exit-status", "--interval", "20"],
    ["run", "watch", "123", "--exit-status", "--interval", "20"],
  ]);
});

test("waits for a run to appear", (t) => {
  const result = run(t, "delayed", { WAIT_WORKFLOWS: "ci.yml" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.calls.filter((args) => args[1] === "list").length, 3);
});

test("stops after the discovery deadline", (t) => {
  const result = run(t, "missing");
  assert.equal(result.status, 1);
  assert.match(result.stdout, /No ci.yml push run found/);
  assert.equal(result.calls.length, 30);
});

for (const scenario of ["failure", "cancelled", "api-error"]) {
  test(`fails closed on ${scenario}`, (t) => {
    const result = run(t, scenario);
    assert.notEqual(result.status, 0);
    assert.equal(result.calls.filter((args) => args[1] === "list").length, 1);
  });
}

for (
  const overrides of [
    { WAIT_COMMIT: "main" },
    { WAIT_BRANCH: "" },
    { WAIT_WORKFLOWS: "" },
    { WAIT_WORKFLOWS: "ci.yml; echo unsafe" },
  ]
) {
  test(`rejects invalid inputs ${JSON.stringify(overrides)}`, (t) => {
    const result = run(t, "success", overrides);
    assert.equal(result.status, 1);
    assert.deepEqual(result.calls, []);
  });
}

test("selects only the requested PR event", (t) => {
  const result = run(t, "success", { WAIT_EVENT: "pull_request" });
  assert.equal(result.status, 0, result.stderr);
  for (const args of result.calls.filter((a) => a[1] === "list")) {
    assert.equal(args[args.indexOf("--event") + 1], "pull_request");
  }
});
test("rejects other events", (t) => {
  const result = run(t, "success", { WAIT_EVENT: "workflow_dispatch" });
  assert.notEqual(result.status, 0);
  assert.deepEqual(result.calls, []);
});
