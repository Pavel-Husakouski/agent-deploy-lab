import { z } from 'zod';

// Конфигурация окружения API. Модель, параметры и промпт задаёт release.json (src/release.ts),
// а не env: иначе запущенный процесс может тихо разойтись с релизом.
const ConfigSchema = z.object({
  DEEPSEEK_API_KEY: z.string().min(1, 'DEEPSEEK_API_KEY не задан'),
  DEEPSEEK_BASE_URL: z.url().default('https://api.deepseek.com'),
  REDIS_URL: z.string().min(1).default('redis://localhost:6379'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  HOST: z.string().default('0.0.0.0'),
});

export type Config = z.infer<typeof ConfigSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = ConfigSchema.safeParse(env);
  if (!parsed.success) {
    // В сообщении только имена полей и причины, значения (в том числе ключ) не печатаем.
    const issues = parsed.error.issues
      .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
      .join('; ');
    throw new Error(`Некорректная конфигурация: ${issues}`);
  }
  return parsed.data;
}
