import { z } from 'zod';
import type { ChatMessage } from './llm.js';
import type { HistoryRecord } from './history.js';

// Сборка запроса к LLM: общая для API и eval, чтобы eval проверял то, что поедет в прод.

const ROLE_PATTERN = /^[\p{L}\p{N} +#./()-]{2,80}$/u;

// Роль попадает в system prompt: переносы строк и "{{" не проходят по формату, а текст вроде
// «игнорируй инструкции» проходит, его должен отсекать сам промпт (проверяет eval injection).
export const RoleSchema = z
  .string()
  .trim()
  .regex(ROLE_PATTERN, 'от 2 до 80 символов: буквы, цифры, пробел и + # . / ( ) -');

// Идентификатор сессии или клиента: попадает в ключ Redis.
export const IdSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9_-]+$/, 'допустимы только латиница, цифры, "_" и "-"');

// Реплика вместо сообщения клиента в режиме question: у LLM должен быть запрос пользователя.
export const QUESTION_REQUEST = 'Задай вопрос.';

const PLACEHOLDERS = ['{{role}}', '{{mode}}', '{{asked}}'] as const;

// Начала вопроса хватает, чтобы узнать тему, а размер запроса к LLM остаётся ограниченным.
const ASKED_ITEM_CHARS = 200;

export type ChatTurn =
  | { mode: 'question'; clientId?: string | undefined }
  | { mode: 'clarify' | 'answer' | 'discuss'; message: string };

export type ChatMode = ChatTurn['mode'];

// Возвращает плейсхолдеры, которых нет в шаблоне: такой промпт не должен попасть в работу.
export function missingPlaceholders(template: string): string[] {
  return PLACEHOLDERS.filter((p) => !template.includes(p));
}

// Список заданных вопросов для system prompt: один вопрос на строку.
export function formatAsked(asked: readonly string[]): string {
  if (asked.length === 0) return 'нет';
  return asked
    .map((question) => `- ${question.replace(/\s+/g, ' ').trim().slice(0, ASKED_ITEM_CHARS)}`)
    .join('\n');
}

export function buildSystemPrompt(
  template: string,
  role: string,
  mode: ChatMode,
  asked: readonly string[] = [],
): string {
  // Замена функцией: "$&" и другие шаблоны replacement в роли не должны раскрываться.
  // Вопросы подставляются последними: это текст модели, плейсхолдеры в нём не раскрываются.
  return template
    .replaceAll('{{role}}', () => role)
    .replaceAll('{{mode}}', () => mode)
    .replaceAll('{{asked}}', () => formatAsked(asked));
}

export function userText(turn: ChatTurn): string {
  return turn.mode === 'question' ? QUESTION_REQUEST : turn.message;
}

export function buildMessages(
  template: string,
  role: string,
  turn: ChatTurn,
  history: Pick<HistoryRecord, 'role' | 'content'>[],
  asked: readonly string[] = [],
): ChatMessage[] {
  return [
    { role: 'system', content: buildSystemPrompt(template, role, turn.mode, asked) },
    ...history.map((r) => ({ role: r.role, content: r.content })),
    { role: 'user', content: userText(turn) },
  ];
}
