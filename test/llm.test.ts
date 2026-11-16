import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { createLlmClient, type LlmEvent, type LlmTrace } from '../src/llm.js';

// Фейковый OpenAI-совместимый endpoint: запоминает тело запроса и отвечает коротким стримом.
let server: Server | undefined;
const bodies: Record<string, unknown>[] = [];
const headers: Record<string, string | string[] | undefined>[] = [];

async function startServer(): Promise<string> {
  server = createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk: Buffer) => (raw += chunk.toString()));
    req.on('end', () => {
      bodies.push(JSON.parse(raw) as Record<string, unknown>);
      headers.push(req.headers);
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const chunk = (data: object) => res.write(`data: ${JSON.stringify(data)}\n\n`);
      chunk({ choices: [{ index: 0, delta: { content: 'ok' }, finish_reason: null }] });
      chunk({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
      chunk({ choices: [], usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 } });
      res.end('data: [DONE]\n\n');
    });
  });
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(server!.address() as AddressInfo).port}/v1`;
}

afterEach(async () => {
  bodies.length = 0;
  headers.length = 0;
  await new Promise((resolve) => server?.close(resolve));
  server = undefined;
});

const TRACE: LlmTrace = {
  traceId: 'a'.repeat(32),
  sessionId: 's1',
  name: 'chat-answer',
  tags: ['release:1.2.0', 'mode:answer'],
  release: '1.2.0',
  userId: 'c1',
};

async function call(sendMetadata: boolean): Promise<LlmEvent[]> {
  const llm = createLlmClient({
    apiKey: 'k',
    baseURL: await startServer(),
    model: 'm',
    temperature: 0.3,
    maxTokens: 100,
    sendMetadata,
  });
  const events: LlmEvent[] = [];
  for await (const event of llm.streamChat([{ role: 'user', content: 'q' }], undefined, {
    json: true,
    trace: TRACE,
  })) {
    events.push(event);
  }
  return events;
}

describe('createLlmClient', () => {
  it('с sendMetadata отдаёт trace в traceparent и metadata в формате LiteLLM', async () => {
    const events = await call(true);

    expect(headers[0]?.['traceparent']).toMatch(
      new RegExp(`^00-${TRACE.traceId}-[0-9a-f]{16}-01$`),
    );
    expect(bodies[0]?.['metadata']).toEqual({
      session_id: 's1',
      trace_name: 'chat-answer',
      generation_name: 'chat-answer',
      tags: ['release:1.2.0', 'mode:answer'],
      trace_release: '1.2.0',
      trace_user_id: 'c1',
    });
    // От metadata не должны пострадать параметры, на которых держатся стоимость и разбор.
    expect(bodies[0]).toMatchObject({
      response_format: { type: 'json_object' },
      stream_options: { include_usage: true },
    });
    expect(events).toEqual([
      { type: 'delta', text: 'ok' },
      { type: 'usage', usage: { promptTokens: 3, completionTokens: 1 } },
      { type: 'finish', reason: 'stop' },
    ]);
  });

  it('без sendMetadata metadata не отправляется', async () => {
    await call(false);

    expect(bodies[0]).not.toHaveProperty('metadata');
    expect(headers[0]).not.toHaveProperty('traceparent');
  });
});
