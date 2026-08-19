/**
 * Scenario: parseToolCallArguments caching and error contract.
 * Responsibilities: byte-stable tool-call argument strings are parsed once and
 * reused across requests (bounded cache), different strings never interfere,
 * failures re-run with the exact original error types, and the returned object
 * is detached (shallow copy) so callers cannot poison the cache.
 * Run: pnpm exec vitest run packages/kosong/test/providers/tool-arguments.test.ts
 */
import { ChatProviderError } from '#/errors';
import { parseToolCallArguments } from '#/providers/tool-arguments';
import { describe, expect, it } from 'vitest';

describe('parseToolCallArguments', () => {
  it('同一 arguments 字符串重复转换结果一致(命中缓存)', () => {
    const json = '{"query":"trace_id","limit":5,"nested":{"a":[1,2,3]}}';
    const first = parseToolCallArguments(json);
    const second = parseToolCallArguments(json);
    expect(second).toEqual(first);
    // 浅拷贝隔离:命中缓存不返回缓存对象本身
    expect(second).not.toBe(first);
    // 深层结构共享(与旧"每次 parse 全新对象"的读取语义一致)
    expect(second['nested']).toBe(first['nested']);
  });

  it('命中缓存后变异返回值第一层不影响后续解析', () => {
    const json = '{"k":"v","n":[1,2]}';
    const first = parseToolCallArguments(json);
    first['k'] = 'mutated';
    first['injected'] = true;
    const second = parseToolCallArguments(json);
    expect(second).toEqual({ k: 'v', n: [1, 2] });
  });

  it('不同字符串不串扰', () => {
    const a = parseToolCallArguments('{"x":1}');
    const b = parseToolCallArguments('{"y":"two"}');
    expect(a).toEqual({ x: 1 });
    expect(b).toEqual({ y: 'two' });
  });

  it('非法 JSON 抛 ChatProviderError "must be valid JSON"', () => {
    expect(() => parseToolCallArguments('{invalid')).toThrow(ChatProviderError);
    expect(() => parseToolCallArguments('{invalid')).toThrow('Tool call arguments must be valid JSON.');
  });

  it('合法 JSON 但非对象(数组/标量/null)抛 "must be a JSON object"', () => {
    for (const bad of ['[1,2]', '"str"', '42', 'null', 'true']) {
      expect(() => parseToolCallArguments(bad)).toThrow(ChatProviderError);
      expect(() => parseToolCallArguments(bad)).toThrow('Tool call arguments must be a JSON object.');
    }
  });

  it('失败不被缓存:同一坏字符串连续调用都抛同样的错误', () => {
    expect(() => parseToolCallArguments('{invalid')).toThrow('Tool call arguments must be valid JSON.');
    expect(() => parseToolCallArguments('{invalid')).toThrow('Tool call arguments must be valid JSON.');
    expect(() => parseToolCallArguments('[1]')).toThrow('Tool call arguments must be a JSON object.');
    expect(() => parseToolCallArguments('[1]')).toThrow('Tool call arguments must be a JSON object.');
  });

  it('空对象参数返回空对象', () => {
    expect(parseToolCallArguments('{}')).toEqual({});
  });
});
