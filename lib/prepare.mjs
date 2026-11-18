import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { manifestVersion, output, preparedFiles, version } from "./release.mjs";

export function nextVersion(current, requested) {
  const before = version(current).split(".").map(BigInt);
  const parts = [...before];
  const bump = ["major", "minor", "patch"].indexOf(requested);
  if (bump !== -1) {
    parts[bump]++;
    for (let i = bump + 1; i < 3; i++) parts[i] = 0n;
    requested = parts.join(".");
  }
  const after = version(requested).split(".").map(BigInt);
  const index = after.findIndex((part, i) => part !== before[i]);
  if (index === -1 || after[index] < before[index]) {
    throw new Error("Release version must increase");
  }
  return requested;
}

export const run = (command, extra = [], options = {}) => {
  if (!Array.isArray(command) || !command.length || command.some((s) => typeof s !== "string")) {
    throw new Error("Expected a command argument array");
  }
  return execFileSync(command[0], [...command.slice(1), ...extra], {
    encoding: "utf8",
    ...options,
  });
};
export const config = () => JSON.parse(readFileSync(".release.json", "utf8"));
export function currentVersion(settings) {
  return settings.metadata
    ? version(JSON.parse(run(settings.metadata)).version)
    : manifestVersion(settings.manifest || "package.json");
}
export function prepare(settings, requested) {
  const current = currentVersion(settings);
  const next = nextVersion(current, requested);
  run(settings.prepare, [next], { stdio: ["ignore", "inherit", "inherit"] });
  if (currentVersion(settings) !== next) throw new Error("Prepared version or mirrors disagree");
  preparedFiles(settings.files.join("\n"));
  return { current, next };
}

if (process.argv[2] === "prepare") {
  const settings = config();
  const { current, next } = prepare(settings, process.env.REQUESTED_VERSION);
  const manifest = join(process.env.RUNNER_TEMP, `release-manifest-${crypto.randomUUID()}.json`);
  writeFileSync(manifest, JSON.stringify({ version: next }));
  output("version", next);
  output("current-version", current);
  output("manifest", manifest);
  const delimiter = crypto.randomUUID();
  // File paths are validated by preparedFiles before emitting this output.
  const { appendFileSync } = await import("node:fs");
  appendFileSync(
    process.env.GITHUB_OUTPUT,
    `files<<${delimiter}\n${settings.files.join("\n")}\n${delimiter}\n`,
  );
}
