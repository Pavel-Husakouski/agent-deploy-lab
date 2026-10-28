import { z } from 'zod';

// Конфигурация API из переменных окружения. Ошибка валидации роняет процесс на старте.
const ConfigSchema = z.object({
  DEEPSEEK_API_KEY: z.string().min(1, 'DEEPSEEK_API_KEY не задан'),
  DEEPSEEK_BASE_URL: z.url().default('https://api.deepseek.com'),
  REDIS_URL: z.string().min(1).default('redis://localhost:6379'),
  MODEL_ID: z.string().min(1).default('deepseek-chat'),
  TEMPERATURE: z.coerce.number().min(0).max(2).default(0.3),
  MAX_TOKENS: z.coerce.number().int().positive().default(1024),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  HOST: z.string().default('0.0.0.0'),
  PROMPT_PATH: z.string().min(1).default('prompts/trainer-v1.md'),
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
