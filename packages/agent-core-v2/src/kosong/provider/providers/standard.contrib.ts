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
  id: 'openai-codex',
  baseProtocol: 'openai_responses',
  traits: [
    {
      provides: () => ({ omitResponsesLiteHeaderWhenHostedSearch: true }),
      buildParams: shapeOpenAICodexResponsesLiteParams,
    },
  ],
  endpoint: { defaultBaseUrl: 'https://chatgpt.com/backend-api/codex' },
  hostHeaders: 'user-agent',
});

registerProviderDefinition({
  id: 'google-genai',
  baseProtocol: 'google-genai',
  traits: [
    { endpoint: () => ({ apiKeyEnv: 'VERTEXAI_API_KEY', baseUrlEnv: 'GOOGLE_VERTEX_BASE_URL' }) },
    { endpoint: () => ({ apiKeyEnv: 'GOOGLE_API_KEY', baseUrlEnv: 'GOOGLE_GEMINI_BASE_URL' }) },
  ],
});

function shapeOpenAICodexResponsesLiteParams(
  params: Record<string, unknown>,
): Record<string, unknown> {
  const tools = Array.isArray(params['tools']) ? params['tools'] : [];
  delete params['max_output_tokens'];
  delete params['max_completion_tokens'];
  if (tools.some(isHostedTool)) return params;

  const input = Array.isArray(params['input']) ? params['input'] : [];
  stripImageDetails(input);
  const additionalTools = tools.filter((tool) => !isHostedTool(tool));
  const prefix: unknown[] = [
    { type: 'additional_tools', role: 'developer', tools: additionalTools },
  ];
  const instructions = params['instructions'];
  if (typeof instructions === 'string' && instructions.length > 0) {
    prefix.push({
      type: 'message',
      role: 'developer',
      content: [{ type: 'input_text', text: instructions }],
    });
  }
  params['input'] = [...prefix, ...input];
  params['parallel_tool_calls'] = false;
  if (params['tool_choice'] !== 'none' && params['tool_choice'] !== 'required') {
    params['tool_choice'] = 'auto';
  }
  params['reasoning'] = { ...asRecord(params['reasoning']), context: 'all_turns' };
  delete params['instructions'];
  delete params['tools'];
  return params;
}

function isHostedTool(value: unknown): boolean {
  return asRecord(value)['type'] === 'web_search';
}

function stripImageDetails(input: unknown[]): void {
  for (const item of input) {
    const record = asRecord(item);
    for (const field of ['content', 'output']) {
      const parts = record[field];
      if (!Array.isArray(parts)) continue;
      for (const part of parts) {
        const partRecord = asRecord(part);
        if (partRecord['type'] === 'input_image') delete partRecord['detail'];
      }
    }
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

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
