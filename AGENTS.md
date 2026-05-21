# AI Zero Token Agent Notes

## Release Defaults

When the user asks to publish, release, or ship a new version, treat it as the full npm release flow unless they explicitly narrow the request.

Always check these files first:

- `BUILD_CLI.md` for the npm/CLI release flow.
- `docs/DESKTOP_RELEASE.md` for desktop artifact rules.
- `CHANGELOG.md` for the release notes entry.

For a normal npm release:

1. Confirm the intended version from `package.json`.
2. Update `package.json`, `package-lock.json`, and `CHANGELOG.md`.
3. Run `npm run typecheck`.
4. Run `npm run build`.
5. Run `npm run pack:dry` and inspect the packed file list.
6. Commit with `Release vX.Y.Z`.
7. Create tag `vX.Y.Z`.
8. Before publishing, verify npm auth from the project-local publish config:

   ```bash
   set -a; [ -f ./.env.publish ] && . ./.env.publish; set +a
   npm whoami --registry=https://registry.npmjs.org/
   ```

   The command must return the maintainer account with publish permission. If it returns `E401`, do not publish; update the ignored local `.env.publish` or `.npmrc` token first. Never print or commit token values.
9. Run `npm publish`.
10. Verify with `npm view ai-zero-token version`.
11. Push `master` and the release tag.

If GitHub CLI is installed, create or update the matching GitHub Release after the tag is pushed. If it is not installed, say so clearly.

Do not stage unrelated local files unless the user explicitly asks. In particular, leave `docs/images/wechat-free-account-settings.png` and `tmp/` alone when they are untracked.

## Gateway Stability Checks

For gateway, account rotation, Codex Responses, usage stats, model sync, or streaming changes, run at least:

- `npm run typecheck`
- `npm run build`
- `npm run pack:dry` before release

Check Codex-specific paths when relevant:

- `/codex/v1/responses`
- `/codex/v1/responses/compact`
- `/v1/chat/completions`
- model refresh and account rotation settings in the desktop UI

## Communication

Use Chinese for user-facing updates unless the user switches languages.

When reporting a release, include:

- version
- commit hash
- tag
- npm verification result
- whether GitHub Release artifacts were created or skipped
