/**
 * `/workflows` — render the workflow run tree from the TUI's live progress
 * ledger (`appState.workflowRuns`, folded from the engine's `workflow.progress`
 * wire events by `utils/workflow-model.ts`).
 *
 * Each run renders as a tree: a top-line run summary + progress, the declared
 * `meta.phases` matched to the subagents that reported each phase, per-agent
 * label/status/model/tokens/duration rows, narrator `log()` lines, and the
 * terminal error for failed runs. Running runs show an animated braille
 * progress meter (the official client renders the same 4-cell meter for a
 * running workflow) and a live elapsed clock; the command re-renders the panel
 * on a slow tick while any run is still going, so the animation and clock
 * advance without further engine events.
 *
 * `buildWorkflowReportLines` is a pure line builder so it can be unit-tested;
 * the command wraps it in the standard bordered panel (the same
 * `UsagePanelComponent` `/usage` and `/status` use).
 *
 * `/workflows` shows every run the TUI has observed (newest first);
 * `/workflows <runId>` focuses a single run.
 */

import { formatDuration } from '@moonshot-ai/kimi-code-oauth';

import { UsagePanelComponent } from '../components/messages/usage-panel';
import { FAILURE_MARK, STATUS_BULLET, SUCCESS_MARK } from '../constant/symbols';
import { currentTheme } from '#/tui/theme';
import type {
  WorkflowRunAgentView,
  WorkflowRunView,
  WorkflowRunViewPhase,
  WorkflowRunsViewState,
} from '#/tui/utils/workflow-model';
import type { SlashCommandHost } from './dispatch';

const EMPTY_RUNS_MESSAGE = '  No workflow runs recorded this session yet.';

/** Width (cells) of the animated braille progress meter. */
const PROGRESS_METER_CELLS = 4;
/** Full cell of the progress meter (braille "all dots" reads as a block). */
const METER_FULL_CELL = '⣿';
/** Braille spinner frames for the meter's leading cell (official spinner set). */
const METER_SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'] as const;
/** Tick interval (ms) for the live re-render while any run is still running. */
const LIVE_TICK_MS = 160;

export async function handleWorkflowsCommand(
  host: SlashCommandHost,
  args: string,
): Promise<void> {
  const runs = host.state.appState.workflowRuns;
  const focusRunId = args.trim();

  let focused: WorkflowRunView | undefined;
  if (focusRunId.length > 0) {
    focused = runs.find((run) => run.runId === focusRunId);
    if (focused === undefined) {
      host.showError(`No workflow run found: ${focusRunId}`);
      return;
    }
  }

  const visible = focused !== undefined ? [focused] : runs;
  const title =
    focused !== undefined ? ` Workflow ${focused.runId} ` : ` Workflows (${runs.length}) `;
  // The builder re-reads the ledger at build time so both engine events (via
  // the tick) and the animation tick itself paint the newest state.
  const readVisible = (): WorkflowRunsViewState =>
    focused !== undefined
      ? host.state.appState.workflowRuns.filter((run) => run.runId === focused.runId)
      : host.state.appState.workflowRuns;
  const panel = new UsagePanelComponent(
    () => buildWorkflowReportLines(readVisible()),
    'primary',
    title,
  );
  host.state.transcriptContainer.addChild(panel);
  host.state.ui.requestRender();

  // Live animation: while any visible run is still running, re-render the
  // panel on a slow tick so the braille meter spins and the elapsed clock
  // advances even when no new engine events arrive. The tick stops itself as
  // soon as every visible run settles.
  if (visible.some((run) => run.status === 'running')) {
    let ticks = 0;
    const timer = setInterval(() => {
      ticks += 1;
      const stillRunning = readVisible().some((run) => run.status === 'running');
      if (!stillRunning || ticks > 2400) {
        clearInterval(timer);
      }
      panel.invalidate();
      host.state.ui.requestRender();
    }, LIVE_TICK_MS);
    timer.unref?.();
  }
}

/**
 * Build the colourised report lines for a set of workflow runs (newest first).
 * Pure in the sense that it depends only on its arguments plus the theme
 * singleton, which is read at call time (so a theme switch repaints via the
 * panel's `invalidate`).
 */
export function buildWorkflowReportLines(runs: WorkflowRunsViewState): string[] {
  if (runs.length === 0) {
    return [currentTheme.fg('textDim', EMPTY_RUNS_MESSAGE)];
  }
  const lines: string[] = [];
  for (let i = 0; i < runs.length; i++) {
    const run = runs[i];
    if (run === undefined) continue;
    if (i > 0) lines.push('');
    lines.push(...buildRunBlock(run));
  }
  return lines;
}

// ---------------------------------------------------------------------------
// Run block renderer
// ---------------------------------------------------------------------------

/** One agent group: a phase header (declared or ad-hoc) with its agents. */
interface WorkflowAgentGroup {
  readonly title: string;
  readonly agents: readonly WorkflowRunAgentView[];
}

function buildRunBlock(run: WorkflowRunView): string[] {
  const accent = (text: string): string => currentTheme.boldFg('primary', text);
  const muted = (text: string): string => currentTheme.fg('textDim', text);
  const dim = (text: string): string => currentTheme.fg('textMuted', text);
  const error = (text: string): string => currentTheme.fg('error', text);

  const lines: string[] = [];
  const stats: string[] = [`${run.completedAgents}/${run.spawnedAgents} agents`];
  if (run.phase !== undefined && run.phase.length > 0) stats.push(`phase: ${run.phase}`);
  const tokens = runTokens(run);
  if (tokens > 0) stats.push(`${formatTokenCount(tokens)} tok`);
  const elapsed = runElapsedMs(run);
  if (elapsed !== undefined) stats.push(formatDuration(elapsed));

  // Top-line run summary + animated meter + stats.
  const meter = run.status === 'running' ? ` ${progressMeter(run)}` : '';
  lines.push(`  ${accent(run.name.length > 0 ? run.name : run.runId)}${meter}  ${runStatusBadge(run)}  ${dim(run.runId)}`);
  lines.push(`  ${muted(stats.join(' · '))}`);
  if (run.description.length > 0) {
    lines.push(`  ${muted(run.description)}`);
  }

  // Declared phases matched to their agent groups, then ad-hoc phases.
  for (const group of groupAgentsByPhase(run)) {
    lines.push('');
    lines.push(`  ${muted('──')}  ${accent(group.title)}`);
    for (const agent of group.agents) {
      lines.push(renderAgentLine(agent));
    }
  }

  // Narrator log() lines, folded live from `workflow.log` events.
  for (const line of run.logLines) {
    lines.push(`  ${dim('·')}  ${dim(line)}`);
  }

  if (run.error !== undefined && run.error.length > 0) {
    lines.push('');
    lines.push(`  ${error(FAILURE_MARK.trimEnd())}  ${error(run.error)}`);
  }
  return lines;
}

/**
 * The animated 4-cell braille progress meter shown next to a running run:
 * `round(done/total * 4)` solid cells, one spinning leading cell while agents
 * are in flight, and dim empty cells for the remainder — the same meter the
 * official client renders for a running workflow.
 */
function progressMeter(run: WorkflowRunView): string {
  const total = run.spawnedAgents;
  const done = run.completedAgents;
  const running = done < total;
  const filled = total > 0 ? Math.round((done / total) * PROGRESS_METER_CELLS) : 0;
  const solidCells = Math.min(running ? PROGRESS_METER_CELLS - 1 : PROGRESS_METER_CELLS, Math.max(0, filled));
  const spinnerCells = running ? Math.min(PROGRESS_METER_CELLS - solidCells, 1) : 0;
  const emptyCells = PROGRESS_METER_CELLS - solidCells - spinnerCells;

  const frame = METER_SPINNER_FRAMES[Math.floor(Date.now() / LIVE_TICK_MS) % METER_SPINNER_FRAMES.length] ?? '⠋';
  const parts: string[] = [];
  if (solidCells > 0) parts.push(currentTheme.fg('success', METER_FULL_CELL.repeat(solidCells)));
  if (spinnerCells > 0) parts.push(currentTheme.fg('success', frame));
  if (emptyCells > 0) parts.push(currentTheme.fg('textMuted', METER_FULL_CELL.repeat(emptyCells)));
  return parts.join('');
}

/** Total tokens reported by the run's agent completions (0 when unreported). */
function runTokens(run: WorkflowRunView): number {
  if (run.tokensSpent !== undefined) return run.tokensSpent;
  let total = 0;
  for (const agent of run.agents) {
    total += agent.tokens ?? 0;
  }
  return total;
}

/** Run wall-clock so far: terminal duration, or live elapsed while running. */
function runElapsedMs(run: WorkflowRunView): number | undefined {
  if (run.durationMs !== undefined) return run.durationMs;
  if (run.status !== 'running') return undefined;
  const started = Date.parse(run.startedAt);
  if (Number.isNaN(started)) return undefined;
  return Math.max(0, Date.now() - started);
}

/** Compact token count: `1.2k` below a million, `1.2m` above. */
function formatTokenCount(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}m`;
  if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(1)}k`;
  return String(tokens);
}

/**
 * Group a run's agents by phase, matching agent `phase` labels to the declared
 * `meta.phases` (in declared order) and falling back to ad-hoc phase headers
 * for agent phases that are not declared. Agents without a phase share the
 * generic `Agents` group.
 */
function groupAgentsByPhase(run: WorkflowRunView): readonly WorkflowAgentGroup[] {
  const declaredTitles = new Set<string>(run.phases.map((phase) => phase.title));
  const byPhase = new Map<string, WorkflowRunAgentView[]>();
  const unphased: WorkflowRunAgentView[] = [];
  for (const agent of run.agents) {
    const phase = agent.phase;
    if (phase === undefined || phase.length === 0) {
      unphased.push(agent);
      continue;
    }
    const list = byPhase.get(phase) ?? [];
    list.push(agent);
    byPhase.set(phase, list);
  }

  const groups: WorkflowAgentGroup[] = [];
  for (const phase of run.phases) {
    const agents = byPhase.get(phase.title);
    if (agents !== undefined && agents.length > 0) {
      groups.push({ title: phaseTitle(phase), agents });
    }
  }
  for (const [phase, agents] of byPhase) {
    if (!declaredTitles.has(phase)) {
      groups.push({ title: phase, agents });
    }
  }
  if (unphased.length > 0) {
    groups.push({ title: 'Agents', agents: unphased });
  }
  return groups;
}

function phaseTitle(phase: WorkflowRunViewPhase): string {
  return phase.detail !== undefined && phase.detail.length > 0
    ? `${phase.title} · ${phase.detail}`
    : phase.title;
}

function renderAgentLine(agent: WorkflowRunAgentView): string {
  const mark = agentStatusMark(agent);
  const label = agent.label ?? agent.agentId;
  const facts: string[] = [];
  if (agent.model !== undefined && agent.model.length > 0) facts.push(agent.model);
  if (agent.tokens !== undefined && agent.tokens > 0) facts.push(`${formatTokenCount(agent.tokens)} tok`);
  if (agent.durationMs !== undefined) facts.push(formatDuration(agent.durationMs));
  const factText = facts.length > 0 ? currentTheme.fg('textDim', facts.join(' · ')) : '';
  const summary =
    agent.summary !== undefined && agent.summary.length > 0
      ? currentTheme.fg('textDim', agent.summary)
      : '';
  return [`    ${mark} ${label}`, factText, summary].filter((part) => part.length > 0).join('  ');
}

function agentStatusMark(agent: WorkflowRunAgentView): string {
  switch (agent.status) {
    case 'completed':
      return currentTheme.fg('success', SUCCESS_MARK.trimEnd());
    case 'failed':
      return currentTheme.fg('error', FAILURE_MARK.trimEnd());
    case 'aborted':
      return currentTheme.fg('textDim', '·');
    default:
      return currentTheme.fg('primary', STATUS_BULLET.trimEnd());
  }
}

function runStatusBadge(run: WorkflowRunView): string {
  switch (run.status) {
    case 'completed':
      return currentTheme.fg('success', 'completed');
    case 'failed':
      return currentTheme.fg('error', 'failed');
    default:
      return currentTheme.fg('primary', 'running');
  }
}
