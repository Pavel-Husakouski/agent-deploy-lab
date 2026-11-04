import { describe, expect, it } from 'vitest';
import { decideAction, parseInput, REVIEWED_HINT, type Stage } from '../src/cli/input.js';

describe('parseInput', () => {
  it.each([
    ['? что значит idempotent', { kind: 'clarify', text: 'что значит idempotent' }],
    ['?без пробела', { kind: 'clarify', text: 'без пробела' }],
    ['  ? с отступом  ', { kind: 'clarify', text: 'с отступом' }],
    ['обычный ответ', { kind: 'answer', text: 'обычный ответ' }],
    ['что такое SQS?', { kind: 'answer', text: 'что такое SQS?' }],
    ['/etc/hosts содержит адреса', { kind: 'answer', text: '/etc/hosts содержит адреса' }],
    ['', { kind: 'empty' }],
    ['   ', { kind: 'empty' }],
    ['/exit', { kind: 'exit' }],
    ['/new', { kind: 'new' }],
    ['/role Node AWS Developer', { kind: 'role', role: 'Node AWS Developer' }],
  ])('%j', (input, expected) => {
    expect(parseInput(input)).toEqual(expected);
  });

  it.each(['?', ' ?  ', '/role', '/unknown', '/unknown с текстом'])(
    '%j — подсказка без обращения к модели',
    (input) => {
      expect(parseInput(input).kind).toBe('hint');
    },
  );
});

describe('decideAction', () => {
  const act = (stage: Stage, line: string) => decideAction(stage, parseInput(line));

  it('Enter: после разбора новый вопрос, при ожидании ответа ничего', () => {
    expect(act('reviewed', '')).toEqual({ kind: 'next_question' });
    expect(act('awaiting_answer', '')).toEqual({ kind: 'none' });
    expect(act('no_question', '')).toEqual({ kind: 'next_question' });
  });

  it('"?" до ответа — clarify, после разбора — discuss', () => {
    expect(act('awaiting_answer', '? текст')).toEqual({
      kind: 'send',
      mode: 'clarify',
      text: 'текст',
    });
    expect(act('reviewed', '? текст')).toEqual({ kind: 'send', mode: 'discuss', text: 'текст' });
  });

  it('текст без "?" — ответ, а после разбора только подсказка', () => {
    expect(act('awaiting_answer', 'ответ')).toEqual({
      kind: 'send',
      mode: 'answer',
      text: 'ответ',
    });
    expect(act('reviewed', 'ответ')).toEqual({ kind: 'hint', text: REVIEWED_HINT });
  });

  it.each(['? текст', 'ответ'])('без вопроса %j не отправляется', (line) => {
    expect(act('no_question', line)).toEqual({ kind: 'retry_question' });
  });

  it.each<Stage>(['no_question', 'awaiting_answer', 'reviewed'])('команды на этапе %s', (stage) => {
    expect(act(stage, '/new')).toEqual({ kind: 'next_question' });
    expect(act(stage, '/role Data Engineer')).toEqual({ kind: 'set_role', role: 'Data Engineer' });
    expect(act(stage, '/exit')).toEqual({ kind: 'exit' });
    expect(act(stage, '?').kind).toBe('hint');
  });
});
