/**
 * `ultracode` domain — pure keyword detection for the Ultracode trigger.
 *
 * Mirrors Claude Code's `f4o` matching: the `chesto!` token only fires when it
 * appears as a bare word in natural language. Fenced code blocks, inline code,
 * shell-command lines and quoted strings are stripped first so a token inside
 * code or a command never opts a turn in.
 */

import type { ContentPart } from '#/kosong/contract/message';

/** Join the text parts of a user prompt into a single searchable string. */
export function userPromptText(content: readonly ContentPart[]): string {
  return content
    .filter((part): part is Extract<ContentPart, { type: 'text' }> => part.type === 'text')
    .map((part) => part.text)
    .join('\n');
}

/** Whether natural-language text contains the bare `chesto!` keyword. */
export function containsUltracodeToken(text: string): boolean {
  if (text.length === 0) return false;
  if (text.startsWith('/')) return false;
  const stripped = text
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('/'))
    .join('\n')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`[^`]*`/g, ' ')
    .replace(/"[^"]*"|'[^']*'/g, ' ');
  // `\b` guards the head so "xchesto!" never matches; the literal `!` means
  // a bare "chesto" (no bang) does not trigger the mode either.
  return /\bchesto!/i.test(stripped);
}
