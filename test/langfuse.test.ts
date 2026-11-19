import { describe, expect, it } from 'vitest';
import { createLangfuseScores } from '../src/langfuse.js';

describe('createLangfuseScores', () => {
  it('шлёт score в public API с basic auth', async () => {
    const requests: { url: string; init: RequestInit }[] = [];
    const sink = createLangfuseScores({
      host: 'http://langfuse:3000',
      publicKey: 'pk-lf-1',
      secretKey: 'sk-lf-1',
      fetch: async (url, init) => {
        requests.push({ url: String(url), init: init! });
        return new Response('{}', { status: 200 });
      },
    });

    await sink.record({ traceId: 't1', name: 'review_score', value: 7 });

    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe('http://langfuse:3000/api/public/scores');
    const headers = requests[0]?.init.headers as Record<string, string>;
    expect(headers['authorization']).toBe(
      `Basic ${Buffer.from('pk-lf-1:sk-lf-1').toString('base64')}`,
    );
    expect(JSON.parse(String(requests[0]?.init.body))).toEqual({
      traceId: 't1',
      name: 'review_score',
      value: 7,
      dataType: 'NUMERIC',
    });
  });

  it('ответ не 2xx — ошибка', async () => {
    const sink = createLangfuseScores({
      host: 'http://langfuse:3000',
      publicKey: 'pk',
      secretKey: 'sk',
      fetch: async () => new Response('nope', { status: 401 }),
    });

    await expect(sink.record({ traceId: 't', name: 'n', value: 1 })).rejects.toThrow(/401/);
  });
});
