import { DatabaseSync } from "node:sqlite";
import { getDatabasePath } from "./state-paths.js";

export type GatewaySqlDialect = "sqlite" | "postgres";

export type GatewaySqlRunResult = {
  changes: number;
};

type SqliteValue = string | number | null | Buffer;
type SqlParam = SqliteValue | undefined;

const DEFAULT_POSTGRES_POOL_MAX = 20;

let database: GatewaySqlDatabase | null = null;

type PgQueryResult = {
  rows: Array<Record<string, unknown>>;
  rowCount: number | null;
};

type PgPool = {
  query(sql: string, params?: SqliteValue[] | null): Promise<PgQueryResult>;
  end(): Promise<void>;
};

type PgPoolConstructor = new (config: Record<string, unknown>) => PgPool;

type PgModule = {
  Pool?: PgPoolConstructor;
  types?: {
    setTypeParser(typeId: number, parser: (value: string) => unknown): void;
  };
  default?: {
    Pool?: PgPoolConstructor;
    types?: {
      setTypeParser(typeId: number, parser: (value: string) => unknown): void;
    };
  };
};

function readPoolMax(): number {
  const raw = process.env.AZT_DB_POOL_MAX?.trim();
  const parsed = raw ? Number.parseInt(raw, 10) : DEFAULT_POSTGRES_POOL_MAX;
  if (!Number.isFinite(parsed)) {
    return DEFAULT_POSTGRES_POOL_MAX;
  }
  return Math.max(1, Math.min(100, parsed));
}

function normalizeParam(value: SqlParam): SqliteValue | null {
  if (typeof value === "undefined") {
    return null;
  }
  if (typeof value === "boolean") {
    return value ? 1 : 0;
  }
  return value;
}

function toPostgresSql(sql: string): string {
  let index = 0;
  let inSingleQuote = false;
  let inDoubleQuote = false;
  let result = "";

  for (let offset = 0; offset < sql.length; offset += 1) {
    const char = sql[offset];
    const next = sql[offset + 1];
    if (char === "'" && !inDoubleQuote) {
      result += char;
      if (inSingleQuote && next === "'") {
        result += next;
        offset += 1;
      } else {
        inSingleQuote = !inSingleQuote;
      }
      continue;
    }
    if (char === "\"" && !inSingleQuote) {
      inDoubleQuote = !inDoubleQuote;
      result += char;
      continue;
    }
    if (char === "?" && !inSingleQuote && !inDoubleQuote) {
      index += 1;
      const previous = sql.slice(Math.max(0, offset - 32), offset).toUpperCase();
      const nextToken = sql.slice(offset + 1, offset + 16).toUpperCase();
      result += nextToken.trimStart().startsWith("IS NULL") || previous.includes("COALESCE(")
        ? `CAST($${index} AS TEXT)`
        : `$${index}`;
      continue;
    }
    result += char;
  }

  result = result.replace(/\bAS\s+([a-z][A-Za-z0-9]*[A-Z][A-Za-z0-9]*)\b/g, 'AS "$1"');

  const insertMatch = /\bINSERT\s+INTO\s+\w+\s*\(([^)]+)\)\s*VALUES\s*\(([^)]+)\)/i.exec(result);
  if (insertMatch?.[1] && insertMatch[2]) {
    const columns = insertMatch[1].split(",").map((item) => item.trim().replace(/^"|"$/g, ""));
    const values = insertMatch[2].split(",").map((item) => item.trim());
    const nextValues = values.map((value, valueIndex) => {
      const column = columns[valueIndex];
      return column && (column === "value_json" || column.endsWith("_json")) && /^\$\d+$/.test(value)
        ? `${value}::jsonb`
        : value;
    });
    result = result.slice(0, insertMatch.index)
      + insertMatch[0].replace(insertMatch[2], nextValues.join(", "))
      + result.slice(insertMatch.index + insertMatch[0].length);
  }

  return result.replace(/=\s*excluded\.(value_json|\w+_json)\b/g, "= excluded.$1");
}

function toPostgresSchemaSql(sql: string): string {
  let next = sql;
  next = next.replace(/\b(gateway_settings\s*\([^;]*?value_json)\s+TEXT\b/gs, "$1 JSONB");
  next = next.replace(/\b(details_json|request_json|response_summary_json|reference_images_json|images_json|metadata_json)\s+TEXT\b/g, "$1 JSONB");
  next = next
    .replace(/\bINTEGER\b/g, "BIGINT")
    .replace(/\bALTER TABLE ([\w"]+) ADD COLUMN ([\w"]+) BIGINT\b/g, "ALTER TABLE $1 ADD COLUMN $2 BIGINT")
    .replace(/\bREAL\b/g, "DOUBLE PRECISION");
  return next;
}

export class GatewaySqlDatabase {
  readonly dialect: GatewaySqlDialect;
  private sqlite: DatabaseSync | null = null;
  private pool: PgPool | null = null;
  private poolReady: Promise<PgPool> | null = null;

  constructor(databaseUrl = process.env.AZT_DATABASE_URL?.trim()) {
    if (databaseUrl) {
      this.dialect = "postgres";
      this.poolReady = this.createPostgresPool(databaseUrl);
    } else {
      this.dialect = "sqlite";
    }
  }

  async exec(sql: string): Promise<void> {
    if (this.dialect === "postgres") {
      await this.postgresQuery(toPostgresSchemaSql(sql));
      return;
    }
    this.getSqlite().exec(sql);
  }

  async run(sql: string, ...params: SqlParam[]): Promise<GatewaySqlRunResult> {
    if (this.dialect === "postgres") {
      const result = await this.postgresQuery(toPostgresSql(sql), params.map(normalizeParam));
      return { changes: result.rowCount ?? 0 };
    }
    const result = this.getSqlite().prepare(sql).run(...params.map(normalizeParam));
    return { changes: Number(result.changes ?? 0) };
  }

  async get<T extends Record<string, unknown> = Record<string, unknown>>(sql: string, ...params: SqlParam[]): Promise<T | undefined> {
    if (this.dialect === "postgres") {
      const result = await this.postgresQuery(toPostgresSql(sql), params.map(normalizeParam));
      return result.rows[0] as T | undefined;
    }
    return this.getSqlite().prepare(sql).get(...params.map(normalizeParam)) as T | undefined;
  }

  async all<T extends Record<string, unknown> = Record<string, unknown>>(sql: string, ...params: SqlParam[]): Promise<T[]> {
    if (this.dialect === "postgres") {
      const result = await this.postgresQuery(toPostgresSql(sql), params.map(normalizeParam));
      return result.rows as T[];
    }
    return this.getSqlite().prepare(sql).all(...params.map(normalizeParam)) as T[];
  }

  async close(): Promise<void> {
    if (this.pool) {
      await this.pool.end();
      this.pool = null;
    }
    if (this.sqlite) {
      this.sqlite.close();
      this.sqlite = null;
    }
  }

  private getSqlite(): DatabaseSync {
    if (!this.sqlite) {
      this.sqlite = new DatabaseSync(getDatabasePath());
    }
    return this.sqlite;
  }

  private async createPostgresPool(databaseUrl: string): Promise<PgPool> {
    const module = await importPgModule();
    const types = module.types ?? module.default?.types;
    types?.setTypeParser(20, (value) => Number(value));

    const Pool = module.Pool ?? module.default?.Pool;
    if (!Pool) {
      throw new Error("AZT_DATABASE_URL 已配置，但 pg 模块没有导出 Pool。");
    }

    const pool = new Pool({
      connectionString: databaseUrl,
      max: readPoolMax(),
    });
    await pool.query("SELECT 1");
    this.pool = pool;
    return pool;
  }

  private async postgresQuery(sql: string, params?: SqliteValue[] | null): Promise<PgQueryResult> {
    const pool = this.pool ?? await this.poolReady;
    if (!pool) {
      throw new Error("PostgreSQL pool is not initialized.");
    }
    return pool.query(sql, params ?? undefined);
  }
}

async function importPgModule(): Promise<PgModule> {
  try {
    const importModule = new Function("specifier", "return import(specifier)") as (specifier: string) => Promise<unknown>;
    return await importModule("pg") as PgModule;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`AZT_DATABASE_URL 已配置，但无法加载 pg 模块：${message}`);
  }
}

export function getGatewaySqlDatabase(): GatewaySqlDatabase {
  if (!database) {
    database = new GatewaySqlDatabase();
  }
  return database;
}

export function isPostgresDatabaseConfigured(): boolean {
  return Boolean(process.env.AZT_DATABASE_URL?.trim());
}
