import { Redis } from 'ioredis';
import { loadConfig } from '../config.js';
import { RedisHistoryStore } from '../history.js';
import { createLangfuseScores } from '../langfuse.js';
import { createLlmClient } from '../llm.js';
import { createMetrics } from '../metrics.js';
import { loadRelease } from '../release.js';
import { buildApp } from './server.js';

// Точка входа API: собирает зависимости из конфигурации и запускает HTTP-сервер.
const config = loadConfig();
// Manifest и промпт читаются из текущего каталога (корень репозитория или /app в образе).
const release = await loadRelease();
const { model } = release.manifest;

const redis = new Redis(config.REDIS_URL, { maxRetriesPerRequest: 2 });
const metrics = createMetrics(release.manifest, { collectDefault: true });
// Пропуск записей считается в метрике; лог — через app.log, который появится ниже.
const store = new RedisHistoryStore(redis, undefined, (schemaVersion) => {
  metrics.historySkipped.inc({ schema_version: schemaVersion });
  app.log.warn({ schemaVersion }, 'запись истории пропущена: формат не поддерживается');
});

const app = buildApp({
  llm: createLlmClient({
    apiKey: config.LLM_API_KEY,
    baseURL: config.LLM_BASE_URL,
    model: model.id,
    temperature: model.temperature,
    maxTokens: model.maxTokens,
    sendMetadata: config.LLM_METADATA,
  }),
  store,
  release,
  metrics,
  ...(config.LANGFUSE_HOST &&
    config.LANGFUSE_PUBLIC_KEY &&
    config.LANGFUSE_SECRET_KEY && {
      scores: createLangfuseScores({
        host: config.LANGFUSE_HOST,
        publicKey: config.LANGFUSE_PUBLIC_KEY,
        secretKey: config.LANGFUSE_SECRET_KEY,
      }),
    }),
  faultErrorRate: config.FAULT_ERROR_RATE,
  logger: { level: process.env['LOG_LEVEL'] ?? 'info' },
});

if (config.FAULT_ERROR_RATE > 0) {
  app.log.warn({ rate: config.FAULT_ERROR_RATE }, 'включён учебный сбой FAULT_ERROR_RATE');
}

redis.on('error', (err) => {
  // Без обработчика ioredis пишет необработанные ошибки; переподключение идёт само.
  app.log.warn({ err: err.message }, 'ошибка соединения с Redis');
});

async function shutdown(signal: string): Promise<void> {
  app.log.info({ signal }, 'остановка');
  await app.close();
  redis.disconnect();
  process.exit(0);
}
process.once('SIGTERM', () => void shutdown('SIGTERM'));
process.once('SIGINT', () => void shutdown('SIGINT'));

await app.listen({ port: config.PORT, host: config.HOST });
app.log.info(
  { release: release.manifest.version, model: model.id, prompt: release.manifest.prompt.id },
  'API запущен',
);
