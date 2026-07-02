# SQLite 到 PostgreSQL 一次性迁移

本片段用于把 AI Zero Token 当前 SQLite 状态库迁移到 `AZT_DATABASE_URL` 指向的 PostgreSQL。脚本只迁移数据和目标表结构，不切换服务代码，也不会复制生成图片文件本身。

## 覆盖范围

脚本：`scripts/migrate-sqlite-to-postgres.mjs`

覆盖表：

- `gateway_settings`
- `gateway_user_groups`
- `gateway_users`
- `request_logs`
- `generation_history`
- `chat_conversations`
- `chat_messages`

JSON 字段会写入 PostgreSQL `jsonb` 列，并在执行后抽样比对；`generation_history.images_json` 中的 `path`、`previewPath`、`url`、`previewUrl` 会做全量清单哈希校验，确保迁移过程不改写生成图片路径。

## 前置条件

- Node.js 22+，因为脚本使用 `node:sqlite`。
- 本机或容器内可执行 `psql`。
- 迁移执行前建议暂停网关写入，避免 SQLite 在迁移过程中继续产生新数据。
- PostgreSQL 连接串通过 `AZT_DATABASE_URL` 提供，格式为 `postgresql://...` 或 `postgres://...`。

## Dry-run

默认就是 dry-run，只读取 SQLite 并校验源数据，不连接、不写入 PostgreSQL：

```bash
node scripts/migrate-sqlite-to-postgres.mjs \
  --sqlite-path /data/.state/gateway.sqlite \
  --dry-run
```

如果是在服务器宿主机上运行，SQLite 通常位于：

```text
/opt/ai-zero-token/state/.state/gateway.sqlite
```

## 执行迁移

目标库为空时：

```bash
export AZT_DATABASE_URL='postgresql://user:password@host:5432/dbname'

node scripts/migrate-sqlite-to-postgres.mjs \
  --sqlite-path /data/.state/gateway.sqlite \
  --execute
```

如果确认要覆盖目标库中这些表的现有数据，加 `--truncate-target`：

```bash
node scripts/migrate-sqlite-to-postgres.mjs \
  --sqlite-path /data/.state/gateway.sqlite \
  --execute \
  --truncate-target
```

可选参数：

- `--database-url <url>`：覆盖 `AZT_DATABASE_URL`。
- `--sample-size <n>`：每个 JSON 字段抽样比对数量，默认 `5`。
- `--batch-size <n>`：批量插入行数，默认 `200`。
- `--psql-bin <path>`：指定 `psql` 路径。

## 校验内容

执行模式会按顺序完成：

1. 创建或补齐 PostgreSQL 目标表。
2. 默认检查目标表为空；除非显式使用 `--truncate-target`。
3. 插入七张表的数据。
4. 校验每张表源库和目标库行数一致。
5. 抽样比对 JSON 字段内容。
6. 全量比对生成图片路径和 URL 清单哈希。

## 风险和注意事项

- 脚本不会复制 `/data/.state/generations/images` 下的图片文件，只保持数据库里的路径和 URL 不变；切换服务时要保证同一持久化卷仍可访问这些文件。
- PostgreSQL `jsonb` 会规范化 JSON 的空白和对象键顺序，但字段值不会被主动改写。
- 源库如果存在孤立的 `chat_messages.conversation_id`，脚本会中止，避免目标库外键不一致。
- 目标表非空时默认中止，防止把两套运行数据混合；覆盖前请先备份目标库。
- `gateway_users.password_hash`、`api_key_hash` 等敏感字段会完整迁移，迁移日志不会打印连接串密码，但仍应在可信环境运行。
