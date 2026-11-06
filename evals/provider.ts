import { fileURLToPath } from 'node:url';
import { loadConfig } from '../src/config.js';
import {
  createDeepSeekClient,
  type FinishReason,
  type TokenUsage,
} from '../src/llm.js';
import { buildMessages, RoleSchema, type ChatTurn } from '../src/prompt.js';
import { estimateCostUsd, loadRelease } from '../src/release.js';
import { requestReview } from '../src/review.js';

// Custom provider для promptfoo: проверяется ровно тот релиз, который поедет в прод.
// Промпт, модель, параметры и pricing берутся из release.json, вызов LLM — через src/llm.ts.
//
// Vars теста:
//   role — название роли, те же правила формата, что в API;
//   mode — режим хода: question, clarify, answer или discuss;
//   history — предыдущие реплики диалога [{ role: 'user' | 'assistant', content }], опционально;
//   asked — уже заданные вопросы, по одному на строку, опционально: promptfoo размножает тест
//     по массиву строк, поэтому это текст, а не массив;
//   message — сообщение пользователя (оно же prompt в конфиге promptfoo), в question не нужно.
//
// В режиме answer output — JSON разбора после проверки схемы (с тем же повтором, что в API),
// токены и стоимость суммируются по всем попыткам.

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));

interface ProviderContext {
  vars: Record<string, unknown>;
}

interface ProviderResponse {
  output?: string;
  error?: string;
  tokenUsage?: { total: number; prompt: number; completion: number };
  cost?: number;
  // Проверяется assertion finish-reason: length означает, что ответ обрезан по maxTokens.
  finishReason?: string;
  metadata?: Record<string, unknown>;
}

function parseHistory(value: unknown): { role: 'user' | 'assistant'; content: string }[] {
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

function parseAsked(value: unknown): string[] {
  if (value === undefined) return [];
  if (typeof value !== 'string') throw new Error('vars.asked должен быть строкой');
  return value.split('\n').filter((line) => line.trim() !== '');
}

function parseTurn(mode: unknown, message: string): ChatTurn {
  if (mode === 'question') return { mode };
  if (mode === 'clarify' || mode === 'answer' || mode === 'discuss') return { mode, message };
  throw new Error('vars.mode: ожидается question, clarify, answer или discuss');
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

    const messages = buildMessages(
      systemPrompt,
      RoleSchema.parse(context?.vars['role']),
      parseTurn(context?.vars['mode'], prompt),
      parseHistory(context?.vars['history']),
      parseAsked(context?.vars['asked']),
    );

    let usage: TokenUsage | undefined;
    let finishReason: FinishReason | undefined;
    const generate = async (json = false): Promise<string> => {
      let text = '';
      for await (const event of llm.streamChat(messages, undefined, { json })) {
        if (event.type === 'delta') text += event.text;
        else if (event.type === 'usage') {
          usage = {
            promptTokens: (usage?.promptTokens ?? 0) + event.usage.promptTokens,
            completionTokens: (usage?.completionTokens ?? 0) + event.usage.completionTokens,
          };
        } else finishReason = event.reason;
      }
      return text;
    };

    let output: string;
    if (context?.vars['mode'] === 'answer') {
      try {
        output = JSON.stringify(await requestReview(() => generate(true)));
      } catch (err) {
        return { error: err instanceof Error ? err.message : String(err) };
      }
    } else {
      output = await generate();
    }

    return {
      output,
      ...(finishReason && { finishReason }),
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
