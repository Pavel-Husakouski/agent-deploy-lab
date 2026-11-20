import { randomUUID } from 'node:crypto';
import { parseArgs } from 'node:util';

// Нагрузка на API во время canary: без запросов AnalysisTemplate нечего сравнивать.
// Каждый запрос — новый вопрос в новой сессии (один вызов LLM, самый дешёвый режим).
// Запуск: npm run load [-- --rate 20 --duration 600 --url http://localhost:13000]
const { values } = parseArgs({
  options: {
    url: { type: 'string', default: process.env['API_URL'] ?? 'http://localhost:13000' },
    // Запросов в минуту и длительность в секундах.
    rate: { type: 'string', default: '20' },
    duration: { type: 'string', default: '600' },
    role: { type: 'string', default: 'Node AWS Developer' },
  },
});
const rate = Number(values.rate);
const duration = Number(values.duration);
if (!(rate > 0) || !(duration > 0)) {
  console.error('--rate и --duration должны быть положительными числами');
  process.exit(2);
}

type Outcome = 'ok' | 'error' | 'http_error' | 'network';
const counts: Record<Outcome, number> = { ok: 0, error: 0, http_error: 0, network: 0 };

// Ответ API — SSE: итог запроса определяет последнее событие done или error.
async function one(): Promise<Outcome> {
  try {
    const res = await fetch(`${values.url}/chat`, {
      method: 'POST',
      // Новое соединение на каждый запрос: kube-proxy делит соединения, а не запросы, и с
      // keep-alive нагрузка прилипает к уже открытым соединениям со stable-подом.
      headers: { 'content-type': 'application/json', connection: 'close' },
      body: JSON.stringify({ sessionId: randomUUID(), role: values.role, mode: 'question' }),
      signal: AbortSignal.timeout(120_000),
    });
    if (!res.ok) return 'http_error';
    const body = await res.text();
    if (body.includes('event: done')) return 'ok';
    return 'error';
  } catch {
    return 'network';
  }
}

const started = Date.now();
const intervalMs = 60_000 / rate;
const inflight = new Set<Promise<void>>();
const report = () => {
  const sec = Math.round((Date.now() - started) / 1000);
  console.log(`${sec}s ${JSON.stringify(counts)}`);
};
const timer = setInterval(report, 30_000);

console.log(`${values.url}: ${rate} запросов/мин, ${duration}s`);
for (let i = 0; Date.now() - started < duration * 1000; i++) {
  const p = one().then((outcome) => {
    counts[outcome]++;
    inflight.delete(p);
  });
  inflight.add(p);
  // Запросы идут по расписанию, а не по готовности: медленный ответ не снижает частоту.
  const next = started + (i + 1) * intervalMs;
  await new Promise((r) => setTimeout(r, Math.max(0, next - Date.now())));
}
await Promise.all(inflight);
clearInterval(timer);
report();
