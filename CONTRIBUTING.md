# Contributing

Thanks for helping. Keep changes small and tested.

1. Open an issue that states the problem or the change you want.
2. Branch from an up-to-date `main`, one change per branch.
3. Run `npm ci --ignore-scripts`, `npm test` and `npm run check` before you push.
4. Open a pull request that says `Closes #ISSUE`, what changed, and how you verified it.
5. Never commit credentials, tokens, personal identifiers or local paths. Tests use fabricated data only.

Maintainers merge when checks pass and the change matches the project's scope. Updating `spec/openapi.json` is a deliberate change, so describe the upstream diff in the pull request.
