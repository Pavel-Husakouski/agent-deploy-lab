import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from 'prom-client';
import type { TokenUsage } from './llm.js';
import type { ReleaseManifest } from './release.js';

export type ChatStatus = 'ok' | 'error' | 'aborted' | 'bad_request' | 'unavailable';

export interface Metrics {
  registry: Registry;
  requests: Counter<'status'>;
  duration: Histogram<'status'>;
  ttft: Histogram;
  tokens: Counter<'type'>;
  costUsd: Counter;
  recordUsage(usage: TokenUsage): void;
}

// Отдельный Registry на экземпляр приложения: тесты поднимают несколько app в одном процессе.
// Default labels release/prompt/model попадают во все метрики, по ним canary-анализ (этап 6)
// сравнивает stable и новую версию.
export function createMetrics(
  manifest: ReleaseManifest,
  options: { collectDefault?: boolean } = {},
): Metrics {
  const registry = new Registry();
  registry.setDefaultLabels({
    release: manifest.version,
    prompt: manifest.prompt.id,
    model: manifest.model.id,
  });
  if (options.collectDefault) collectDefaultMetrics({ register: registry });

  const info = new Gauge({
    name: 'agent_release_info',
    help: 'Manifest текущего релиза, значение всегда 1',
    labelNames: ['version', 'model_id', 'prompt_id', 'prompt_sha256', 'eval_dataset'],
    registers: [registry],
  });
  info.set(
    {
      version: manifest.version,
      model_id: manifest.model.id,
      prompt_id: manifest.prompt.id,
      prompt_sha256: manifest.prompt.sha256,
      eval_dataset: manifest.evalDataset,
    },
    1,
  );

  const requests = new Counter({
    name: 'agent_chat_requests_total',
    help: 'Запросы POST /chat по итогу обработки',
    labelNames: ['status'] as const,
    registers: [registry],
  });
  const duration = new Histogram({
    name: 'agent_chat_duration_seconds',
    help: 'Время ответа POST /chat от запроса до конца стрима',
    labelNames: ['status'] as const,
    buckets: [0.5, 1, 2, 5, 10, 20, 30, 60, 120],
    registers: [registry],
  });
  const ttft = new Histogram({
    name: 'agent_chat_ttft_seconds',
    help: 'Время до первого фрагмента ответа LLM',
    buckets: [0.1, 0.25, 0.5, 1, 2, 5, 10, 20],
    registers: [registry],
  });
  const tokens = new Counter({
    name: 'agent_llm_tokens_total',
    help: 'Токены LLM по данным usage провайдера',
    labelNames: ['type'] as const,
    registers: [registry],
  });
  const costUsd = new Counter({
    name: 'agent_llm_cost_usd_total',
    help: 'Оценка стоимости запросов к LLM в USD по pricing из release.json',
    registers: [registry],
  });

  const { inputPerMTok, outputPerMTok } = manifest.model.pricing;
  return {
    registry,
    requests,
    duration,
    ttft,
    tokens,
    costUsd,
    recordUsage(usage) {
      tokens.inc({ type: 'prompt' }, usage.promptTokens);
      tokens.inc({ type: 'completion' }, usage.completionTokens);
      // Скидка за cache hit не учитывается: стоимость — оценка сверху.
      costUsd.inc(
        (usage.promptTokens * inputPerMTok + usage.completionTokens * outputPerMTok) / 1e6,
      );
    },
  };
}
