/**
 * `kosong/provider` system-prompt boundary helpers.
 *
 * Provider adapters use the marker to separate or remove the runtime prompt
 * boundary without depending on the agent-profile application domain.
 */

export const SYSTEM_PROMPT_DYNAMIC_BOUNDARY = '__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__';

export function splitSystemPromptAtBoundary(systemPrompt: string): {
  readonly staticText: string;
  readonly dynamicText: string;
} {
  const idx = systemPrompt.indexOf(SYSTEM_PROMPT_DYNAMIC_BOUNDARY);
  if (idx < 0) return { staticText: systemPrompt, dynamicText: '' };
  return {
    staticText: systemPrompt.slice(0, idx).trimEnd(),
    dynamicText: systemPrompt.slice(idx + SYSTEM_PROMPT_DYNAMIC_BOUNDARY.length).trimStart(),
  };
}

export function stripSystemPromptBoundary(systemPrompt: string): string {
  const { staticText, dynamicText } = splitSystemPromptAtBoundary(systemPrompt);
  return dynamicText.length === 0 ? staticText : `${staticText}\n\n${dynamicText}`;
}
