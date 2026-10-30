import { Redis } from 'ioredis';
import { loadConfig } from '../config.js';
import { RedisHistoryStore } from '../history.js';
import { createDeepSeekClient } from '../llm.js';
import { createMetrics } from '../metrics.js';
import { loadRelease } from '../release.js';
import { buildApp } from './server.js';

// Точка входа API: собирает зависимости из конфигурации и запускает HTTP-сервер.
const config = loadConfig();
// Manifest и промпт читаются из текущего каталога (корень репозитория или /app в образе).
const release = await loadRelease();
const { model } = release.manifest;

const redis = new Redis(config.REDIS_URL, { maxRetriesPerRequest: 2 });

const app = buildApp({
  llm: createDeepSeekClient({
    apiKey: config.DEEPSEEK_API_KEY,
    baseURL: config.DEEPSEEK_BASE_URL,
    model: model.id,
    temperature: model.temperature,
    maxTokens: model.maxTokens,
  }),
  store: new RedisHistoryStore(redis),
  release,
  metrics: createMetrics(release.manifest, { collectDefault: true }),
  logger: { level: process.env['LOG_LEVEL'] ?? 'info' },
});

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
