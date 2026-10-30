import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/api/server.js';
import type { HistoryRecord, HistoryStore } from '../src/history.js';
import { makeRecord } from '../src/history.js';
import type { ChatMessage, LlmClient, LlmEvent, TokenUsage } from '../src/llm.js';
import type { Release } from '../src/release.js';

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
    private readonly usage?: TokenUsage,
  ) {}

  async *streamChat(messages: ChatMessage[]): AsyncIterable<LlmEvent> {
    this.calls.push(messages);
    for (const [i, chunk] of this.chunks.entries()) {
      if (this.failAfter !== undefined && i >= this.failAfter) throw new Error('LLM упала');
      yield { type: 'delta', text: chunk };
    }
    if (this.usage) yield { type: 'usage', usage: this.usage };
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
const RELEASE: Release = {
  systemPrompt: SYSTEM,
  manifest: {
    version: '1.2.0',
    model: {
      id: 'test-model',
      temperature: 0.3,
      maxTokens: 1024,
      pricing: { inputPerMTok: 0.5, outputPerMTok: 2 },
    },
    prompt: { id: 'trainer-test', sha256: 'a'.repeat(64) },
    evalDataset: 'golden-test',
  },
};
let app: FastifyInstance | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
});

describe('POST /chat', () => {
  it('стримит дельты, завершает событием done и сохраняет обе реплики', async () => {
    const store = new MemoryStore();
    const llm = new FakeLlm(['При', 'вет']);
    app = buildApp({ llm, store, release: RELEASE });

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
    app = buildApp({ llm, store, release: RELEASE });

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
    app = buildApp({ llm: new FakeLlm(['a', 'b'], 1), store, release: RELEASE });

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
    app = buildApp({ llm, store: new MemoryStore(), release: RELEASE });

    const res = await app.inject({ method: 'POST', url: '/chat', payload });

    expect(res.statusCode).toBe(400);
    expect(llm.calls).toHaveLength(0);
  });
});

describe('GET /metrics', () => {
  // Значение метрики из текстового формата Prometheus по имени и подстроке labels.
  function metric(body: string, name: string, labels = ''): number | undefined {
    const line = body
      .split('\n')
      .find((l) => l.startsWith(`${name}{`) && l.includes(labels));
    return line === undefined ? undefined : Number(line.split(' ').at(-1));
  }

  it('считает запросы, токены и стоимость, labels содержат версию релиза', async () => {
    const llm = new FakeLlm(['ок'], undefined, { promptTokens: 1000, completionTokens: 500 });
    app = buildApp({ llm, store: new MemoryStore(), release: RELEASE });

    await app.inject({ method: 'POST', url: '/chat', payload: { sessionId: 's1', message: 'q' } });
    await app.inject({ method: 'POST', url: '/chat', payload: { sessionId: 's1' } });
    const res = await app.inject({ method: 'GET', url: '/metrics' });

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/plain');
    const body = res.body;
    const common = 'release="1.2.0",prompt="trainer-test",model="test-model"';
    expect(metric(body, 'agent_chat_requests_total', 'status="ok"')).toBe(1);
    expect(metric(body, 'agent_chat_requests_total', 'status="bad_request"')).toBe(1);
    expect(metric(body, 'agent_llm_tokens_total', 'type="prompt"')).toBe(1000);
    expect(metric(body, 'agent_llm_tokens_total', 'type="completion"')).toBe(500);
    // 1000 * 0.5 / 1e6 + 500 * 2 / 1e6
    expect(metric(body, 'agent_llm_cost_usd_total')).toBeCloseTo(0.0015, 10);
    expect(metric(body, 'agent_chat_duration_seconds_count', 'status="ok"')).toBe(1);
    expect(metric(body, 'agent_chat_ttft_seconds_count')).toBe(1);
    expect(metric(body, 'agent_release_info', 'prompt_sha256="' + 'a'.repeat(64))).toBe(1);
    expect(body).toContain(common);
  });

  it('ошибка LLM считается со статусом error', async () => {
    app = buildApp({ llm: new FakeLlm(['a'], 0), store: new MemoryStore(), release: RELEASE });

    await app.inject({ method: 'POST', url: '/chat', payload: { sessionId: 's1', message: 'q' } });
    const body = (await app.inject({ method: 'GET', url: '/metrics' })).body;

    expect(metric(body, 'agent_chat_requests_total', 'status="error"')).toBe(1);
    expect(metric(body, 'agent_chat_requests_total', 'status="ok"')).toBeUndefined();
  });
});

describe('GET /healthz', () => {
  it('отдаёт версию релиза', async () => {
    app = buildApp({ llm: new FakeLlm([]), store: new MemoryStore(), release: RELEASE });

    const res = await app.inject({ method: 'GET', url: '/healthz' });
    expect(res.json()).toEqual({ status: 'ok', redis: true, release: '1.2.0' });
  });

  it('200, когда Redis отвечает, и 503, когда нет', async () => {
    const store = new MemoryStore();
    app = buildApp({ llm: new FakeLlm([]), store, release: RELEASE });

    expect((await app.inject({ method: 'GET', url: '/healthz' })).statusCode).toBe(200);
    store.healthy = false;
    expect((await app.inject({ method: 'GET', url: '/healthz' })).statusCode).toBe(503);
  });
});
