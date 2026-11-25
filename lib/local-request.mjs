import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { nextVersion } from "./prepare.mjs";
import { github, stable } from "./control.mjs";

const shared = fileURLToPath(new URL("../", import.meta.url));
const exec = (command, args, options = {}) =>
  execFileSync(command, args, {
    encoding: "utf8",
    maxBuffer: 128 * 1024 * 1024,
    timeout: 20 * 60 * 1000,
    ...options,
  });
export function validatePlan(plan, settings, requested, originalMode) {
  if (plan.next !== nextVersion(plan.current, requested)) {
    throw new Error("Unexpected release version");
  }
  if (!Array.isArray(plan.files) || !plan.files.length) throw new Error("No release files");
  const seen = new Set();
  for (const file of plan.files) {
    if (
      typeof file.path !== "string" || !/^[\w./-]+$/.test(file.path) ||
      file.path.split("/").some((p) => !p || p === "." || p === ".." || p === ".git") ||
      file.path.startsWith(".github/") || !settings.files.includes(file.path) || seen.has(file.path)
    ) {
      throw new Error(`Unexpected release file: ${file.path}`);
    }
    seen.add(file.path);
    if (
      file.type !== "blob" || !["100644", "100755"].includes(file.mode) ||
      file.mode !== originalMode(file.path) || typeof file.content !== "string" ||
      Buffer.byteLength(file.content) > 16 * 1024 * 1024 ||
      Buffer.from(file.content).toString("utf8") !== file.content
    ) {
      throw new Error(`Invalid release file: ${file.path}`);
    }
  }
  return plan;
}
export function containerArgs(name, image) {
  return [
    "create",
    "--name",
    name,
    "--network",
    "bridge",
    "--cap-drop=ALL",
    "--security-opt=no-new-privileges",
    "--pids-limit=256",
    "--memory=4g",
    "--cpus=2",
    "--user=1000:1000",
    "--env",
    "HTTP_PROXY=",
    "--env",
    "HTTPS_PROXY=",
    "--env",
    "ALL_PROXY=",
    "--env",
    "NO_PROXY=",
    image,
    "sh",
    "-c",
    'mkdir -p /tmp/source && tar -xf /tmp/source.tar -C /tmp/source && cd /tmp/source && node /tmp/tooling/sandbox-runner.mjs "$1"',
    "release",
  ];
}
export function sandbox(archive, requested, root) {
  // Use a fresh Docker config to prevent automatic proxy credential injection.
  // Local Unix sockets only: never send source to a remote Docker daemon.
  const context = JSON.parse(exec("docker", ["context", "inspect"]))[0];
  const endpoint = process.env.DOCKER_HOST || context.Endpoints.docker.Host;
  if (!endpoint.startsWith("unix://")) throw new Error("Use a local Docker daemon (Unix socket)");
  const config = join(root, "docker");
  mkdirSync(config);
  const plugins = JSON.parse(exec("docker", ["info", "--format", "{{json .ClientInfo.Plugins}}"]));
  writeFileSync(
    join(config, "config.json"),
    JSON.stringify({
      cliPluginsExtraDirs: plugins.filter((p) => p.Name === "buildx").map((p) => dirname(p.Path)),
    }),
  );
  const docker = (args, options) =>
    exec("docker", ["--config", config, "--host", endpoint, ...args], options);
  const dockerfile = readFileSync(join(shared, "sandbox/Dockerfile"));
  const image = `release-preparation:${
    createHash("sha256").update(dockerfile).digest("hex").slice(0, 20)
  }`;
  // The empty context contains only this trusted Dockerfile. No repository build steps.
  docker(["build", "--tag", image, "-"], {
    input: dockerfile,
    stdio: ["pipe", "inherit", "inherit"],
  });
  writeFileSync(join(root, "source.tar"), archive);
  const name = `release-${randomUUID()}`;
  try {
    docker([...containerArgs(name, image), requested]);
    docker(["cp", join(root, "source.tar"), `${name}:/tmp/source.tar`]);
    docker(["cp", join(shared, "lib"), `${name}:/tmp/tooling`]);
    docker(["start", "--attach", name], { stdio: "inherit" });
    const state = JSON.parse(docker(["inspect", "--format", "{{json .State}}", name]));
    if (state.ExitCode !== 0 || state.OOMKilled) {
      throw new Error("Sandbox preparation failed; no PR created");
    }
    const result = join(root, "result.json");
    docker(["cp", `${name}:/tmp/result.json`, result]);
    if (!lstatSync(result).isFile() || lstatSync(result).size > 32 * 1024 * 1024) {
      throw new Error("Invalid sandbox result");
    }
    return JSON.parse(readFileSync(result, "utf8"));
  } finally {
    docker(["rm", "--force", name]);
  }
}
export async function localRequest(repository, requested, { dryRun = false } = {}) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository)) throw new Error("Invalid repository");
  if (!["patch", "minor", "major"].includes(requested) && !stable.test(requested)) {
    throw new Error("Use patch, minor, major, or stable X.Y.Z");
  }
  const api = github(repository);
  const root = mkdtempSync(join(tmpdir(), "release-request-"));
  try {
    const db = join(root, "git");
    // A new bare Git database never loads repository hooks/config or checks out source on the host.
    exec("git", ["init", "--bare", "--quiet", db]);
    const git = (...args) =>
      exec("git", [
        "--git-dir",
        db,
        "-c",
        "core.hooksPath=/dev/null",
        "-c",
        "credential.helper=",
        "-c",
        "credential.helper=!gh auth git-credential",
        ...args,
      ]).trim();
    const url = `https://github.com/${repository}.git`;
    git("fetch", "--depth=1", "--no-tags", url, "refs/heads/main");
    const sha = git("rev-parse", "FETCH_HEAD");
    const settings = JSON.parse(git("show", `${sha}:.release.json`));
    if (settings.repository !== repository || !Array.isArray(settings.files)) {
      throw new Error("Invalid release config");
    }
    const archive = exec("git", ["--git-dir", db, "archive", sha], { encoding: "buffer" });
    const plan = validatePlan(
      sandbox(archive, requested, root),
      settings,
      requested,
      (path) => git("ls-tree", sha, "--", path).slice(0, 6),
    );
    if (settings.manifest || !settings.metadata) {
      const manifest = settings.manifest || "package.json";
      if (
        JSON.parse(git("show", `${sha}:${manifest}`)).version !== plan.current ||
        JSON.parse(plan.files.find((f) => f.path === manifest)?.content || "{}").version !==
          plan.next
      ) {
        throw new Error("Manifest does not match release plan");
      }
    }
    console.error(
      `Validated ${repository} ${plan.current} → ${plan.next}: ${
        plan.files.map((f) => f.path).join(", ")
      }`,
    );
    if (dryRun) {
      return {
        repository,
        sha,
        version: plan.next,
        files: plan.files.map((f) => f.path),
        dryRun: true,
      };
    }
    git("read-tree", sha);
    for (const file of plan.files) {
      const blob = exec("git", ["--git-dir", db, "hash-object", "-w", "--stdin"], {
        input: file.content,
      }).trim();
      git("update-index", "--add", "--cacheinfo", file.mode, blob, file.path);
    }
    const tree = git("write-tree");
    if ((await api("git/ref/heads/main")).object.sha !== sha) {
      throw new Error("Main advanced; run preparation again");
    }
    if (git("ls-remote", url, `refs/tags/v${plan.next}`)) {
      throw new Error("Version is already tagged");
    }
    const branch = `release/${plan.next}`;
    if (git("ls-remote", url, `refs/heads/${branch}`)) {
      git("fetch", "--depth=2", "--no-tags", url, `refs/heads/${branch}`);
      const existing = git("rev-parse", "FETCH_HEAD");
      if (git("show", "-s", "--format=%T %P", existing) !== `${tree} ${sha}`) {
        throw new Error(
          `Branch ${branch} has different changes; inspect it instead of overwriting it`,
        );
      }
    } else {
      const user = JSON.parse(exec("gh", ["api", "user"]));
      const commit = exec("git", [
        "--git-dir",
        db,
        "-c",
        "commit.gpgsign=false",
        "commit-tree",
        tree,
        "-p",
        sha,
        "-m",
        `release: ${plan.next}`,
      ], {
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: user.login,
          GIT_COMMITTER_NAME: user.login,
          GIT_AUTHOR_EMAIL: `${user.id}+${user.login}@users.noreply.github.com`,
          GIT_COMMITTER_EMAIL: `${user.id}+${user.login}@users.noreply.github.com`,
        },
      }).trim();
      // Empty lease requires a new branch. Never overwrite a concurrent request or push tags.
      git(
        "push",
        "--no-follow-tags",
        `--force-with-lease=refs/heads/${branch}:`,
        url,
        `${commit}:refs/heads/${branch}`,
      );
    }
    const prs = await api(
      `pulls?state=all&head=${
        encodeURIComponent(repository.split("/")[0] + ":" + branch)
      }&base=main&per_page=100`,
    );
    if (prs.length) {
      const open = prs.find((pr) => pr.state === "open");
      if (!open) throw new Error("Release PR was closed; reopen it or choose a new version");
      return open.html_url;
    }
    const pr = await api("pulls", {
      base: "main",
      head: branch,
      title: `release: ${plan.next}`,
      body:
        `Prepared from main at ${sha} in a credential-free container.\n\nAfter CI and merge, a marimo-eng reviewer approves tagging in the protected release environment. Publication starts from v${plan.next}.`,
    });
    return pr.html_url;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
