# Internal (but public) marimo GH actions

Reusable GitHub Actions for internal marimo workflows.

## Actions

### Release Notification

Sends Slack notifications for release success or failure. Automatically uses repository name and checks for forked PRs.

**Inputs:**

| Input | Description | Required |
|-------|-------------|----------|
| `status` | `success` or `failure` | Yes |
| `slack-webhook-url` | Slack webhook URL | Yes |
| `artifact-url` | Marketplace/release URL | No |

**Usage:**

```yaml
- name: Notify Release Result
  if: always()
  uses: marimo-team/internal-gh-actions/release-notification@main
  with:
    status: ${{ job.status }}
    slack-webhook-url: ${{ secrets.SLACK_WEBHOOK_URL_RELEASES }}
    artifact-url: 'https://marketplace.visualstudio.com/items?itemName=marimo-team.vscode-marimo'
```

## Setup

1. Create a Slack Incoming Webhook at https://api.slack.com/apps
2. Add webhook URL as `SLACK_WEBHOOK_URL_RELEASES` secret in your GitHub repository
3. Reference actions using `marimo-team/internal-gh-actions/action-name@main`
