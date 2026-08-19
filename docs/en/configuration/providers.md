# Providers and models

Hasu CLI supports connecting to multiple LLM platforms simultaneously — OAuth login for Kimi Code and OpenAI ChatGPT, connecting Claude with an Anthropic API key, or connecting third-party inference services via the OpenAI-compatible protocol. Each provider corresponds to a specific API protocol; models are declared on top of providers with their own name, context length, and capabilities. This page explains how to configure each type of provider in `config.toml`.

## Supported provider types

The `type` field in the `providers` table determines which protocol implementation to use:

| Type | Protocol | Typical use |
| --- | --- | --- |
| `kimi` | OpenAI-compatible | Kimi Code managed service, Kimi Platform API key |
| `anthropic` | Anthropic Messages | Claude model family |
| `openai` | OpenAI Chat Completions | OpenAI and compatible services, DeepSeek, Qwen, etc. |
| `openai_responses` | OpenAI Responses API | OpenAI's newer Responses interface |
| `openai-codex` | Codex Responses | ChatGPT subscription through OAuth |
| `google-genai` | Google GenAI | Gemini API |
| `vertexai` | Google GenAI on Vertex | Google Cloud Vertex AI |

All providers communicate with models in streaming mode by default. Capabilities such as thinking, vision, and tool use are matched automatically by model name prefix — you typically do not need to declare them manually.

**Credential priority**: `api_key` direct field > `[providers.<name>.env]` sub-table key > if both are absent, startup fails with an error. The CLI does not fall back to shell environment variables for credentials — see [Config overrides: provider credentials](./overrides.md#provider-credentials).

## `/provider` — interactive provider management

Prefer not to edit TOML by hand? Type `/provider` in the TUI to open the **provider manager**, where you can interactively add or remove providers.

The manager displays providers as a list of entries grouped by source. Navigation:

- ↑/↓ to move the cursor, ←/→ to page
- `d` to delete the current provider (with `[y/N]` confirmation)
- Press Enter on the `[ Add New Platform ]` row to add a new provider

Two paths when adding:

- **Known third-party provider**: fetches the model catalog from [models.dev](https://models.dev/), select a provider → enter an API key → select a default model. Vendors whose protocol the catalog does not declare (e.g. xai, openrouter, and other vendor-specific SDKs) are imported as OpenAI-compatible with a "guessed" note; when the catalog provides no usable endpoint, a base URL prompt appears first; proprietary protocols (Amazon Bedrock, Cohere) and unrecognized explicit protocols are refused. Deprecated and alpha-status models are excluded from the import list. If the public catalog is unreachable, the CLI falls back to a built-in snapshot of the catalog, so the import still works offline or in blocked networks
- **Custom registry (api.json)**: paste a custom registry URL and Bearer token; the CLI automatically creates the `providers` / `models` entries. On later startup, providers from the same registry URL are refreshed together, so upstream provider additions, removals, and model metadata changes are synced.

::: warning
Kimi Code and OpenAI ChatGPT OAuth accounts do not appear in `/provider`. Use `/login` and `/logout` to manage them.
:::

The same operations are also available in non-interactive environments via the shell command: [`hasu provider`](../reference/kimi-command.md#hasu-provider).

## `kimi`

For connecting to Moonshot AI's OpenAI-compatible interface, including the Kimi Code managed service and Kimi Platform API keys.

- Default `base_url`: `https://api.moonshot.ai/v1`
- Credential key names: `KIMI_API_KEY`, `KIMI_BASE_URL`
- Additional capability: supports video upload

```toml
[providers.kimi]
type = "kimi"
base_url = "https://api.moonshot.ai/v1"
api_key = "sk-xxxxx"
```

> When using the Kimi Code managed service, running `/login` automatically configures `base_url` and credentials — no manual setup needed.

## `anthropic`

For connecting to the Claude API. Standard Claude models automatically enable vision, tool use, and Thinking (where supported); custom or uncovered models need `capabilities` declared explicitly on `[models.<alias>]`.

- Default `base_url`: follows Anthropic SDK default
- Credential key names: `ANTHROPIC_API_KEY`, `ANTHROPIC_BASE_URL`
- Default `max_tokens`: inferred per model. To override, set `max_output_size` on the model alias

```toml
[providers.anthropic]
type = "anthropic"
api_key = "sk-ant-xxxxx"

[models."claude-opus-4-7"]
provider = "anthropic"
model = "claude-opus-4-7"
max_context_size = 200000
# max_output_size = 32000  # optional; omit to use the model-inferred default
```

## `openai`

For connecting to the OpenAI Chat Completions protocol, as well as any third-party service compatible with that protocol (override `base_url` as needed).

Third-party reasoning models (DeepSeek, Qwen, One API, etc.) work out of the box: the CLI automatically handles the `reasoning_content` field and `reasoning_effort` injection. If your gateway returns reasoning content under a non-standard field name, set `reasoning_key` on the model alias to override.

- Default `base_url`: `https://api.openai.com/v1`
- Credential key names: `OPENAI_API_KEY`, `OPENAI_BASE_URL`

```toml
[providers.openai]
type = "openai"
base_url = "https://api.openai.com/v1"
api_key = "sk-xxxxx"
```

## `openai_responses`

Corresponds to OpenAI's newer Responses API, always operating in streaming mode. Configuration is the same as `openai`.

- Default `base_url`: `https://api.openai.com/v1`
- Credential key names: `OPENAI_API_KEY`, `OPENAI_BASE_URL`

```toml
[providers.openai-responses]
type = "openai_responses"
base_url = "https://api.openai.com/v1"
api_key = "sk-xxxxx"
```

## `openai-codex`

Run `/login`, select **OpenAI ChatGPT OAuth**, and complete the browser
authorization. Before opening the browser, the CLI copies the full
authorization URL to the clipboard so you can paste it manually if needed. The
CLI listens on `localhost:1455` for the OAuth callback. After authentication
succeeds, choose a built-in GPT-5.6 model. The CLI writes all built-in OpenAI
models to `config.toml`, makes the selected model the default, stores the OAuth
credential under the Hasu home directory, and refreshes access tokens
automatically. The models then appear under the **OpenAI ChatGPT** tab in
`/model`. Run `/logout` and select **OpenAI ChatGPT** to remove both the
credential and the provider configuration.

This login path uses a ChatGPT subscription with the Codex Responses backend.
It does not use `OPENAI_API_KEY`; OpenAI Platform API-key billing remains a
separate authentication path.

### In-process harness

The TypeScript harness has a runtime-only OpenAI entry that does not persist
the API key to `config.toml`:

```ts
import { createKimiHarness } from '@moonshot-ai/kimi-code-sdk';

const harness = createKimiHarness({
  openai: {
    apiKey: process.env.OPENAI_API_KEY,
    defaultModel: 'gpt-5.6-terra',
  },
});

const session = await harness.createSession({ workDir: process.cwd() });
```

The harness also supports signing in with a ChatGPT subscription through the
Codex OAuth flow:

```ts
const harness = createKimiHarness({
  openai: {
    authentication: 'chatgpt',
    defaultModel: 'gpt-5.6-sol',
  },
});

await harness.auth.loginOpenAI({
  onAuthorization: ({ url }) => {
    console.log(`Open this URL to sign in: ${url}`);
  },
});

const session = await harness.createSession({ workDir: process.cwd() });
```

The browser flow listens on `localhost:1455` for the OAuth callback. On a
headless host, use `flow: 'device'` and show the supplied URL and user code.
The harness stores the credential under its home directory and refreshes it
automatically. This mode uses the ChatGPT subscription and Codex Responses
backend, so `OPENAI_API_KEY` is not required. OpenAI Platform API-key usage and
ChatGPT subscription usage remain separate authentication choices.

The built-in entries are `gpt-5.6-sol`, `gpt-5.6-terra`, and
`gpt-5.6-luna`. All three use the Responses API with a 1,050,000-token context
window, a 128,000-token output limit, image input, function tools, and reasoning
levels from off through max. The default is `gpt-5.6-sol`. Omitted credentials
and endpoints fall back to `OPENAI_API_KEY` and `OPENAI_BASE_URL`.

## `google-genai`

For connecting directly to the Google Gemini API. Thinking, vision, and multimodal capabilities are auto-detected by model name.

- Credential key name: `GOOGLE_API_KEY`

```toml
[providers.gemini]
type = "google-genai"
api_key = "xxxxx"
```

To route through a Gemini-compatible proxy or gateway, set `base_url` (or the `GOOGLE_GEMINI_BASE_URL` env var); when omitted, the SDK default `https://generativelanguage.googleapis.com` is used.

> Give the **host root only**. The Google GenAI SDK appends the API version and path itself (e.g. `/v1beta/models/<model>:generateContent`), so a trailing `/v1beta` would produce a doubled `/v1beta/v1beta/…`.

```toml
[providers.gemini]
type = "google-genai"
api_key = "xxxxx"
base_url = "https://your-gateway.example"
```

## `vertexai`

Shares the same implementation as `google-genai`; setting `type = "vertexai"` switches to the Vertex AI access path.

Authentication follows the standard Google Cloud ADC flow (`gcloud auth application-default login` or a `GOOGLE_APPLICATION_CREDENTIALS` service account JSON) — this part is unrelated to Hasu. **The project ID and region must be written in the `[providers.vertexai.env]` sub-table** — simply `export GOOGLE_CLOUD_PROJECT` in the shell will not be read by the CLI.

```toml
[providers.vertexai]
type = "vertexai"

[providers.vertexai.env]
GOOGLE_CLOUD_PROJECT = "my-gcp-project"
GOOGLE_CLOUD_LOCATION = "us-central1"
```

```sh
gcloud auth application-default login   # one-time authentication
hasu
```

To route Vertex requests through a custom (e.g. proxied) endpoint, set `base_url` (or the `GOOGLE_VERTEX_BASE_URL` env var); when omitted, the SDK default regional `*-aiplatform.googleapis.com` host is used. As with `google-genai`, give the host root only — the SDK appends `/v1beta1/publishers/google/models/…` itself.

## OAuth and credential injection

Kimi Code and OpenAI ChatGPT support OAuth login. After running `/login`, the built-in authentication toolchain writes and refreshes credentials automatically. The OpenAI entry also writes its selected model and provider to `config.toml`.

## Next steps

- [Configuration files](./config-files.md) — full field reference for the `providers` and `models` tables
- [Config overrides](./overrides.md) — credential resolution priority rules for providers
- [Environment variables](./env-vars.md) — credential key names per provider type
