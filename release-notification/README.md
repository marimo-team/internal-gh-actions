# Release Notification Action

Sends Slack notifications for release success or failure.

## Inputs

| Input | Description | Required | Default |
|-------|-------------|----------|---------|
| `status` | `success` or `failure` | Yes | - |
| `slack-webhook-url` | Slack webhook URL | Yes | - |
| `artifact-url` | Marketplace/release URL | No | `''` |

**Note:** Automatically uses `github.event.repository.name` and checks `github.event.pull_request.head.repo.fork`.

## Usage

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

1. Create Slack Incoming Webhook: https://api.slack.com/apps
2. Add webhook URL as `SLACK_WEBHOOK_URL_RELEASES` secret in repository settings
