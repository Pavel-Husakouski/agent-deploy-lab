// Разбор строки ввода CLI. Сообщение с "?" в начале — уточнение, без него — ответ на вопрос.
export type CliInput =
  | { kind: 'empty' }
  | { kind: 'exit' }
  | { kind: 'new' }
  | { kind: 'role'; role: string }
  | { kind: 'clarify'; text: string }
  | { kind: 'answer'; text: string }
  | { kind: 'hint'; text: string };

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
