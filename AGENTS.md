# AI Zero Token Agent Notes

## Local Workspace And Server Deployment

This project was customized and deployed as a Docker service for:

- Public URL: `http://43.134.21.160/`
- Public port: `80`
- Container name: `ai-zero-token`
- Docker image tag: `ai-zero-token:local`
- Local workspace: `/Users/raojiajun/mypro/server/nodejs/ai-zero-token`
- Server source path: `/opt/ai-zero-token/src`
- Server env file: `/opt/ai-zero-token/.env`
- Server persisted state volume: `/opt/ai-zero-token/state:/data`
- Runtime data root inside container: `AI_ZERO_TOKEN_HOME=/data`

Use Chinese for user-facing replies.

### What To Run Before Deploying

From the local workspace:

```bash
cd /Users/raojiajun/mypro/server/nodejs/ai-zero-token
npm run build
```

`npm run build` runs the admin UI Vite build and server `tsup` build. It is the normal pre-deploy verification for these UI/server changes.

### Docker Deployment Command

Deploy by syncing the built workspace to the server, rebuilding the Docker image, and recreating the container:

```bash
cd /Users/raojiajun/mypro/server/nodejs/ai-zero-token
npm run build && \
rsync -az --delete --exclude node_modules ./ root@43.134.21.160:/opt/ai-zero-token/src/ && \
ssh root@43.134.21.160 '
  cd /opt/ai-zero-token/src &&
  docker build -t ai-zero-token:local . >/tmp/azt-build.log &&
  docker rm -f ai-zero-token >/dev/null 2>&1 || true &&
  docker run -d \
    --name ai-zero-token \
    --restart unless-stopped \
    --env-file /opt/ai-zero-token/.env \
    -e AI_ZERO_TOKEN_HOME=/data \
    -p 80:8787 \
    -v /opt/ai-zero-token/state:/data \
    ai-zero-token:local &&
  sleep 2 &&
  docker ps --filter name=ai-zero-token --format "table {{.Names}}\t{{.Status}}\t{{.Ports}}" &&
  curl -s --max-time 10 http://127.0.0.1:80/_gateway/auth/status
'
```

The service listens on `8787` inside the container and is published as host port `80`.

### Post-Deploy Checks

Run these checks after deployment:

```bash
curl -s http://43.134.21.160/ | sed -n '1,40p'
ssh root@43.134.21.160 'docker logs --tail 80 ai-zero-token'
ssh root@43.134.21.160 'docker ps --filter name=ai-zero-token --format "table {{.Names}}\t{{.Status}}\t{{.Ports}}"'
```

Expected auth status without browser cookie:

```json
{"configured":true,"authenticated":false,"user":null,"role":null}
```

This means the admin auth system is configured and the unauthenticated curl is correctly not logged in.

### Important Deployment Notes

- Do not use `git reset --hard` or revert local changes unless the user explicitly asks.
- The worktree is intentionally dirty because this service has many local customizations.
- `rsync --delete` is used against `/opt/ai-zero-token/src`; be careful to run it only from the project root.
- Exclude `node_modules` from rsync. The Docker image installs production dependencies with `npm ci --omit=dev --ignore-scripts`.
- Persisted runtime state, SQLite database, generated images, and uploaded/reference files live under `/opt/ai-zero-token/state`; do not delete it during deploy.
- If a UI change appears stale, check the asset hash in the served HTML:

  ```bash
  curl -s http://43.134.21.160/ | sed -n '1,40p'
  ```

### Useful Server Debug Commands

Inspect recent generated image files:

```bash
ssh root@43.134.21.160 'find /opt/ai-zero-token/state -path "*generations*" -type f -printf "%T@ %s %p\n" | sort -nr | head -40'
```

Inspect recent generation history rows:

```bash
ssh root@43.134.21.160 'docker exec ai-zero-token sh -lc '"'"'node <<"NODE"
const { DatabaseSync } = require("node:sqlite");
const db = new DatabaseSync("/data/.state/gateway.sqlite");
for (const row of db.prepare("SELECT id, owner, created_at, status, endpoint, substr(prompt,1,60) AS prompt, duration_ms FROM generation_history ORDER BY created_at DESC LIMIT 12").all()) {
  console.log(JSON.stringify(row));
}
NODE'"'"''
```

Inspect request logs:

```bash
ssh root@43.134.21.160 'docker exec ai-zero-token sh -lc '"'"'node <<"NODE"
const { DatabaseSync } = require("node:sqlite");
const db = new DatabaseSync("/data/.state/gateway.sqlite");
for (const row of db.prepare("SELECT id, owner, time, method, endpoint, model, status_code, duration_ms, source FROM request_logs ORDER BY time DESC LIMIT 20").all()) {
  console.log(JSON.stringify(row));
}
NODE'"'"''
```

### Current Custom Behavior To Preserve

- Multi-user admin/user management is stored in SQLite.
- Normal users only see image generation and their own request logs/history.
- Admin users default to their own data but can filter to other users or all users.
- Image generation history and request logs are persisted in SQLite.
- Generated images are saved locally under the persisted state volume.
- Image previews are compressed server-side, but UI previews must display complete images with `object-fit: contain` and must not crop.
- The request log UI must not display account information in the list, detail panel, detail JSON, or copied detail payload.
- The image generation page must prevent duplicate submissions while one generation is running.
- Successful/failed generation saves clean up covered stale `running` history rows for the same owner, endpoint, and prompt.

## Release Defaults

When the user asks to publish, release, or ship a new version, treat it as the full npm plus desktop GitHub Release flow unless they explicitly narrow the request.

Always check these files first:

- `BUILD_CLI.md` for the npm/CLI release flow.
- `docs/DESKTOP_RELEASE.md` for desktop artifact rules.
- `CHANGELOG.md` for the release notes entry.

For a normal release:

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
12. Build desktop artifacts:

   ```bash
   npm run dist:mac
   npm run dist:win
   ```

   If disk space is low, clean only ignored/rebuildable `release/` old-version artifacts and unpacked intermediate directories, never source files or user data.
13. Rename or stage the generated desktop assets so the GitHub Release has the standard user-facing artifacts:

   ```text
   AI Zero Token-{version}-mac-arm64.dmg
   AI Zero Token-{version}-mac-x64.dmg
   AI Zero Token Setup {version}.exe
   AI Zero Token-{version}-win.zip
   ```

   Do not upload mac zip files, blockmaps, unpacked app directories, debug metadata, or auto-update metadata unless the release explicitly enables an auto-update channel.
14. Create or update the matching GitHub Release and upload the four desktop artifacts. If `gh` is installed, use it. If `gh` is not installed, load the ignored project-local `.env.github` token and use the GitHub Releases API. Never print or commit GitHub token values.

GitHub may normalize uploaded asset names by replacing spaces with dots. Still verify that the four expected macOS/Windows artifacts are present on the release.

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
