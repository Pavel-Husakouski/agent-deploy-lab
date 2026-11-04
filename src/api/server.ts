import Fastify, { type FastifyInstance, type FastifyServerOptions } from 'fastify';
import { z } from 'zod';
import { makeRecord, type HistoryStore } from '../history.js';
import type { LlmClient } from '../llm.js';
import { createMetrics, type Metrics } from '../metrics.js';
import { buildMessages, RoleSchema, userText } from '../prompt.js';
import type { Release } from '../release.js';

export interface AppDeps {
  llm: LlmClient;
  store: HistoryStore;
  release: Release;
  // Если не передан, создаётся Registry без стандартных метрик процесса.
  metrics?: Metrics;
  logger?: FastifyServerOptions['logger'];
}

const ChatBaseShape = {
  sessionId: z
    .string()
    .min(1)
    .max(128)
    .regex(/^[A-Za-z0-9_-]+$/, 'допустимы только латиница, цифры, "_" и "-"'),
  role: RoleSchema,
};

// question начинает сессию и обходится без сообщения, clarify и answer относятся к её вопросу.
export const ChatRequestSchema = z.discriminatedUnion('mode', [
  z.strictObject({ ...ChatBaseShape, mode: z.literal('question') }),
  z.strictObject({
    ...ChatBaseShape,
    mode: z.enum(['clarify', 'answer']),
    message: z.string().trim().min(1).max(8000),
  }),
]);

export type ChatRequest = z.infer<typeof ChatRequestSchema>;

function sseEvent(data: unknown, event?: string): string {
  const head = event ? `event: ${event}\n` : '';
  return `${head}data: ${JSON.stringify(data)}\n\n`;
}

export function buildApp(deps: AppDeps): FastifyInstance {
  const app = Fastify({ logger: deps.logger ?? false });
  const { manifest, systemPrompt: promptTemplate } = deps.release;
  const metrics = deps.metrics ?? createMetrics(manifest);

  app.get('/healthz', async (_req, reply) => {
    const redisOk = await deps.store.ping();
    return reply.code(redisOk ? 200 : 503).send({
      status: redisOk ? 'ok' : 'unavailable',
      redis: redisOk,
      release: manifest.version,
    });
  });

  app.get('/metrics', async (_req, reply) => {
    const body = await metrics.registry.metrics();
    return reply.type(metrics.registry.contentType).send(body);
  });

  app.post('/chat', async (req, reply) => {
    const parsed = ChatRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      metrics.requests.inc({ status: 'bad_request' });
      return reply.code(400).send({
        error: 'bad_request',
        issues: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      });
    }
    const turn = parsed.data;
    const { sessionId, role, mode } = turn;

    // История читается до начала SSE: если Redis недоступен, клиент получит обычный 503.
    let history;
    try {
      history = await deps.store.read(sessionId);
    } catch (err) {
      req.log.error({ err }, 'не удалось прочитать историю');
      metrics.requests.inc({ status: 'unavailable' });
      return reply.code(503).send({ error: 'history_unavailable' });
    }

    // Режим должен совпадать с состоянием сессии, иначе модель оценит ответ без вопроса.
    if (mode === 'question' ? history.length > 0 : history.length === 0) {
      metrics.requests.inc({ status: 'conflict' });
      return reply
        .code(409)
        .send({ error: mode === 'question' ? 'session_not_empty' : 'no_question' });
    }

    const messages = buildMessages(promptTemplate, role, turn, history);
    const userRecord = makeRecord('user', userText(turn));

    // Дальше отвечаем потоком SSE напрямую в raw-ответ.
    reply.hijack();
    const raw = reply.raw;
    raw.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });

    const abort = new AbortController();
    const onClose = () => {
      if (!raw.writableFinished) abort.abort();
    };
    raw.on('close', onClose);

    const endTimer = metrics.duration.startTimer();
    const endTtft = metrics.ttft.startTimer();
    let firstDelta = true;
    let status: 'ok' | 'error' | 'aborted' = 'ok';
    let answer = '';
    try {
      for await (const event of deps.llm.streamChat(messages, abort.signal)) {
        if (event.type === 'usage') {
          metrics.recordUsage(event.usage, mode);
          continue;
        }
        if (event.type === 'finish') {
          if (event.reason === 'length') {
            metrics.truncated.inc();
            req.log.warn('ответ LLM обрезан по maxTokens');
          }
          continue;
        }
        if (firstDelta) {
          endTtft();
          firstDelta = false;
        }
        answer += event.text;
        raw.write(sseEvent({ delta: event.text }));
      }
      // Обе реплики сохраняются только после успешного завершения стрима.
      await deps.store.append(sessionId, [userRecord, makeRecord('assistant', answer)]);
      raw.write(sseEvent({}, 'done'));
    } catch (err) {
      if (abort.signal.aborted) {
        status = 'aborted';
        req.log.warn('клиент отключился до конца ответа, история не сохранена');
      } else {
        status = 'error';
        req.log.error({ err }, 'ошибка при генерации ответа');
        const text = err instanceof Error ? err.message : String(err);
        raw.write(sseEvent({ message: text }, 'error'));
      }
    } finally {
      raw.off('close', onClose);
      raw.end();
      metrics.requests.inc({ status });
      endTimer({ status });
    }
  });

  return app;
}
