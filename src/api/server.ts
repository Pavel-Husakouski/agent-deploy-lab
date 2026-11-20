import { randomBytes } from 'node:crypto';
import Fastify, { type FastifyInstance, type FastifyServerOptions } from 'fastify';
import { z } from 'zod';
import { makeRecordV2, type HistoryStore } from '../history.js';
import type { ScoreSink } from '../langfuse.js';
import type { LlmClient, LlmTrace } from '../llm.js';
import { createMetrics, type Metrics } from '../metrics.js';
import { buildMessages, IdSchema, RoleSchema, userText } from '../prompt.js';
import type { Release } from '../release.js';
import { renderReview, requestReview, type Review } from '../review.js';

export interface AppDeps {
  llm: LlmClient;
  store: HistoryStore;
  release: Release;
  // Если не передан, создаётся Registry без стандартных метрик процесса.
  metrics?: Metrics;
  // Куда отправлять оценку разбора (Langfuse). Без него оценка есть только в метриках.
  scores?: ScoreSink;
  // Учебный сбой для показа автоотката canary: доля /chat, которая падает до вызова LLM.
  faultErrorRate?: number;
  // Источник случайности для faultErrorRate, в тестах подменяется.
  random?: () => number;
  logger?: FastifyServerOptions['logger'];
}

export const FAULT_MESSAGE = 'учебный сбой (FAULT_ERROR_RATE)';

const ChatBaseShape = {
  sessionId: IdSchema,
  role: RoleSchema,
};

// question начинает сессию и обходится без сообщения, остальные режимы относятся к её вопросу.
// clarify идёт до ответа и не раскрывает его, discuss — после разбора. Режим задаёт клиент явно:
// текст сообщения не должен влиять на то, можно ли раскрывать ответ. clientId переживает сессию:
// по нему API помнит заданные вопросы, без него вопросы могут повторяться.
export const ChatRequestSchema = z.discriminatedUnion('mode', [
  z.strictObject({ ...ChatBaseShape, mode: z.literal('question'), clientId: IdSchema.optional() }),
  z.strictObject({
    ...ChatBaseShape,
    mode: z.enum(['clarify', 'answer', 'discuss']),
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
  const faultErrorRate = deps.faultErrorRate ?? 0;
  const random = deps.random ?? Math.random;

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
    const clientId = turn.mode === 'question' ? turn.clientId : undefined;

    // История читается до начала SSE: если Redis недоступен, клиент получит обычный 503.
    let history;
    let asked: string[] = [];
    try {
      history = await deps.store.read(sessionId);
      if (clientId) asked = await deps.store.readAsked(clientId, role);
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

    const messages = buildMessages(promptTemplate, role, turn, history, asked);
    const meta = { mode, release: manifest.version };
    const userRecord = makeRecordV2('user', meta, { content: userText(turn) });
    const trace: LlmTrace = {
      traceId: randomBytes(16).toString('hex'),
      sessionId,
      name: `chat-${mode}`,
      tags: [
        `release:${manifest.version}`,
        `prompt:${manifest.prompt.id}`,
        `model:${manifest.model.id}`,
        `mode:${mode}`,
      ],
      release: manifest.version,
      ...(clientId && { userId: clientId }),
    };
    // По traceId запрос из лога API находится в Langfuse.
    req.log.info({ traceId: trace.traceId, mode }, 'вызов LLM');

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
    let review: Review | undefined;
    // Один вызов LLM: onDelta получает фрагменты по мере прихода, результат — весь текст.
    const generate = async (onDelta: (text: string) => void, json = false): Promise<string> => {
      let text = '';
      for await (const event of deps.llm.streamChat(messages, abort.signal, { json, trace })) {
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
        text += event.text;
        onDelta(event.text);
      }
      return text;
    };
    try {
      // Падает как ошибка LLM (status=error, event: error), но без вызова и его стоимости.
      if (faultErrorRate > 0 && random() < faultErrorRate) throw new Error(FAULT_MESSAGE);
      if (mode === 'answer') {
        // Разбор приходит JSON: клиенту он уходит одним событием после проверки схемы, в
        // историю пишется объектом (v2), а discuss видит его markdown после чтения.
        review = await requestReview(
          () => generate(() => {}, true),
          (text, reason) => {
            metrics.invalidOutput.inc();
            // Только причина и длина: текст ответа может содержать данные кандидата.
            req.log.warn(
              { reason: reason.slice(0, 300), length: text.length },
              'разбор не прошёл схему',
            );
          },
        );
        if (review.kind === 'review') {
          metrics.reviewScore.observe(review.score);
          // Не ждём: Langfuse — наблюдаемость, его сбой не должен задерживать или ломать ответ.
          deps.scores
            ?.record({ traceId: trace.traceId, name: 'review_score', value: review.score })
            .catch((err: unknown) => {
              req.log.warn({ err }, 'не удалось отправить score в Langfuse');
            });
        }
        answer = renderReview(review);
        raw.write(sseEvent(review, 'review'));
      } else {
        answer = await generate((text) => raw.write(sseEvent({ delta: text })));
      }
      // Обе реплики сохраняются только после успешного завершения стрима.
      const assistantRecord = makeRecordV2(
        'assistant',
        meta,
        review ? { review } : { content: answer },
      );
      await deps.store.append(sessionId, [userRecord, assistantRecord]);
      if (clientId) {
        // Вопрос уже показан: сбой записи не должен ломать тренировку, худшее — один повтор.
        await deps.store.addAsked(clientId, role, answer).catch((err: unknown) => {
          req.log.warn({ err }, 'не удалось сохранить заданный вопрос');
        });
      }
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
