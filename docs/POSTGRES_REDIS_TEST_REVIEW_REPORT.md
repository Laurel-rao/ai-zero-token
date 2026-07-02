# PostgreSQL + Redis 改造测试与审查报告

本报告记录单实例 PostgreSQL + Redis 改造的本地测试、生产 SQLite 迁移演练和代码审查结论。当前目标是生产化单实例运行，不包含多实例负载均衡和对象存储迁移。

## 范围

- PostgreSQL 主路径：用户、用户组、设置、请求日志、生成历史、聊天会话/消息。
- SQLite fallback：未配置 `AZT_DATABASE_URL` 时继续使用本地 SQLite。
- Redis 限流路径：未配置 `AZT_REDIS_URL` 时使用内存队列；配置 Redis 后使用 Redis 账号并发槽、最小启动间隔和 TTL。
- 迁移脚本：从 `/data/.state/gateway.sqlite` 导入 PostgreSQL，并校验行数、JSON 字段和生成图片路径。
- 部署：本地/服务器 Docker Compose 形态为 app + PostgreSQL + Redis，生成图片文件仍保留在 `/data`。

## 测试 Agent 结论

测试 agent 已完成只读验证：

- 本地 compose 服务运行正常：`ai-zero-token`、`ai-zero-token-postgres`、`ai-zero-token-redis` 均为 healthy。
- PostgreSQL 版本为 15.15，本地 app 主库已自动创建 7 张业务表。
- Redis `PING` 正常。
- 管理员登录成功：`admin / Admin`。
- 顺序只读接口巡检通过，13 个端点均为 HTTP 200。
- 200 并发验收通过：`requests=200`、`concurrency=200`、`failures=0`。

覆盖说明：

- 已覆盖 PostgreSQL 主路径的管理登录、设置读取、用户/用户组列表、请求日志、生成历史等只读端点。
- 200 并发默认压测路径是 `/_gateway/auth/status`，覆盖 app/auth 并发稳定性。
- Redis request-throttle 的真实模型请求路径需要可用 OAuth profile 才能端到端覆盖；当前本地 `activeProvider: none`，因此通过 Redis 存储层直接行为测试补充验证。

## 生产 SQLite 迁移演练

生产 SQLite 已复制到本地：

```text
tmp/production-sqlite-migration/gateway.production.sqlite
sha256=aff42a8ba7acad664963d15a5aae3db3eef889720f6b1c7d084f0ff8455535ae
```

dry-run 通过：

```text
gateway_settings=1
gateway_user_groups=2
gateway_users=1245
request_logs=718
generation_history=258
chat_conversations=17
chat_messages=102
source json cells validated=1853
source image path/url entries=934
```

真实迁移目标为本地临时库 `ai_zero_token_migration_test`，未污染当前 app 使用的 `ai_zero_token` 库。迁移结果：

```text
row counts verified:
gateway_settings=1
gateway_user_groups=2
gateway_users=1245
request_logs=718
generation_history=258
chat_conversations=17
chat_messages=102

json samples verified=61
image paths verified count=934
image paths sha256=091ba6ae15069b2b3e4d2cfaef351754a346d58eaa0bae415931d8ce04dfeb2f
```

迁移脚本的目标库保护已验证：目标表已有数据时，不加 `--truncate-target` 会拒绝覆盖。

## 额外功能验证

SQLite fallback 独立冒烟：

- 使用独立 `AI_ZERO_TOKEN_HOME=tmp/sqlite-fallback-home-*`。
- 显式不配置 `AZT_DATABASE_URL`、`DATABASE_URL`、`AZT_REDIS_URL`、`REDIS_URL`。
- 服务可启动，`/_gateway/auth/status` 正常。
- 管理员登录成功。
- 用户列表 `users=1`，用户组 `groups=2`。
- 成功生成 SQLite 文件：`.state/gateway.sqlite`。

PostgreSQL 服务层 CRUD 冒烟：

- 使用临时库 `ai_zero_token_service_crud_test`。
- 验证设置 `jsonb` 读写。
- 验证管理员初始化、用户组创建、用户创建。
- 验证请求日志写入和带 details 查询。
- 验证生成历史写入和读取。
- 验证聊天会话、聊天消息、metadata JSON 读写。

Redis 限流存储层冒烟：

- `tryAcquireSlot(profile, token1, 1)` 可获取槽位。
- 第二个 token 在并发上限为 1 时无法获取槽位。
- `refreshSlot` 可刷新已有槽位。
- `releaseSlot` 后第二个 token 可获取槽位。
- `reserveStart` 可执行最小启动间隔控制，间隔期内返回等待时间，等待后可再次 reserved。
- 测试临时 key 已清理，无 `azt-direct-test:*` 残留。

Redis 请求节流服务层冒烟：

- 直接调用 `RequestThrottleService.runForProfile`，使用 mock profile 和 mock settings。
- 5 个并发任务、同账号最大并发配置为 2。
- 实测 `maxActive=2`，`queued=3`。
- `onStart` 时间间隔最小值为 105ms，高于测试配置的 80ms 最小间隔容差。
- 测试临时 key 已清理，无 `azt-service-test:*` 残留。

## 代码审查结论

未发现阻塞发布的 P0/P1 问题。已修复一个迁移校验脚本问题：

- `scripts/migrate-sqlite-to-postgres.mjs` 中图片路径校验曾因 source 侧 JS 排序和 PostgreSQL `ORDER BY` 排序规则不一致导致哈希误报。已改为 target 结果读回后使用同一套 JS 排序再计算哈希，生产 SQLite 迁移重跑通过。

主要残余风险：

- Redis request-throttle 尚未用真实 OAuth profile 做端到端模型请求并发验证；当前以 Redis 存储层直接测试和 `RequestThrottleService.runForProfile` 服务层并发测试覆盖核心语义。
- PostgreSQL SQL 适配器目前采用运行时 SQL 转换，已通过构建、接口巡检、生产迁移、服务层 CRUD 冒烟覆盖现有 SQL 形态；后续新增复杂 SQL 时仍需补充 PostgreSQL 路径测试。
- 本地迁移演练只验证了数据入库和路径清单不变，没有复制或打开生产图片文件本身；图片文件仍按设计保留在 `/data`。

## 验收命令

本次改造提供两个可复跑的本地 agent：

```bash
npm run review:postgres-redis
```

本轮执行结果：通过，未发现 P0/P1/P2 阻塞问题。

```bash
npm run test:postgres-redis -- \
  --sqlite-path tmp/production-sqlite-migration/gateway.production.sqlite
```

本轮执行结果：`pass=12 warn=1 fail=0`。唯一 warning 是默认跳过真实迁移写入；需要显式传入 `--execute-migration` 和临时 PostgreSQL 目标库。

如需执行真实迁移校验，可增加临时 PostgreSQL 目标库：

```bash
npm run test:postgres-redis -- \
  --sqlite-path tmp/production-sqlite-migration/gateway.production.sqlite \
  --execute-migration \
  --migration-database-url postgresql://azt:change-me-please@127.0.0.1:5432/ai_zero_token_migration_test \
  --psql-bin tmp/production-sqlite-migration/psql-docker-wrapper.sh
```

```bash
npm run build
```

```bash
./node_modules/.bin/tsc -p tsconfig.json --noEmit
npm run typecheck:ui
```

```bash
node scripts/migrate-sqlite-to-postgres.mjs \
  --sqlite-path tmp/production-sqlite-migration/gateway.production.sqlite \
  --dry-run
```

```bash
node scripts/migrate-sqlite-to-postgres.mjs \
  --sqlite-path tmp/production-sqlite-migration/gateway.production.sqlite \
  --database-url postgresql://azt:change-me-please@127.0.0.1:5432/ai_zero_token_migration_test \
  --psql-bin tmp/production-sqlite-migration/psql-docker-wrapper.sh \
  --execute \
  --sample-size 10
```

```bash
AZT_PERF_BASE_URL=http://127.0.0.1:8787 \
AZT_PERF_USERNAME=admin \
AZT_PERF_PASSWORD=Admin \
node scripts/api-perf-check.mjs --rounds 1 --threshold-ms 3000 --timeout-ms 10000
```

```bash
AZT_PERF_BASE_URL=http://127.0.0.1:8787 \
AZT_PERF_USERNAME=admin \
AZT_PERF_PASSWORD=Admin \
node scripts/api-perf-check.mjs \
  --acceptance-200 \
  --skip-endpoints \
  --timeout-ms 10000 \
  --threshold-ms 3000
```

## 发布建议

有条件发布：

- PostgreSQL 主路径、SQLite fallback、生产 SQLite 迁移、本地 compose 和 200 并发 auth/status 验收已通过。
- 发布前若能准备真实 OAuth profile，建议追加一次实际模型请求并发测试，观察 Redis throttle 日志和 Redis key 生命周期。
