#!/usr/bin/env node

const DEFAULT_BASE_URL = "http://43.134.21.160";
const DEFAULT_THRESHOLD_MS = 2000;
const DEFAULT_ROUNDS = 3;
const DEFAULT_TIMEOUT_MS = 8000;
let requestTimeoutMs = DEFAULT_TIMEOUT_MS;

function parseArgs(argv) {
  const args = {
    baseUrl: process.env.AZT_PERF_BASE_URL || DEFAULT_BASE_URL,
    username: process.env.AZT_PERF_USERNAME || process.env.AZT_ADMIN_USER || "admin",
    password: process.env.AZT_PERF_PASSWORD || process.env.AZT_ADMIN_PASSWORD || "Admin@123",
    rounds: Number.parseInt(process.env.AZT_PERF_ROUNDS || "", 10) || DEFAULT_ROUNDS,
    thresholdMs: Number.parseInt(process.env.AZT_PERF_THRESHOLD_MS || "", 10) || DEFAULT_THRESHOLD_MS,
    timeoutMs: Number.parseInt(process.env.AZT_PERF_TIMEOUT_MS || "", 10) || DEFAULT_TIMEOUT_MS,
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
    } else if (item === "--rounds" && next) {
      args.rounds = Number.parseInt(next, 10);
      index += 1;
    } else if (item === "--threshold-ms" && next) {
      args.thresholdMs = Number.parseInt(next, 10);
      index += 1;
    } else if (item === "--timeout-ms" && next) {
      args.timeoutMs = Number.parseInt(next, 10);
      index += 1;
    } else if (item === "--help" || item === "-h") {
      console.log(`Usage: node scripts/api-perf-check.mjs [options]

Options:
  --base-url <url>       Gateway base URL. Default: ${DEFAULT_BASE_URL}
  --username <name>      Admin username. Default: admin
  --password <password>  Admin password. Default: Admin@123
  --rounds <n>           Samples per endpoint. Default: ${DEFAULT_ROUNDS}
  --threshold-ms <n>     Slow threshold. Default: ${DEFAULT_THRESHOLD_MS}
  --timeout-ms <n>       Per-request timeout. Default: ${DEFAULT_TIMEOUT_MS}

Environment:
  AZT_PERF_BASE_URL, AZT_PERF_USERNAME, AZT_PERF_PASSWORD,
  AZT_PERF_ROUNDS, AZT_PERF_THRESHOLD_MS, AZT_PERF_TIMEOUT_MS
`);
      process.exit(0);
    }
  }

  if (!Number.isFinite(args.rounds) || args.rounds < 1) {
    args.rounds = DEFAULT_ROUNDS;
  }
  if (!Number.isFinite(args.thresholdMs) || args.thresholdMs < 1) {
    args.thresholdMs = DEFAULT_THRESHOLD_MS;
  }
  if (!Number.isFinite(args.timeoutMs) || args.timeoutMs < 1) {
    args.timeoutMs = DEFAULT_TIMEOUT_MS;
  }

  args.baseUrl = args.baseUrl.replace(/\/+$/, "");
  return args;
}

function percentile(values, ratio) {
  if (values.length === 0) {
    return 0;
  }
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.ceil(sorted.length * ratio) - 1);
  return sorted[index];
}

function formatMs(value) {
  return `${Math.round(value).toString().padStart(5, " ")}ms`;
}

function formatBytes(value) {
  if (value < 1024) {
    return `${value}B`;
  }
  if (value < 1024 * 1024) {
    return `${(value / 1024).toFixed(1)}KB`;
  }
  return `${(value / 1024 / 1024).toFixed(2)}MB`;
}

function updateCookieJar(cookieJar, response) {
  const getSetCookie = response.headers.getSetCookie?.bind(response.headers);
  const cookies = typeof getSetCookie === "function"
    ? getSetCookie()
    : response.headers.get("set-cookie")
      ? [response.headers.get("set-cookie")]
      : [];

  for (const cookie of cookies.filter(Boolean)) {
    const [pair] = cookie.split(";", 1);
    const eq = pair.indexOf("=");
    if (eq <= 0) {
      continue;
    }
    const name = pair.slice(0, eq).trim();
    const value = pair.slice(eq + 1).trim();
    if (!value) {
      cookieJar.delete(name);
    } else {
      cookieJar.set(name, value);
    }
  }
}

function cookieHeader(cookieJar) {
  return [...cookieJar.entries()].map(([name, value]) => `${name}=${value}`).join("; ");
}

async function request(baseUrl, cookieJar, endpoint) {
  const headers = {
    ...(endpoint.headers || {}),
  };
  const cookies = cookieHeader(cookieJar);
  if (cookies) {
    headers.cookie = cookies;
  }
  if (endpoint.body !== undefined && !headers["content-type"]) {
    headers["content-type"] = "application/json";
  }

  const controller = new AbortController();
  const effectiveTimeoutMs = endpoint.timeoutMs || requestTimeoutMs;
  const timeout = setTimeout(() => controller.abort(new Error(`timeout after ${effectiveTimeoutMs}ms`)), effectiveTimeoutMs);
  const started = performance.now();
  try {
    const response = await fetch(`${baseUrl}${endpoint.path}`, {
      method: endpoint.method || "GET",
      headers,
      body: endpoint.body === undefined ? undefined : JSON.stringify(endpoint.body),
      redirect: "manual",
      signal: controller.signal,
    });
    const text = await response.text();
    updateCookieJar(cookieJar, response);
    return {
      ok: response.ok,
      status: response.status,
      ms: performance.now() - started,
      bytes: Buffer.byteLength(text),
      text,
    };
  } finally {
    clearTimeout(timeout);
  }
}

const readOnlyEndpoints = [
  { name: "auth status", path: "/_gateway/auth/status" },
  { name: "admin config", path: "/_gateway/admin/config" },
  { name: "admin users page", path: "/_gateway/admin/users?limit=100&page=1" },
  { name: "admin users full", path: "/_gateway/admin/users" },
  { name: "admin user groups", path: "/_gateway/admin/user-groups" },
  { name: "admin request logs", path: "/_gateway/admin/request-logs?limit=100&owner=all" },
  { name: "admin usage", path: "/_gateway/admin/usage" },
  { name: "generation history", path: "/_gateway/generations/history?limit=100&owner=all&light=true" },
  { name: "gateway status", path: "/_gateway/status" },
  { name: "gateway models", path: "/_gateway/models" },
  { name: "image bed config", path: "/_gateway/image-bed/config" },
  { name: "image bed history", path: "/_gateway/image-bed/history?limit=100" },
  { name: "admin share", path: "/_gateway/admin/share" },
];

async function main() {
  const args = parseArgs(process.argv.slice(2));
  requestTimeoutMs = args.timeoutMs;
  const cookieJar = new Map();

  console.log(`API perf check: ${args.baseUrl}`);
  console.log(`rounds=${args.rounds} threshold=${args.thresholdMs}ms timeout=${args.timeoutMs}ms`);

  const login = await request(args.baseUrl, cookieJar, {
    name: "login",
    path: "/_gateway/auth/login",
    method: "POST",
    body: {
      username: args.username,
      password: args.password,
    },
  });

  if (!login.ok) {
    console.error(`Login failed: HTTP ${login.status} ${login.text.slice(0, 300)}`);
    process.exit(2);
  }
  console.log(`login ${formatMs(login.ms)} ${formatBytes(login.bytes)}`);

  const results = [];
  for (const endpoint of readOnlyEndpoints) {
    process.stdout.write(`checking ${endpoint.name} ... `);
    const samples = [];
    let bytes = 0;
    let status = 0;
    let ok = true;
    let error = "";
    for (let round = 0; round < args.rounds; round += 1) {
      try {
        const result = await request(args.baseUrl, cookieJar, endpoint);
        samples.push(result.ms);
        bytes = result.bytes;
        status = result.status;
        ok = ok && result.ok;
        if (!result.ok) {
          error = result.text.slice(0, 160).replace(/\s+/g, " ");
        }
      } catch (caught) {
        ok = false;
        error = caught instanceof Error ? caught.message : String(caught);
        samples.push(args.timeoutMs);
        break;
      }
    }
    const item = {
      endpoint,
      ok,
      status,
      bytes,
      error,
      min: Math.min(...samples),
      p50: percentile(samples, 0.5),
      p95: percentile(samples, 0.95),
      max: Math.max(...samples),
    };
    results.push(item);
    console.log(`${ok ? "done" : "failed"} max=${formatMs(item.max)} size=${formatBytes(bytes)}`);
  }

  const slow = results.filter((item) => item.max > args.thresholdMs || !item.ok);
  console.log("\nendpoint                         status   size      min     p50     p95     max  result");
  console.log("--------------------------------------------------------------------------------------");
  for (const item of results) {
    const failed = !item.ok;
    const slowFlag = item.max > args.thresholdMs;
    const label = item.endpoint.name.padEnd(32, " ");
    const status = String(item.status || "-").padStart(6, " ");
    const size = formatBytes(item.bytes).padStart(8, " ");
    const result = failed ? `FAIL ${item.error}` : slowFlag ? "SLOW" : "OK";
    console.log(`${label}${status} ${size} ${formatMs(item.min)} ${formatMs(item.p50)} ${formatMs(item.p95)} ${formatMs(item.max)}  ${result}`);
  }

  if (slow.length > 0) {
    console.log(`\n${slow.length} endpoint(s) failed or exceeded ${args.thresholdMs}ms.`);
    process.exitCode = 1;
  } else {
    console.log(`\nAll measured endpoints are within ${args.thresholdMs}ms.`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
