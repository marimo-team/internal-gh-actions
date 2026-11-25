// Keep user-controlled metadata inert; only our generated links use mrkdwn.
const plain = (text) => ({ type: "plain_text", text, emoji: true });
const markdown = (text) => ({ type: "mrkdwn", text, verbatim: true });
const compact = (value) => String(value ?? "Unknown").replace(/[\r\n\t]+/g, " ").slice(0, 500);
function safeUrl(value) {
  try {
    const url = new URL(value);
    if (!["https:", "http:"].includes(url.protocol) || url.username || url.password) return null;
    if (url.href.length > 2000) return null;
    return url.href.replace(/[<>|]/g, (c) => encodeURIComponent(c)).replaceAll("&", "&amp;");
  } catch {
    return null;
  }
}
const escapeText = (text) =>
  text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
function link(url, label) {
  const safe = safeUrl(url);
  return safe ? `<${safe}|${escapeText(label)}>` : null;
}
function repositoryBlock(repository) {
  const name = compact(repository);
  return {
    type: "section",
    text: /^[\w.-]+\/[\w.-]+$/.test(name)
      ? markdown(`*${link(`https://github.com/${name}`, name)}*`)
      : plain(name),
  };
}
function linksBlock(links) {
  const valid = links.filter(Boolean);
  return valid.length ? [{ type: "section", text: markdown(valid.join("   ·   ")) }] : [];
}
function message(text, blocks) {
  return {
    text: escapeText(text),
    mrkdwn: false,
    link_names: false,
    unfurl_links: false,
    unfurl_media: false,
    blocks,
  };
}
export function approvalNotification(repository, info, run) {
  const step = info.step === "tagging" ? "Tag release" : "Prepare release PR";
  const actor = compact(run.triggering_actor?.login || run.actor?.login);
  const version = compact(info.version);
  const url = run.html_url;
  return message(
    `🟡 ${
      compact(repository)
    }: ${info.step} awaiting release approval\nVersion: ${version}\nRequested by: ${actor}\n${
      info.pr ? `PR: ${info.pr}\n` : ""
    }Ask another marimo-eng member to approve: ${url}`,
    [
      { type: "header", text: plain("🟡 Release approval needed") },
      repositoryBlock(repository),
      { type: "section", fields: [plain(`Version\n${version}`), plain(`Step\n${step}`)] },
      {
        type: "context",
        elements: [
          plain(`Requested by ${actor} · Approval required from another marimo-eng member`),
        ],
      },
      ...linksBlock([link(url, "Review & approve →"), link(info.pr, "View release PR")]),
    ],
  );
}
export function releaseNotification(status, repository, ref, url, artifact) {
  const success = status === "success";
  const heading = success ? "✅ Release published" : "❌ Release failed";
  let artifactLabel = "View artifact";
  try {
    const host = new URL(artifact).hostname;
    if (["npmjs.com", "www.npmjs.com", "pypi.org"].includes(host)) artifactLabel = "View package";
    else if (host === "github.com" && new URL(artifact).pathname.includes("/releases/")) {
      artifactLabel = "View release";
    }
  } catch { /* Omit invalid or absent artifact URLs below. */ }
  return message(
    `${heading}: ${compact(repository)} ${compact(ref)}\nWorkflow: ${url}${
      safeUrl(artifact) ? `\nArtifact: ${artifact}` : ""
    }`,
    [
      { type: "header", text: plain(heading) },
      repositoryBlock(repository),
      {
        type: "section",
        fields: [
          plain(`${/^v?\d+\.\d+\.\d+$/.test(ref) ? "Version" : "Ref"}\n${compact(ref)}`),
          plain(`Status\n${success ? "Published successfully" : "Publication did not complete"}`),
        ],
      },
      ...linksBlock([
        ...(success
          ? [link(artifact, artifactLabel), link(url, "View workflow")]
          : [link(url, "Inspect failed workflow →"), link(artifact, artifactLabel)]),
      ]),
    ],
  );
}
