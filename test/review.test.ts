import { describe, expect, it } from 'vitest';
import {
  InvalidReviewError,
  parseReview,
  REVIEW_ATTEMPTS,
  renderReview,
  requestReview,
  type Review,
} from '../src/review.js';

const REVIEW: Review = {
  kind: 'review',
  score: 7,
  reason: 'идея верная',
  good: 'дедупликация',
  missing: ['условная запись', 'TTL'],
  reference: ['ключ идемпотентности', 'attribute_not_exists'],
};

describe('parseReview', () => {
  it('принимает разбор и redirect по схеме', () => {
    expect(parseReview(JSON.stringify(REVIEW))).toEqual(REVIEW);
    expect(parseReview('{"kind":"redirect","text":"вернёмся к вопросу"}')).toEqual({
      kind: 'redirect',
      text: 'вернёмся к вопросу',
    });
  });

  it.each([
    ['пустой ответ JSON mode', '   '],
    ['не JSON', '**Оценка:** 7/10'],
    ['оценка вне 0–10', JSON.stringify({ ...REVIEW, score: 11 })],
    ['дробная оценка', JSON.stringify({ ...REVIEW, score: 7.5 })],
    ['без эталона', JSON.stringify({ ...REVIEW, reference: [] })],
    ['неизвестный kind', JSON.stringify({ ...REVIEW, kind: 'other' })],
  ])('отклоняет: %s', (_name, text) => {
    expect(parseReview(text)).toBeNull();
  });
});

describe('requestReview', () => {
  it('повторяет запрос, если ответ не прошёл схему', async () => {
    const answers = ['  ', JSON.stringify(REVIEW)];
    const invalid: string[] = [];

    const review = await requestReview(
      async () => answers.shift() ?? '',
      (text) => invalid.push(text),
    );

    expect(review).toEqual(REVIEW);
    expect(invalid).toEqual(['  ']);
  });

  it(`после ${REVIEW_ATTEMPTS} неудачных попыток бросает InvalidReviewError`, async () => {
    let calls = 0;
    const generate = async () => {
      calls++;
      return 'не json';
    };

    await expect(requestReview(generate)).rejects.toBeInstanceOf(InvalidReviewError);
    expect(calls).toBe(REVIEW_ATTEMPTS);
  });
});

describe('renderReview', () => {
  it('собирает markdown разбора', () => {
    expect(renderReview(REVIEW)).toBe(
      [
        '**Оценка:** 7/10, идея верная',
        '**Что хорошо:** дедупликация',
        '**Чего не хватает:**\n- условная запись\n- TTL',
        '**Эталонный ответ:**\n- ключ идемпотентности\n- attribute_not_exists',
      ].join('\n\n'),
    );
  });

  it('«не знаю»: пустые good и missing показываются прочерком', () => {
    const text = renderReview({ ...REVIEW, score: 0, good: '', missing: [] });
    expect(text).toContain('**Что хорошо:** —');
    expect(text).toContain('**Чего не хватает:**\n—');
  });

  it('redirect — просто текст', () => {
    expect(renderReview({ kind: 'redirect', text: 'вернёмся к вопросу' })).toBe(
      'вернёмся к вопросу',
    );
  });
});
