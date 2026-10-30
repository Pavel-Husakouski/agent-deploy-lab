import OpenAI from 'openai';

export type ChatRole = 'system' | 'user' | 'assistant';

export interface ChatMessage {
  role: ChatRole;
  content: string;
}

export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
}

// События стрима: фрагменты текста, в конце — расход токенов (если провайдер его отдал).
export type LlmEvent = { type: 'delta'; text: string } | { type: 'usage'; usage: TokenUsage };

// Абстракция над LLM: в тестах подменяется фейком, в проде — DeepSeek.
export interface LlmClient {
  streamChat(messages: ChatMessage[], signal?: AbortSignal): AsyncIterable<LlmEvent>;
}

export interface DeepSeekOptions {
  apiKey: string;
  baseURL: string;
  model: string;
  temperature: number;
  maxTokens: number;
}

export function createDeepSeekClient(options: DeepSeekOptions): LlmClient {
  // DeepSeek совместим с OpenAI Chat Completions API, поэтому используем пакет openai.
  const client = new OpenAI({ apiKey: options.apiKey, baseURL: options.baseURL });

  return {
    async *streamChat(messages, signal) {
      const stream = await client.chat.completions.create(
        {
          model: options.model,
          temperature: options.temperature,
          max_tokens: options.maxTokens,
          messages,
          stream: true,
          // usage приходит в последнем чанке перед [DONE], в остальных чанках он null.
          stream_options: { include_usage: true },
        },
        { signal },
      );
      for await (const chunk of stream) {
        const delta = chunk.choices[0]?.delta?.content;
        if (delta) yield { type: 'delta', text: delta };
        if (chunk.usage) {
          yield {
            type: 'usage',
            usage: {
              promptTokens: chunk.usage.prompt_tokens,
              completionTokens: chunk.usage.completion_tokens,
            },
          };
        }
      }
    },
  };
}
