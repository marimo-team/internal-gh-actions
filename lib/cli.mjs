import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  apiClient,
  ensureReleasePr,
  ensureTag,
  git,
  manifestVersion,
  mergedRelease,
  notification,
  output,
  preparedFiles,
  releaseStatus,
  version,
} from "./release.mjs";

import { nextVersion } from "./prepare.mjs";

const env = process.env;
const command = process.argv[2];
const repository = env.GITHUB_REPOSITORY;
const base = env.RELEASE_BASE || "main";
const event = JSON.parse(readFileSync(env.GITHUB_EVENT_PATH, "utf8"));
const api = () => apiClient(repository, env.GH_TOKEN);
const value = () => manifestVersion(env.RELEASE_MANIFEST || "package.json");

if (command === "tag-check" || command === "tag") {
  const v = value();
  if (env.GITHUB_EVENT_NAME !== "pull_request") {
    throw new Error("Tagging requires a pull_request event");
  }
  const sha = mergedRelease(event, repository, base, v);
  if (git("rev-parse", "HEAD") !== sha) {
    throw new Error("Checkout must be the exact merge commit");
  }
  output("version", v);
  if (command === "tag") {
    const result = await ensureTag(api(), v, sha);
    output("tag", result.tag);
    output("created", result.created);
    if (!result.created) {
      console.log(
        "Tag already exists. Re-run failed publication jobs if necessary.",
      );
    }
  }
} else if (command === "validate") {
  const v = value();
  if (env.GITHUB_REF !== `refs/tags/v${v}`) {
    throw new Error("Tag must match the release manifest version");
  }
  if (
    git("rev-parse", "HEAD") !== git("rev-parse", `refs/tags/v${v}^{commit}`)
  ) {
    throw new Error("Checkout must match the release tag");
  }
  // The caller checks out the tag with full history, including origin/BASE.
  git("merge-base", "--is-ancestor", "HEAD", `refs/remotes/origin/${base}`);
  output("version", v);
  output("tag", `v${v}`);
} else if (command === "pr-prepare") {
  if (
    env.GITHUB_EVENT_NAME !== "workflow_dispatch" ||
    env.GITHUB_REF !== `refs/heads/${base}`
  ) {
    throw new Error(
      "Release preparation must be dispatched from the base branch",
    );
  }
  const v = nextVersion(env.RELEASE_CURRENT_VERSION, version(env.RELEASE_VERSION));
  if (value() !== v) {
    throw new Error("Prepared manifest does not match requested version");
  }
  const plan = {
    repository,
    base,
    sha: git("rev-parse", "HEAD"),
    version: v,
    files: preparedFiles(env.RELEASE_FILES || ""),
  };
  const path = join(
    env.RUNNER_TEMP,
    `release-plan-${crypto.randomUUID()}.json`,
  );
  writeFileSync(path, JSON.stringify(plan), { mode: 0o600 });
  output("plan", path);
} else if (command === "pr") {
  const plan = JSON.parse(readFileSync(env.RELEASE_PLAN, "utf8"));
  if (plan.repository !== repository || plan.base !== base) {
    throw new Error("Invalid release plan");
  }
  const pr = await ensureReleasePr(
    api(),
    repository,
    base,
    plan.sha,
    plan.version,
    plan.files,
  );
  output("url", pr.html_url);
  output("number", pr.number);
  console.log(pr.html_url);
} else if (command === "notify") {
  if (
    event.pull_request?.head.repo?.full_name !== undefined &&
    event.pull_request.head.repo.full_name !== repository
  ) {
    console.log("Skipping notification for a fork PR");
  } else {
    const status = releaseStatus(env.RELEASE_STATUS, env.RELEASE_RESULTS);
    const payload = notification(
      status,
      repository,
      env.GITHUB_REF_NAME,
      `${env.GITHUB_SERVER_URL}/${repository}/actions/runs/${env.GITHUB_RUN_ID}`,
      env.RELEASE_ARTIFACT,
    );
    if (!env.SLACK_WEBHOOK_URL) throw new Error("Slack webhook is required");
    const response = await fetch(env.SLACK_WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!response.ok) {
      throw new Error(`Slack notification failed: HTTP ${response.status}`);
    }
  }
} else {
  throw new Error(`Unknown command: ${command}`);
}
