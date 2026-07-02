#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const requiredFiles = [
  "src/core/store/gateway-sql-database.ts",
  "src/core/services/gateway-database-service.ts",
  "src/core/store/settings-store.ts",
  "src/core/services/request-throttle-service.ts",
  "src/core/services/redis-throttle-store.ts",
  "scripts/migrate-sqlite-to-postgres.mjs",
  "docker-compose.yml",
  ".env.example",
  "docs/DOCKER_POSTGRES_REDIS_DEPLOY.md",
  "docs/sqlite-to-postgres-migration.md",
];

const findings = [];
const passed = [];

function read(relativePath) {
  return fs.readFileSync(path.join(rootDir, relativePath), "utf8");
}

function lineOf(content, pattern) {
  const index = typeof pattern === "string" ? content.indexOf(pattern) : content.search(pattern);
  if (index < 0) {
    return 1;
  }
  return content.slice(0, index).split("\n").length;
}

function addFinding(priority, relativePath, pattern, title, risk, fix, verify) {
  const content = fs.existsSync(path.join(rootDir, relativePath)) ? read(relativePath) : "";
  findings.push({
    priority,
    relativePath,
    line: lineOf(content, pattern),
    title,
    risk,
    fix,
    verify,
  });
}

function pass(label) {
  passed.push(label);
}

function requireFile(relativePath) {
  if (!fs.existsSync(path.join(rootDir, relativePath))) {
    addFinding("P1", relativePath, "", "缺少必要文件", "改造契约不完整，部署或运行路径会缺少关键能力。", "补齐该文件。", "重新运行本脚本。");
    return false;
  }
  pass(`${relativePath} exists`);
  return true;
}

function assertContains(relativePath, pattern, options) {
  const content = read(relativePath);
  const ok = pattern instanceof RegExp ? pattern.test(content) : content.includes(pattern);
  if (!ok) {
    addFinding(options.priority ?? "P1", relativePath, pattern, options.title, options.risk, options.fix, options.verify);
    return;
  }
  pass(options.title);
}

function reviewGatewaySqlDatabase() {
  const file = "src/core/store/gateway-sql-database.ts";
  assertContains(file, "process.env.AZT_DATABASE_URL", {
    title: "数据库后端由 AZT_DATABASE_URL 切换",
    risk: "无法保留 SQLite fallback 或 PostgreSQL 主路径开关。",
    fix: "通过 AZT_DATABASE_URL 判断 PostgreSQL，否则使用 SQLite。",
    verify: "分别配置和不配置 AZT_DATABASE_URL 做启动冒烟。",
  });
  assertContains(file, "DEFAULT_POSTGRES_POOL_MAX", {
    title: "PostgreSQL pool 默认值存在",
    risk: "高并发下连接数不可控。",
    fix: "保留 AZT_DB_POOL_MAX 和默认池上限。",
    verify: "检查 pool max 配置并执行并发请求。",
  });
  assertContains(file, "::jsonb", {
    title: "JSON 参数写入 PostgreSQL jsonb",
    risk: "PostgreSQL jsonb 列无法接收 text 参数或运行期类型错误。",
    fix: "对 value_json 和 *_json INSERT 参数增加 ::jsonb。",
    verify: "服务层写 settings/request log/chat metadata/generation history。",
  });
  assertContains(file, "CAST($", {
    title: "NULL 参数显式类型转换",
    risk: "PostgreSQL 在 ? IS NULL 查询中无法推断参数类型。",
    fix: "保留 IS NULL/COALESCE 场景的 CAST($n AS TEXT)。",
    verify: "执行 owner 为空的列表、countActiveAdmins 等查询。",
  });
  assertContains(file, "new DatabaseSync(getDatabasePath())", {
    title: "SQLite fallback 仍使用原状态库路径",
    risk: "本地优先体验或旧部署会断裂。",
    fix: "未配置 PostgreSQL 时继续打开 gateway.sqlite。",
    verify: "不配置 AZT_DATABASE_URL 启动并登录。",
  });
}

function reviewGatewayStores() {
  assertContains("src/core/services/gateway-database-service.ts", "getGatewaySqlDatabase", {
    title: "网关数据服务使用统一 SQL 适配器",
    risk: "仍直接依赖 SQLite 会绕过 PostgreSQL 主路径。",
    fix: "所有业务 SQL 通过 GatewaySqlDatabase。",
    verify: "PostgreSQL 服务层 CRUD 冒烟。",
  });
  assertContains("src/core/services/gateway-database-service.ts", "parseJsonObject(value: unknown)", {
    title: "JSON 对象兼容 PostgreSQL jsonb 返回值",
    risk: "jsonb 返回对象时设置、日志或聊天 metadata 解析为空。",
    fix: "parseJsonObject/parseJsonArray 同时接受对象和字符串。",
    verify: "写入并读取 jsonb 字段。",
  });
  assertContains("src/core/store/settings-store.ts", "getGatewaySqlDatabase", {
    title: "settings-store 接入统一 SQL 存储",
    risk: "设置仍落本地文件或 SQLite，导致 PostgreSQL 数据不完整。",
    fix: "通过 gateway_settings 表读写设置。",
    verify: "PostgreSQL 主路径保存并读取设置。",
  });
}

function reviewRedisThrottle() {
  const redisFile = "src/core/services/redis-throttle-store.ts";
  assertContains(redisFile, "ZREMRANGEBYSCORE", {
    title: "Redis 并发槽清理过期 lease",
    risk: "异常退出后账号并发槽可能永久占用。",
    fix: "获取槽位前按 score 清理过期 token。",
    verify: "TTL 后可重新获取槽位。",
  });
  assertContains(redisFile, "PEXPIRE", {
    title: "Redis key 设置 TTL",
    risk: "短状态 key 长期残留。",
    fix: "running 和 lastStart key 均设置过期时间。",
    verify: "检查 Redis key 生命周期。",
  });
  assertContains(redisFile, "ZREM", {
    title: "Redis release 移除运行槽位",
    risk: "请求结束后并发槽不释放，后续请求被错误排队。",
    fix: "finally 中调用 releaseSlot，Lua 中 ZREM token。",
    verify: "runForProfile 并发冒烟 maxActive 不超过配置且能全部完成。",
  });
  assertContains("src/core/services/request-throttle-service.ts", "RedisThrottleStore.fromEnv()", {
    title: "AZT_REDIS_URL 启用 Redis throttle",
    risk: "Redis 配置存在时仍使用内存队列，无法为未来多实例预留状态层。",
    fix: "初始化 RedisThrottleStore 并在 runForProfile 中优先使用。",
    verify: "设置 AZT_REDIS_URL 后执行 service-level throttle 测试。",
  });
  assertContains("src/core/services/request-throttle-service.ts", "acquireProfileSlot", {
    title: "保留内存 throttle fallback",
    risk: "未配置 Redis 的本地运行路径被破坏。",
    fix: "未配置 AZT_REDIS_URL 时继续使用内存队列。",
    verify: "SQLite fallback 冒烟。",
  });
}

function reviewMigration() {
  const file = "scripts/migrate-sqlite-to-postgres.mjs";
  for (const table of ["gateway_settings", "gateway_user_groups", "gateway_users", "request_logs", "generation_history", "chat_conversations", "chat_messages"]) {
    assertContains(file, `name: "${table}"`, {
      title: `迁移覆盖表 ${table}`,
      risk: "生产 SQLite 数据无法完整迁移。",
      fix: "在迁移表清单中保留该表。",
      verify: "生产 SQLite dry-run 行数和目标库行数一致。",
    });
  }
  assertContains(file, "assertTargetEmpty", {
    title: "迁移执行前保护非空目标库",
    risk: "误把生产数据覆盖或混写。",
    fix: "非空目标库默认拒绝执行，显式 --truncate-target 才覆盖。",
    verify: "对已有数据目标库执行迁移应失败。",
  });
  assertContains(file, "validateJsonSamples", {
    title: "迁移后 JSON 抽样校验",
    risk: "jsonb 规范化或转换错误不被发现。",
    fix: "保留 JSON 抽样比对。",
    verify: "执行 --execute 并检查 json samples verified。",
  });
  assertContains(file, "sortImagePathEntries", {
    title: "图片路径清单使用统一排序哈希",
    risk: "路径校验误报或漏报。",
    fix: "source/target 均使用同一排序后再哈希。",
    verify: "生产 SQLite 迁移 image paths verified。",
  });
}

function reviewDeployment() {
  assertContains("docker-compose.yml", "AZT_DATABASE_URL", {
    title: "compose 配置 PostgreSQL 主路径",
    risk: "compose 启动后仍使用 SQLite。",
    fix: "app 环境变量设置 AZT_DATABASE_URL。",
    verify: "compose 启动后 PostgreSQL 7 张业务表存在。",
  });
  assertContains("docker-compose.yml", "AZT_REDIS_URL", {
    title: "compose 配置 Redis throttle",
    risk: "compose 启动后仍使用内存 throttle。",
    fix: "app 环境变量设置 AZT_REDIS_URL。",
    verify: "Redis service-level throttle 测试。",
  });
  assertContains(".env.example", "AZT_DB_POOL_MAX=20", {
    title: "env 示例包含连接池配置",
    risk: "部署者无法调整 PostgreSQL 并发连接。",
    fix: "保留 AZT_DB_POOL_MAX 示例。",
    verify: "docker compose config 展开环境变量。",
  });
  assertContains("update.sh", "DEPLOY_MODE", {
    title: "update.sh 支持 compose 部署模式",
    risk: "服务器无法按 app + PostgreSQL + Redis 形态发布。",
    fix: "保留 DEPLOY_MODE=compose 分支。",
    verify: "bash -n update.sh。",
  });
}

function main() {
  for (const file of requiredFiles) {
    requireFile(file);
  }
  if (findings.some((item) => item.title === "缺少必要文件")) {
    printReport();
    process.exitCode = 1;
    return;
  }

  reviewGatewaySqlDatabase();
  reviewGatewayStores();
  reviewRedisThrottle();
  reviewMigration();
  reviewDeployment();
  printReport();
  process.exitCode = findings.some((item) => item.priority === "P0" || item.priority === "P1") ? 1 : 0;
}

function printReport() {
  console.log("# PostgreSQL + Redis Code Review Agent");
  console.log("");
  if (findings.length === 0) {
    console.log("未发现 P0/P1/P2 阻塞问题。");
  } else {
    console.log("## Findings");
    for (const item of findings) {
      console.log(`### [${item.priority}] ${item.title}`);
      console.log(`- 位置: ${path.join(rootDir, item.relativePath)}:${item.line}`);
      console.log(`- 风险: ${item.risk}`);
      console.log(`- 修复: ${item.fix}`);
      console.log(`- 验证: ${item.verify}`);
      console.log("");
    }
  }

  console.log("## Checks Passed");
  for (const item of passed) {
    console.log(`- ${item}`);
  }
}

main();
