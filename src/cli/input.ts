// Разбор строки ввода CLI. Сообщение с "?" в начале — уточнение, без него — ответ на вопрос.
export type CliInput =
  | { kind: 'empty' }
  | { kind: 'exit' }
  | { kind: 'new' }
  | { kind: 'role'; role: string }
  | { kind: 'clarify'; text: string }
  | { kind: 'answer'; text: string }
  | { kind: 'hint'; text: string };

// Этап тренировки в текущей сессии.
export type Stage = 'no_question' | 'awaiting_answer' | 'reviewed';

export type CliAction =
  | { kind: 'none' }
  | { kind: 'exit' }
  | { kind: 'next_question' }
  // Вопроса нет, поэтому сообщение не отправляется, а вопрос запрашивается снова.
  | { kind: 'retry_question' }
  | { kind: 'set_role'; role: string }
  | { kind: 'send'; mode: 'clarify' | 'answer' | 'discuss'; text: string }
  | { kind: 'hint'; text: string };

export const REVIEWED_HINT = 'Enter — следующий вопрос, "? текст" — спросить по разбору.';

const CLARIFY_HINT = 'Напишите уточнение после "?", например: ? что значит idempotent';
const ROLE_HINT = 'Укажите роль: /role Node AWS Developer';

export function parseInput(input: string): CliInput {
  const line = input.trim();
  if (!line) return { kind: 'empty' };
  if (line.startsWith('?')) {
    const text = line.slice(1).trim();
    return text ? { kind: 'clarify', text } : { kind: 'hint', text: CLARIFY_HINT };
  }
  // Команда — одно слово после "/": ответ вроде "/etc/hosts ..." командой не считается.
  const command = /^\/([a-z]+)(?:\s+(.*))?$/i.exec(line);
  if (!command) return { kind: 'answer', text: line };
  switch (command[1]) {
    case 'exit':
      return { kind: 'exit' };
    case 'new':
      return { kind: 'new' };
    case 'role':
      return command[2] ? { kind: 'role', role: command[2] } : { kind: 'hint', text: ROLE_HINT };
    default:
      return { kind: 'hint', text: `Неизвестная команда ${line.split(/\s/)[0]}` };
  }
}

// Что делать с вводом на текущем этапе. Enter начинает новый вопрос только после разбора, чтобы
// случайное нажатие не потеряло вопрос, а текст после разбора не считается вторым ответом.
export function decideAction(stage: Stage, input: CliInput): CliAction {
  switch (input.kind) {
    case 'exit':
      return { kind: 'exit' };
    case 'new':
      return { kind: 'next_question' };
    case 'role':
      return { kind: 'set_role', role: input.role };
    case 'hint':
      return { kind: 'hint', text: input.text };
    case 'empty':
      return stage === 'awaiting_answer' ? { kind: 'none' } : { kind: 'next_question' };
    case 'clarify':
      if (stage === 'no_question') return { kind: 'retry_question' };
      return {
        kind: 'send',
        mode: stage === 'reviewed' ? 'discuss' : 'clarify',
        text: input.text,
      };
    case 'answer':
      if (stage === 'no_question') return { kind: 'retry_question' };
      if (stage === 'reviewed') return { kind: 'hint', text: REVIEWED_HINT };
      return { kind: 'send', mode: 'answer', text: input.text };
  }
}
