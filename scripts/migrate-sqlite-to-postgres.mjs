#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import { spawn } from "node:child_process";

const DEFAULT_SQLITE_PATH = "/data/.state/gateway.sqlite";
const DEFAULT_SAMPLE_SIZE = 5;
const DEFAULT_BATCH_SIZE = 200;
const require = createRequire(import.meta.url);

const tables = [
  {
    name: "gateway_settings",
    columns: [
      { name: "id", pgType: "TEXT", nullable: false },
      { name: "value_json", pgType: "JSONB", nullable: false, json: true, defaultJson: {} },
      { name: "created_at", pgType: "BIGINT", nullable: false, numeric: true },
      { name: "updated_at", pgType: "BIGINT", nullable: false, numeric: true },
    ],
    indexes: [],
  },
  {
    name: "gateway_user_groups",
    columns: [
      { name: "id", pgType: "TEXT", nullable: false },
      { name: "name", pgType: "TEXT", nullable: false },
      { name: "sort_order", pgType: "INTEGER", nullable: false, numeric: true, defaultValue: 0 },
      { name: "image_limits_disabled", pgType: "INTEGER", nullable: false, numeric: true, defaultValue: 0 },
      { name: "per_user_daily", pgType: "INTEGER", numeric: true },
      { name: "per_user_hourly", pgType: "INTEGER", numeric: true },
      { name: "min_interval_seconds", pgType: "INTEGER", numeric: true },
      { name: "created_at", pgType: "BIGINT", nullable: false, numeric: true },
      { name: "updated_at", pgType: "BIGINT", nullable: false, numeric: true },
    ],
    indexes: [
      "CREATE UNIQUE INDEX IF NOT EXISTS idx_gateway_user_groups_name_unique ON gateway_user_groups(name);",
      "CREATE INDEX IF NOT EXISTS idx_gateway_user_groups_sort_order ON gateway_user_groups(sort_order DESC, created_at ASC);",
    ],
  },
  {
    name: "gateway_users",
    columns: [
      { name: "id", pgType: "TEXT", nullable: false },
      { name: "username", pgType: "TEXT", nullable: false },
      { name: "display_name", pgType: "TEXT" },
      { name: "password_hash", pgType: "TEXT", nullable: false },
      { name: "api_key_hash", pgType: "TEXT" },
      { name: "role", pgType: "TEXT", nullable: false },
      { name: "group_id", pgType: "TEXT" },
      { name: "created_at", pgType: "BIGINT", nullable: false, numeric: true },
      { name: "updated_at", pgType: "BIGINT", nullable: false, numeric: true },
      { name: "disabled", pgType: "INTEGER", nullable: false, numeric: true, defaultValue: 0 },
    ],
    indexes: [
      "CREATE UNIQUE INDEX IF NOT EXISTS idx_gateway_users_username_unique ON gateway_users(username);",
      "CREATE INDEX IF NOT EXISTS idx_gateway_users_username ON gateway_users(username);",
    ],
  },
  {
    name: "request_logs",
    columns: [
      { name: "id", pgType: "TEXT", nullable: false },
      { name: "owner", pgType: "TEXT" },
      { name: "time", pgType: "BIGINT", nullable: false, numeric: true },
      { name: "method", pgType: "TEXT", nullable: false },
      { name: "endpoint", pgType: "TEXT", nullable: false },
      { name: "account", pgType: "TEXT", nullable: false },
      { name: "model", pgType: "TEXT", nullable: false },
      { name: "status_code", pgType: "INTEGER", nullable: false, numeric: true },
      { name: "duration_ms", pgType: "DOUBLE PRECISION", nullable: false, numeric: true },
      { name: "source", pgType: "TEXT", nullable: false },
      { name: "details_json", pgType: "JSONB", json: true },
    ],
    indexes: [
      "CREATE INDEX IF NOT EXISTS idx_request_logs_time ON request_logs(time DESC);",
      "CREATE INDEX IF NOT EXISTS idx_request_logs_owner_time ON request_logs(owner, time DESC);",
    ],
  },
  {
    name: "generation_history",
    columns: [
      { name: "id", pgType: "TEXT", nullable: false },
      { name: "owner", pgType: "TEXT" },
      { name: "created_at", pgType: "BIGINT", nullable: false, numeric: true },
      { name: "started_at", pgType: "BIGINT", numeric: true },
      { name: "updated_at", pgType: "BIGINT", nullable: false, numeric: true },
      { name: "status", pgType: "TEXT", nullable: false },
      { name: "endpoint", pgType: "TEXT", nullable: false },
      { name: "account", pgType: "TEXT", nullable: false },
      { name: "model", pgType: "TEXT", nullable: false },
      { name: "prompt", pgType: "TEXT", nullable: false },
      { name: "ratio", pgType: "TEXT" },
      { name: "size", pgType: "TEXT" },
      { name: "quality", pgType: "TEXT" },
      { name: "output_format", pgType: "TEXT" },
      { name: "duration_ms", pgType: "DOUBLE PRECISION", nullable: false, numeric: true },
      { name: "request_json", pgType: "JSONB", nullable: false, json: true, defaultJson: {} },
      { name: "response_summary_json", pgType: "JSONB", json: true },
      { name: "error", pgType: "TEXT" },
      { name: "reference_images_json", pgType: "JSONB", nullable: false, json: true, defaultJson: [] },
      { name: "images_json", pgType: "JSONB", nullable: false, json: true, defaultJson: [] },
    ],
    indexes: [
      "CREATE INDEX IF NOT EXISTS idx_generation_history_created_at ON generation_history(created_at DESC);",
      "CREATE INDEX IF NOT EXISTS idx_generation_history_owner_created_at ON generation_history(owner, created_at DESC);",
    ],
  },
  {
    name: "chat_conversations",
    columns: [
      { name: "id", pgType: "TEXT", nullable: false },
      { name: "owner", pgType: "TEXT" },
      { name: "title", pgType: "TEXT", nullable: false },
      { name: "model", pgType: "TEXT" },
      { name: "created_at", pgType: "BIGINT", nullable: false, numeric: true },
      { name: "updated_at", pgType: "BIGINT", nullable: false, numeric: true },
    ],
    indexes: [
      "CREATE INDEX IF NOT EXISTS idx_chat_conversations_owner_updated_at ON chat_conversations(owner, updated_at DESC);",
    ],
  },
  {
    name: "chat_messages",
    columns: [
      { name: "id", pgType: "TEXT", nullable: false },
      { name: "conversation_id", pgType: "TEXT", nullable: false },
      { name: "owner", pgType: "TEXT" },
      { name: "role", pgType: "TEXT", nullable: false },
      { name: "content", pgType: "TEXT", nullable: false },
      { name: "status", pgType: "TEXT", nullable: false },
      { name: "model", pgType: "TEXT" },
      { name: "error", pgType: "TEXT" },
      { name: "created_at", pgType: "BIGINT", nullable: false, numeric: true },
      { name: "updated_at", pgType: "BIGINT", nullable: false, numeric: true },
      { name: "metadata_json", pgType: "JSONB", json: true },
    ],
    indexes: [
      "CREATE INDEX IF NOT EXISTS idx_chat_messages_conversation_created_at ON chat_messages(conversation_id, created_at ASC);",
      "CREATE INDEX IF NOT EXISTS idx_chat_messages_conversation_created_id ON chat_messages(conversation_id, created_at DESC, id);",
    ],
  },
];

function printHelp() {
  console.log(`SQLite -> PostgreSQL migration for AI Zero Token

Usage:
  node scripts/migrate-sqlite-to-postgres.mjs [options]

Options:
  --sqlite-path <path>       Source SQLite DB. Default: ${DEFAULT_SQLITE_PATH}
  --database-url <url>       PostgreSQL URL. Default: AZT_DATABASE_URL
  --dry-run                  Read and validate SQLite only. This is the default.
  --execute                  Create/update target schema and migrate data.
  --truncate-target          Delete target rows in covered tables before inserting.
  --sample-size <n>          JSON comparison sample size per JSON field. Default: ${DEFAULT_SAMPLE_SIZE}
  --batch-size <n>           INSERT batch size. Default: ${DEFAULT_BATCH_SIZE}
  --psql-bin <path>          psql binary. Default: psql
  --help, -h                 Show this help.

Environment:
  AZT_DATABASE_URL           postgresql:// or postgres:// connection URL
  AZT_SQLITE_PATH            Optional source SQLite path override
  PSQL_BIN                   Optional psql binary override
`);
}

function parseArgs(argv) {
  const args = {
    sqlitePath: process.env.AZT_SQLITE_PATH || DEFAULT_SQLITE_PATH,
    databaseUrl: process.env.AZT_DATABASE_URL || "",
    dryRun: true,
    execute: false,
    truncateTarget: false,
    sampleSize: DEFAULT_SAMPLE_SIZE,
    batchSize: DEFAULT_BATCH_SIZE,
    psqlBin: process.env.PSQL_BIN || "psql",
  };

  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    const next = argv[index + 1];
    if (item === "--sqlite-path" && next) {
      args.sqlitePath = next;
      index += 1;
    } else if (item === "--database-url" && next) {
      args.databaseUrl = next;
      index += 1;
    } else if (item === "--dry-run") {
      args.dryRun = true;
      args.execute = false;
    } else if (item === "--execute") {
      args.execute = true;
      args.dryRun = false;
    } else if (item === "--truncate-target") {
      args.truncateTarget = true;
    } else if (item === "--sample-size" && next) {
      args.sampleSize = Number.parseInt(next, 10);
      index += 1;
    } else if (item === "--batch-size" && next) {
      args.batchSize = Number.parseInt(next, 10);
      index += 1;
    } else if (item === "--psql-bin" && next) {
      args.psqlBin = next;
      index += 1;
    } else if (item === "--help" || item === "-h") {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`未知参数：${item}`);
    }
  }

  if (!Number.isFinite(args.sampleSize) || args.sampleSize < 0) {
    args.sampleSize = DEFAULT_SAMPLE_SIZE;
  }
  if (!Number.isFinite(args.batchSize) || args.batchSize < 1) {
    args.batchSize = DEFAULT_BATCH_SIZE;
  }
  return args;
}

function maskDatabaseUrl(url) {
  if (!url) {
    return "(not set)";
  }
  try {
    const parsed = new URL(url);
    if (parsed.password) {
      parsed.password = "***";
    }
    return parsed.toString();
  } catch {
    return url.replace(/:\/\/([^:/?#]+):([^@/?#]+)@/, "://$1:***@");
  }
}

function assertPostgresUrl(url) {
  if (!url) {
    throw new Error("缺少 PostgreSQL 连接串，请设置 AZT_DATABASE_URL 或传入 --database-url。");
  }
  if (!/^postgres(?:ql)?:\/\//i.test(url)) {
    throw new Error("AZT_DATABASE_URL 必须是 postgres:// 或 postgresql://。");
  }
}

function sqlIdent(value) {
  return `"${String(value).replaceAll('"', '""')}"`;
}

function sqlLiteral(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function sqlValue(column, value) {
  if (value === null || value === undefined) {
    return "NULL";
  }
  if (column.json) {
    return `${sqlLiteral(value)}::jsonb`;
  }
  if (column.numeric) {
    const number = Number(value);
    if (!Number.isFinite(number)) {
      if (column.nullable === false) {
        throw new Error(`字段 ${column.name} 需要数值，但收到：${value}`);
      }
      return "NULL";
    }
    return String(number);
  }
  return sqlLiteral(value);
}

function sourceDefaultSql(column) {
  if (column.defaultValue !== undefined) {
    return String(column.defaultValue);
  }
  if (column.defaultJson !== undefined) {
    return sqlLiteral(JSON.stringify(column.defaultJson));
  }
  return "NULL";
}

function normalizeJsonValue(tableName, columnName, rowId, raw, fallback, nullable) {
  if (raw === null || raw === undefined || raw === "") {
    if (fallback !== undefined) {
      return { text: JSON.stringify(fallback), value: fallback };
    }
    if (nullable !== false) {
      return { text: null, value: null };
    }
  }

  const text = Buffer.isBuffer(raw) ? raw.toString("utf8") : String(raw);
  try {
    const parsed = JSON.parse(text);
    return { text: JSON.stringify(parsed), value: parsed };
  } catch (error) {
    throw new Error(`JSON 解析失败：${tableName}.${columnName} id=${rowId ?? "(unknown)"}，${error instanceof Error ? error.message : String(error)}`);
  }
}

function sortedJson(value) {
  if (Array.isArray(value)) {
    return value.map(sortedJson);
  }
  if (value && typeof value === "object") {
    return Object.keys(value).sort().reduce((next, key) => {
      next[key] = sortedJson(value[key]);
      return next;
    }, {});
  }
  return value;
}

function canonicalJson(value) {
  return JSON.stringify(sortedJson(value));
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function getTableColumns(db, tableName) {
  const rows = db.prepare(`PRAGMA table_info(${sqlIdent(tableName)})`).all();
  return new Set(rows.map((row) => String(row.name)));
}

function tableExists(db, tableName) {
  const row = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(tableName);
  return Boolean(row);
}

function readSource(sqlitePath) {
  if (!fs.existsSync(sqlitePath)) {
    throw new Error(`SQLite 文件不存在：${sqlitePath}`);
  }

  const { DatabaseSync } = require("node:sqlite");
  const db = new DatabaseSync(sqlitePath, { readOnly: true });
  const data = new Map();
  const warnings = [];

  try {
    for (const table of tables) {
      if (!tableExists(db, table.name)) {
        data.set(table.name, []);
        warnings.push(`源库缺少表 ${table.name}，按 0 行处理。`);
        continue;
      }

      const availableColumns = getTableColumns(db, table.name);
      const selectList = table.columns.map((column) => {
        if (availableColumns.has(column.name)) {
          return sqlIdent(column.name);
        }
        warnings.push(`源表 ${table.name} 缺少列 ${column.name}，迁移时使用默认值。`);
        return `${sourceDefaultSql(column)} AS ${sqlIdent(column.name)}`;
      });
      const rows = db.prepare(`SELECT ${selectList.join(", ")} FROM ${sqlIdent(table.name)}`).all();
      data.set(table.name, rows.map((row) => normalizeRow(table, row)));
    }
  } finally {
    db.close();
  }

  return { data, warnings };
}

function normalizeRow(table, row) {
  const next = {};
  for (const column of table.columns) {
    let value = row[column.name];
    if ((value === null || value === undefined) && column.defaultValue !== undefined) {
      value = column.defaultValue;
    }
    if (column.json) {
      const normalized = normalizeJsonValue(table.name, column.name, row.id, value, column.defaultJson, column.nullable);
      next[column.name] = normalized.text;
      next[`__json_${column.name}`] = normalized.value;
      continue;
    }
    if (value === undefined) {
      value = null;
    }
    next[column.name] = value;
  }
  return next;
}

function validateSource(data) {
  const errors = [];
  const requiredFailures = [];

  for (const table of tables) {
    const rows = data.get(table.name) || [];
    for (const row of rows) {
      for (const column of table.columns) {
        if (column.nullable === false && (row[column.name] === null || row[column.name] === undefined)) {
          requiredFailures.push(`${table.name}.${column.name} id=${row.id ?? "(unknown)"}`);
        }
      }
    }
  }

  if (requiredFailures.length > 0) {
    errors.push(`存在必填字段为空：${requiredFailures.slice(0, 8).join(", ")}${requiredFailures.length > 8 ? " ..." : ""}`);
  }

  const conversationIds = new Set((data.get("chat_conversations") || []).map((row) => row.id));
  const orphanMessages = (data.get("chat_messages") || []).filter((row) => !conversationIds.has(row.conversation_id));
  if (orphanMessages.length > 0) {
    errors.push(`发现 ${orphanMessages.length} 条 chat_messages 找不到 chat_conversations：${orphanMessages.slice(0, 5).map((row) => row.id).join(", ")}`);
  }

  if (errors.length > 0) {
    throw new Error(errors.join("\n"));
  }
}

function createSchemaSql() {
  const statements = [];
  for (const table of tables) {
    const columnLines = table.columns.map((column) => {
      const pieces = [sqlIdent(column.name), column.pgType];
      if (column.name === "id") {
        pieces.push("PRIMARY KEY");
      }
      if (column.nullable === false && column.name !== "id") {
        pieces.push("NOT NULL");
      }
      return `  ${pieces.join(" ")}`;
    });
    if (table.name === "gateway_user_groups") {
      columnLines.push("  CONSTRAINT gateway_user_groups_name_unique UNIQUE (name)");
    }
    if (table.name === "gateway_users") {
      columnLines.push("  CONSTRAINT gateway_users_username_unique UNIQUE (username)");
    }
    if (table.name === "chat_messages") {
      columnLines.push("  CONSTRAINT chat_messages_conversation_id_fk FOREIGN KEY (conversation_id) REFERENCES chat_conversations(id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED");
    }

    statements.push(`CREATE TABLE IF NOT EXISTS ${sqlIdent(table.name)} (\n${columnLines.join(",\n")}\n);`);
    for (const column of table.columns) {
      if (column.name === "id") {
        continue;
      }
      statements.push(`ALTER TABLE ${sqlIdent(table.name)} ADD COLUMN IF NOT EXISTS ${sqlIdent(column.name)} ${column.pgType};`);
    }
    statements.push(...table.indexes);
  }

  return `${statements.join("\n")}\n`;
}

function buildInsertSql(data, batchSize) {
  const statements = ["BEGIN;", "SET CONSTRAINTS ALL DEFERRED;"];

  for (const table of tables) {
    const rows = data.get(table.name) || [];
    if (rows.length === 0) {
      continue;
    }
    const columns = table.columns;
    const columnList = columns.map((column) => sqlIdent(column.name)).join(", ");
    const conflictUpdate = columns
      .filter((column) => column.name !== "id")
      .map((column) => `${sqlIdent(column.name)} = EXCLUDED.${sqlIdent(column.name)}`)
      .join(", ");

    for (let offset = 0; offset < rows.length; offset += batchSize) {
      const batch = rows.slice(offset, offset + batchSize);
      const values = batch.map((row) => {
        const cells = columns.map((column) => sqlValue(column, row[column.name]));
        return `(${cells.join(", ")})`;
      });
      statements.push(`
INSERT INTO ${sqlIdent(table.name)} (${columnList})
VALUES
${values.join(",\n")}
ON CONFLICT (id) DO UPDATE SET
${conflictUpdate};
`);
    }
  }

  statements.push("COMMIT;");
  return `${statements.join("\n")}\n`;
}

function createMigrationSql(data, batchSize, truncateTarget) {
  const truncateSql = truncateTarget
    ? `TRUNCATE TABLE ${tables.map((table) => sqlIdent(table.name)).join(", ")} RESTART IDENTITY;\n`
    : "";
  return `${createSchemaSql()}\n${truncateSql}${buildInsertSql(data, batchSize)}`;
}

function runPsql(args, sql, options = {}) {
  const captureOutput = options.captureOutput !== false;
  return new Promise((resolve, reject) => {
    const child = spawn(args.psqlBin, [
      "--no-psqlrc",
      "--quiet",
      "--tuples-only",
      "--no-align",
      "--set",
      "ON_ERROR_STOP=1",
      "--dbname",
      args.databaseUrl,
    ], {
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      if (captureOutput) {
        stdout += chunk.toString("utf8");
      }
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (error) => {
      reject(new Error(`无法执行 ${args.psqlBin}：${error.message}`));
    });
    child.on("close", (code) => {
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }
      reject(new Error(`psql 执行失败，退出码 ${code}\n${stderr.trim()}`));
    });
    child.stdin.end(sql);
  });
}

function countsSql() {
  const parts = tables.map((table) => `SELECT ${sqlLiteral(table.name)} AS table_name, COUNT(*)::bigint AS row_count FROM ${sqlIdent(table.name)}`);
  return `
SELECT COALESCE(json_agg(json_build_object('table', table_name, 'count', row_count) ORDER BY table_name)::text, '[]')
FROM (
${parts.join("\nUNION ALL\n")}
) AS counts;
`;
}

async function readTargetCounts(args) {
  const result = await runPsql(args, countsSql());
  const raw = result.stdout.trim() || "[]";
  const parsed = JSON.parse(raw);
  return new Map(parsed.map((row) => [row.table, Number(row.count)]));
}

function sourceCounts(data) {
  return new Map(tables.map((table) => [table.name, (data.get(table.name) || []).length]));
}

function formatCounts(counts) {
  return tables.map((table) => `${table.name}=${counts.get(table.name) ?? 0}`).join(", ");
}

function assertTargetEmpty(targetCounts) {
  const nonEmpty = tables
    .map((table) => ({ table: table.name, count: targetCounts.get(table.name) ?? 0 }))
    .filter((item) => item.count > 0);
  if (nonEmpty.length > 0) {
    throw new Error(`目标库已存在数据：${nonEmpty.map((item) => `${item.table}=${item.count}`).join(", ")}。如确认要覆盖，请加 --truncate-target。`);
  }
}

function assertCountsEqual(expected, actual) {
  const mismatches = [];
  for (const table of tables) {
    const sourceCount = expected.get(table.name) ?? 0;
    const targetCount = actual.get(table.name) ?? 0;
    if (sourceCount !== targetCount) {
      mismatches.push(`${table.name}: source=${sourceCount}, target=${targetCount}`);
    }
  }
  if (mismatches.length > 0) {
    throw new Error(`行数校验失败：${mismatches.join("; ")}`);
  }
}

function sampleRows(rows, size) {
  if (size <= 0 || rows.length === 0) {
    return [];
  }
  if (rows.length <= size) {
    return rows;
  }
  if (size === 1) {
    return [rows[0]];
  }
  const indexes = new Set();
  for (let index = 0; index < size; index += 1) {
    indexes.add(Math.round((index * (rows.length - 1)) / (size - 1)));
  }
  return [...indexes].sort((left, right) => left - right).map((index) => rows[index]);
}

async function readTargetJsonSamples(args, tableName, columnName, ids) {
  if (ids.length === 0) {
    return new Map();
  }
  const sql = `
SELECT COALESCE(json_agg(json_build_object('id', id, 'value', ${sqlIdent(columnName)}) ORDER BY id)::text, '[]')
FROM ${sqlIdent(tableName)}
WHERE id IN (${ids.map(sqlLiteral).join(", ")});
`;
  const result = await runPsql(args, sql);
  const parsed = JSON.parse(result.stdout.trim() || "[]");
  return new Map(parsed.map((row) => [row.id, row.value]));
}

async function validateJsonSamples(args, data, sampleSize) {
  const failures = [];
  let checked = 0;

  for (const table of tables) {
    const jsonColumns = table.columns.filter((column) => column.json);
    if (jsonColumns.length === 0) {
      continue;
    }
    const rows = [...(data.get(table.name) || [])].sort((left, right) => String(left.id).localeCompare(String(right.id)));
    const sampledRows = sampleRows(rows, sampleSize);
    const ids = sampledRows.map((row) => row.id);
    for (const column of jsonColumns) {
      const targetValues = await readTargetJsonSamples(args, table.name, column.name, ids);
      for (const row of sampledRows) {
        const expected = row[`__json_${column.name}`];
        const actual = targetValues.get(row.id);
        if (canonicalJson(expected) !== canonicalJson(actual)) {
          failures.push(`${table.name}.${column.name} id=${row.id}`);
        }
        checked += 1;
      }
    }
  }

  if (failures.length > 0) {
    throw new Error(`JSON 抽样校验失败：${failures.slice(0, 10).join(", ")}${failures.length > 10 ? " ..." : ""}`);
  }
  return checked;
}

function extractImagePathsFromRows(rows) {
  const paths = [];
  for (const row of rows) {
    const images = row.__json_images_json;
    if (!Array.isArray(images)) {
      continue;
    }
    for (const image of images) {
      if (!image || typeof image !== "object") {
        continue;
      }
      for (const key of ["path", "previewPath", "url", "previewUrl"]) {
        if (typeof image[key] === "string" && image[key].length > 0) {
          paths.push({ id: String(row.id), key, value: image[key] });
        }
      }
    }
  }
  return sortImagePathEntries(paths);
}

function sortImagePathEntries(paths) {
  return paths.sort((left, right) => `${left.id}\0${left.key}\0${left.value}`.localeCompare(`${right.id}\0${right.key}\0${right.value}`));
}

async function readTargetImagePaths(args) {
  const sql = `
WITH expanded AS (
  SELECT id, image
  FROM generation_history
  CROSS JOIN LATERAL jsonb_array_elements(
    CASE
      WHEN images_json IS NULL THEN '[]'::jsonb
      WHEN jsonb_typeof(images_json) = 'array' THEN images_json
      ELSE '[]'::jsonb
    END
  ) AS image
),
paths AS (
  SELECT id, key, value
  FROM expanded
  CROSS JOIN LATERAL (
    VALUES
      ('path', image->>'path'),
      ('previewPath', image->>'previewPath'),
      ('url', image->>'url'),
      ('previewUrl', image->>'previewUrl')
  ) AS fields(key, value)
  WHERE value IS NOT NULL AND value <> ''
)
SELECT COALESCE(json_agg(json_build_object('id', id, 'key', key, 'value', value) ORDER BY id, key, value)::text, '[]')
FROM paths;
`;
  const result = await runPsql(args, sql);
  return JSON.parse(result.stdout.trim() || "[]");
}

async function validateImagePaths(args, data) {
  const sourcePaths = extractImagePathsFromRows(data.get("generation_history") || []);
  const targetPaths = sortImagePathEntries(await readTargetImagePaths(args));
  const sourceHash = sha256(canonicalJson(sourcePaths));
  const targetHash = sha256(canonicalJson(targetPaths));
  if (sourceHash !== targetHash) {
    throw new Error(`生成图片路径校验失败：source=${sourcePaths.length}/${sourceHash}, target=${targetPaths.length}/${targetHash}`);
  }
  return { count: sourcePaths.length, hash: sourceHash };
}

function validateSourceJsonSummary(data) {
  let jsonCells = 0;
  for (const table of tables) {
    const jsonColumnCount = table.columns.filter((column) => column.json).length;
    jsonCells += (data.get(table.name) || []).length * jsonColumnCount;
  }
  return jsonCells;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const mode = args.execute ? "execute" : "dry-run";

  console.log(`[azt-migrate] mode=${mode}`);
  console.log(`[azt-migrate] sqlite=${args.sqlitePath}`);
  if (args.execute) {
    assertPostgresUrl(args.databaseUrl);
    console.log(`[azt-migrate] postgres=${maskDatabaseUrl(args.databaseUrl)}`);
  }

  const { data, warnings } = readSource(args.sqlitePath);
  validateSource(data);

  for (const warning of warnings) {
    console.warn(`[azt-migrate] warning: ${warning}`);
  }

  const expectedCounts = sourceCounts(data);
  const jsonCells = validateSourceJsonSummary(data);
  const imagePaths = extractImagePathsFromRows(data.get("generation_history") || []);
  console.log(`[azt-migrate] source rows: ${formatCounts(expectedCounts)}`);
  console.log(`[azt-migrate] source json cells validated: ${jsonCells}`);
  console.log(`[azt-migrate] source image path/url entries: ${imagePaths.length}`);

  if (!args.execute) {
    console.log("[azt-migrate] dry-run 完成：未连接或写入 PostgreSQL。使用 --execute 执行迁移。");
    return;
  }

  console.log("[azt-migrate] ensuring PostgreSQL schema...");
  await runPsql(args, createSchemaSql(), { captureOutput: false });

  if (!args.truncateTarget) {
    const beforeCounts = await readTargetCounts(args);
    assertTargetEmpty(beforeCounts);
  }

  console.log(`[azt-migrate] migrating rows${args.truncateTarget ? " with --truncate-target" : ""}...`);
  await runPsql(args, createMigrationSql(data, args.batchSize, args.truncateTarget), { captureOutput: false });

  const actualCounts = await readTargetCounts(args);
  assertCountsEqual(expectedCounts, actualCounts);
  console.log(`[azt-migrate] row counts verified: ${formatCounts(actualCounts)}`);

  const checkedJsonSamples = await validateJsonSamples(args, data, args.sampleSize);
  console.log(`[azt-migrate] json samples verified: ${checkedJsonSamples}`);

  const imagePathResult = await validateImagePaths(args, data);
  console.log(`[azt-migrate] image paths verified: count=${imagePathResult.count}, sha256=${imagePathResult.hash}`);
  console.log("[azt-migrate] migration completed successfully.");
}

main().catch((error) => {
  console.error(`[azt-migrate] failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
