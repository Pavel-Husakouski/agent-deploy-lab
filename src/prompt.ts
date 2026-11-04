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

// Реплика вместо сообщения клиента в режиме question: у LLM должен быть запрос пользователя.
export const QUESTION_REQUEST = 'Задай вопрос.';

const PLACEHOLDERS = ['{{role}}', '{{mode}}'] as const;

export type ChatTurn = { mode: 'question' } | { mode: 'clarify' | 'answer'; message: string };

export type ChatMode = ChatTurn['mode'];

// Возвращает плейсхолдеры, которых нет в шаблоне: такой промпт не должен попасть в работу.
export function missingPlaceholders(template: string): string[] {
  return PLACEHOLDERS.filter((p) => !template.includes(p));
}

export function buildSystemPrompt(template: string, role: string, mode: ChatMode): string {
  // Замена функцией: "$&" и другие шаблоны replacement в роли не должны раскрываться.
  return template.replaceAll('{{role}}', () => role).replaceAll('{{mode}}', () => mode);
}

export function userText(turn: ChatTurn): string {
  return turn.mode === 'question' ? QUESTION_REQUEST : turn.message;
}

export function buildMessages(
  template: string,
  role: string,
  turn: ChatTurn,
  history: Pick<HistoryRecord, 'role' | 'content'>[],
): ChatMessage[] {
  return [
    { role: 'system', content: buildSystemPrompt(template, role, turn.mode) },
    ...history.map((r) => ({ role: r.role, content: r.content })),
    { role: 'user', content: userText(turn) },
  ];
}
