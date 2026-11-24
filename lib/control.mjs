import { execFileSync } from "node:child_process";

export const stable = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
export function github(repository) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository)) throw new Error("Invalid repository");
  return async (path, body) => {
    const args = ["api", `repos/${repository}/${path}`, "-H", "X-GitHub-Api-Version: 2022-11-28"];
    if (body) args.push("--method", "POST", "--input", "-");
    const text = execFileSync("gh", args, {
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
      timeout: 60000,
      input: body ? JSON.stringify(body) : undefined,
    });
    return text.trim() ? JSON.parse(text) : null;
  };
}
export async function list(api, path, key) {
  const all = [];
  for (let page = 1;; page++) {
    const data = await api(`${path}${path.includes("?") ? "&" : "?"}per_page=100&page=${page}`);
    const batch = key ? data[key] : data;
    all.push(...batch);
    if (batch.length < 100) return all;
  }
}
export function releasePr(pr, repository) {
  const v = pr.title?.replace(/^release: /, "");
  return stable.test(v) && pr.title === `release: ${v}` &&
    pr.head?.ref === `release/${v}` && pr.head?.repo?.full_name === repository &&
    pr.base?.ref === "main" && pr.base?.repo?.full_name === repository;
}
export async function identity(api, run, repository) {
  if (
    run.path === ".github/workflows/release-pr.yml" &&
    run.event === "workflow_dispatch" && run.head_branch === "main"
  ) {
    return {
      step: "preparation",
      version: run.display_title || "version requested in workflow inputs",
    };
  }
  if (run.path !== ".github/workflows/release-tag.yml" || run.event !== "pull_request") {
    throw new Error("Refusing a run outside the two release workflows");
  }
  const candidates = await list(api, `commits/${run.head_sha}/pulls`);
  for (const candidate of candidates) {
    const pr = await api(`pulls/${candidate.number}`);
    if (
      releasePr(pr, repository) && pr.merged === true && pr.head.sha === run.head_sha &&
      pr.head.ref === run.head_branch &&
      Date.parse(run.created_at) >= Date.parse(pr.merged_at)
    ) {
      return { step: "tagging", version: pr.title.slice(9), pr: pr.html_url };
    }
  }
  throw new Error("Tagging requires a merged same-repository release PR at the run commit");
}
export async function pending(api, id) {
  return (await api(`actions/runs/${id}/pending_deployments`)).find((p) =>
    p.environment.name === "release"
  );
}
export async function approve(api, repository, id) {
  if (!/^\d+$/.test(String(id))) throw new Error("Select a numeric run ID");
  const run = await api(`actions/runs/${id}`);
  const info = await identity(api, run, repository);
  const deployment = await pending(api, id);
  if (!deployment?.current_user_can_approve) {
    throw new Error(
      "No release approval available to this user (reviewer and self-review rules apply)",
    );
  }
  await api(`actions/runs/${id}/pending_deployments`, {
    environment_ids: [deployment.environment.id],
    state: "approved",
    comment: "Approved with guarded release tooling",
  });
  return { ...info, url: run.html_url };
}
export async function request(api, version) {
  if (!["patch", "minor", "major"].includes(version) && !stable.test(version)) {
    throw new Error("Use patch, minor, major, or stable X.Y.Z");
  }
  const run = await api("actions/workflows/release-pr.yml/dispatches", {
    ref: "main",
    inputs: { version },
    return_run_details: true,
  });
  if (!run?.html_url) {
    throw new Error("Dispatch accepted but returned no run URL; inspect Actions before retrying");
  }
  return `Ask another marimo-eng member to approve: ${run.html_url}`;
}
export async function waiting(api, repository) {
  const runs = await list(api, "actions/runs?status=waiting", "workflow_runs");
  const found = [];
  for (const run of runs) {
    if (
      ![".github/workflows/release-pr.yml", ".github/workflows/release-tag.yml"].includes(run.path)
    ) continue;
    try {
      const info = await identity(api, run, repository);
      if (await pending(api, run.id)) {
        found.push({
          id: run.id,
          ...info,
          actor: run.triggering_actor?.login || run.actor?.login,
          url: run.html_url,
        });
      }
    } catch (e) {
      console.error(`Skipping run ${run.id}: ${e.message}`);
    }
  }
  return found;
}
function progress(run, step) {
  return {
    state: run.conclusion && run.conclusion !== "success"
      ? `${step} ${run.conclusion}`
      : `${step} in progress`,
    url: run.html_url,
  };
}
export async function status(api, repository) {
  const preparations = await api(
    "actions/workflows/release-pr.yml/runs?event=workflow_dispatch&branch=main&per_page=1",
  );
  const prep = preparations.workflow_runs[0];
  if (!prep) return { state: "No release requested" };
  if (await pending(api, prep.id)) {
    return { state: "preparation awaiting approval", url: prep.html_url };
  }
  if (prep.conclusion !== "success") return progress(prep, "preparation");
  let pr;
  for (let page = 1;; page++) {
    const prs = await api(
      `pulls?state=all&base=main&sort=created&direction=desc&per_page=100&page=${page}`,
    );
    pr = prs.find((candidate) =>
      releasePr(candidate, repository) &&
      Date.parse(candidate.created_at) >= Date.parse(prep.created_at)
    );
    if (pr || prs.length < 100 || Date.parse(prs.at(-1).created_at) < Date.parse(prep.created_at)) {
      break;
    }
  }
  if (!pr) return { state: "Preparation completed; release PR not found", url: prep.html_url };
  if (pr.state === "open") return { state: "PR open", url: pr.html_url };
  const detail = await api(`pulls/${pr.number}`);
  if (!detail.merged) return { state: "Release PR closed without merging", url: pr.html_url };
  const tags = await list(
    api,
    `actions/workflows/release-tag.yml/runs?event=pull_request&head_sha=${detail.head.sha}`,
    "workflow_runs",
  );
  const tag = tags[0];
  if (!tag) return { state: "Waiting for tagging workflow", url: pr.html_url };
  await identity(api, tag, repository);
  if (await pending(api, tag.id)) return { state: "tagging awaiting approval", url: tag.html_url };
  if (tag.conclusion !== "success") return progress(tag, "tagging");
  const version = detail.title.slice(9);
  const allPublishers = (await list(
    api,
    `actions/runs?event=push&head_sha=${detail.merge_commit_sha}`,
    "workflow_runs",
  ))
    .filter((run) => run.head_branch === `v${version}`);
  const publishers = [
    ...new Map(allPublishers.toReversed().map((run) => [run.workflow_id, run])).values(),
  ];
  if (!publishers.length) {
    return { state: "publishing (waiting for tag workflows)", url: tag.html_url };
  }
  const failure = publishers.find((run) => run.conclusion && run.conclusion !== "success");
  if (failure) return progress(failure, "publishing");
  const active = publishers.find((run) => run.conclusion !== "success");
  return { state: active ? "publishing" : "done", url: (active || publishers[0]).html_url };
}
export async function notifyWaiting(
  api,
  repository,
  id,
  send,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  attempts = 120,
) {
  const run = await api(`actions/runs/${id}`);
  const info = await identity(api, run, repository);
  // A rerun must not repeat the original approval notification.
  if (run.run_attempt !== 1) return false;
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (await pending(api, id)) {
      await send({
        mrkdwn: false,
        link_names: false,
        text:
          `${repository}: ${info.step} awaiting release approval\nVersion: ${info.version}\nRequested by: ${
            run.triggering_actor?.login || run.actor?.login
          }\n${
            info.pr ? `PR: ${info.pr}\n` : ""
          }Ask another marimo-eng member to approve: ${run.html_url}`,
      });
      return true;
    }
    // The observer itself keeps the run active: inspect the other jobs too.
    const jobs = await list(api, `actions/runs/${id}/jobs`, "jobs");
    const releaseJobs = jobs.filter((job) => job.name !== "Notify release approval");
    if (releaseJobs.length && releaseJobs.every((job) => job.status === "completed")) return false;
    await sleep(5000);
  }
  throw new Error("Timed out waiting for release approval; inspect the workflow run");
}
