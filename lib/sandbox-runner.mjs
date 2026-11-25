// Runs only inside the credential-free container, never on the requester's host.
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { config, currentVersion, prepare, run } from "./prepare.mjs";
import { git, preparedFiles } from "./release.mjs";
mkdirSync(process.env.HOME, { recursive: true });
git("init", "-q");
git("add", ".");
git(
  "-c",
  "user.name=Release",
  "-c",
  "user.email=release@example.invalid",
  "commit",
  "-qm",
  "Baseline",
);
const settings = config();
const checks = () => {
  for (const command of settings.checks || []) run(command, [], { stdio: "inherit" });
};
const current = currentVersion(settings);
checks();
assert.equal(git("status", "--porcelain"), "", "Checks changed the baseline");
const { next } = prepare(settings, process.argv[2]);
const files = preparedFiles(settings.files.join("\n"));
checks();
assert.deepEqual(preparedFiles(settings.files.join("\n")), files, "Checks changed release files");
assert.equal(currentVersion(settings), next);
writeFileSync("/tmp/result.json", JSON.stringify({ current, next, files }));
