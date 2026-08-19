import type { ContentPart } from '@moonshot-ai/kosong';
import { describe, expect, it } from 'vitest';

import {
  estimateTokens,
  estimateTokensForContentPart,
  estimateTokensForMessage,
  estimateTokensForTools,
  MEDIA_TOKEN_ESTIMATE,
} from '../../src/utils/tokens';

// Regression coverage for CMP-03: media content parts (image/audio/video) must
// NOT estimate to 0 tokens. When they did, compaction triggers, the
// overflow-shrink budget, the kept-user 20k budget, and the reported
// `tokensAfter` all went blind to the single largest context contributor (a
// base64 image data URL), so a vision-heavy session could overflow the provider
// while the estimator reported a near-empty context.
describe('estimateTokensForContentPart — media parts', () => {
  const imagePart: ContentPart = {
    type: 'image_url',
    imageUrl: { url: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB' },
  };
  const audioPart: ContentPart = {
    type: 'audio_url',
    audioUrl: { url: 'data:audio/mp3;base64,AAAA' },
  };
  const videoPart: ContentPart = {
    type: 'video_url',
    videoUrl: { url: 'data:video/mp4;base64,AAAA' },
  };

  it('estimates an image part as a substantial, non-zero token cost', () => {
    expect(estimateTokensForContentPart(imagePart)).toBe(MEDIA_TOKEN_ESTIMATE);
    expect(MEDIA_TOKEN_ESTIMATE).toBeGreaterThan(100);
  });

  it('estimates audio and video parts as non-zero', () => {
    expect(estimateTokensForContentPart(audioPart)).toBeGreaterThan(0);
    expect(estimateTokensForContentPart(videoPart)).toBeGreaterThan(0);
  });

  it('uses a bounded fixed estimate, not the base64 payload length', () => {
    // A ~4 MB base64 data URL must not be counted as text (which would yield
    // ~1M "tokens"); the estimate must stay a small bounded value.
    const huge = 'A'.repeat(4_000_000);
    const bigImage: ContentPart = {
      type: 'image_url',
      imageUrl: { url: `data:image/png;base64,${huge}` },
    };
    const estimate = estimateTokensForContentPart(bigImage);
    expect(estimate).toBeGreaterThan(0);
    expect(estimate).toBeLessThan(50_000);
  });

  it('includes media when estimating a whole message', () => {
    const message = {
      role: 'user',
      content: [{ type: 'text', text: 'see screenshot' }, imagePart] satisfies ContentPart[],
    };
    // The image must dominate the ~4-token text, not be free.
    expect(estimateTokensForMessage(message)).toBeGreaterThan(100);
  });
});

// Dynamic tool schema messages (select_tools progressive disclosure) carry
// full tool definitions in `message.tools`. If the estimator ignores them,
// injected schemas are invisible to every compaction budget and the context
// overflows before compaction triggers.
describe('estimateTokensForMessage — message.tools', () => {
  const tool = {
    name: 'mcp__grafana__query_range',
    description: 'Query a Prometheus-compatible range endpoint.',
    parameters: {
      type: 'object',
      properties: { query: { type: 'string' }, minutes: { type: 'number' } },
      required: ['query'],
    },
  };

  it('counts injected tool schemas', () => {
    const bare = { role: 'system', content: [] } as const;
    const withTools = { role: 'system', content: [], tools: [tool] } as const;
    expect(estimateTokensForMessage(withTools)).toBe(
      estimateTokensForMessage(bare) + estimateTokensForTools([tool]),
    );
  });

  it('leaves messages without tools byte-identical to the old estimate', () => {
    const message = {
      role: 'user',
      content: [{ type: 'text', text: 'hello world' }] satisfies ContentPart[],
      toolCalls: [{ name: 'Read', arguments: { file: 'a.ts' } }],
    };
    const expected =
      estimateTokens('user') +
      estimateTokens('hello world') +
      estimateTokens('Read') +
      estimateTokens(JSON.stringify({ file: 'a.ts' }));
    expect(estimateTokensForMessage(message)).toBe(expected);
  });
});

// The optimized `estimateTokens` replaces the per-character loop with a single
// `/gu` regex scan. The two must return identical numbers on every input —
// including surrogate pairs (emoji), lone surrogates, and mixed ASCII/CJK,
// where UTF-16 code units and code points diverge.
describe('estimateTokens — regex scan equivalence', () => {
  // Reference: the original per-character implementation, verbatim.
  function referenceEstimateTokens(text: string): number {
    let asciiCount = 0;
    let nonAsciiCount = 0;
    for (const char of text) {
      if (char.codePointAt(0)! <= 127) {
        asciiCount++;
      } else {
        nonAsciiCount++;
      }
    }
    return Math.ceil(asciiCount / 4) + nonAsciiCount;
  }

  const curatedSamples = [
    '',
    'hello world',
    '中文测试文本',
    'The quick brown fox 敏捷的棕色狐狸',
    '😀',
    'a😀b',
    'emoji 混合：😀🚀💩 中文 🀄',
    '\uD800', // lone high surrogate
    '\uDC00', // lone low surrogate
    '\uD83D\uDE00', // 😀 written out as an explicit pair
    'x\uD800y\uDE00z', // lone surrogates interleaved with ASCII
    '😀'.repeat(100), // many astral chars
    '中'.repeat(1000),
    'A'.repeat(1000) + '中😀',
    'line1\nline2\ttab\r\n',
    '\u0000\u007F\u0080\u07FF\u0800\uFFFF',
  ];

  it('matches the per-character reference on curated samples', () => {
    for (const sample of curatedSamples) {
      expect(estimateTokens(sample)).toBe(referenceEstimateTokens(sample));
    }
  });

  it('matches the per-character reference on deterministic random strings', () => {
    // mulberry32 PRNG: the corpus is stable across runs.
    let seed = 0x2f6e2b1;
    const rng = () => {
      seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    const pool = [
      'a',
      'Z',
      '0',
      ' ',
      '\n',
      '\t',
      '中',
      '文',
      '测',
      '试',
      '😀',
      '🚀',
      '💩',
      '\uD800',
      '\uDC00',
      '\uDFFF',
      '\uE000',
    ];
    for (let i = 0; i < 2000; i++) {
      const len = Math.floor(rng() * 60);
      let s = '';
      for (let j = 0; j < len; j++) s += pool[Math.floor(rng() * pool.length)];
      expect(estimateTokens(s)).toBe(referenceEstimateTokens(s));
    }
  });
});

// The stringify cache must be transparent: repeated estimates over the same
// schema / argument objects return the same totals as the pre-cache code.
describe('estimateTokensForTools — stringify cache', () => {
  it('caches JSON.stringify by parameter object identity', () => {
    const params = { type: 'object', properties: { q: { type: 'string' } } };
    const tools = [
      { name: 't1', description: 'd1', parameters: params },
      { name: 't2', description: 'd2', parameters: params },
    ];
    const expected =
      estimateTokens('t1') +
      estimateTokens('d1') +
      estimateTokens(JSON.stringify(params)) +
      estimateTokens('t2') +
      estimateTokens('d2') +
      estimateTokens(JSON.stringify(params));
    expect(estimateTokensForTools(tools)).toBe(expected);
    // Repeated calls over the same schema objects (the cache path) stay stable.
    expect(estimateTokensForTools(tools)).toBe(expected);
    expect(estimateTokensForTools(tools)).toBe(expected);
  });

  it('still serializes distinct schema objects independently', () => {
    const mk = (i: number) => ({ name: `t${i}`, description: 'd', parameters: { i } });
    const a = [mk(1), mk(2)];
    const b = [mk(1), mk(3)];
    expect(estimateTokensForTools(a)).toBe(
      estimateTokens('t1') +
        estimateTokens('d') +
        estimateTokens(JSON.stringify({ i: 1 })) +
        estimateTokens('t2') +
        estimateTokens('d') +
        estimateTokens(JSON.stringify({ i: 2 })),
    );
    expect(estimateTokensForTools(b)).toBe(
      estimateTokens('t1') +
        estimateTokens('d') +
        estimateTokens(JSON.stringify({ i: 1 })) +
        estimateTokens('t3') +
        estimateTokens('d') +
        estimateTokens(JSON.stringify({ i: 3 })),
    );
  });
});

describe('estimateTokensForMessage — tool-call arguments cache', () => {
  it('shares the stringify cache across messages with the same arguments object', () => {
    const args = { file: 'a.ts', line: 42 };
    const mk = () => ({ role: 'assistant', content: [], toolCalls: [{ name: 'Read', arguments: args }] });
    const expected =
      estimateTokens('assistant') +
      estimateTokens('Read') +
      estimateTokens(JSON.stringify(args));
    // Two distinct message objects sharing one arguments object: both must
    // agree with the uncached reference total.
    expect(estimateTokensForMessage(mk())).toBe(expected);
    expect(estimateTokensForMessage(mk())).toBe(expected);
  });
});
