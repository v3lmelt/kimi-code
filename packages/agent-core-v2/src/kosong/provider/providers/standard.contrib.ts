/**
 * ⚠ PHASE 4 GAP PATCH — additive lower-layer fill-in, clearly marked.
 *
 * `kosong/provider` domain — side-effect module: endpoint-only provider
 * definitions for the four canonical vendors.
 *
 * Only the Kimi vendor definition existed before, so endpoint resolution
 * answered for `kimi` alone and the legacy config-env-bag fallbacks
 * (`[providers.x.env] OPENAI_API_KEY=…` etc.) had no registry home. Endpoint
 * resolution now goes through the definition registry — hardcoded
 * per-protocol env tables are abolished — so the four canonical vendors each
 * need a definition that declares their env chain. These declarations change
 * nothing else: each vendor's `baseProtocol` equals its protocol id and
 * (Google GenAI aside, see below) the trait list is empty, so adapter
 * identity, hook composition, and capability resolution are exactly as they
 * were for an unregistered vendor.
 *
 * No `defaultBaseUrl` is declared: construction-time defaults stay where they
 * always were (inside the bases / their SDKs), matching the legacy env-only
 * fallback semantics precisely.
 *
 * Google GenAI is the one definition with non-empty traits: Vertex AI is a
 * `providerOptions` mode of the `google-genai` base rather than a vendor of
 * its own, and two one-line endpoint traits keep the legacy vertex chain
 * precedence — `VERTEXAI_API_KEY` / `GOOGLE_VERTEX_BASE_URL` first,
 * `GOOGLE_API_KEY` / `GOOGLE_GEMINI_BASE_URL` as fallback — while plain
 * Gemini users without the vertex envs see exactly the old behavior.
 *
 * Like every contrib, this module is imported for effect only.
 */

import { registerProviderDefinition } from '../providerDefinition';

registerProviderDefinition({
  id: 'anthropic',
  baseProtocol: 'anthropic',
  traits: [],
  endpoint: { apiKeyEnv: 'ANTHROPIC_API_KEY', baseUrlEnv: 'ANTHROPIC_BASE_URL' },
});

registerProviderDefinition({
  id: 'openai',
  baseProtocol: 'openai',
  traits: [],
  endpoint: { apiKeyEnv: 'OPENAI_API_KEY', baseUrlEnv: 'OPENAI_BASE_URL' },
});

registerProviderDefinition({
  id: 'openai_responses',
  baseProtocol: 'openai_responses',
  traits: [],
  endpoint: { apiKeyEnv: 'OPENAI_API_KEY', baseUrlEnv: 'OPENAI_BASE_URL' },
});

registerProviderDefinition({
  id: 'google-genai',
  baseProtocol: 'google-genai',
  traits: [
    { endpoint: () => ({ apiKeyEnv: 'VERTEXAI_API_KEY', baseUrlEnv: 'GOOGLE_VERTEX_BASE_URL' }) },
    { endpoint: () => ({ apiKeyEnv: 'GOOGLE_API_KEY', baseUrlEnv: 'GOOGLE_GEMINI_BASE_URL' }) },
  ],
});

// OpenCode Go — an endpoint-only definition so the OPENCODE_GO_API_KEY env
// chain resolves (id-level queries read this one). Models route to their wire
// via the per-alias `protocol` override; the unregistered protocols fall back
// to their base defaults, which is what this gateway needs.
//
// The gateway rejects assistant messages that carry neither `content` nor
// `tool_calls` (a turn interrupted mid-reasoning then resumed leaves a
// think-only assistant whose think is pulled into `reasoning_content`), so a
// `convertMessage` trait drops exactly those — mirroring the kimi trait
// pattern and keeping every other message untouched.
registerProviderDefinition({
  id: 'opencode-go',
  baseProtocol: 'openai',
  traits: [
    {
      convertMessage: (message, converted) => {
        if (
          message.role === 'assistant' &&
          converted['content'] === undefined &&
          converted['tool_calls'] === undefined
        ) {
          return null;
        }
        return converted;
      },
    },
  ],
  endpoint: { apiKeyEnv: 'OPENCODE_GO_API_KEY', baseUrlEnv: 'OPENCODE_GO_BASE_URL' },
});
