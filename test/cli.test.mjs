import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync, spawnSync } from "node:child_process";

const cli = fileURLToPath(new URL("../lib/cli.mjs", import.meta.url));
test("CLI checks event, checkout, tag ancestry and prepared plan before credentials", () => {
  const dir = mkdtempSync(join(tmpdir(), "release-cli-"));
  const events = mkdtempSync(join(tmpdir(), "release-events-"));
  const git = (...args) =>
    execFileSync("git", args, {
      cwd: dir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  const output = join(events, "output");
  try {
    git("init", "-b", "main");
    git("config", "user.name", "test");
    git("config", "user.email", "test@example.com");
    writeFileSync(join(dir, "package.json"), '{"version":"1.2.3"}');
    git("add", ".");
    git("commit", "-m", "release");
    const sha = git("rev-parse", "HEAD");
    git("tag", "-a", "v1.2.3", "-m", "release");
    git("update-ref", "refs/remotes/origin/main", sha);
    const event = {
      action: "closed",
      pull_request: {
        merged: true,
        merge_commit_sha: sha,
        title: "release: 1.2.3",
        base: { ref: "main", repo: { full_name: "team/repo" } },
        head: { ref: "release/1.2.3", repo: { full_name: "team/repo" } },
      },
    };
    const eventPath = join(events, "event.json");
    writeFileSync(eventPath, JSON.stringify(event));
    const run = (command, extra = {}) => {
      writeFileSync(output, "");
      return spawnSync(process.execPath, [cli, command], {
        cwd: dir,
        encoding: "utf8",
        env: {
          ...process.env,
          GITHUB_EVENT_PATH: eventPath,
          GITHUB_OUTPUT: output,
          GITHUB_REPOSITORY: "team/repo",
          GITHUB_EVENT_NAME: "pull_request",
          GITHUB_REF: "refs/tags/v1.2.3",
          RUNNER_TEMP: events,
          ...extra,
        },
      });
    };
    assert.equal(run("tag-check").status, 0);
    assert.notEqual(
      run("tag-check", { GITHUB_EVENT_NAME: "workflow_dispatch" }).status,
      0,
    );
    assert.equal(run("validate").status, 0);
    assert.match(readFileSync(output, "utf8"), /version=1.2.3/);
    assert.notEqual(
      run("validate", { GITHUB_REF: "refs/tags/v1.2.4" }).status,
      0,
    );
    git("commit", "--allow-empty", "-m", "later");
    assert.notEqual(run("tag-check").status, 0);
    assert.notEqual(run("validate").status, 0);
    git("tag", "-f", "v1.2.3");
    const offMain = run("validate");
    assert.notEqual(offMain.status, 0);
    assert.match(offMain.stderr, /merge-base --is-ancestor/);
    writeFileSync(join(dir, "package.json"), '{"version":"1.2.4"}');
    const preparation = {
      GITHUB_EVENT_NAME: "workflow_dispatch",
      GITHUB_REF: "refs/heads/main",
      RELEASE_VERSION: "1.2.4",
      RELEASE_FILES: "package.json",
    };
    const result = run("pr-prepare", preparation);
    assert.equal(result.status, 0, result.stderr);
    const plan = JSON.parse(
      readFileSync(
        readFileSync(output, "utf8").trim().slice("plan=".length),
        "utf8",
      ),
    );
    assert.equal(plan.version, "1.2.4");
    assert.equal(plan.files.length, 1);
    assert.notEqual(
      run("pr-prepare", { ...preparation, GITHUB_REF: "refs/heads/feature" })
        .status,
      0,
    );
    assert.notEqual(
      run("pr-prepare", { ...preparation, RELEASE_VERSION: "1.2.5" }).status,
      0,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(events, { recursive: true, force: true });
  }
});
