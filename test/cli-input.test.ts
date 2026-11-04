import { describe, expect, it } from 'vitest';
import { parseInput } from '../src/cli/input.js';

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
