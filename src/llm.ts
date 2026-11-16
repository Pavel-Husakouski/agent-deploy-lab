import { randomBytes } from 'node:crypto';
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
  // 32 hex-символа: trace id OpenTelemetry. LiteLLM пишет в Langfuse через OTel и берёт его
  // только из заголовка traceparent, поле trace_id в metadata игнорирует.
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
    session_id: trace.sessionId,
    trace_name: trace.name,
    generation_name: trace.name,
    tags: trace.tags,
    trace_release: trace.release,
    ...(trace.userId && { trace_user_id: trace.userId }),
  };
}

// W3C traceparent: trace id запроса и случайный span id вызова. Span агента в Langfuse не
// экспортируется, generation LiteLLM ссылается на него как на родителя.
export function traceparent(trace: LlmTrace): string {
  return `00-${trace.traceId}-${randomBytes(8).toString('hex')}-01`;
}

export function createLlmClient(options: LlmClientOptions): LlmClient {
  // DeepSeek и LiteLLM совместимы с OpenAI Chat Completions API, поэтому используем пакет openai.
  const client = new OpenAI({ apiKey: options.apiKey, baseURL: options.baseURL });

  return {
    async *streamChat(messages, signal, streamOptions = {}) {
      const trace = options.sendMetadata ? streamOptions.trace : undefined;
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
          ...(trace && { metadata: traceMetadata(trace) as Record<string, string> }),
        },
        { signal, ...(trace && { headers: { traceparent: traceparent(trace) } }) },
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
