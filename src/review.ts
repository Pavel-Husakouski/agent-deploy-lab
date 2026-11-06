import { z } from 'zod';

// Разбор ответа кандидата (режим answer): модель отвечает JSON, поля проверяет схема, текст для
// человека собирает renderReview. Общий для API, CLI и eval, чтобы все видели один формат.

export const ReviewSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('review'),
    score: z.number().int().min(0).max(10),
    reason: z.string().trim().min(1),
    good: z.string().trim(),
    missing: z.array(z.string().trim().min(1)),
    reference: z.array(z.string().trim().min(1)).min(1),
  }),
  // Сообщение не по теме: оценки нет, модель возвращает разговор к вопросу.
  z.object({ kind: z.literal('redirect'), text: z.string().trim().min(1) }),
]);

export type Review = z.infer<typeof ReviewSchema>;

// DeepSeek в JSON mode не проверяет схему, а невалидный JSON отдаёт пробелами: один повтор
// покрывает случайный сбой, постоянный сбой видно в метрике agent_llm_invalid_output_total.
export const REVIEW_ATTEMPTS = 2;

export class InvalidReviewError extends Error {}

// Разбор или причина, по которой ответ не прошёл: она идёт в лог API и eval.
export function checkReview(text: string): { review: Review } | { error: string } {
  if (text.trim() === '') return { error: 'пустой ответ' };
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (err) {
    return { error: `не JSON: ${err instanceof Error ? err.message : String(err)}` };
  }
  const parsed = ReviewSchema.safeParse(json);
  if (parsed.success) return { review: parsed.data };
  const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
  return { error: `схема: ${issues}` };
}

export function parseReview(text: string): Review | null {
  const result = checkReview(text);
  return 'review' in result ? result.review : null;
}

// generate — один вызов LLM в JSON mode, onInvalid — учёт ответа, не прошедшего схему.
export async function requestReview(
  generate: () => Promise<string>,
  onInvalid: (text: string, reason: string) => void = () => {},
): Promise<Review> {
  for (let attempt = 0; attempt < REVIEW_ATTEMPTS; attempt++) {
    const text = await generate();
    const result = checkReview(text);
    if ('review' in result) return result.review;
    onInvalid(text, result.error);
  }
  throw new InvalidReviewError(`разбор не прошёл схему за ${REVIEW_ATTEMPTS} попытки`);
}

// Markdown разбора: так он хранится в истории (его видит модель в discuss) и печатается в CLI.
export function renderReview(review: Review): string {
  if (review.kind === 'redirect') return review.text;
  const list = (items: string[]) => items.map((item) => `- ${item}`).join('\n');
  return [
    `**Оценка:** ${review.score}/10, ${review.reason}`,
    `**Что хорошо:** ${review.good || '—'}`,
    `**Чего не хватает:**\n${review.missing.length > 0 ? list(review.missing) : '—'}`,
    `**Эталонный ответ:**\n${list(review.reference)}`,
  ].join('\n\n');
}
