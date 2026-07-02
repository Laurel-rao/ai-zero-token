#!/usr/bin/env node

import http from "node:http";
import https from "node:https";
import { spawnSync } from "node:child_process";
import { performance } from "node:perf_hooks";
import sharp from "sharp";

const DEFAULT_BASE_URL = "http://43.128.120.182";
const DEFAULT_USERNAME = "admin";
const DEFAULT_PASSWORD = "Admin@123";
const DEFAULT_ROUNDS = 3;
const DEFAULT_TIMEOUT_MS = 8_000;
const DEFAULT_REMOTE_ASSET_ROOT = "/opt/ai-zero-token/state/.state/generations/images";

function parseArgs(argv) {
  const args = {
    baseUrl: process.env.AZT_IMAGE_DIAG_BASE_URL || DEFAULT_BASE_URL,
    username: process.env.AZT_IMAGE_DIAG_USERNAME || process.env.AZT_ADMIN_USER || DEFAULT_USERNAME,
    password: process.env.AZT_IMAGE_DIAG_PASSWORD || process.env.AZT_ADMIN_PASSWORD || DEFAULT_PASSWORD,
    id: process.env.AZT_IMAGE_DIAG_ID || "",
    imageIndex: Number.parseInt(process.env.AZT_IMAGE_DIAG_INDEX || "", 10) || 0,
    rounds: Number.parseInt(process.env.AZT_IMAGE_DIAG_ROUNDS || "", 10) || DEFAULT_ROUNDS,
    timeoutMs: Number.parseInt(process.env.AZT_IMAGE_DIAG_TIMEOUT_MS || "", 10) || DEFAULT_TIMEOUT_MS,
    url: process.env.AZT_IMAGE_DIAG_URL || "",
    previewUrl: process.env.AZT_IMAGE_DIAG_PREVIEW_URL || "",
    ssh: process.env.AZT_IMAGE_DIAG_SSH || "",
    remoteAssetRoot: process.env.AZT_IMAGE_DIAG_REMOTE_ROOT || DEFAULT_REMOTE_ASSET_ROOT,
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
    } else if (item === "--id" && next) {
      args.id = next;
      index += 1;
    } else if (item === "--index" && next) {
      args.imageIndex = Number.parseInt(next, 10);
      index += 1;
    } else if (item === "--url" && next) {
      args.url = next;
      index += 1;
    } else if (item === "--preview-url" && next) {
      args.previewUrl = next;
      index += 1;
    } else if (item === "--rounds" && next) {
      args.rounds = Number.parseInt(next, 10);
      index += 1;
    } else if (item === "--timeout-ms" && next) {
      args.timeoutMs = Number.parseInt(next, 10);
      index += 1;
    } else if (item === "--ssh" && next) {
      args.ssh = next;
      index += 1;
    } else if (item === "--remote-root" && next) {
      args.remoteAssetRoot = next;
      index += 1;
    } else if (item === "--help" || item === "-h") {
      console.log(`Usage:
  node scripts/image-load-diagnose.mjs --id <generation-id> [options]
  node scripts/image-load-diagnose.mjs --url <image-url> [--preview-url <url>] [options]

Options:
  --base-url <url>       Gateway base URL. Default: ${DEFAULT_BASE_URL}
  --username <name>      Login username. Default: ${DEFAULT_USERNAME}
  --password <password>  Login password. Default: ${DEFAULT_PASSWORD}
  --id <id>              Generation history id, for example req-8c.
  --index <n>            Image index in history item, 0-based. Default: 0
  --url <url>            Direct original image URL or path.
  --preview-url <url>    Direct preview image URL or path.
  --rounds <n>           Download samples per image. Default: ${DEFAULT_ROUNDS}
  --timeout-ms <n>       Per-request timeout. Default: ${DEFAULT_TIMEOUT_MS}
  --ssh <host>           Optional remote host, for example root@43.128.120.182.
  --remote-root <path>   Remote generation image root. Default: ${DEFAULT_REMOTE_ASSET_ROOT}

Environment:
  AZT_IMAGE_DIAG_BASE_URL, AZT_IMAGE_DIAG_USERNAME, AZT_IMAGE_DIAG_PASSWORD,
  AZT_IMAGE_DIAG_ID, AZT_IMAGE_DIAG_URL, AZT_IMAGE_DIAG_PREVIEW_URL,
  AZT_IMAGE_DIAG_ROUNDS, AZT_IMAGE_DIAG_TIMEOUT_MS, AZT_IMAGE_DIAG_SSH
`);
      process.exit(0);
    }
  }

  args.baseUrl = args.baseUrl.replace(/\/+$/, "");
  args.imageIndex = Number.isFinite(args.imageIndex) && args.imageIndex >= 0 ? args.imageIndex : 0;
  args.rounds = Number.isFinite(args.rounds) && args.rounds > 0 ? args.rounds : DEFAULT_ROUNDS;
  args.timeoutMs = Number.isFinite(args.timeoutMs) && args.timeoutMs > 0 ? args.timeoutMs : DEFAULT_TIMEOUT_MS;
  return args;
}

function formatMs(value) {
  if (!Number.isFinite(value)) {
    return "-";
  }
  return `${value.toFixed(1)}ms`;
}

function formatBytes(value) {
  if (!Number.isFinite(value)) {
    return "-";
  }
  if (value < 1024) {
    return `${value}B`;
  }
  if (value < 1024 * 1024) {
    return `${(value / 1024).toFixed(1)}KB`;
  }
  return `${(value / 1024 / 1024).toFixed(2)}MB`;
}

function formatSpeed(bytes, ms) {
  if (!bytes || !ms) {
    return "-";
  }
  return `${(bytes / 1024 / 1024 / (ms / 1000)).toFixed(2)}MB/s`;
}

function percentile(values, ratio) {
  const sorted = values.filter(Number.isFinite).sort((left, right) => left - right);
  if (sorted.length === 0) {
    return 0;
  }
  const index = Math.min(sorted.length - 1, Math.ceil(sorted.length * ratio) - 1);
  return sorted[index];
}

function toAbsoluteUrl(baseUrl, value) {
  if (!value) {
    return "";
  }
  return new URL(value, `${baseUrl}/`).toString();
}

function imagePathFromGatewayUrl(urlValue) {
  const url = new URL(urlValue);
  const marker = "/_gateway/generations/images/";
  const index = url.pathname.indexOf(marker);
  if (index < 0) {
    return "";
  }
  return decodeURIComponent(url.pathname.slice(index + marker.length));
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
    if (value) {
      cookieJar.set(name, value);
    } else {
      cookieJar.delete(name);
    }
  }
}

function cookieHeader(cookieJar) {
  return [...cookieJar.entries()].map(([name, value]) => `${name}=${value}`).join("; ");
}

async function fetchJson(baseUrl, cookieJar, path, options = {}) {
  const headers = { ...(options.headers || {}) };
  const cookies = cookieHeader(cookieJar);
  if (cookies) {
    headers.cookie = cookies;
  }
  if (options.body !== undefined && !headers["content-type"]) {
    headers["content-type"] = "application/json";
  }
  const response = await fetch(`${baseUrl}${path}`, {
    method: options.method || "GET",
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  updateCookieJar(cookieJar, response);
  const text = await response.text();
  let parsed = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = null;
  }
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${text.slice(0, 240)}`);
  }
  return parsed;
}

async function login(args, cookieJar) {
  await fetchJson(args.baseUrl, cookieJar, "/_gateway/auth/login", {
    method: "POST",
    body: {
      username: args.username,
      password: args.password,
    },
  });
}

async function resolveImages(args, cookieJar) {
  if (args.url || args.previewUrl) {
    return {
      id: args.id || "(direct-url)",
      prompt: "",
      originalUrl: toAbsoluteUrl(args.baseUrl, args.url),
      previewUrl: toAbsoluteUrl(args.baseUrl, args.previewUrl),
      expectedSize: 0,
      expectedPreviewSize: 0,
      mimeType: "",
      width: 0,
      height: 0,
    };
  }

  if (!args.id) {
    const history = await fetchJson(args.baseUrl, cookieJar, "/_gateway/generations/history?limit=10&owner=all&light=true");
    const item = history?.items?.find((entry) => Array.isArray(entry.images) && entry.images.length > 0);
    if (!item?.id) {
      throw new Error("没有传 --id，最近历史里也没有找到带图片的记录。");
    }
    args.id = item.id;
  }

  let item = null;
  try {
    const detail = await fetchJson(args.baseUrl, cookieJar, `/_gateway/generations/history/${encodeURIComponent(args.id)}`);
    item = detail?.item;
  } catch (error) {
    const history = await fetchJson(args.baseUrl, cookieJar, "/_gateway/generations/history?limit=200&owner=all&light=false");
    item = history?.items?.find((entry) => entry?.id === args.id) ?? null;
    if (!item) {
      throw error;
    }
  }
  const image = item?.images?.[args.imageIndex];
  if (!image) {
    throw new Error(`历史 ${args.id} 没有第 ${args.imageIndex} 张图片。`);
  }
  return {
    id: item.id,
    prompt: item.prompt || "",
    originalUrl: toAbsoluteUrl(args.baseUrl, image.url),
    previewUrl: toAbsoluteUrl(args.baseUrl, image.previewUrl || ""),
    expectedSize: image.size || 0,
    expectedPreviewSize: image.previewSize || 0,
    mimeType: image.mimeType || "",
    width: image.width || 0,
    height: image.height || 0,
  };
}

function timedRequest(urlValue, cookieJar, timeoutMs) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlValue);
    const isHttps = url.protocol === "https:";
    const client = isHttps ? https : http;
    const headers = {};
    const cookies = cookieHeader(cookieJar);
    if (cookies) {
      headers.cookie = cookies;
    }
    headers["cache-control"] = "no-cache";
    headers.pragma = "no-cache";

    const timings = {
      start: performance.now(),
      socket: 0,
      lookup: 0,
      connect: 0,
      secureConnect: 0,
      firstByte: 0,
      end: 0,
    };
    let statusCode = 0;
    let contentType = "";
    let bytes = 0;
    const chunks = [];

    const request = client.request({
      protocol: url.protocol,
      hostname: url.hostname,
      port: url.port,
      path: `${url.pathname}${url.search}`,
      method: "GET",
      headers,
      timeout: timeoutMs,
    }, (response) => {
      statusCode = response.statusCode || 0;
      contentType = String(response.headers["content-type"] || "");
      timings.firstByte = performance.now();
      response.on("data", (chunk) => {
        bytes += chunk.length;
        chunks.push(chunk);
      });
      response.on("end", () => {
        timings.end = performance.now();
        resolve({
          url: urlValue,
          statusCode,
          contentType,
          bytes,
          buffer: Buffer.concat(chunks),
          timings,
          phases: {
            dnsMs: timings.lookup && timings.socket ? timings.lookup - timings.socket : 0,
            connectMs: timings.connect && (timings.lookup || timings.socket) ? timings.connect - (timings.lookup || timings.socket) : 0,
            tlsMs: timings.secureConnect && timings.connect ? timings.secureConnect - timings.connect : 0,
            ttfbMs: timings.firstByte - timings.start,
            downloadMs: timings.end - timings.firstByte,
            totalMs: timings.end - timings.start,
          },
        });
      });
    });

    request.on("socket", (socket) => {
      timings.socket = performance.now();
      socket.on("lookup", () => {
        timings.lookup = performance.now();
      });
      socket.on("connect", () => {
        timings.connect = performance.now();
      });
      socket.on("secureConnect", () => {
        timings.secureConnect = performance.now();
      });
    });
    request.on("timeout", () => {
      request.destroy(new Error(`timeout after ${timeoutMs}ms`));
    });
    request.on("error", reject);
    request.end();
  });
}

async function measureImage(label, url, args, cookieJar) {
  if (!url) {
    return null;
  }
  console.log(`\nmeasuring ${label}: ${url}`);
  const samples = [];
  let last = null;
  for (let index = 0; index < args.rounds; index += 1) {
    process.stdout.write(`  ${label} #${index + 1} ... `);
    const result = await timedRequest(url, cookieJar, args.timeoutMs);
    console.log(`status=${result.statusCode} total=${formatMs(result.phases.totalMs)} ttfb=${formatMs(result.phases.ttfbMs)} download=${formatMs(result.phases.downloadMs)} bytes=${formatBytes(result.bytes)} speed=${formatSpeed(result.bytes, result.phases.downloadMs)}`);
    samples.push(result);
    last = result;
  }

  const totals = samples.map((item) => item.phases.totalMs);
  const ttfbs = samples.map((item) => item.phases.ttfbMs);
  const downloads = samples.map((item) => item.phases.downloadMs);
  const bytes = last?.bytes || 0;
  let metadata = null;
  let decodeMs = 0;
  let decodeError = "";
  if (last?.statusCode === 200 && last.buffer.length > 0 && /^image\//i.test(last.contentType)) {
    const started = performance.now();
    try {
      metadata = await sharp(last.buffer).metadata();
      decodeMs = performance.now() - started;
    } catch (error) {
      decodeError = error instanceof Error ? error.message : String(error);
    }
  }

  return {
    label,
    url,
    statusCode: last?.statusCode || 0,
    contentType: last?.contentType || "",
    bytes,
    samples,
    totalAvgMs: totals.reduce((sum, value) => sum + value, 0) / totals.length,
    totalP95Ms: percentile(totals, 0.95),
    ttfbAvgMs: ttfbs.reduce((sum, value) => sum + value, 0) / ttfbs.length,
    downloadAvgMs: downloads.reduce((sum, value) => sum + value, 0) / downloads.length,
    speed: formatSpeed(bytes, downloads.reduce((sum, value) => sum + value, 0) / downloads.length),
    metadata,
    decodeMs,
    decodeError,
  };
}

function printImageReport(report, expectedSize = 0) {
  if (!report) {
    return;
  }
  console.log(`\n[${report.label}]`);
  console.log(`url: ${report.url}`);
  console.log(`status=${report.statusCode} content-type=${report.contentType || "-"} bytes=${formatBytes(report.bytes)}${expectedSize ? ` expected=${formatBytes(expectedSize)}` : ""}`);
  console.log(`avg total=${formatMs(report.totalAvgMs)} p95=${formatMs(report.totalP95Ms)} avg ttfb=${formatMs(report.ttfbAvgMs)} avg download=${formatMs(report.downloadAvgMs)} speed=${report.speed}`);
  report.samples.forEach((sample, index) => {
    console.log(`  #${index + 1} dns=${formatMs(sample.phases.dnsMs)} connect=${formatMs(sample.phases.connectMs)} ttfb=${formatMs(sample.phases.ttfbMs)} download=${formatMs(sample.phases.downloadMs)} total=${formatMs(sample.phases.totalMs)} bytes=${formatBytes(sample.bytes)}`);
  });
  if (report.metadata) {
    console.log(`decode sharp=${formatMs(report.decodeMs)} ${report.metadata.width || "?"}x${report.metadata.height || "?"} ${report.metadata.format || ""}`);
  } else if (report.decodeError) {
    console.log(`decode failed: ${report.decodeError}`);
  }
}

function runRemoteDiskTest(args, relativePath) {
  if (!args.ssh || !relativePath) {
    return null;
  }
  const safeRoot = args.remoteAssetRoot.replace(/'/g, "'\\''");
  const safeRelative = relativePath.replace(/'/g, "'\\''");
  const script = `
node <<'NODE'
const fs = require("node:fs");
const path = require("node:path");
const root = '${safeRoot}';
const relative = '${safeRelative}';
const file = path.resolve(root, relative);
const startedStat = performance.now();
const stat = fs.statSync(file);
const statMs = performance.now() - startedStat;
const samples = [];
let bytes = 0;
for (let i = 0; i < 5; i++) {
  const started = performance.now();
  const data = fs.readFileSync(file);
  samples.push(performance.now() - started);
  bytes = data.length;
}
console.log(JSON.stringify({ file, statSize: stat.size, statMs, bytes, samples }));
NODE
`;
  const result = spawnSync("ssh", [args.ssh, script], { encoding: "utf8", maxBuffer: 1024 * 1024 });
  if (result.status !== 0) {
    return { error: result.stderr || result.stdout || `ssh exited ${result.status}` };
  }
  try {
    return JSON.parse(result.stdout.trim().split("\n").pop() || "{}");
  } catch {
    return { error: result.stdout.trim() || "failed to parse ssh output" };
  }
}

function printRemoteDiskReport(label, result) {
  if (!result) {
    return;
  }
  console.log(`\n[remote disk: ${label}]`);
  if (result.error) {
    console.log(result.error);
    return;
  }
  const avg = result.samples.reduce((sum, value) => sum + value, 0) / result.samples.length;
  console.log(`file=${result.file}`);
  console.log(`stat=${formatMs(result.statMs)} bytes=${formatBytes(result.bytes)} read_avg=${formatMs(avg)} read_p95=${formatMs(percentile(result.samples, 0.95))}`);
  result.samples.forEach((value, index) => console.log(`  #${index + 1} read=${formatMs(value)}`));
}

function printDiagnosis(original, preview, originalDisk, previewDisk) {
  console.log("\n[diagnosis]");
  if (preview && original) {
    const sizeRatio = preview.bytes > 0 ? original.bytes / preview.bytes : 0;
    console.log(`原图/预览图体积比: ${sizeRatio ? sizeRatio.toFixed(1) : "-"}x`);
  }

  if (original) {
    if (original.statusCode !== 200) {
      console.log(`原图 HTTP 状态不是 200，而是 ${original.statusCode}，需要先看鉴权/路由返回。`);
      return;
    }
    if (original.ttfbAvgMs > 1000) {
      console.log(`主要慢在 TTFB（平均 ${formatMs(original.ttfbAvgMs)}）：请求到达后服务端迟迟没开始返回，优先查鉴权、数据库 owner 查询、文件读取或服务端阻塞。`);
    } else if (original.downloadAvgMs > 1000) {
      console.log(`主要慢在下载阶段（平均 ${formatMs(original.downloadAvgMs)}）：服务端已经开始返回，但公网吞吐偏低，优先查带宽、跨境链路、反向代理限速。`);
    } else if (original.decodeMs > 500) {
      console.log(`网络下载并不慢，但图片解码耗时 ${formatMs(original.decodeMs)}，前端体感慢更可能是浏览器解码/渲染。`);
    } else {
      console.log(`原图链路本身不慢：平均总耗时 ${formatMs(original.totalAvgMs)}，下载 ${formatMs(original.downloadAvgMs)}，解码 ${formatMs(original.decodeMs)}。如果浏览器仍慢，重点看缓存、并发请求、主线程阻塞或图片元素是否重复加载。`);
    }
  }

  if (originalDisk && !originalDisk.error && original) {
    const avgDisk = originalDisk.samples.reduce((sum, value) => sum + value, 0) / originalDisk.samples.length;
    if (avgDisk > 500 && original.ttfbAvgMs > 500) {
      console.log(`远端磁盘读也慢（平均 ${formatMs(avgDisk)}），可能是磁盘/容器卷 IO 问题。`);
    }
  }
  if (previewDisk) {
    void previewDisk;
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const cookieJar = new Map();

  console.log(`image load diagnose: ${args.baseUrl}`);
  console.log(`rounds=${args.rounds} timeout=${args.timeoutMs}ms index=${args.imageIndex}`);
  await login(args, cookieJar);
  console.log("login ok");

  const images = await resolveImages(args, cookieJar);
  console.log(`history=${images.id}`);
  if (images.prompt) {
    console.log(`prompt=${images.prompt.slice(0, 120).replace(/\s+/g, " ")}`);
  }
  if (images.width && images.height) {
    console.log(`declared=${images.width}x${images.height} ${images.mimeType || ""}`);
  }

  const preview = await measureImage("preview", images.previewUrl, args, cookieJar);
  const original = await measureImage("original", images.originalUrl, args, cookieJar);
  printImageReport(preview, images.expectedPreviewSize);
  printImageReport(original, images.expectedSize);

  const previewRelativePath = images.previewUrl ? imagePathFromGatewayUrl(images.previewUrl) : "";
  const originalRelativePath = images.originalUrl ? imagePathFromGatewayUrl(images.originalUrl) : "";
  const previewDisk = runRemoteDiskTest(args, previewRelativePath);
  const originalDisk = runRemoteDiskTest(args, originalRelativePath);
  printRemoteDiskReport("preview", previewDisk);
  printRemoteDiskReport("original", originalDisk);
  printDiagnosis(original, preview, originalDisk, previewDisk);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
