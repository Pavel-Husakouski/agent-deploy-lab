// Score в Langfuse: оценка разбора привязывается к trace вызова, который записал LiteLLM.
// Так в Langfuse видно качество по релизам и промптам, а не только токены и задержку.
// Без SDK: один POST в public API, ответ клиенту от него не зависит.

export interface Score {
  traceId: string;
  name: string;
  value: number;
}

export interface ScoreSink {
  record(score: Score): Promise<void>;
}

export interface LangfuseOptions {
  host: string;
  publicKey: string;
  secretKey: string;
  timeoutMs?: number;
  fetch?: typeof globalThis.fetch;
}

export function createLangfuseScores(options: LangfuseOptions): ScoreSink {
  const doFetch = options.fetch ?? globalThis.fetch;
  const url = new URL('/api/public/scores', options.host).toString();
  const auth = Buffer.from(`${options.publicKey}:${options.secretKey}`).toString('base64');

  return {
    async record(score) {
      const res = await doFetch(url, {
        method: 'POST',
        headers: { authorization: `Basic ${auth}`, 'content-type': 'application/json' },
        body: JSON.stringify({ ...score, dataType: 'NUMERIC' }),
        signal: AbortSignal.timeout(options.timeoutMs ?? 5000),
      });
      if (!res.ok) throw new Error(`Langfuse ответил ${res.status}`);
    },
  };
}
