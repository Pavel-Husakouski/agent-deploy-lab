import { describe, expect, it } from 'vitest';
import { bold, boldEnabled, createBoldRenderer } from '../src/cli/style.js';

describe('boldEnabled', () => {
  it.each([
    [true, undefined, true],
    [true, '', true],
    [true, '1', false],
    [false, undefined, false],
    [undefined, undefined, false],
  ])('isTty=%j, NO_COLOR=%j: %j', (isTty, noColor, expected) => {
    expect(boldEnabled(isTty, noColor)).toBe(expected);
  });
});

describe('bold', () => {
  it('сбрасывает стиль в конце каждого фрагмента', () => {
    expect(bold('текст')).toBe('\x1b[1mтекст\x1b[0m');
  });
});

describe('createBoldRenderer', () => {
  const B = (text: string) => bold(text);
  const render = (chunks: string[], styled = true, allBold = false) => {
    const r = createBoldRenderer(styled, allBold);
    return chunks.map((c) => r.write(c)).join('') + r.end();
  };

  it('печатает **выделенное** жирным без звёздочек', () => {
    expect(render(['**Оценка:** 7/10'])).toBe(`${B('Оценка:')} 7/10`);
  });

  it('собирает маркер, разрезанный между фрагментами', () => {
    expect(render(['**Чего не хвата', 'ет:*', '* пункт'])).toBe(
      `${B('Чего не хвата')}${B('ет:')} пункт`,
    );
    expect(render(['a *', '*b** c'])).toBe(`a ${B('b')} c`);
  });

  it('одиночная звёздочка остаётся текстом, в том числе в конце ответа', () => {
    expect(render(['* пункт\n', '2 * 3 *'])).toBe('* пункт\n2 * 3 *');
  });

  it('незакрытый маркер: каждый фрагмент со сбросом стиля', () => {
    expect(render(['**начало', ' конец'])).toBe(`${B('начало')}${B(' конец')}`);
  });

  it('без стилей убирает маркеры и не пишет escape-коды', () => {
    expect(render(['**Оценка:** 7/10'], false)).toBe('Оценка: 7/10');
    expect(render(['**Вопрос:** как?'], false, true)).toBe('Вопрос: как?');
  });

  it('allBold: весь текст жирный, маркеры убраны', () => {
    expect(render(['**Вопрос:** как?'], true, true)).toBe(`${B('Вопрос:')}${B(' как?')}`);
  });
});
