# Post as the Hammer bot

By default Hammer comments as `github-actions[bot]`, because the workflow token belongs to that account. To comment as the Hammer bot:

1. Install the Hammer GitHub App on your repository.
2. Sign in at [hammer.anvia.dev](https://hammer.anvia.dev), register the repository (you need admin permission on it) and copy the API key it shows.
3. Add the key as the repository secret `HAMMER_API_KEY` and pass it to the Action:

```yaml
permissions:
  contents: read
  pull-requests: write

steps:
  - uses: anvia-hq/hammer@v1
    with:
      client: anthropic
      model: claude-sonnet-5-5
      api-key: ${{ secrets.MODEL_API_KEY }}
      hammer-api-key: ${{ secrets.HAMMER_API_KEY }}
```

You still pass your model key. Hammer asks the Hammer platform for a short-lived token scoped to your repository ([0014](decision/0014-platform-token-broker.md), [0016](decision/0016-platform-registration.md)). If the key, the registration or the installation is missing, or the platform is unreachable, Hammer logs the reason and posts as `github-actions[bot]`, so the review still happens. Fork PRs do not receive repository secrets and use the workflow token.

Without `hammer-api-key`, Hammer falls back to a GitHub OIDC token when the workflow grants `id-token: write`.

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
