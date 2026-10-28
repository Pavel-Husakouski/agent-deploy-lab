import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/api/server.js';
import type { HistoryRecord, HistoryStore } from '../src/history.js';
import { makeRecord } from '../src/history.js';
import type { ChatMessage, LlmClient } from '../src/llm.js';

class MemoryStore implements HistoryStore {
  data = new Map<string, HistoryRecord[]>();
  healthy = true;

  async read(sessionId: string): Promise<HistoryRecord[]> {
    return [...(this.data.get(sessionId) ?? [])];
  }
  async append(sessionId: string, records: HistoryRecord[]): Promise<void> {
    this.data.set(sessionId, [...(this.data.get(sessionId) ?? []), ...records]);
  }
  async ping(): Promise<boolean> {
    return this.healthy;
  }
}

class FakeLlm implements LlmClient {
  calls: ChatMessage[][] = [];
  constructor(
    private readonly chunks: string[],
    private readonly failAfter?: number,
  ) {}

  async *streamChat(messages: ChatMessage[]): AsyncIterable<string> {
    this.calls.push(messages);
    for (const [i, chunk] of this.chunks.entries()) {
      if (this.failAfter !== undefined && i >= this.failAfter) throw new Error('LLM упала');
      yield chunk;
    }
  }
}

interface ParsedEvent {
  event: string;
  data: unknown;
}

function parseSse(body: string): ParsedEvent[] {
  return body
    .split('\n\n')
    .filter((block) => block.trim() !== '')
    .map((block) => {
      let event = 'message';
      let data = '';
      for (const line of block.split('\n')) {
        if (line.startsWith('event: ')) event = line.slice(7);
        if (line.startsWith('data: ')) data = line.slice(6);
      }
      return { event, data: JSON.parse(data) as unknown };
    });
}

const SYSTEM = 'системный промпт';
let app: FastifyInstance | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
});

describe('POST /chat', () => {
  it('стримит дельты, завершает событием done и сохраняет обе реплики', async () => {
    const store = new MemoryStore();
    const llm = new FakeLlm(['При', 'вет']);
    app = buildApp({ llm, store, systemPrompt: SYSTEM });

    const res = await app.inject({
      method: 'POST',
      url: '/chat',
      payload: { sessionId: 's1', message: 'начнём' },
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/event-stream');
    expect(parseSse(res.body)).toEqual([
      { event: 'message', data: { delta: 'При' } },
      { event: 'message', data: { delta: 'вет' } },
      { event: 'done', data: {} },
    ]);

    const saved = await store.read('s1');
    expect(saved.map((r) => [r.role, r.content])).toEqual([
      ['user', 'начнём'],
      ['assistant', 'Привет'],
    ]);
    expect(saved.every((r) => r.schemaVersion === 1)).toBe(true);
  });

  it('передаёт в LLM system prompt, историю и новое сообщение', async () => {
    const store = new MemoryStore();
    await store.append('s1', [makeRecord('user', 'q1'), makeRecord('assistant', 'a1')]);
    const llm = new FakeLlm(['ok']);
    app = buildApp({ llm, store, systemPrompt: SYSTEM });

    await app.inject({
      method: 'POST',
      url: '/chat',
      payload: { sessionId: 's1', message: 'q2' },
    });

    expect(llm.calls[0]).toEqual([
      { role: 'system', content: SYSTEM },
      { role: 'user', content: 'q1' },
      { role: 'assistant', content: 'a1' },
      { role: 'user', content: 'q2' },
    ]);
  });

  it('при ошибке LLM отдаёт event: error и не пишет историю', async () => {
    const store = new MemoryStore();
    app = buildApp({ llm: new FakeLlm(['a', 'b'], 1), store, systemPrompt: SYSTEM });

    const res = await app.inject({
      method: 'POST',
      url: '/chat',
      payload: { sessionId: 's1', message: 'привет' },
    });

    const events = parseSse(res.body);
    expect(events.at(-1)).toEqual({ event: 'error', data: { message: 'LLM упала' } });
    expect(events.some((e) => e.event === 'done')).toBe(false);
    expect(await store.read('s1')).toEqual([]);
  });

  it.each([
    [{ message: 'x' }],
    [{ sessionId: 's1' }],
    [{ sessionId: 's1', message: '   ' }],
    [{ sessionId: 'bad id!', message: 'x' }],
  ])('отклоняет невалидный запрос %j с кодом 400', async (payload) => {
    const llm = new FakeLlm(['x']);
    app = buildApp({ llm, store: new MemoryStore(), systemPrompt: SYSTEM });

    const res = await app.inject({ method: 'POST', url: '/chat', payload });

    expect(res.statusCode).toBe(400);
    expect(llm.calls).toHaveLength(0);
  });
});

describe('GET /healthz', () => {
  it('200, когда Redis отвечает, и 503, когда нет', async () => {
    const store = new MemoryStore();
    app = buildApp({ llm: new FakeLlm([]), store, systemPrompt: SYSTEM });

    expect((await app.inject({ method: 'GET', url: '/healthz' })).statusCode).toBe(200);
    store.healthy = false;
    expect((await app.inject({ method: 'GET', url: '/healthz' })).statusCode).toBe(503);
  });
});
