# Docker Compose 部署说明

本部署形态是单个 app 容器加 PostgreSQL、Redis 两个依赖容器：

- `app`: AI Zero Token Web/Gateway，容器内固定 `AI_ZERO_TOKEN_HOME=/data`
- `postgres`: PostgreSQL，通过 `AZT_DATABASE_URL` 启用网关 SQL 存储
- `redis`: Redis，通过 `AZT_REDIS_URL` 启用跨进程请求限流状态

## 首次部署

```bash
cd /Users/raojiajun/mypro/server/nodejs/ai-zero-token
cp .env.example .env
```

编辑 `.env`，至少替换：

- `POSTGRES_PASSWORD`
- `AZT_DATABASE_URL` 中的密码
- `AZT_ADMIN_PASSWORD`
- `AZT_API_KEY`
- `AZT_SESSION_SECRET`

构建并启动：

```bash
npm run build
docker compose --env-file .env up -d --build
```

如果是从旧的 SQLite 部署迁移到 PostgreSQL，先停止 app 写入并执行现有迁移脚本：

```bash
export AZT_DATABASE_URL='postgresql://azt:你的密码@127.0.0.1:15432/ai_zero_token'
node scripts/migrate-sqlite-to-postgres.mjs \
  --sqlite-path ./state/.state/gateway.sqlite \
  --execute
```

默认 compose 把 PostgreSQL 仅绑定到宿主机 `127.0.0.1:15432`。app 容器内部仍使用 `.env` 里的 `postgres:5432`。

查看状态：

```bash
docker compose --env-file .env ps
curl -s http://127.0.0.1:${HOST_PORT:-80}/_gateway/auth/status
```

未带浏览器 Cookie 时，认证状态应类似：

```json
{"configured":true,"authenticated":false,"user":null,"role":null}
```

## 数据目录

compose 默认使用本地 bind mount：

```text
./state:/data
./state/postgres:/var/lib/postgresql/data
./state/redis:/data
```

其中 app 容器内保持 `AI_ZERO_TOKEN_HOME=/data`，生成图片、上传文件等运行时文件仍位于 `/data/.state`。启用 `AZT_DATABASE_URL` 后，网关 SQL 数据走 PostgreSQL；旧 SQLite 数据需要通过 `scripts/migrate-sqlite-to-postgres.mjs` 迁移。

## 远端更新脚本

保留旧的单容器部署模式。需要使用 compose 三服务部署时：

```bash
cd /Users/raojiajun/mypro/server/nodejs/ai-zero-token
DEPLOY_MODE=compose ./update.sh
```

`update.sh` 会把 app 数据卷继续挂载到远端的 `REMOTE_STATE`，默认是 `/opt/ai-zero-token/state:/data`，同时把 PostgreSQL、Redis 数据放到：

```text
/opt/ai-zero-token/state/postgres
/opt/ai-zero-token/state/redis
```

## 200 并发验收

只跑并发验收：

```bash
AZT_PERF_BASE_URL=http://127.0.0.1 \
AZT_PERF_USERNAME=admin \
AZT_PERF_PASSWORD='你的管理员密码' \
node scripts/api-perf-check.mjs --acceptance-200 --skip-endpoints
```

同时跑常规只读端点巡检和 200 并发验收：

```bash
AZT_PERF_BASE_URL=http://127.0.0.1 \
AZT_PERF_USERNAME=admin \
AZT_PERF_PASSWORD='你的管理员密码' \
node scripts/api-perf-check.mjs --rounds 2 --acceptance-200
```

默认验收口径：

- 并发数：`200`
- 总请求数：`200`
- 并发路径：`/_gateway/auth/status`
- 通过标准：失败数为 `0`，且并发请求 `p95 <= AZT_PERF_THRESHOLD_MS`，默认 `2000ms`

可覆盖示例：

```bash
node scripts/api-perf-check.mjs \
  --base-url http://127.0.0.1 \
  --username admin \
  --password '你的管理员密码' \
  --concurrency 200 \
  --requests 1000 \
  --concurrent-path /_gateway/status \
  --concurrent-threshold-ms 3000 \
  --skip-endpoints
```

## 当前限制

首次启用 `AZT_DATABASE_URL` 会让网关 SQL 数据切到 PostgreSQL。如果原来已有 `/data/.state/gateway.sqlite`，但没有先迁移，页面上会看到一个新的 PostgreSQL 数据集；旧 SQLite 文件不会被删除，但不会再作为主库读取。
