/**
 * Shared prompt-section prose — the single source for the environment- and
 * tool-dependent prose blocks that appear in BOTH the builtin default prompt
 * and agent-file prompts:
 *
 * - `profile/default/system.md` renders them through the `KIMI_WINDOWS_NOTES`
 *   / `KIMI_ADDITIONAL_DIRS_SECTION_PROSE` / `KIMI_SKILLS_SECTION_PROSE`
 *   / `KIMI_TODO_LIST_SECTION` template variables injected by
 *   `resolve.ts#buildTemplateVars`;
 * - `profile/agentfile/from-file.ts` composes them into the agent-file
 *   `${windows_notes}` / `${additional_dirs_section}` / `${skills_section}`
 *   variables.
 *
 * Edit the text HERE only — the two render paths must never drift apart.
 */

export const WINDOWS_NOTES =
  'IMPORTANT: You are on Windows. The Bash tool runs through Git Bash, so use Unix shell syntax inside Bash commands — `/dev/null` not `NUL`, and forward slashes in paths. For file operations, always prefer the built-in tools (Read, Write, Edit, Glob, Grep) over Bash commands — they work reliably across all platforms.';

export const ADDITIONAL_DIRS_SECTION_PROSE =
  'The following directories have been added to the workspace. You can read, write, search, and glob files in these directories as part of your workspace scope.';

export const SKILLS_SECTION_PROSE =
  'Skills are reusable, composable capabilities that enhance your abilities. Each skill is either a self-contained directory with a `SKILL.md` file or a standalone `.md` file that contains instructions, examples, and/or reference material.\n\n' +
  'Identify the skills relevant to your current task and read the skill file for its instructions; only read further skill details when needed, to conserve the context window.\n\n' +
  '## Available skills\n\n' +
  'Skills are grouped by scope (`Project`, `User`, `Extra`, `Built-in`) so you can tell where each came from. When the user refers to "the skill in this project" or "the user-scope skill", use the scope heading to disambiguate. When multiple scopes define a skill with the same name, the more specific scope takes precedence: **Project overrides User overrides Extra overrides Built-in**.';

/**
 * TodoList planning obligation. Unlike the environment blocks above this is
 * gated on tool availability: it renders only when the profile's tool set
 * includes `TodoList` (the builtin `agent` and `coder` profiles do; the
 * read-only `explore` / `plan` profiles do not). The one-line write reminder
 * appended to every TodoList result (`todo-list.ts`) repeats the "done as
 * soon as finished" rule so the obligation stays fresh mid-session.
 */
export const TODO_LIST_SECTION_PROSE =
  'Use the `TodoList` tool to plan and track multi-step work: break the task into concrete items before starting, keep exactly one item `in_progress` at a time, and mark each item `done` immediately after finishing it — do not batch several completions at the end.';
