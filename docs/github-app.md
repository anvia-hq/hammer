# Post as a GitHub App

By default Hammer comments as `github-actions[bot]`, because the workflow token belongs to that account. To comment under your own bot name and avatar, give Hammer a token from a GitHub App you own.

## Create the App

1. In your org (or user) settings, open Developer settings, GitHub Apps, New GitHub App.
2. Name it (for example `hammer`), set any homepage URL, and untick Webhook > Active.
3. Repository permissions: Pull requests: Read and write, Issues: Read and write, Contents: Read-only.
4. Create the App, note its App ID, generate a private key, and install it on the repositories Hammer reviews.
5. Add the App ID as a repository variable (`HAMMER_APP_ID`) and the private key as a secret (`HAMMER_APP_PRIVATE_KEY`).

## Use it in the workflow

```yaml
steps:
  - id: app
    uses: actions/create-github-app-token@v2
    with:
      app-id: ${{ vars.HAMMER_APP_ID }}
      private-key: ${{ secrets.HAMMER_APP_PRIVATE_KEY }}
  - uses: anvia-hq/hammer@v1
    with:
      github-token: ${{ steps.app.outputs.token }}
      bot-login: hammer[bot]
      # client, model and api-key as usual
```

`bot-login` is the App's slug plus `[bot]`. It is required with an App token: an installation token cannot look up its own login, and Hammer uses the login to find and update its earlier summary and progress comments. Without it Hammer would assume `github-actions[bot]`, miss its own comments and post a new one each run.

Pin `actions/create-github-app-token` to a commit SHA if your org requires pinned actions.
