import { chmodSync, symlinkSync } from "node:fs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import {
  ensureReleasePr,
  ensureTag,
  mergedRelease,
  notification,
  preparedFiles,
  releaseStatus,
  version,
} from "../lib/release.mjs";

const sha = "a".repeat(40);
const event = () => ({
  action: "closed",
  pull_request: {
    merged: true,
    merge_commit_sha: sha,
    base: { ref: "main", repo: { full_name: "team/repo" } },
    head: { ref: "release/1.2.3", repo: { full_name: "team/repo" } },
    title: "release: 1.2.3",
  },
});
const missing = () => {
  throw Object.assign(new Error("missing"), { status: 404 });
};
test("stable versions reject leading zeros, prereleases and injection", () => {
  assert.equal(version("1.2.3"), "1.2.3");
  for (
    const v of [
      "01.2.3",
      "1.2.3-rc.1",
      "1.2",
      "1.2.3\nx=1",
      "1.2.3\n",
      "1.2.3\r\n",
      "1.2.3\r",
      "1.2.3\u2028",
      "1.2.3\u2029",
      null,
    ]
  ) {
    assert.throws(() => version(v));
  }
});
test("release identity requires merged same-repo exact branch/title/base", () => {
  assert.equal(mergedRelease(event(), "team/repo", "main", "1.2.3"), sha);
  for (
    const mutate of [
      (e) => e.action = "opened",
      (e) => e.pull_request.merged = false,
      (e) => e.pull_request.head.repo.full_name = "fork/repo",
      (e) => e.pull_request.base.ref = "other",
      (e) => e.pull_request.head.ref = "main",
      (e) => e.pull_request.title = "release: 1.2.4",
      (e) => e.pull_request.merge_commit_sha = null,
    ]
  ) {
    const e = event();
    mutate(e);
    assert.throws(() => mergedRelease(e, "team/repo", "main", "1.2.3"));
  }
});
test("creates annotated tag without updating any existing ref", async () => {
  const calls = [];
  const api = async (method, path, body) => {
    calls.push([method, path, body]);
    if (method === "GET") return missing();
    if (path === "git/tags") return { sha: "tag-object" };
    assert.deepEqual(body, { ref: "refs/tags/v1.2.3", sha: "tag-object" });
    return {};
  };
  assert.deepEqual(await ensureTag(api, "1.2.3", sha), {
    tag: "v1.2.3",
    created: true,
  });
  assert.equal(calls[1][2].object, sha);
  assert.ok(calls.every(([method]) => method !== "PATCH"));
});
for (const annotated of [false, true]) {
  test(`same tag is a no-op (annotated=${annotated})`, async () => {
    const api = async (method, path) => {
      assert.equal(method, "GET");
      return {
        object: annotated && path.includes("/ref/")
          ? { type: "tag", sha: "object" }
          : { type: "commit", sha },
      };
    };
    assert.equal((await ensureTag(api, "1.2.3", sha)).created, false);
  });
}
test("rejects conflicting tag and propagates API denial", async () => {
  await assert.rejects(
    ensureTag(
      async () => ({ object: { type: "commit", sha: "different" } }),
      "1.2.3",
      sha,
    ),
    /another commit/,
  );
  await assert.rejects(
    ensureTag(
      async () => {
        throw Object.assign(new Error("denied"), { status: 403 });
      },
      "1.2.3",
      sha,
    ),
    /denied/,
  );
});
test("concurrent tag creation accepts only identical target", async () => {
  let refs = 0;
  const api = async (method, path) => {
    if (method === "GET") {
      if (!refs++) return missing();
      return { object: { type: "commit", sha } };
    }
    if (path === "git/tags") return { sha: "tag" };
    throw Object.assign(new Error("exists"), { status: 422 });
  };
  assert.equal((await ensureTag(api, "1.2.3", sha)).created, false);
});
function prApi(
  {
    exists = false,
    conflict = false,
    advanced = false,
    tagged = false,
    closed = false,
    race = false,
  } = {},
) {
  const calls = [];
  let raced = false;
  const api = async (method, path, body) => {
    calls.push([method, path, body]);
    if (path.startsWith("git/ref/tags/")) {
      return tagged ? { object: { type: "commit", sha } } : missing();
    }
    if (path === "git/ref/heads/main") {
      return { object: { sha: advanced ? "new" : sha } };
    }
    if (path.startsWith("git/ref/heads/release")) {
      return (exists || raced) ? { object: { sha: "release" } } : missing();
    }
    if (path === `git/commits/${sha}`) return { tree: { sha: "base-tree" } };
    if (path === "git/trees") return { sha: "prepared-tree" };
    if (path === "git/commits") return { sha: "release" };
    if (path === "git/refs") {
      if (race) {
        raced = true;
        throw Object.assign(new Error("exists"), { status: 422 });
      }
      return { object: { sha: "release" } };
    }
    if (path === "git/commits/release") {
      return {
        tree: { sha: conflict ? "edited" : "prepared-tree" },
        parents: [{ sha }],
      };
    }
    if (path.startsWith("pulls?")) {
      return exists
        ? [{
          state: closed ? "closed" : "open",
          html_url: "existing",
          number: 1,
        }]
        : [];
    }
    if (path === "pulls") return { html_url: "created", number: 2 };
    throw new Error(`${method} ${path}`);
  };
  return { api, calls };
}
test("release PR uses version branch and exact base without pushing main", async () => {
  const { api, calls } = prApi();
  assert.equal(
    (await ensureReleasePr(api, "team/repo", "main", sha, "1.2.3", []))
      .html_url,
    "created",
  );
  assert.deepEqual(calls.find((c) => c[1] === "git/refs")[2], {
    ref: "refs/heads/release/1.2.3",
    sha: "release",
  });
  assert.ok(calls.every(([method]) => method !== "PATCH"));
});
test("identical rerun reuses PR without changing release branch", async () => {
  const { api, calls } = prApi({ exists: true });
  assert.equal(
    (await ensureReleasePr(api, "team/repo", "main", sha, "1.2.3", []))
      .html_url,
    "existing",
  );
  assert.ok(!calls.some((c) => c[1] === "git/refs" || c[1] === "pulls"));
});
for (
  const options of [{ exists: true, conflict: true }, { advanced: true }, {
    tagged: true,
  }, { exists: true, closed: true }]
) {
  test(`rejects unsafe PR preparation ${JSON.stringify(options)}`, async () => {
    const { api } = prApi(options);
    await assert.rejects(
      ensureReleasePr(api, "team/repo", "main", sha, "1.2.3", []),
    );
  });
}
test("prepared diff rejects files outside exact allowlist", () => {
  const previous = process.cwd();
  const dir = mkdtempSync(`${tmpdir()}/release-test-`);
  try {
    process.chdir(dir);
    const git = (...args) => execFileSync("git", args, { stdio: "ignore" });
    git("init");
    git("config", "user.name", "test");
    git("config", "user.email", "test@example.com");
    writeFileSync("package.json", '{"version":"1.0.0"}');
    writeFileSync("script.py", "version = '1.0.0'", { mode: 0o755 });
    git("add", ".");
    git("commit", "-m", "initial");
    writeFileSync("script.py", "version = '1.0.1'");
    assert.equal(preparedFiles("script.py")[0].mode, "100755");
    chmodSync("script.py", 0o644);
    assert.throws(() => preparedFiles("script.py"), /mode must not change/);
    git("checkout", "--", "script.py");
    writeFileSync("package.json", '{"version":"1.0.1"}');
    assert.equal(
      preparedFiles("package.json")[0].content,
      '{"version":"1.0.1"}',
    );
    writeFileSync("unexpected.txt", "unexpected");
    assert.throws(() => preparedFiles("package.json"), /Unexpected/);
    rmSync("unexpected.txt");
    mkdirSync(".github");
    writeFileSync(".github/test.yml", "name: unsafe");
    assert.throws(
      () => preparedFiles("package.json\n.github/test.yml"),
      /Unexpected/,
    );
    rmSync(".github", { recursive: true });
    chmodSync("package.json", 0o755);
    assert.throws(() => preparedFiles("package.json"), /mode must not change/);
    chmodSync("package.json", 0o644);
    writeFileSync("package.json", Buffer.from([0xff]));
    assert.throws(() => preparedFiles("package.json"), /encoded data/);
    rmSync("package.json");
    symlinkSync("missing-target", "package.json");
    assert.throws(() => preparedFiles("package.json"), /regular/);
    rmSync("package.json");
    assert.throws(() => preparedFiles("package.json"), /ENOENT/);
  } finally {
    process.chdir(previous);
    rmSync(dir, { recursive: true, force: true });
  }
});
test("aggregate notification fails for any missing required publication", () => {
  assert.equal(
    releaseStatus("", JSON.stringify({ a: { result: "success" } })),
    "success",
  );
  for (const result of ["failure", "cancelled", "skipped"]) {
    assert.equal(
      releaseStatus(
        "",
        JSON.stringify({ a: { result: "success" }, b: { result } }),
      ),
      "failure",
    );
    assert.equal(releaseStatus(result, ""), "failure");
  }
  assert.throws(() => releaseStatus("", "{}"));
  const payload = notification(
    "success",
    "team/repo",
    'tag"\nquoted',
    "https://example.com",
    'x"y',
  );
  assert.deepEqual(JSON.parse(JSON.stringify(payload)), payload);
  assert.equal(payload.blocks[0].text.type, "plain_text");
});

test("concurrent PR ref creation reuses identical changes and rejects conflicts", async () => {
  const identical = prApi({ race: true });
  assert.equal(
    (await ensureReleasePr(
      identical.api,
      "team/repo",
      "main",
      sha,
      "1.2.3",
      [],
    )).html_url,
    "created",
  );
  const conflicting = prApi({ race: true, conflict: true });
  await assert.rejects(
    ensureReleasePr(conflicting.api, "team/repo", "main", sha, "1.2.3", []),
    /different changes/,
  );
});
test("concurrent tag creation rejects a different target", async () => {
  let reads = 0;
  const api = async (method, path) => {
    if (method === "GET") {
      if (!reads++) return missing();
      return { object: { type: "commit", sha: "other" } };
    }
    if (path === "git/tags") return { sha: "tag" };
    throw Object.assign(new Error("exists"), { status: 422 });
  };
  await assert.rejects(ensureTag(api, "1.2.3", sha), /another commit/);
});
