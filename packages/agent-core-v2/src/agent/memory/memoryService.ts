/**
 * `memory` domain — `IMemoryService` implementation.
 *
 * Reads/writes a `MEMORY.md` file under the brand home (`~/.kimi-code/memory/`,
 * or a `[memory] dir` override) containing one `## Session <id> · <date>`
 * section per session. The file is bound to a scope at construction time:
 * `'user'` (default) keeps the single shared file; `'project'` keys the file
 * per working directory under `<memoryDir>/projects/<projectKey>/MEMORY.md`,
 * where `projectKey` is derived from the cwd via `encodeWorkDirKey`. The whole
 * file feeds system-prompt injection
 * (`loadMemoryText`); the current session's section feeds memory-first
 * compaction (`loadCompactionSummary`). Background extraction triggers on
 * `turn.ended`, is gated by time / turn-count double gates plus loop idleness,
 * and runs an `llmRequester` operation request (read-only tool whitelist, no
 * turn blocked) that distills the messages since the last boundary into a new
 * section. The boundary (message index + timestamps) is registered into
 * `agentState` so it snapshots/restores with the agent. A full context clear
 * resets the boundary. Bound at Agent scope.
 */

import { Disposable } from '#/_base/di/lifecycle';
import { IInstantiationService } from '#/_base/di/instantiation';
import { LifecycleScope } from '#/app/scopes';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { defineState } from '#/_base/state/stateRegistry';
import { renderPrompt } from '#/_base/utils/render-prompt';
import { IConfigService } from '#/app/config/config';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { IEventBus } from '#/app/event/eventBus';
import { IHostFileSystem } from '#/os/interface/hostFileSystem';
import { IHostEnvironment } from '#/os/interface/hostEnvironment';
import { ISessionContext } from '#/session/sessionContext/sessionContext';
import { IAgentContextMemoryService } from '#/agent/contextMemory/contextMemory';
import type { ContextMessage } from '#/agent/contextMemory/types';
import { IAgentLLMRequesterService, type AgentLLMRequestFinish } from '#/agent/llmRequester/llmRequester';
import { IAgentLoopService } from '#/agent/loop/loop';
import { IAgentStateService } from '#/agent/state/agentState';
import { IAgentTokenCountingService } from '#/agent/tokenCounting/tokenCounting';
import { IAgentToolRegistryService } from '#/agent/toolRegistry/toolRegistry';
import { IAgentToolSelectService } from '#/agent/toolSelect/toolSelect';
import { ILogService } from '#/_base/log/log';
import { createUserMessage, isToolDeclarationOnlyMessage, type Message } from '#/kosong/contract/message';
import type { Tool } from '#/kosong/contract/tool';
import { isAbortError } from '#/_base/utils/abort';
import { encodeWorkDirKey } from '#/_base/utils/workdir-slug';
import { dirname, join } from 'pathe';

import { DEFAULT_MEMORY_SCOPE, IMemoryService, MEMORY_FILE_NAME, MEMORY_SECTION_HEADING, type MemoryScope } from './memory';
import { MEMORY_SECTION, type MemoryConfig } from './configSection';
import memoryExtractionPromptTemplate from './extraction-prompt.md?raw';

const DEFAULT_EXTRACT_MIN_INTERVAL_MS = 10 * 60 * 1000;
const DEFAULT_EXTRACT_MIN_TURNS = 3;
const DEFAULT_MEMORY_MAX_BYTES = 64 * 1024;
const DEFAULT_COMPACT_SUMMARY_MAX_CHARS = 6_000;
const MIN_COMPACTION_SUMMARY_CHARS = 80;
const EXTRACTION_MAX_SEGMENT_TOKENS = 30_000;
const EXTRACTION_MAX_OUTPUT_TOKENS = 4_096;
const EXTRACTION_DISTILL_INSTRUCTION =
  'Distill the memory notes from the conversation excerpt above, following the system instructions.';

/** Read-only tool whitelist for the extraction request: the extraction model
 *  only ever sees schemas for read-only tools. Tools are never executed. */
const EXTRACTION_READONLY_TOOLS = new Set(['Read', 'Glob', 'Grep']);

const EMPTY_TOOL_PARAMETERS: Record<string, unknown> = { type: 'object', properties: {} };

export const memoryLastExtractedMessageIndexKey = defineState<number>(
  'memory.lastExtractedMessageIndex',
  () => 0,
);
export const memoryLastExtractedAtKey = defineState<number>('memory.lastExtractedAt', () => 0);
export const memoryTurnsSinceExtractionKey = defineState<number>(
  'memory.turnsSinceExtraction',
  () => 0,
);

interface MemorySection {
  readonly sessionId: string;
  readonly date: string;
  readonly body: string;
}

// NOTE: stays Disposable — `Service` owns `config`/`get` members that collide
export class AgentMemoryService extends Disposable implements IMemoryService {
  declare readonly _serviceBrand: undefined;

  private _extractionRunning = false;
  private _extractionController: AbortController | undefined;
  private loopService: IAgentLoopService | undefined;
  // Bound by the profile binder (`AgentProfileService`), never by this
  // service: 'user' keeps the shared file, 'project' keys the file per cwd.
  private scope: MemoryScope = DEFAULT_MEMORY_SCOPE;

  constructor(
    @IConfigService private readonly config: IConfigService,
    @IBootstrapService private readonly bootstrap: IBootstrapService,
    @IHostEnvironment private readonly env: IHostEnvironment,
    @IHostFileSystem private readonly fs: IHostFileSystem,
    @ISessionContext private readonly sessionContext: ISessionContext,
    @IAgentContextMemoryService private readonly context: IAgentContextMemoryService,
    @IAgentTokenCountingService private readonly tokenCounting: IAgentTokenCountingService,
    @IAgentLLMRequesterService private readonly llmRequester: IAgentLLMRequesterService,
    @IAgentToolRegistryService private readonly toolRegistry: IAgentToolRegistryService,
    @IAgentToolSelectService private readonly toolSelect: IAgentToolSelectService,
    @IInstantiationService private readonly instantiation: IInstantiationService,
    @IAgentStateService private readonly states: IAgentStateService,
    @IEventBus private readonly eventBus: IEventBus,
    @ILogService private readonly log: ILogService,
  ) {
    super();
    this.states.register(memoryLastExtractedMessageIndexKey);
    this.states.register(memoryLastExtractedAtKey);
    this.states.register(memoryTurnsSinceExtractionKey);
    this._register(
      this.eventBus.subscribe('turn.ended', () => {
        this.turnsSinceExtraction += 1;
        this.maybeRunExtraction();
      }),
    );
    this._register(
      this.eventBus.subscribe('context.spliced', (event) => {
        // A full clear (start:0, empty result) begins a fresh conversation —
        // reset the extraction boundary so distillation starts from scratch.
        // Compactions publish a non-empty message list and an undo carries a
        // non-zero start, so neither resets here.
        if (event.start === 0 && event.messages.length === 0) {
          this.lastExtractedMessageIndex = 0;
          this.turnsSinceExtraction = 0;
        }
      }),
    );
  }

  // Lazy: `loop -> profile -> memory -> loop` would be a construction cycle.
  // The loop service is only needed at extraction time, resolved on demand.
  private get loop(): IAgentLoopService {
    if (this.loopService === undefined) {
      this.loopService = this.instantiation.invokeFunction((accessor) =>
        accessor.get(IAgentLoopService),
      );
    }
    return this.loopService;
  }

  isEnabled(): boolean {
    return this.config.get<MemoryConfig>(MEMORY_SECTION)?.enabled ?? true;
  }

  private autoExtract(): boolean {
    return this.config.get<MemoryConfig>(MEMORY_SECTION)?.autoExtract ?? true;
  }

  private maxBytes(): number {
    return this.config.get<MemoryConfig>(MEMORY_SECTION)?.maxBytes ?? DEFAULT_MEMORY_MAX_BYTES;
  }

  memoryDir(): string {
    return (
      this.config.get<MemoryConfig>(MEMORY_SECTION)?.dir ??
      join(this.env.homeDir ?? this.bootstrap.homeDir, 'memory')
    );
  }

  memoryScope(): MemoryScope {
    return this.scope;
  }

  setScope(scope: MemoryScope): void {
    this.scope = scope;
  }

  memoryFilePath(): string {
    const dir = this.memoryDir();
    // 'project' keys the file per working directory: the cwd is normalized and
    // hashed through `encodeWorkDirKey` (the same stable, filesystem-safe key
    // used for `workspaceId`), so drive letters, separators, and case
    // differences map to one directory per project across machines.
    return this.scope === 'project'
      ? join(dir, 'projects', encodeWorkDirKey(this.sessionContext.cwd), MEMORY_FILE_NAME)
      : join(dir, MEMORY_FILE_NAME);
  }

  async loadMemoryText(): Promise<string> {
    if (!this.isEnabled()) return '';
    const content = await this.readMemoryFile();
    return content.trim();
  }

  async loadCompactionSummary(): Promise<string | undefined> {
    if (!this.isEnabled()) return undefined;
    const content = await this.readMemoryFile();
    const body = currentSessionBody(content, this.sessionContext.sessionId);
    if (body === undefined) return undefined;
    const maxChars =
      this.config.get<MemoryConfig>(MEMORY_SECTION)?.compactSummaryMaxChars ??
      DEFAULT_COMPACT_SUMMARY_MAX_CHARS;
    const capped = capText(body, maxChars);
    if (capped.trim().length < MIN_COMPACTION_SUMMARY_CHARS) return undefined;
    return capped;
  }

  maybeRunExtraction(): void {
    if (!this.isEnabled() || !this.autoExtract()) return;
    if (this._extractionRunning) return;
    // Never contend with the main turn: only distill while the loop is idle.
    if (this.loop.status().state !== 'idle') return;

    const history = this.context.get();
    if (history.length === 0) return;

    const start = Math.min(this.lastExtractedMessageIndex, history.length);
    const segment = history.slice(start);
    if (segment.length === 0) {
      this.lastExtractedMessageIndex = history.length;
      return;
    }

    const config = this.config.get<MemoryConfig>(MEMORY_SECTION) ?? {};
    const interval = config.extractMinIntervalMs ?? DEFAULT_EXTRACT_MIN_INTERVAL_MS;
    const minTurns = config.extractMinTurns ?? DEFAULT_EXTRACT_MIN_TURNS;
    const now = Date.now();
    if (now - this.lastExtractedAt < interval || this.turnsSinceExtraction < minTurns) return;

    this.runExtraction(segment, history.length);
  }

  override dispose(): void {
    this._extractionController?.abort();
    super.dispose();
  }

  private get lastExtractedMessageIndex(): number {
    return this.states.get(memoryLastExtractedMessageIndexKey);
  }

  private set lastExtractedMessageIndex(value: number) {
    this.states.set(memoryLastExtractedMessageIndexKey, value);
  }

  private get lastExtractedAt(): number {
    return this.states.get(memoryLastExtractedAtKey);
  }

  private set lastExtractedAt(value: number) {
    this.states.set(memoryLastExtractedAtKey, value);
  }

  private get turnsSinceExtraction(): number {
    return this.states.get(memoryTurnsSinceExtractionKey);
  }

  private set turnsSinceExtraction(value: number) {
    this.states.set(memoryTurnsSinceExtractionKey, value);
  }

  private async readMemoryFile(): Promise<string> {
    try {
      return (await this.fs.readText(this.memoryFilePath(), { errors: 'ignore' })) ?? '';
    } catch {
      return '';
    }
  }

  private async writeMemoryFile(content: string): Promise<void> {
    // mkdir the file's own directory (not just `memoryDir()`) so the
    // `projects/<projectKey>/` nesting exists for project-scoped files.
    const file = this.memoryFilePath();
    try {
      await this.fs.mkdir(dirname(file), { recursive: true });
    } catch {
      // Directory already exists or is not writable; the write below surfaces it.
    }
    await this.fs.writeText(file, capText(content, this.maxBytes()));
  }

  private async appendSessionEntry(body: string): Promise<void> {
    const trimmed = body.trim();
    if (trimmed.length === 0) return;
    const existing = await this.readMemoryFile();
    // Keep one section per session: replace the previous entry for this id.
    const sections = splitSections(existing).filter(
      (section) => section.sessionId !== this.sessionContext.sessionId,
    );
    const section: MemorySection = {
      sessionId: this.sessionContext.sessionId,
      date: localDateLabel(),
      body: normalizeSectionBody(trimmed),
    };
    const parts = [serializeSection(section), ...sections.map(serializeSection)];
    await this.writeMemoryFile(`${MEMORY_SECTION_HEADING}\n\n${parts.join('\n\n---\n\n')}\n`);
  }

  private runExtraction(
    segment: readonly ContextMessage[],
    segmentEndIndex: number,
  ): void {
    const controller = new AbortController();
    this._extractionRunning = true;
    this._extractionController = controller;
    const done = (): void => {
      this._extractionRunning = false;
      this._extractionController = undefined;
    };
    void this.extractionWorker(segment, segmentEndIndex, controller).then(done, done);
  }

  private async extractionWorker(
    segment: readonly ContextMessage[],
    segmentEndIndex: number,
    controller: AbortController,
  ): Promise<void> {
    const signal = controller.signal;
    try {
      const messages = this.buildExtractionMessages(segment);
      if (messages.length === 0) return;
      const request = this.llmRequester.start(
        {
          messages,
          systemPrompt: renderPrompt(memoryExtractionPromptTemplate, {}),
          tools: this.readOnlyExtractionTools(),
          maxOutputSize: EXTRACTION_MAX_OUTPUT_TOKENS,
          source: { type: 'operation', requestKind: 'memory_extraction' },
        },
        undefined,
        signal,
      );
      const finish = await request.result;
      signal.throwIfAborted();
      const memory = extractMemoryText(finish);
      if (memory.trim().length === 0) return;
      await this.appendSessionEntry(memory);
      this.lastExtractedMessageIndex = segmentEndIndex;
      this.lastExtractedAt = Date.now();
      this.turnsSinceExtraction = 0;
      this.log.info('memory extraction complete', {
        sessionId: this.sessionContext.sessionId,
        chars: memory.length,
      });
    } catch (error) {
      if (signal.aborted || isAbortError(error)) return;
      this.log.warn('memory extraction failed', {
        sessionId: this.sessionContext.sessionId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private buildExtractionMessages(segment: readonly ContextMessage[]): Message[] {
    const candidate = segment.filter(
      (message) =>
        message.partial !== true &&
        !isToolDeclarationOnlyMessage(message) &&
        (message.role === 'user' || message.role === 'assistant' || message.role === 'tool'),
    );
    const kept = capSegmentForExtraction(candidate, EXTRACTION_MAX_SEGMENT_TOKENS, (message) =>
      this.tokenCounting.estimateMessage(message),
    );
    if (kept.length === 0) return [];
    return [...kept, createUserMessage(EXTRACTION_DISTILL_INSTRUCTION)];
  }

  private readOnlyExtractionTools(): readonly Tool[] {
    return this.toolSelect
      .shapeTools(this.toolRegistry.list())
      .filter((tool) => EXTRACTION_READONLY_TOOLS.has(tool.name))
      .map((tool) => ({
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters ?? EMPTY_TOOL_PARAMETERS,
        deferred: tool.deferred,
      }));
  }
}

function extractMemoryText(finish: AgentLLMRequestFinish): string {
  return finish.message.content
    .filter((part): part is Extract<typeof part, { type: 'text' }> => part.type === 'text')
    .map((part) => part.text)
    .join('')
    .trim();
}

/** Keeps the recent tail of `messages` within `budget` estimated tokens while
 *  preserving tool-call / tool-result pairing so the request stays
 *  provider-valid: a leading tool result whose assistant call was cut is
 *  dropped, and a trailing assistant tool call (or stray tool message) whose
 *  results were cut is dropped. */
function capSegmentForExtraction<T extends { readonly role: string; readonly toolCalls?: readonly unknown[] }>(
  messages: readonly T[],
  budget: number,
  estimate: (message: T) => number,
): T[] {
  const kept: T[] = [];
  let tokens = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]!;
    const messageTokens = estimate(message);
    if (tokens + messageTokens > budget) break;
    tokens += messageTokens;
    kept.push(message);
  }
  if (kept.length === 0 && messages.length > 0) {
    // A single oversized message would starve extraction: keep the most recent
    // one anyway (cleanup below drops a lone tool result if that applies).
    kept.push(messages[messages.length - 1]!);
  }
  kept.reverse();
  while (kept.length > 0 && kept[0]!.role === 'tool') kept.shift();
  while (kept.length > 0) {
    const last = kept[kept.length - 1]!;
    if (last.role === 'tool') {
      kept.pop();
      continue;
    }
    if (last.role === 'assistant' && (last.toolCalls?.length ?? 0) > 0) {
      kept.pop();
      continue;
    }
    break;
  }
  while (
    kept.length > 0 &&
    kept[0]!.role === 'assistant' &&
    (kept[0]!.toolCalls?.length ?? 0) > 0 &&
    kept[1]?.role !== 'tool'
  ) {
    kept.shift();
  }
  return kept;
}

function splitSections(content: string): MemorySection[] {
  const sections: MemorySection[] = [];
  const lines = content.split('\n');
  let current: MemorySection | undefined;
  const body: string[] = [];
  for (const line of lines) {
    const match = line.match(/^## Session\s+(\S+)\s*[·•]\s*(.*)$/);
    if (match !== null) {
      if (current !== undefined) {
        sections.push({ ...current, body: body.join('\n').trim() });
        body.length = 0;
      }
      current = { sessionId: match[1]!, date: match[2] ?? '', body: '' };
      continue;
    }
    if (current !== undefined) body.push(line);
  }
  if (current !== undefined) {
    sections.push({ ...current, body: body.join('\n').trim() });
  }
  return sections;
}

function currentSessionBody(content: string, sessionId: string): string | undefined {
  const sections = splitSections(content);
  for (let i = sections.length - 1; i >= 0; i--) {
    if (sections[i]!.sessionId === sessionId) return sections[i]!.body;
  }
  return undefined;
}

function serializeSection(section: MemorySection): string {
  return `## Session ${section.sessionId} · ${section.date}\n\n${section.body}`;
}

/** Downgrade top-level headings so a `##` inside a body cannot collide with
 *  the `## Session` section delimiter. */
function normalizeSectionBody(body: string): string {
  return body
    .split('\n')
    .map((line) => (/^##\s/.test(line) ? line.replace(/^##/, '###') : line))
    .join('\n');
}

function localDateLabel(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Caps `text` to `maxChars` characters without splitting surrogate pairs. */
function capText(text: string, maxChars: number): string {
  if (maxChars <= 0 || text.length <= maxChars) return text;
  let end = 0;
  for (let i = 0; i < maxChars; i++) {
    const code = text.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff && i + 1 < text.length) {
      i += 1;
    }
    end = i + 1;
  }
  return text.slice(0, end);
}

registerScopedService(
  LifecycleScope.Agent,
  IMemoryService,
  AgentMemoryService,
  ScopeActivation.OnScopeCreated,
  'memory',
);
