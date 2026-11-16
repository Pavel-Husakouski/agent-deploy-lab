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

// Причина конца генерации: stop — модель закончила сама, length — упёрлась в maxTokens.
export type FinishReason = 'stop' | 'length' | (string & {});

// События стрима: фрагменты текста, в конце — расход токенов (если провайдер его отдал)
// и причина конца генерации.
export type LlmEvent =
  | { type: 'delta'; text: string }
  | { type: 'usage'; usage: TokenUsage }
  | { type: 'finish'; reason: FinishReason };

// Привязка вызова к trace в Langfuse: все вызовы одного POST /chat (в том числе повтор
// разбора) попадают в один trace, сессии группируются по sessionId.
export interface LlmTrace {
  // 32 hex-символа: формат trace id в OpenTelemetry, через него LiteLLM пишет в Langfuse.
  traceId: string;
  sessionId: string;
  name: string;
  tags: string[];
  release: string;
  userId?: string;
}

// json: JSON mode провайдера, гарантирует валидный JSON, но не схему.
export interface StreamOptions {
  json?: boolean;
  trace?: LlmTrace;
}

// Абстракция над LLM: в тестах подменяется фейком, в проде — DeepSeek или LiteLLM Proxy.
export interface LlmClient {
  streamChat(
    messages: ChatMessage[],
    signal?: AbortSignal,
    options?: StreamOptions,
  ): AsyncIterable<LlmEvent>;
}

export interface LlmClientOptions {
  apiKey: string;
  baseURL: string;
  model: string;
  temperature: number;
  maxTokens: number;
  // Отправлять trace в metadata запроса: его понимает LiteLLM, DeepSeek напрямую — нет.
  sendMetadata?: boolean;
}

// Поля metadata, которые LiteLLM передаёт в Langfuse (callback langfuse_otel).
export function traceMetadata(trace: LlmTrace): Record<string, unknown> {
  return {
    trace_id: trace.traceId,
    session_id: trace.sessionId,
    trace_name: trace.name,
    generation_name: trace.name,
    tags: trace.tags,
    trace_release: trace.release,
    ...(trace.userId && { trace_user_id: trace.userId }),
  };
}

export function createLlmClient(options: LlmClientOptions): LlmClient {
  // DeepSeek и LiteLLM совместимы с OpenAI Chat Completions API, поэтому используем пакет openai.
  const client = new OpenAI({ apiKey: options.apiKey, baseURL: options.baseURL });

  return {
    async *streamChat(messages, signal, streamOptions = {}) {
      const stream = await client.chat.completions.create(
        {
          model: options.model,
          temperature: options.temperature,
          max_tokens: options.maxTokens,
          messages,
          stream: true,
          ...(streamOptions.json && { response_format: { type: 'json_object' as const } }),
          // usage приходит в последнем чанке перед [DONE], в остальных чанках он null.
          stream_options: { include_usage: true },
          // В типах openai metadata — Record<string, string> (stored completions OpenAI), а LiteLLM
          // ждёт в tags массив, поэтому приведение типа.
          ...(options.sendMetadata &&
            streamOptions.trace && {
              metadata: traceMetadata(streamOptions.trace) as Record<string, string>,
            }),
        },
        { signal },
      );
      let finishReason: FinishReason | undefined;
      for await (const chunk of stream) {
        const choice = chunk.choices[0];
        const delta = choice?.delta?.content;
        if (delta) yield { type: 'delta', text: delta };
        if (choice?.finish_reason) finishReason = choice.finish_reason;
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
      if (finishReason) yield { type: 'finish', reason: finishReason };
    },
  };
}
