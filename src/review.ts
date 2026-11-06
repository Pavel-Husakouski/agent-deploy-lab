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

export function parseReview(text: string): Review | null {
  if (text.trim() === '') return null;
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return null;
  }
  const parsed = ReviewSchema.safeParse(json);
  return parsed.success ? parsed.data : null;
}

// generate — один вызов LLM в JSON mode, onInvalid — учёт ответа, не прошедшего схему.
export async function requestReview(
  generate: () => Promise<string>,
  onInvalid: (text: string) => void = () => {},
): Promise<Review> {
  for (let attempt = 0; attempt < REVIEW_ATTEMPTS; attempt++) {
    const text = await generate();
    const review = parseReview(text);
    if (review) return review;
    onInvalid(text);
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
