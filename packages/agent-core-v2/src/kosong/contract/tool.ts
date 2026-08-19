/**
 * `kosong/contract` domain — the provider-agnostic tool definition.
 *
 * A tool that the model may invoke during generation. The definition is
 * provider-agnostic; each provider implementation converts it to the
 * appropriate wire format (e.g. OpenAI function-calling, Anthropic tool-use,
 * Google function declarations).
 */

export interface Tool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  /**
   * Internal progressive-disclosure marker (a dynamically-loadable tool that
   * is not yet loaded). Never a provider-visible field: the model schema is
   * projected centrally through the toolSelect domain's `toModelToolSchema`
   * allowlist (name/description/parameters only), and `generate()` strips
   * `deferred` tools before the wire. Kept on the contract for backward
   * compatibility with existing strip points.
   */
  deferred?: true;
  /** MCP tool annotations passed through from `tools/list` (e.g. readOnlyHint). */
  annotations?: { readonly readOnlyHint?: boolean };
}
