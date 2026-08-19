/**
 * `mcpCore` domain — qualified `mcp__server__tool` name sanitizing and hashing.
 */

import { createHash } from 'node:crypto';

const MCP_NAME_PREFIX = 'mcp__';
const MCP_NAME_SEPARATOR = '__';

const MAX_QUALIFIED_LENGTH = 64;

export function sanitizeMcpNamePart(part: string): string {
  return part.replaceAll(/[^a-zA-Z0-9_-]/g, '_').replaceAll(/_+/g, '_');
}

export function qualifyMcpToolName(serverName: string, toolName: string): string {
  const full = `${MCP_NAME_PREFIX}${sanitizeMcpNamePart(serverName)}${MCP_NAME_SEPARATOR}${sanitizeMcpNamePart(toolName)}`;
  if (full.length <= MAX_QUALIFIED_LENGTH) return full;

  const hash = stableHash(full);
  const head = full.slice(0, MAX_QUALIFIED_LENGTH - hash.length - 1);
  return `${head}_${hash}`;
}

// 12 hex chars of SHA-256 (48 bits) for the length-cap suffix — collision
// resistance comfortably above the qualified-name space so two distinct
// long names cannot realistically hash together.
function stableHash(input: string): string {
  return createHash('sha256').update(input).digest('hex').slice(0, 12);
}
