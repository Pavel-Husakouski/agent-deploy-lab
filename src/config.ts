import { z } from 'zod';

// Конфигурация окружения API. Модель, параметры и промпт задаёт release.json (src/release.ts),
// а не env: иначе запущенный процесс может тихо разойтись с релизом.
//
// LLM_* — OpenAI-совместимый endpoint: DeepSeek напрямую (docker compose, eval в CI) или
// LiteLLM Proxy в кластере. DEEPSEEK_API_KEY и DEEPSEEK_BASE_URL остаются запасными именами,
// чтобы compose и CI работали без правок.
const ConfigSchema = z
  .object({
    LLM_API_KEY: z.string().min(1, 'LLM_API_KEY (или DEEPSEEK_API_KEY) не задан'),
    LLM_BASE_URL: z.url().default('https://api.deepseek.com'),
    // metadata запроса (trace, сессия, теги) понимает LiteLLM, DeepSeek напрямую — нет.
    LLM_METADATA: z.stringbool().default(false),
    // Langfuse нужен только для score разбора, трейсы пишет LiteLLM. Все три или ни одного.
    LANGFUSE_HOST: z.url().optional(),
    LANGFUSE_PUBLIC_KEY: z.string().min(1).optional(),
    LANGFUSE_SECRET_KEY: z.string().min(1).optional(),
    REDIS_URL: z.string().min(1).default('redis://localhost:6379'),
    PORT: z.coerce.number().int().min(1).max(65535).default(13000),
    HOST: z.string().default('0.0.0.0'),
  })
  .refine(
    (c) => {
      const set = [c.LANGFUSE_HOST, c.LANGFUSE_PUBLIC_KEY, c.LANGFUSE_SECRET_KEY].filter(Boolean);
      return set.length === 0 || set.length === 3;
    },
    { path: ['LANGFUSE_HOST'], message: 'LANGFUSE_* задаются все три или ни одного' },
  );

export type Config = z.infer<typeof ConfigSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = ConfigSchema.safeParse({
    ...env,
    LLM_API_KEY: env['LLM_API_KEY'] ?? env['DEEPSEEK_API_KEY'],
    LLM_BASE_URL: env['LLM_BASE_URL'] ?? env['DEEPSEEK_BASE_URL'],
  });
  if (!parsed.success) {
    // В сообщении только имена полей и причины, значения (в том числе ключ) не печатаем.
    const issues = parsed.error.issues
      .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
      .join('; ');
    throw new Error(`Некорректная конфигурация: ${issues}`);
  }
  return parsed.data;
}
