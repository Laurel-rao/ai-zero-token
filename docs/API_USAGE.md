# AI Zero Token API Usage

This guide is for Vibe Coding tools, OpenAI-compatible SDKs, local frontends, and scripts that need to call AI Zero Token through HTTP.

## Base URL

Start the local gateway:

```bash
azt start
```

Default API base URL:

```text
http://127.0.0.1:8787/v1
```

For another device on the same network, replace `127.0.0.1` with the gateway machine IP.

## Auth

The local gateway does not require an API key by default.

Most OpenAI-compatible clients still require a non-empty key value. Use a placeholder:

```text
local
```

## Vibe Coding Settings

Use these values for the Responses endpoint and the image endpoints. The gateway no longer serves chat completions:

```text
API Base URL: http://127.0.0.1:8787/v1
API Key: local
Text model: gpt-5.4
Image model: gpt-image-2.5-sunburst
```

Use `GET /v1/models` to see the models available through the current local Codex cache.

## OpenClaw Settings

OpenClaw's OpenAI-compatible provider mode posts to `/chat/completions`, which this gateway no longer serves: `POST /v1/chat/completions` returns HTTP 410 `endpoint_retired`. There is no chat-completions provider mode that works against the current gateway.

Connect through the Responses surface instead:

```text
Responses API base URL: http://127.0.0.1:8787/v1
Responses endpoint: POST /v1/responses
Codex Responses passthrough base URL: http://127.0.0.1:8787/codex/v1
API Key: local
Model: gpt-5.4
Streaming: only on the Codex passthrough routes
```

`POST /v1/responses` accepts `model`, `input` (string or Responses-style input array), `instructions`, `tools` (flat Responses tool objects such as `{ "type": "function", "name": "get_weather", "description": "...", "parameters": { ... } }`), `tool_choice`, `text`, `store`, `parallel_tool_calls`, `include`, `reasoning`, and `experimental_codex`. It returns `output_text` plus the `output[]` message array, and `stream: true` on this route returns HTTP 501.

Requests from clients that send an OpenClaw user agent still appear in the management console request log when they hit a served route. The log keeps safe summaries only; it does not store full access tokens.

## Codex Custom Provider

Codex CLI/Desktop can route model traffic through AI Zero Token by using a custom Responses provider in `~/.codex/config.toml`. The management console Settings page can write this automatically with "接管 Codex 请求" after you choose the history mode first. The default `openai` mode keeps the native Codex history view; the `AI Zero Token` mode creates a separate provider/history bucket.

Default history-preserving mode:

```toml
model = "gpt-5.4"
model_provider = "openai"
openai_base_url = "http://127.0.0.1:8787/codex/v1"
```

Codex sends `POST /codex/v1/responses` with `Accept: text/event-stream`; the gateway forwards that request to the active Codex OAuth account and streams upstream Responses SSE events back to Codex. Newer Codex versions also call `POST /codex/v1/responses/compact` for remote context compaction, and the gateway forwards that compact stream through the same account pool. The regular `/v1/*` routes remain OpenAI-compatible API routes for non-Codex clients.

For Codex `image_generation` tool requests, Plus, Team, Pro, and other paid plans use the Codex Responses image tool. If `Free account image generation` is enabled in Settings, Free plans use the ChatGPT web image path and receive a synthetic Codex-compatible Responses SSE stream, because Free accounts may have ChatGPT image quota while the Codex `image_generation` tool is unavailable upstream.

Separate AI Zero Token provider mode:

```toml
model = "gpt-5.4"
model_provider = "ai-zero-token"

[model_providers.ai-zero-token]
name = "AI Zero Token"
base_url = "http://127.0.0.1:8787/codex/v1"
wire_api = "responses"
supports_websockets = false
```

## Models

```bash
curl http://127.0.0.1:8787/v1/models
```

## Local Usage Statistics

The management console reads persisted local usage statistics from:

```text
~/.ai-zero-token/.state/usage
```

Fetch the same summary through the admin endpoint:

```bash
curl http://127.0.0.1:8787/_gateway/admin/usage
```

The summary includes today, current-process, lifetime, daily trend, account, model, endpoint, error, image-route, and source breakdowns. Token totals are counted only when the upstream response returns `usage`; requests without upstream usage are counted separately as requests with missing usage. Usage files keep metadata only and do not store prompts, messages, access tokens, or base64 image payloads.

Sync the Codex model list from the Codex backend into the local cache:

```bash
azt models --refresh
```

## Responses API

```bash
curl http://127.0.0.1:8787/v1/responses \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-5.4",
    "input": "Reply with OK only."
  }'
```

## Chat Completions API (retired)

`POST /v1/chat/completions` was removed. The route is kept as a tombstone so former chat.completions clients get a clear pointer instead of a bare 404:

```bash
curl -i http://127.0.0.1:8787/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"gpt-5.4","messages":[{"role":"user","content":"Reply with OK only."}]}'
```

```json
{"error":{"type":"endpoint_retired","message":"chat.completions 接口已下线，请改用 /v1/responses（Codex 透传：/codex/v1/responses）。"}}
```

Use `POST /v1/responses` for text and `POST /v1/images/generations` / `POST /v1/images/edits` for images. The `messages`, `n`, `max_tokens`, and chat streaming fields are not part of the current API.

`stream: true` on `POST /v1/responses` returns HTTP 501 (streaming is not implemented on that route). Streamed Responses traffic is only served by the Codex passthrough routes:

```bash
curl -N http://127.0.0.1:8787/codex/v1/responses \
  -H "Content-Type: application/json" \
  -H "Accept: text/event-stream" \
  -d '{"model":"gpt-5.4","input":"Reply with OK only.","stream":true}'
```

Tool calls on `POST /v1/responses` use the flat Responses tool shape:

```bash
curl http://127.0.0.1:8787/v1/responses \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-5.4",
    "input": "What is the weather tool argument for Shanghai?",
    "tools": [
      {
        "type": "function",
        "name": "get_weather",
        "description": "Get weather for a city.",
        "parameters": {
          "type": "object",
          "properties": {
            "city": { "type": "string" }
          },
          "required": ["city"]
        }
      }
    ],
    "tool_choice": "auto"
  }'
```

## Images API

Image requests are also routed by account plan. Plus, Team, Pro, and other paid plans use the Codex Responses `image_generation` tool. Free accounts use the ChatGPT web image path only when `Free account image generation` is enabled in Settings; otherwise they keep the original Codex image-tool path.

Supported image models: `gpt-image-1`, `gpt-image-1-mini`, `gpt-image-1.5`, `gpt-image-2`, `gpt-image-2.5-sunburst` (default), `gpt-image-2.5-flare`. The optional `quality` field accepts `low`, `medium`, `high`, `xhigh`, `max`, or `auto`; the Codex image channel may report a different effective quality than the one requested.

```bash
curl http://127.0.0.1:8787/v1/images/generations \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-image-2.5-sunburst",
    "prompt": "A clean product poster on a white desk with a laptop and glass cup.",
    "size": "1024x1024",
    "quality": "low",
    "response_format": "b64_json"
  }'
```

JSON image edit with a reference image URL or base64 data URL:

```bash
curl http://127.0.0.1:8787/v1/images/edits \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-image-2.5-sunburst",
    "prompt": "Use this reference image and make it look like a clean product advertisement.",
    "images": [
      {
        "image_url": "data:image/png;base64,REPLACE_WITH_IMAGE_BASE64"
      }
    ],
    "size": "1024x1024",
    "quality": "low",
    "response_format": "b64_json"
  }'
```

## JavaScript SDK Example

```ts
import OpenAI from "openai";

const client = new OpenAI({
  apiKey: "local",
  baseURL: "http://127.0.0.1:8787/v1",
});

const response = await client.responses.create({
  model: "gpt-5.4",
  input: "Reply with OK only.",
});

console.log(response.output_text);
```

## Notes

- Login first through the management page or `azt login`.
- A model appearing in `/v1/models` means the local Codex cache lists it. Final availability still depends on the active account.
- `POST /v1/chat/completions` was removed and now returns HTTP 410 `endpoint_retired`; use `POST /v1/responses` for text or the image endpoints for images.
- `stream: true` is not supported on `/v1/responses` and returns HTTP 501. Codex passthrough streaming lives under `/codex/v1/responses` and `/codex/v1/responses/compact`.
- Tool/function calling is supported on `POST /v1/responses` with the flat Responses tool shape, but exact upstream behavior still depends on the active Codex model and account.
- The default listener is `0.0.0.0:8787`, so local-network clients can call the gateway by using the machine IP.
