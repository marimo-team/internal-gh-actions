import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { config, currentVersion, nextVersion, prepare, run } from "./prepare.mjs";
import { git, preparedFiles } from "./release.mjs";

const source = process.cwd();
const archive = execFileSync("git", ["archive", "HEAD"], { maxBuffer: 100 * 1024 * 1024 });
const root = mkdtempSync(join(tmpdir(), "release-contract-"));
const originalPath = process.env.PATH;
try {
  for (const request of ["patch", "minor", "major", "explicit"]) {
    const checkout = join(root, request);
    mkdirSync(checkout);
    execFileSync("tar", ["-xf", "-", "-C", checkout], { input: archive });
    process.chdir(checkout);
    git("init", "-q");
    git("add", ".");
    git(
      "-c",
      "user.name=Release contract",
      "-c",
      "user.email=contract@example.invalid",
      "-c",
      "core.hooksPath=/dev/null",
      "commit",
      "-qm",
      "Baseline",
    );
    const settings = config();
    const current = currentVersion(settings);
    const head = git("rev-parse", "HEAD");
    const refs = git("show-ref");
    const checks = () => {
      for (const command of settings.checks || []) run(command, [], { stdio: "inherit" });
    };
    checks();
    assert.equal(git("status", "--porcelain"), "", "Checks must not change tracked files");
    if (request === "patch") {
      assert.ok(
        readFileSync(settings.docs, "utf8").includes(`${settings.command.join(" ")} patch`),
        "Document the tested command",
      );
      const bin = join(root, "bin");
      mkdirSync(bin);
      const log = join(root, "request.jsonl");
      writeFileSync(
        join(bin, "gh"),
        `#!/usr/bin/env node\nrequire('node:fs').appendFileSync(${
          JSON.stringify(log)
        }, JSON.stringify({args:process.argv.slice(2),repository:process.env.GITHUB_REPOSITORY}) + '\\n');\n`,
        { mode: 0o755 },
      );
      process.env.PATH = `${bin}${delimiter}${originalPath}`;
      run(settings.command, ["patch"]);
      process.env.PATH = originalPath;
      const calls = readFileSync(log, "utf8").trim().split("\n").map(JSON.parse);
      assert.equal(calls.length, 1, "Release command must request exactly once");
      const { args, repository } = calls[0];
      assert.equal(repository, settings.repository);
      assert.deepEqual(args, ["release-control", "request", "patch"]);
      assert.equal(git("status", "--porcelain"), "", "Request shortcut must not edit files");
    }
    const requested = request === "explicit" ? nextVersion(current, "patch") : request;
    for (const invalid of [current, "0.0.0", "1.0.0-rc.1"]) {
      assert.throws(() => prepare(settings, invalid));
      assert.equal(git("status", "--porcelain"), "", "Reject invalid versions before mutation");
    }
    prepare(settings, requested);
    const changes = preparedFiles(settings.files.join("\n"));
    checks();
    assert.deepEqual(
      preparedFiles(settings.files.join("\n")),
      changes,
      "Checks must not change release files",
    );
    assert.equal(git("rev-parse", "HEAD"), head, "Preparation must not commit");
    assert.equal(git("show-ref"), refs, "Preparation must not create refs");
    console.log(`Release contract passed: ${request}`);
  }
} finally {
  process.chdir(source);
  process.env.PATH = originalPath;
  rmSync(root, { recursive: true, force: true });
}
