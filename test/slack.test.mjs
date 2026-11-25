import assert from "node:assert/strict";
import { test } from "node:test";
import { approvalNotification, releaseNotification } from "../lib/slack.mjs";
const run = {
  html_url: "https://github.com/team/repo/actions/runs/123",
  actor: { login: "requester" },
};
const info = { step: "tagging", version: "2.0.2", pr: "https://github.com/team/repo/pull/42" };
function renderedLinks(payload) {
  return payload.blocks.filter((b) => b.text?.type === "mrkdwn").map((b) => b.text.text).join("\n");
}
test("approval card has actionable links, clear metadata and accessible fallback", () => {
  const p = approvalNotification("team/repo", info, run);
  assert.equal(p.blocks[0].text.text, "🟡 Release approval needed");
  assert.match(
    renderedLinks(p),
    /<https:\/\/github.com\/team\/repo\/actions\/runs\/123\|Review &amp; approve →>/,
  );
  assert.match(renderedLinks(p), /pull\/42\|View release PR/);
  assert.ok(p.blocks.some((b) => b.fields?.some((f) => f.text === "Version\n2.0.2")));
  for (const value of ["team/repo", "2.0.2", "requester", info.pr, run.html_url]) {
    assert.ok(p.text.includes(value));
  }
  assert.equal(p.unfurl_links, false);
});
test("preparation omits missing PR and uses the rerun requester", () => {
  const p = approvalNotification("team/repo", { step: "preparation", version: "minor" }, {
    ...run,
    triggering_actor: { login: "other" },
  });
  assert.ok(!renderedLinks(p).includes("View release PR"));
  assert.ok(p.text.includes("other"));
  assert.ok(p.blocks.some((b) => b.fields?.some((f) => f.text === "Step\nPrepare release PR")));
});
test("success and failure cards prioritize the correct destination", () => {
  const packageUrl = "https://npmjs.com/package/@team/repo";
  const success = releaseNotification("success", "team/repo", "v2.0.2", run.html_url, packageUrl);
  const failure = releaseNotification("failure", "team/repo", "v2.0.2", run.html_url, packageUrl);
  assert.equal(success.blocks[0].text.text, "✅ Release published");
  assert.equal(failure.blocks[0].text.text, "❌ Release failed");
  assert.ok(
    renderedLinks(success).indexOf("View package") <
      renderedLinks(success).indexOf("View workflow"),
  );
  assert.ok(
    renderedLinks(failure).indexOf("Inspect failed workflow") <
      renderedLinks(failure).indexOf("View package"),
  );
});
test("hostile metadata cannot create mentions or extra links", () => {
  const value = "<!channel> *bold* `code` <https://evil.test|click>";
  const p = approvalNotification(value, { ...info, version: value }, {
    ...run,
    actor: { login: value },
  });
  assert.ok(!renderedLinks(p).includes(value));
  assert.equal(p.mrkdwn, false);
  assert.equal(p.link_names, false);
  assert.deepEqual(JSON.parse(JSON.stringify(p)), p);
});
test("invalid artifact links are omitted; Slack delimiters in URLs are encoded", () => {
  for (
    const url of [undefined, "", "javascript:alert(1)", "https://user:pass@example.com", 'x"y']
  ) {
    const p = releaseNotification("success", "team/repo", "v1", run.html_url, url);
    assert.ok(!renderedLinks(p).includes("View artifact"));
  }
  const p = releaseNotification(
    "success",
    "team/repo",
    "v1",
    run.html_url,
    "https://example.com/a|b?x=1&y=2",
  );
  assert.match(renderedLinks(p), /a%7Cb\?x=1&amp;y=2\|View artifact/);
});
test("long request metadata stays within Slack field limits", () => {
  const p = approvalNotification("team/repo", { ...info, version: "x".repeat(10000) }, {
    ...run,
    actor: { login: "a".repeat(10000) },
  });
  for (const block of p.blocks) {
    for (const field of block.fields || block.elements || []) assert.ok(field.text.length <= 2000);
  }
});
