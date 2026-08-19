# @moonshot-ai/kimi-code-sdk

The TypeScript SDK for Kimi Code

Part of the [Kimi Code](https://github.com/MoonshotAI/kimi-code) monorepo.

See the main repository for documentation, issues, and contribution guidelines.

## OpenAI Responses models

The in-process harness can register the current GPT-5.6 family without writing
provider credentials to `config.toml`:

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

ChatGPT subscription authentication is available through the Codex OAuth flow:

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

The browser flow listens on `localhost:1455` for the OAuth callback. For a
headless host, pass `flow: 'device'` and display the supplied URL and user code.
Credentials are stored under the harness home directory and refreshed before
they expire. ChatGPT login uses the Codex Responses backend and does not require
`OPENAI_API_KEY`.

The built-in models are `gpt-5.6-sol`, `gpt-5.6-terra`, and
`gpt-5.6-luna`. They use the Responses API, default to medium reasoning, and
support the full off-to-max reasoning ladder. When `apiKey` or `baseUrl` is
omitted, the provider reads `OPENAI_API_KEY` or `OPENAI_BASE_URL` at runtime.

## License

MIT
