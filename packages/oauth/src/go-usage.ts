/**
 * opencode-go usage fetch / parse.
 *
 * The provider exposes a `/usage` endpoint relative to its base URL
 * (default https://opencode.ai/zen/go/v1) that returns a payload of the
 * shape:
 *
 *   {
 *     "usage": {
 *       "rolling": { "status": "ok", "percent": 11, "resetsAt": "2026-08-14T09:14:53Z" },
 *       "weekly":  { "status": "ok", "percent": 44, "resetsAt": "..." },
 *       "monthly": { "status": "ok", "percent": 22, "resetsAt": "..." }
 *     }
 *   }
 *
 * Each window carries only a usage percentage (integer 0-100) and an ISO
 * reset time — no amounts or currency. The parser keeps the rolling (5h)
 * and weekly windows; a window that is missing, malformed, or not `ok` is
 * dropped (null) rather than guessed at.
 */

import { readApiErrorMessage } from './api-error';
import { isRecord } from './utils';

export interface GoUsageWindow {
  readonly percent: number;
  readonly resetsAt?: string;
}

export interface ParsedGoUsage {
  readonly rolling: GoUsageWindow | null;
  readonly weekly: GoUsageWindow | null;
}

export type GoUsageFetchResult =
  | { readonly kind: 'ok'; readonly parsed: ParsedGoUsage }
  | { readonly kind: 'error'; readonly status?: number; readonly message: string };

function parseWindow(raw: unknown): GoUsageWindow | null {
  if (!isRecord(raw)) return null;
  if (raw['status'] !== 'ok') return null;
  const percent = raw['percent'];
  if (typeof percent !== 'number' || !Number.isFinite(percent) || percent < 0 || percent > 100) {
    return null;
  }
  const resetsAt = raw['resetsAt'];
  return {
    percent,
    resetsAt: typeof resetsAt === 'string' && resetsAt.length > 0 ? resetsAt : undefined,
  };
}

// ── HTTP fetch ────────────────────────────────────────────────────────

export async function fetchGoUsage(
  baseUrl: string,
  apiKey: string,
  opts: { timeoutMs?: number } = {},
): Promise<GoUsageFetchResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, opts.timeoutMs ?? 8000);
  try {
    const res = await fetch(`${baseUrl.replace(/\/+$/, '')}/usage`, {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: 'application/json',
      },
      signal: controller.signal,
    });
    if (!res.ok) {
      const status = res.status;
      const hint =
        status === 401
          ? 'Authorization failed. Please check your API key.'
          : status === 404
            ? 'Usage endpoint not available. Please check the opencode-go base URL.'
            : `Failed to fetch usage: HTTP ${String(status)}`;
      return { kind: 'error', status, message: await readApiErrorMessage(res, hint) };
    }
    const json: unknown = await res.json();
    const usage = isRecord(json) ? json['usage'] : undefined;
    return {
      kind: 'ok',
      parsed: {
        rolling: parseWindow(isRecord(usage) ? usage['rolling'] : undefined),
        weekly: parseWindow(isRecord(usage) ? usage['weekly'] : undefined),
      },
    };
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      return { kind: 'error', message: 'Failed to fetch usage: request timed out.' };
    }
    const msg = error instanceof Error ? error.message : String(error);
    return { kind: 'error', message: `Failed to fetch usage: ${msg}` };
  } finally {
    clearTimeout(timer);
  }
}
