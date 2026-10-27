# Post as the Hammer bot

By default Hammer comments as `github-actions[bot]`, because the workflow token belongs to that account. To comment as the Hammer bot:

1. Install the Hammer GitHub App on your repository.
2. Add `id-token: write` to the workflow permissions.

```yaml
permissions:
  contents: read
  pull-requests: write
  id-token: write
```

Nothing else changes: you still pass only your model key. Hammer asks the Hammer platform for a short-lived token scoped to your repository ([0014](decision/0014-platform-token-broker.md)). If the permission or the installation is missing, or the platform is unreachable, Hammer logs the reason and posts as `github-actions[bot]`, so the review still happens. Fork PRs reviewed automatically do not get `id-token` and use the workflow token.

Set `platform-url` to an empty string to disable the lookup, or to your own broker's URL.

## Use your own GitHub App

Create an App with Contents (read), Pull requests (read and write) and Issues (read and write), install it on the repository, and pass its installation token and login:

```yaml
steps:
  - id: app
    uses: actions/create-github-app-token@v2
    with:
      app-id: ${{ vars.APP_ID }}
      private-key: ${{ secrets.APP_PRIVATE_KEY }}
  - uses: anvia-hq/hammer@v1
    with:
      github-token: ${{ steps.app.outputs.token }}
      bot-login: my-app[bot]
      # client, model and api-key as usual
```

`bot-login` is the App's slug plus `[bot]`. It is required with your own App token: an installation token cannot look up its own login, and Hammer uses the login to find and update its earlier comments. Setting it also skips the platform lookup.
