/**
 * `toolSelect` domain — progressive tool disclosure contract.
 *
 * Defines the Agent-scope service that shapes provider-visible tool/history
 * views, loads selected dynamic schemas, and reports loadable-tool
 * announcements.
 */

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import type { ContextMessage } from '#/agent/contextMemory/types';
import type { ToolInfo } from '#/tool/toolContract';

export const SELECT_TOOLS_TOOL_NAME = 'select_tools';

export interface ShapedToolEntry extends ToolInfo {
  readonly deferred?: true;
}

/** Model-visible tool schema — the explicit allowlist projection of a tool's
 *  static metadata. Only `name` / `description` / `parameters` ever reach the
 *  model; execution metadata (`accesses`, `approvalRule`, `deferred`,
 *  `execute`) is never projected here. */
export interface ModelToolSchema {
  readonly name: string;
  readonly description: string;
  readonly parameters: Record<string, unknown>;
}

const EMPTY_TOOL_PARAMETERS: Record<string, unknown> = { type: 'object', properties: {} };

/** Single projection point from a registered tool's static metadata to the
 *  model-visible schema. Assembles only the explicit allowlist fields
 *  (`name` / `description` / `parameters`), defaulting empty parameters, so
 *  execution metadata can never leak onto the wire. Reads `description` at
 *  projection time so runtime getters (e.g. BashTool's policy-dependent
 *  description) are honored. */
export function toModelToolSchema(
  info: Pick<ToolInfo, 'name' | 'description' | 'parameters'>,
): ModelToolSchema {
  return {
    name: info.name,
    description: info.description,
    parameters: info.parameters ?? EMPTY_TOOL_PARAMETERS,
  };
}

export interface LoadToolsResult {
  readonly toLoad: readonly string[];
  readonly alreadyAvailable: readonly string[];
  readonly unknown: readonly string[];
}

export interface IAgentToolSelectService {
  readonly _serviceBrand: undefined;

  enabled(): boolean;

  shapeTools(entries: readonly ToolInfo[]): readonly ShapedToolEntry[];

  /** Projects shaped entries to the model-visible schema allowlist through
   *  {@link toModelToolSchema}; deferred (not-yet-loaded) tools are excluded
   *  and execution metadata never appears. */
  shapeToolsForModel(entries: readonly ToolInfo[]): readonly ModelToolSchema[];

  shapeHistory(messages: readonly ContextMessage[]): readonly ContextMessage[];

  load(names: readonly string[]): LoadToolsResult;

  loadableToolsAnnouncement(): string | undefined;
}

export const IAgentToolSelectService: ServiceIdentifier<IAgentToolSelectService> =
  createDecorator<IAgentToolSelectService>('agentToolSelectService');
