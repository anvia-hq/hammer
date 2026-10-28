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

Nothing else changes: you still pass only your model key. Hammer asks the Hammer platform for a short-lived token scoped to your repository ([0014](decision/0014-platform-token-broker.md)). Hammer reviews only repositories registered with the platform. If the repository is not registered, the App is not installed, or the platform is unreachable, the run fails with the reason and an install link. Fork PRs reviewed automatically do not get `id-token`, so they are refused too.

`platform-url` must not be empty. Leave it at the default.

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
      # client, model and api-key as usual
```
