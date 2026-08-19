import { ChatProviderError } from '#/kosong/contract/errors';

/**
 * Parse a tool-call `arguments` JSON string into a plain object, caching the
 * parse result keyed on the exact string.
 *
 * Tool-call arguments strings are byte-stable within a session: the same
 * historical tool call is re-converted on every request, so without a cache
 * each turn re-parses the full history's argument JSON (30-turn sessions run
 * 60+ parses per turn). The cache is bounded (512 entries, cleared when full)
 * and never caches failures — a failed parse re-runs with the exact same
 * error semantics as the un-cached path.
 *
 * The cached object is shared across requests, so callers receive a shallow
 * copy: the SDKs that consume it serialize read-only, and the copy protects
 * the cache from top-level mutation. Nested objects are shared between the
 * cache and the returned value — callers must treat the returned object as
 * read-only, exactly as the pre-cache path's freshly-parsed result was
 * consumed (the parse result was never mutated at any call site).
 *
 * Error contract (identical to the original inline parse):
 * - syntactically invalid JSON -> `ChatProviderError('Tool call arguments must be valid JSON.')`
 * - valid JSON that is not a plain object (array / scalar / null) ->
 *   `ChatProviderError('Tool call arguments must be a JSON object.')`
 */
const TOOL_ARGUMENTS_CACHE_MAX = 512;
const toolArgumentsCache = new Map<string, Record<string, unknown>>();

export function parseToolCallArguments(argumentsJson: string): Record<string, unknown> {
  const cached = toolArgumentsCache.get(argumentsJson);
  if (cached !== undefined) {
    return { ...cached };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(argumentsJson);
  } catch {
    throw new ChatProviderError('Tool call arguments must be valid JSON.');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new ChatProviderError('Tool call arguments must be a JSON object.');
  }
  const record = parsed as Record<string, unknown>;
  if (toolArgumentsCache.size >= TOOL_ARGUMENTS_CACHE_MAX) {
    toolArgumentsCache.clear();
  }
  toolArgumentsCache.set(argumentsJson, record);
  return { ...record };
}
