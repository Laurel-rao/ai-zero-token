#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function parseArgs(argv) {
  const args = {
    baseUrl: process.env.AZT_PERF_BASE_URL || "http://127.0.0.1:8787",
    username: process.env.AZT_PERF_USERNAME || process.env.AZT_ADMIN_USER || "admin",
    password: process.env.AZT_PERF_PASSWORD || process.env.AZT_ADMIN_PASSWORD || "Admin",
    thresholdMs: Number.parseInt(process.env.AZT_PERF_THRESHOLD_MS || "", 10) || 3000,
    timeoutMs: Number.parseInt(process.env.AZT_PERF_TIMEOUT_MS || "", 10) || 10000,
    rounds: Number.parseInt(process.env.AZT_PERF_ROUNDS || "", 10) || 1,
    sqlitePath: process.env.AZT_TEST_SQLITE_PATH || "",
    migrationDatabaseUrl: process.env.AZT_TEST_MIGRATION_DATABASE_URL || "",
    psqlBin: process.env.PSQL_BIN || "psql",
    composeEnv: process.env.AZT_TEST_COMPOSE_ENV || ".env.local-compose",
    redisUrl: process.env.AZT_TEST_REDIS_URL || "redis://127.0.0.1:16379/0",
    skipCompose: false,
    skipSequential: false,
    skipAcceptance: false,
    skipFallback: false,
    skipRedisService: false,
    skipMigration: false,
    executeMigration: process.env.AZT_TEST_EXECUTE_MIGRATION === "1",
  };

  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    const next = argv[index + 1];
    if (item === "--base-url" && next) {
      args.baseUrl = next;
      index += 1;
    } else if (item === "--username" && next) {
      args.username = next;
      index += 1;
    } else if (item === "--password" && next) {
      args.password = next;
      index += 1;
    } else if (item === "--sqlite-path" && next) {
      args.sqlitePath = next;
      index += 1;
    } else if (item === "--migration-database-url" && next) {
      args.migrationDatabaseUrl = next;
      index += 1;
    } else if (item === "--psql-bin" && next) {
      args.psqlBin = next;
      index += 1;
    } else if (item === "--compose-env" && next) {
      args.composeEnv = next;
      index += 1;
    } else if (item === "--redis-url" && next) {
      args.redisUrl = next;
      index += 1;
    } else if (item === "--threshold-ms" && next) {
      args.thresholdMs = Number.parseInt(next, 10);
      index += 1;
    } else if (item === "--timeout-ms" && next) {
      args.timeoutMs = Number.parseInt(next, 10);
      index += 1;
    } else if (item === "--rounds" && next) {
      args.rounds = Number.parseInt(next, 10);
      index += 1;
    } else if (item === "--execute-migration") {
      args.executeMigration = true;
    } else if (item === "--skip-compose") {
      args.skipCompose = true;
    } else if (item === "--skip-sequential") {
      args.skipSequential = true;
    } else if (item === "--skip-acceptance") {
      args.skipAcceptance = true;
    } else if (item === "--skip-fallback") {
      args.skipFallback = true;
    } else if (item === "--skip-redis-service") {
      args.skipRedisService = true;
    } else if (item === "--skip-migration") {
      args.skipMigration = true;
    } else if (item === "--help" || item === "-h") {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`未知参数：${item}`);
    }
  }

  args.baseUrl = args.baseUrl.replace(/\/+$/, "");
  if (!args.sqlitePath) {
    const localProductionCopy = path.join(rootDir, "tmp/production-sqlite-migration/gateway.production.sqlite");
    args.sqlitePath = fs.existsSync(localProductionCopy) ? localProductionCopy : "";
  }
  return args;
}

function printHelp() {
  console.log(`Usage: node scripts/postgres-redis-test-agent.mjs [options]

Options:
  --base-url <url>                 Gateway URL. Default: http://127.0.0.1:8787
  --username <name>                Admin username. Default: admin
  --password <password>            Admin password. Default: Admin
  --sqlite-path <path>             SQLite source for migration dry-run
  --migration-database-url <url>   PostgreSQL URL for migration execute check
  --psql-bin <path>                psql binary/wrapper for migration execute
  --execute-migration              Execute migration against --migration-database-url
  --redis-url <url>                Redis URL for service-level throttle smoke
  --skip-compose
  --skip-sequential
  --skip-acceptance
  --skip-fallback
  --skip-redis-service
  --skip-migration
`);
}

const results = [];

function record(name, status, detail = "") {
  results.push({ name, status, detail });
  const marker = status === "pass" ? "PASS" : status === "warn" ? "WARN" : "FAIL";
  console.log(`[${marker}] ${name}${detail ? ` - ${detail}` : ""}`);
}

function runChecked(name, command, commandArgs, options = {}) {
  const result = spawnSync(command, commandArgs, {
    cwd: rootDir,
    env: { ...process.env, ...(options.env || {}) },
    encoding: "utf8",
    stdio: options.capture ? "pipe" : "inherit",
  });
  if (result.status === 0) {
    record(name, "pass");
    return result;
  }
  const detail = result.stderr?.trim() || result.stdout?.trim() || `exit=${result.status}`;
  record(name, options.warnOnly ? "warn" : "fail", detail.split("\n").slice(-3).join(" | "));
  return result;
}

async function fetchJson(url, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new Error("timeout")), options.timeoutMs ?? 8000);
  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal,
    });
    const text = await response.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      // Keep text-only responses inspectable.
    }
    return { response, text, json };
  } finally {
    clearTimeout(timeout);
  }
}

function cookieFrom(response) {
  const raw = response.headers.get("set-cookie") || "";
  return raw.split(",").map((item) => item.split(";", 1)[0]).filter(Boolean).join("; ");
}

async function checkRuntime(args) {
  const status = await fetchJson(`${args.baseUrl}/_gateway/auth/status`, { timeoutMs: args.timeoutMs });
  if (!status.response.ok || !status.json?.configured) {
    record("gateway auth status", "fail", `HTTP ${status.response.status}`);
    return;
  }
  record("gateway auth status", "pass", `configured=${status.json.configured}`);

  const login = await fetchJson(`${args.baseUrl}/_gateway/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: args.username, password: args.password }),
    timeoutMs: args.timeoutMs,
  });
  if (!login.response.ok || !login.json?.ok) {
    record("gateway admin login", "fail", `HTTP ${login.response.status}`);
    return;
  }
  record("gateway admin login", "pass", `user=${login.json.user}`);

  const cookie = cookieFrom(login.response);
  const users = await fetchJson(`${args.baseUrl}/_gateway/admin/users`, {
    headers: cookie ? { cookie } : {},
    timeoutMs: args.timeoutMs,
  });
  if (!users.response.ok) {
    record("gateway users list", "fail", `HTTP ${users.response.status}`);
  } else {
    const count = users.json?.data?.length ?? users.json?.users?.length ?? 0;
    record("gateway users list", "pass", `items=${count}`);
  }
}

async function runComposeCheck(args) {
  if (args.skipCompose) {
    record("docker compose ps", "warn", "skipped");
    return;
  }
  if (!fs.existsSync(path.join(rootDir, args.composeEnv))) {
    record("docker compose ps", "warn", `${args.composeEnv} not found`);
    return;
  }
  runChecked("docker compose ps", "docker", ["compose", "--env-file", args.composeEnv, "ps"], { warnOnly: true });
}

function runPerfChecks(args) {
  const env = {
    AZT_PERF_BASE_URL: args.baseUrl,
    AZT_PERF_USERNAME: args.username,
    AZT_PERF_PASSWORD: args.password,
  };
  if (!args.skipSequential) {
    runChecked("api sequential endpoints", process.execPath, [
      "scripts/api-perf-check.mjs",
      "--rounds", String(args.rounds),
      "--threshold-ms", String(args.thresholdMs),
      "--timeout-ms", String(args.timeoutMs),
    ], { env });
  }
  if (!args.skipAcceptance) {
    runChecked("api 200 concurrency", process.execPath, [
      "scripts/api-perf-check.mjs",
      "--acceptance-200",
      "--skip-endpoints",
      "--threshold-ms", String(args.thresholdMs),
      "--timeout-ms", String(args.timeoutMs),
    ], { env });
  }
}

function runMigrationChecks(args) {
  if (args.skipMigration) {
    record("migration checks", "warn", "skipped");
    return;
  }
  if (!args.sqlitePath || !fs.existsSync(args.sqlitePath)) {
    record("migration dry-run", "warn", "sqlite source not provided");
    return;
  }
  runChecked("migration dry-run", process.execPath, [
    "scripts/migrate-sqlite-to-postgres.mjs",
    "--sqlite-path", args.sqlitePath,
    "--dry-run",
  ]);
  if (!args.executeMigration) {
    record("migration execute", "warn", "skipped; pass --execute-migration and --migration-database-url");
    return;
  }
  if (!args.migrationDatabaseUrl) {
    record("migration execute", "fail", "missing --migration-database-url");
    return;
  }
  runChecked("migration execute", process.execPath, [
    "scripts/migrate-sqlite-to-postgres.mjs",
    "--sqlite-path", args.sqlitePath,
    "--database-url", args.migrationDatabaseUrl,
    "--psql-bin", args.psqlBin,
    "--execute",
    "--sample-size", "10",
  ]);
}

async function runSqliteFallbackSmoke(args) {
  if (args.skipFallback) {
    record("sqlite fallback smoke", "warn", "skipped");
    return;
  }
  const cliPath = path.join(rootDir, "dist/cli.js");
  if (!fs.existsSync(cliPath)) {
    record("sqlite fallback smoke", "warn", "dist/cli.js not found; run npm run build first");
    return;
  }
  const home = path.join(rootDir, `tmp/sqlite-fallback-agent-${Date.now()}`);
  fs.mkdirSync(home, { recursive: true });
  const port = 19000 + Math.floor(Math.random() * 1000);
  const env = { ...process.env };
  for (const key of ["AZT_DATABASE_URL", "DATABASE_URL", "AZT_REDIS_URL", "REDIS_URL"]) {
    delete env[key];
  }
  Object.assign(env, {
    AI_ZERO_TOKEN_HOME: home,
    AZT_ADMIN_USER: "admin",
    AZT_ADMIN_PASSWORD: "Admin",
    AZT_SESSION_SECRET: "sqlite-fallback-agent-secret",
    AZT_CORS_ORIGIN: "*",
  });

  const child = spawn(process.execPath, [cliPath, "serve", "--host", "127.0.0.1", "--port", String(port)], {
    cwd: rootDir,
    env,
    stdio: ["ignore", "ignore", "ignore"],
  });
  try {
    let ready = false;
    for (let attempt = 0; attempt < 80; attempt += 1) {
      try {
        const status = await fetchJson(`http://127.0.0.1:${port}/_gateway/auth/status`, { timeoutMs: 1000 });
        if (status.response.ok && status.json?.configured) {
          ready = true;
          break;
        }
      } catch {
        // Wait for server startup.
      }
      await sleep(250);
    }
    if (!ready) {
      record("sqlite fallback smoke", "fail", "server did not become ready");
      return;
    }
    const login = await fetchJson(`http://127.0.0.1:${port}/_gateway/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "admin", password: "Admin" }),
      timeoutMs: 2000,
    });
    const sqlitePath = path.join(home, ".state/gateway.sqlite");
    if (login.response.ok && fs.existsSync(sqlitePath)) {
      record("sqlite fallback smoke", "pass", sqlitePath.replace(`${rootDir}/`, ""));
    } else {
      record("sqlite fallback smoke", "fail", `login=${login.response.status} sqlite=${fs.existsSync(sqlitePath)}`);
    }
  } finally {
    child.kill("SIGTERM");
    await sleep(100);
    if (!child.killed) {
      child.kill("SIGKILL");
    }
  }
}

function runRedisServiceSmoke(args) {
  if (args.skipRedisService) {
    record("redis service-level throttle", "warn", "skipped");
    return;
  }
  const code = `
process.env.AZT_REDIS_URL = ${JSON.stringify(args.redisUrl)};
process.env.AZT_REDIS_KEY_PREFIX = "azt-agent-service-test-" + Date.now();
process.env.AZT_REDIS_THROTTLE_SLOT_TTL_MS = "3000";
process.env.AZT_REDIS_THROTTLE_POLL_MS = "50";
process.env.AZT_ACCOUNT_MAX_CONCURRENCY = "2";
process.env.AZT_CODEX_REQUEST_SERIALIZATION_ENABLED = "1";
process.env.AZT_CODEX_REQUEST_MIN_DELAY_MS = "80";
process.env.AZT_CODEX_REQUEST_JITTER_MS = "0";
const { RequestThrottleService } = await import("./dist/core/services/request-throttle-service.js");
const keyPrefix = process.env.AZT_REDIS_KEY_PREFIX;
const service = new RequestThrottleService({ getSettings: async () => ({ runtime: {
  accountMaxConcurrency: 2,
  codexRequestSerializationEnabled: true,
  codexRequestMinDelayMs: 80,
  codexRequestJitterMs: 0,
} }) });
const profile = { profileId: "agent-profile-" + Date.now() };
let active = 0;
let maxActive = 0;
let queued = 0;
const starts = [];
const results = await Promise.all(Array.from({ length: 5 }, (_, index) => service.runForProfile(profile, async () => {
  active += 1;
  maxActive = Math.max(maxActive, active);
  await new Promise((resolve) => setTimeout(resolve, 120));
  active -= 1;
  return index;
}, {
  requestId: "agent-redis-" + index,
  route: "postgres-redis-test-agent",
  model: "mock-model",
  onQueued: () => { queued += 1; },
  onStart: () => { starts.push(Date.now()); },
})));
const deltas = starts.slice(1).map((time, index) => time - starts[index]);
const minDelta = Math.min(...deltas);
const ok = results.length === 5 && maxActive <= 2 && queued >= 1 && minDelta >= 60;
const encodedProfileId = encodeURIComponent(profile.profileId);
await service.redisStore?.client?.command?.([
  "DEL",
  keyPrefix + ":request-throttle:" + encodedProfileId + ":running",
  keyPrefix + ":request-throttle:" + encodedProfileId + ":lastStart",
]).catch(() => undefined);
console.log(JSON.stringify({ ok, maxActive, queued, minDelta, results }));
setTimeout(() => process.exit(ok ? 0 : 1), 50);
`;
  const result = runChecked("redis service-level throttle", process.execPath, ["--input-type=module", "-e", code], { capture: true });
  if (result.status === 0 && result.stdout) {
    const lines = result.stdout.trim().split("\n");
    console.log(lines.at(-1));
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  console.log("# PostgreSQL + Redis Test Agent");
  runChecked("migration script syntax", process.execPath, ["--check", "scripts/migrate-sqlite-to-postgres.mjs"]);
  runChecked("perf script syntax", process.execPath, ["--check", "scripts/api-perf-check.mjs"]);
  runChecked("update script syntax", "bash", ["-n", "update.sh"]);
  await runComposeCheck(args);
  await checkRuntime(args);
  runPerfChecks(args);
  runMigrationChecks(args);
  await runSqliteFallbackSmoke(args);
  runRedisServiceSmoke(args);

  const failed = results.filter((item) => item.status === "fail");
  const warned = results.filter((item) => item.status === "warn");
  console.log("");
  console.log(`summary: pass=${results.length - failed.length - warned.length} warn=${warned.length} fail=${failed.length}`);
  if (failed.length > 0) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exit(1);
});
