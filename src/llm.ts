import OpenAI from 'openai';

export type ChatRole = 'system' | 'user' | 'assistant';

export interface ChatMessage {
  role: ChatRole;
  content: string;
}

// Абстракция над LLM: в тестах подменяется фейком, в проде — DeepSeek.
export interface LlmClient {
  streamChat(messages: ChatMessage[], signal?: AbortSignal): AsyncIterable<string>;
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
        },
        { signal },
      );
      for await (const chunk of stream) {
        const delta = chunk.choices[0]?.delta?.content;
        if (delta) yield delta;
      }
    },
  };
}
