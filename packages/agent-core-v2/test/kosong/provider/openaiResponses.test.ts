import type OpenAI from 'openai';
import { describe, expect, it, vi } from 'vitest';

import { generate } from '#/kosong/contract/generate';
import { OpenAIResponsesChatProvider } from '#/kosong/provider/bases/openai/openai-responses';
import type { HostedSearchMode } from '#/kosong/contract/provider';

const history = [
  {
    role: 'user' as const,
    content: [{ type: 'text' as const, text: 'search the web' }],
    toolCalls: [],
  },
];

describe('OpenAI Responses hosted search request tool', () => {
  it.each([
    ['disabled', []],
    ['cached', [{ type: 'web_search', external_web_access: false }]],
    [
      'indexed',
      [{ type: 'web_search', external_web_access: true, indexed_web_access: true }],
    ],
    ['live', [{ type: 'web_search', external_web_access: true }]],
  ] as const)('emits the exact %s tool shape', async (mode, expectedTools) => {
    const create = vi.fn().mockResolvedValue({
      async *[Symbol.asyncIterator](): AsyncGenerator<unknown> {
        yield { type: 'response.output_text.delta', delta: 'done' };
        yield { type: 'response.completed', response: { id: 'resp-test' } };
      },
    });
    const client = { responses: { create } } as unknown as OpenAI;
    const provider = new OpenAIResponsesChatProvider({
      apiKey: 'sk-test',
      model: 'gpt-5.6-sol',
      webSearch: mode as HostedSearchMode,
      clientFactory: () => client,
    });

    const stream = await provider.generate('', [], history);
    for await (const _part of stream) {
      // Consume the stream so the request lifecycle completes.
    }

    const params = create.mock.calls[0]?.[0] as { tools: unknown[] };
    expect(params.tools).toEqual(expectedTools);
    if (mode === 'disabled') {
      expect(JSON.stringify(params)).not.toContain('web_search');
    }
  });

  it('retains streamed search lifecycle, sources, and URL citations on the final message', async () => {
    const create = vi.fn().mockResolvedValue({
      async *[Symbol.asyncIterator](): AsyncGenerator<unknown> {
        yield { type: 'response.web_search_call.in_progress', item_id: 'ws-1' };
        yield {
          type: 'response.output_item.done',
          output_index: 0,
          item: {
            type: 'web_search_call',
            id: 'ws-1',
            status: 'completed',
            action: {
              type: 'search',
              query: 'Node.js LTS',
              sources: [{ type: 'url', url: 'https://nodejs.org/en', title: 'Node.js' }],
            },
          },
        };
        yield { type: 'response.output_text.delta', delta: 'Node.js is current.' };
        yield {
          type: 'response.output_text.annotation.added',
          annotation: {
            type: 'url_citation',
            start_index: 0,
            end_index: 7,
            url: 'https://nodejs.org/en',
            title: 'Node.js',
          },
        };
        yield {
          type: 'response.completed',
          response: { id: 'resp-test', status: 'completed' },
        };
      },
    });
    const client = { responses: { create } } as unknown as OpenAI;
    const provider = new OpenAIResponsesChatProvider({
      apiKey: 'sk-test',
      model: 'gpt-5.6-sol',
      webSearch: 'live',
      clientFactory: () => client,
    });
    const parts: string[] = [];

    const result = await generate(provider, '', [], history, {
      onMessagePart: (part) => {
        parts.push(part.type);
      },
    });

    expect(parts).toEqual([
      'hosted_search_lifecycle',
      'hosted_search_action',
      'hosted_search_source',
      'hosted_search_lifecycle',
      'text',
      'url_citation',
    ]);
    expect(result.message.searchMetadata).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ callId: 'ws-1', status: 'in_progress' }),
        expect.objectContaining({
          callId: 'ws-1',
          action: expect.objectContaining({ type: 'search', query: 'Node.js LTS' }),
        }),
        expect.objectContaining({
          callId: 'ws-1',
          sources: [expect.objectContaining({ url: 'https://nodejs.org/en' })],
        }),
      ]),
    );
    expect(result.message.annotations).toEqual([
      {
        type: 'url_citation',
        startIndex: 0,
        endIndex: 7,
        url: 'https://nodejs.org/en',
        title: 'Node.js',
      },
    ]);
  });
});
