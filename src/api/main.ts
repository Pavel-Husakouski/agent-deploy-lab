import { readFile } from 'node:fs/promises';
import { Redis } from 'ioredis';
import { loadConfig } from '../config.js';
import { RedisHistoryStore } from '../history.js';
import { createDeepSeekClient } from '../llm.js';
import { buildApp } from './server.js';

// Точка входа API: собирает зависимости из конфигурации и запускает HTTP-сервер.
const config = loadConfig();
const systemPrompt = await readFile(config.PROMPT_PATH, 'utf8');

const redis = new Redis(config.REDIS_URL, { maxRetriesPerRequest: 2 });

const app = buildApp({
  llm: createDeepSeekClient({
    apiKey: config.DEEPSEEK_API_KEY,
    baseURL: config.DEEPSEEK_BASE_URL,
    model: config.MODEL_ID,
    temperature: config.TEMPERATURE,
    maxTokens: config.MAX_TOKENS,
  }),
  store: new RedisHistoryStore(redis),
  systemPrompt,
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
app.log.info({ model: config.MODEL_ID, prompt: config.PROMPT_PATH }, 'API запущен');
