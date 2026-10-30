import { fileURLToPath } from 'node:url';
import { loadConfig } from '../src/config.js';
import { createDeepSeekClient, type ChatMessage, type TokenUsage } from '../src/llm.js';
import { estimateCostUsd, loadRelease } from '../src/release.js';

// Custom provider для promptfoo: проверяется ровно тот релиз, который поедет в прод.
// Промпт, модель, параметры и pricing берутся из release.json, вызов LLM — через src/llm.ts.
//
// Vars теста:
//   history — предыдущие реплики диалога [{ role: 'user' | 'assistant', content }], опционально;
//   message — новое сообщение пользователя (оно же prompt в конфиге promptfoo).

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));

interface ProviderContext {
  vars: Record<string, unknown>;
}

interface ProviderResponse {
  output?: string;
  error?: string;
  tokenUsage?: { total: number; prompt: number; completion: number };
  cost?: number;
  metadata?: Record<string, unknown>;
}

function parseHistory(value: unknown): ChatMessage[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error('vars.history должен быть массивом реплик');
  return value.map((item, i) => {
    const { role, content } = (item ?? {}) as Record<string, unknown>;
    if ((role !== 'user' && role !== 'assistant') || typeof content !== 'string') {
      throw new Error(`vars.history[${i}]: ожидается { role: user | assistant, content }`);
    }
    return { role, content };
  });
}

export default class TrainerReleaseProvider {
  id(): string {
    return 'trainer-release';
  }

  async callApi(prompt: string, context?: ProviderContext): Promise<ProviderResponse> {
    // Manifest читается на каждый вызов: файлы маленькие, зато нет состояния между тестами.
    const { manifest, systemPrompt } = await loadRelease(REPO_ROOT);
    // Из конфигурации API нужны только ключ и base URL, остальное задаёт manifest.
    const config = loadConfig();
    const llm = createDeepSeekClient({
      apiKey: config.DEEPSEEK_API_KEY,
      baseURL: config.DEEPSEEK_BASE_URL,
      model: manifest.model.id,
      temperature: manifest.model.temperature,
      maxTokens: manifest.model.maxTokens,
    });

    const messages: ChatMessage[] = [
      { role: 'system', content: systemPrompt },
      ...parseHistory(context?.vars['history']),
      { role: 'user', content: prompt },
    ];

    let output = '';
    let usage: TokenUsage | undefined;
    for await (const event of llm.streamChat(messages)) {
      if (event.type === 'delta') output += event.text;
      else usage = event.usage;
    }

    return {
      output,
      ...(usage && {
        tokenUsage: {
          total: usage.promptTokens + usage.completionTokens,
          prompt: usage.promptTokens,
          completion: usage.completionTokens,
        },
        cost: estimateCostUsd(usage, manifest.model.pricing),
      }),
      metadata: { release: manifest.version, prompt: manifest.prompt.id, model: manifest.model.id },
    };
  }
}
