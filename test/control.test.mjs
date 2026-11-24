import assert from "node:assert/strict";
import { test } from "node:test";
import { approve, identity, list, notifyWaiting, request, status } from "../lib/control.mjs";
const repo = "team/repo";
const prep = {
  id: 1,
  path: ".github/workflows/release-pr.yml",
  event: "workflow_dispatch",
  head_branch: "main",
  html_url: "https://example/run/1",
  run_attempt: 1,
  created_at: "2026-01-01T00:00:00Z",
};
const pr = {
  number: 2,
  title: "release: 1.2.3",
  head: { ref: "release/1.2.3", sha: "head", repo: { full_name: repo } },
  base: { ref: "main", repo: { full_name: repo } },
  merged: true,
  merged_at: "2026-01-02T00:00:00Z",
  merge_commit_sha: "merge",
  created_at: "2026-01-01T01:00:00Z",
  html_url: "https://example/pr/2",
  state: "closed",
};
const tag = {
  ...prep,
  id: 3,
  path: ".github/workflows/release-tag.yml",
  event: "pull_request",
  head_branch: "release/1.2.3",
  head_sha: "head",
  created_at: "2026-01-02T00:00:01Z",
};
const deployment = { environment: { id: 8, name: "release" }, current_user_can_approve: true };
function fixture(run = tag, pull = pr, pending = [deployment]) {
  const writes = [];
  const api = async (path, body) => {
    if (body) {
      writes.push([path, body]);
      return {};
    }
    if (/pending_deployments/.test(path)) return pending;
    if (/commits\/.+\/pulls/.test(path)) return [{ number: 2 }];
    if (path === "pulls/2") return pull;
    if (/\/jobs/.test(path)) {
      return {
        jobs: [{ name: "Tag", status: "completed" }, {
          name: "Notify release approval",
          status: "in_progress",
        }],
      };
    }
    if (/actions\/runs\/\d+$/.test(path)) return run;
    throw new Error(path);
  };
  return { api, writes };
}
test("request returns the exact dispatch URL without racing other requests", async () => {
  let count = 0;
  const api = async (path, body) => {
    count++;
    assert.equal(path, "actions/workflows/release-pr.yml/dispatches");
    assert.deepEqual(body, { ref: "main", inputs: { version: "patch" }, return_run_details: true });
    return { html_url: "https://example/exact" };
  };
  assert.match(await request(api, "patch"), /approve: https:\/\/example\/exact/);
  await assert.rejects(request(api, "1.2.3-rc.1"));
  assert.equal(count, 1);
});
test("approval validates PR head SHA, merged time and exact identity before writing", async () => {
  const { api, writes } = fixture();
  await approve(api, repo, 3);
  assert.deepEqual(writes[0][1].environment_ids, [8]);
  for (
    const change of [
      { merged: false },
      { title: "release: 01.2.3" },
      { head: { ...pr.head, sha: "other" } },
      { head: { ...pr.head, repo: { full_name: "fork/repo" } } },
      { base: { ...pr.base, ref: "dev" } },
      { merged_at: "2026-01-03T00:00:00Z" },
    ]
  ) {
    const f = fixture(tag, { ...pr, ...change });
    await assert.rejects(approve(f.api, repo, 3));
    assert.equal(f.writes.length, 0);
  }
  for (
    const change of [{ path: ".github/workflows/other.yml" }, { event: "pull_request_target" }, {
      head_branch: "other",
    }]
  ) {
    const f = fixture({ ...tag, ...change });
    await assert.rejects(approve(f.api, repo, 3));
    assert.equal(f.writes.length, 0);
  }
});
test("preparation only allows dispatch from main; respects GitHub approval permissions", async () => {
  await identity(fixture(prep).api, prep, repo);
  await assert.rejects(identity(fixture().api, { ...prep, head_branch: "feature" }, repo));
  for (const pending of [[], [{ ...deployment, current_user_can_approve: false }]]) {
    const f = fixture(prep, pr, pending);
    await assert.rejects(approve(f.api, repo, 1));
    assert.equal(f.writes.length, 0);
  }
});
test("notifications send once only for pending environments, never rejected jobs or reruns", async () => {
  for (const run of [prep, tag]) {
    const messages = [];
    assert.equal(
      await notifyWaiting(fixture(run).api, repo, run.id, (p) => messages.push(p)),
      true,
    );
    assert.equal(messages.length, 1);
    assert.match(messages[0].text, /awaiting release approval/);
  }
  for (const f of [fixture(tag, pr, []), fixture({ ...tag, run_attempt: 2 })]) {
    assert.equal(
      await notifyWaiting(f.api, repo, 3, () => assert.fail("unexpected notification")),
      false,
    );
  }
});
test("notification polls until pending instead of guessing from run status", async () => {
  const f = fixture(prep);
  let reads = 0;
  let sent = 0;
  const api = async (path) =>
    path.endsWith("/pending_deployments")
      ? (++reads === 1 ? [] : [deployment])
      : path.includes("/jobs")
      ? { jobs: [] }
      : f.api(path);
  await notifyWaiting(api, repo, 1, () => sent++, async () => {});
  assert.equal(reads, 2);
  assert.equal(sent, 1);
});
test("status walks all five release states and preserves failures", async () => {
  for (
    const phase of [
      "preparation awaiting approval",
      "PR open",
      "tagging awaiting approval",
      "publishing",
      "done",
      "publishing failure",
    ]
  ) {
    const api = async (path) => {
      if (path.includes("release-pr.yml/runs")) {
        return { workflow_runs: [{ ...prep, conclusion: "success" }] };
      }
      if (path === "actions/runs/1/pending_deployments") {
        return phase === "preparation awaiting approval" ? [deployment] : [];
      }
      if (path.startsWith("pulls?")) {
        return [{ ...pr, state: phase === "PR open" ? "open" : "closed" }];
      }
      if (path === "pulls/2") return pr;
      if (path.includes("release-tag.yml/runs")) {
        assert.match(path, /head_sha=head/);
        return { workflow_runs: [{ ...tag, conclusion: "success" }] };
      }
      if (path.startsWith("commits/head/pulls")) return [{ number: 2 }];
      if (path === "actions/runs/3/pending_deployments") {
        return phase === "tagging awaiting approval" ? [deployment] : [];
      }
      if (path.startsWith("actions/runs?event=push")) {
        return {
          workflow_runs: [{
            head_branch: "v1.2.3",
            html_url: "https://example/publish",
            conclusion: phase === "done"
              ? "success"
              : phase === "publishing failure"
              ? "failure"
              : null,
          }],
        };
      }
      throw new Error(path);
    };
    assert.equal((await status(api, repo)).state, phase);
  }
});
test("pagination reads beyond the first page", async () => {
  const all = await list(
    async (path) => path.endsWith("&page=1") ? Array(100).fill(1) : [2],
    "pulls",
  );
  assert.equal(all.length, 101);
});

test("status finds an existing PR reused by a successful preparation retry", async () => {
  const api = async (path) => {
    if (path.includes("release-pr.yml/runs")) {
      return {
        workflow_runs: [{ ...prep, created_at: "2026-01-05T00:00:00Z", conclusion: "success" }],
      };
    }
    if (path.endsWith("/pending_deployments")) return [];
    if (path.startsWith("pulls?")) return [{ ...pr, state: "open" }];
    throw new Error(path);
  };
  assert.deepEqual(await status(api, repo), { state: "PR open", url: pr.html_url });
});
