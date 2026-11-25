#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { approve, github, identity, notifyWaiting, status, waiting } from "../lib/control.mjs";
import { localRequest } from "../lib/local-request.mjs";
const [command, value, ...flags] = process.argv.slice(2);
try {
  const repository = process.env.GITHUB_REPOSITORY ||
    execFileSync("gh", ["repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"], {
      encoding: "utf8",
    }).trim();
  const api = github(repository);
  if (command === "request") {
    if (flags.some((flag) => flag !== "--dry-run")) throw new Error("Unknown request option");
    console.log(await localRequest(repository, value, { dryRun: flags.includes("--dry-run") }));
  } else if (command === "status") {
    console.log(JSON.stringify(await status(api, repository), null, 2));
  } else if (command === "approve") {
    if (value) {
      if (!/^\d+$/.test(value)) throw new Error("Select a numeric run ID");
      const run = await api(`actions/runs/${value}`);
      console.log({
        ...await identity(api, run, repository),
        actor: run.triggering_actor?.login || run.actor?.login,
        url: run.html_url,
      });
      console.log(await approve(api, repository, value));
    } else {
      const runs = await waiting(api, repository);
      console.table(runs);
      if (runs.length === 1) console.log(await approve(api, repository, runs[0].id));
      else {console.log(
          runs.length ? "Select a run: release approve RUN_ID" : "No waiting release runs",
        );}
    }
  } else if (command === "notify-waiting") {
    await notifyWaiting(api, repository, process.env.GITHUB_RUN_ID, async (payload) => {
      if (!process.env.SLACK_WEBHOOK_URL) throw new Error("SLACK_WEBHOOK_URL_RELEASES is required");
      const response = await fetch(process.env.SLACK_WEBHOOK_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(30000),
      });
      if (!response.ok) throw new Error(`Slack notification failed: HTTP ${response.status}`);
    });
  } else throw new Error("Usage: release request VERSION | status | approve [RUN_ID]");
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
