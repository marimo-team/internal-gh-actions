import { appendFileSync, lstatSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

export function version(value) {
  if (
    typeof value !== "string" || value !== value.trim() ||
    !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value)
  ) {
    throw new Error(
      `Expected stable MAJOR.MINOR.PATCH, got ${JSON.stringify(value)}`,
    );
  }
  return value;
}
export function mergedRelease(event, repository, base, value) {
  version(value);
  const pr = event.pull_request;
  if (
    event.action !== "closed" || !pr?.merged || pr.base.ref !== base ||
    pr.base.repo.full_name !== repository ||
    pr.head.repo?.full_name !== repository ||
    pr.head.ref !== `release/${value}` || pr.title !== `release: ${value}` ||
    !/^[a-f0-9]{40}$/.test(pr.merge_commit_sha)
  ) {
    throw new Error(
      "Expected a merged, same-repository release/VERSION PR with matching title and base",
    );
  }
  return pr.merge_commit_sha;
}
export function manifestVersion(path) {
  return version(JSON.parse(readFileSync(path, "utf8")).version);
}
export const git = (...args) =>
  execFileSync("git", args, { encoding: "utf8" }).trim();
export function output(name, value) {
  if (/[\r\n]/.test(String(value))) {
    throw new Error("Output must be a single line");
  }
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT, `${name}=${value}\n`);
  }
}
export function apiClient(repository, token) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository)) {
    throw new Error("Invalid repository");
  }
  return async (method, path, body) => {
    const response = await fetch(
      `${
        process.env.GITHUB_API_URL || "https://api.github.com"
      }/repos/${repository}/${path}`,
      {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
          "Content-Type": "application/json",
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      },
    );
    if (!response.ok) {
      const error = new Error(
        `GitHub ${method} ${path}: ${response.status} ${await response.text()}`,
      );
      error.status = response.status;
      throw error;
    }
    return response.status === 204 ? null : response.json();
  };
}
async function optional(api, path) {
  try {
    return await api("GET", path);
  } catch (error) {
    if (error.status === 404) return null;
    throw error;
  }
}
export async function tagCommit(api, tag) {
  const ref = await optional(api, `git/ref/tags/${encodeURIComponent(tag)}`);
  if (!ref) return null;
  let object = ref.object;
  for (let depth = 0; object.type === "tag" && depth < 10; depth++) {
    object = (await api("GET", `git/tags/${object.sha}`)).object;
  }
  if (object.type !== "commit") {
    throw new Error("Tag does not resolve to a commit");
  }
  return object.sha;
}
export async function ensureTag(api, value, sha) {
  const tag = `v${version(value)}`;
  const check = async () => {
    const existing = await tagCommit(api, tag);
    if (existing && existing !== sha) {
      throw new Error(`Immutable tag ${tag} points to another commit`);
    }
    return existing !== null;
  };
  if (await check()) return { tag, created: false };
  const object = await api("POST", "git/tags", {
    tag,
    message: `release: ${value}`,
    object: sha,
    type: "commit",
  });
  try {
    await api("POST", "git/refs", { ref: `refs/tags/${tag}`, sha: object.sha });
  } catch (error) {
    if (error.status !== 422 || !(await check())) throw error;
    return { tag, created: false };
  }
  return { tag, created: true };
}
export function preparedFiles(allowed) {
  const paths = allowed.split(/\r?\n/).map((p) => p.trim()).filter(Boolean);
  if (
    !paths.length ||
    paths.some((p) =>
      p.startsWith("/") || p.split("/").includes("..") || p.startsWith(".git/")
    )
  ) {
    throw new Error(
      "Provide an explicit list of repository-relative release files",
    );
  }
  const changed = execFileSync("git", ["diff", "--name-only", "-z", "HEAD"], {
    encoding: "utf8",
  }).split("\0").filter(Boolean);
  const untracked = execFileSync("git", [
    "ls-files",
    "--others",
    "--exclude-standard",
    "-z",
  ], { encoding: "utf8" }).split("\0").filter(Boolean);
  const names = [...new Set([...changed, ...untracked])];
  if (!names.length) throw new Error("No release changes were prepared");
  return names.map((path) => {
    if (!paths.includes(path) || path.startsWith(".github/")) {
      throw new Error(`Unexpected release file: ${path}`);
    }
    const stat = lstatSync(path);
    if (!stat.isFile() || (stat.mode & 0o111)) {
      throw new Error(
        `Release files must be regular, non-executable files: ${path}`,
      );
    }
    const content = new TextDecoder("utf-8", { fatal: true }).decode(
      readFileSync(path),
    );
    return { path, mode: "100644", type: "blob", content };
  });
}
export async function ensureReleasePr(
  api,
  repository,
  base,
  sha,
  value,
  files,
) {
  version(value);
  if (await tagCommit(api, `v${value}`)) {
    throw new Error(`Version ${value} is already tagged`);
  }
  const baseRef = await api("GET", `git/ref/heads/${encodeURIComponent(base)}`);
  if (baseRef.object.sha !== sha) {
    throw new Error(
      "Base branch advanced during preparation; run preparation again",
    );
  }
  const baseCommit = await api("GET", `git/commits/${sha}`);
  const tree = await api("POST", "git/trees", {
    base_tree: baseCommit.tree.sha,
    tree: files,
  });
  const branch = `release/${value}`;
  let ref = await optional(api, `git/ref/heads/${encodeURIComponent(branch)}`);
  if (!ref) {
    const commit = await api("POST", "git/commits", {
      message: `release: ${value}`,
      tree: tree.sha,
      parents: [sha],
    });
    try {
      ref = await api("POST", "git/refs", {
        ref: `refs/heads/${branch}`,
        sha: commit.sha,
      });
    } catch (error) {
      if (error.status !== 422) throw error;
      ref = await api("GET", `git/ref/heads/${encodeURIComponent(branch)}`);
    }
  }
  const existing = await api("GET", `git/commits/${ref.object.sha}`);
  if (
    existing.tree.sha !== tree.sha || existing.parents.length !== 1 ||
    existing.parents[0].sha !== sha
  ) {
    throw new Error(
      `Branch ${branch} has different changes; inspect it instead of overwriting it`,
    );
  }
  const prs = await api(
    "GET",
    `pulls?state=all&head=${
      encodeURIComponent(repository.split("/")[0] + ":" + branch)
    }&base=${encodeURIComponent(base)}&per_page=100`,
  );
  if (prs.length) {
    const open = prs.find((pr) => pr.state === "open");
    if (!open) {
      throw new Error(
        "Release PR was closed; reopen it or choose a new version",
      );
    }
    return open;
  }
  return api("POST", "pulls", {
    base,
    head: branch,
    title: `release: ${value}`,
    body:
      `Merging this PR creates the immutable v${value} tag and starts the configured release publishers.`,
  });
}
export function releaseStatus(status, results) {
  if (results) {
    const jobs = Object.values(JSON.parse(results));
    if (
      !jobs.length ||
      jobs.some((job) =>
        !["success", "failure", "cancelled", "skipped"].includes(job.result)
      )
    ) throw new Error("Invalid job results");
    return jobs.every((job) => job.result === "success")
      ? "success"
      : "failure";
  }
  if (!["success", "failure", "cancelled", "skipped"].includes(status)) {
    throw new Error("Invalid release status");
  }
  return status === "success" ? "success" : "failure";
}
export function notification(status, repository, ref, url, artifact) {
  return {
    text: `${
      status === "success" ? "✅" : "❌"
    } Release ${status} for ${repository} ${ref}`,
    blocks: [{
      type: "section",
      text: {
        type: "plain_text",
        text:
          `Release ${status}\nRepository: ${repository}\nRef: ${ref}\nWorkflow: ${url}${
            artifact ? `\nArtifact: ${artifact}` : ""
          }`,
      },
    }],
  };
}
