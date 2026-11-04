import { describe, expect, it } from 'vitest';
import { bold, boldEnabled } from '../src/cli/style.js';

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
