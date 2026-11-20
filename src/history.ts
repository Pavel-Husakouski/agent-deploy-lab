import type { Redis } from 'ioredis';
import { z } from 'zod';
import { renderReview, ReviewSchema } from './review.js';

// Версия, в которой API пишет записи. Читает он текущую и следующую (v2): так откат на эту
// версию не теряет историю, которую успела записать новая (expand → contract).
export const HISTORY_SCHEMA_VERSION = 1;
export const HISTORY_TTL_SECONDS = 7 * 24 * 60 * 60;
// Сколько последних вопросов и как долго клиент не должен получать повторно.
export const ASKED_LIMIT = 20;
export const ASKED_TTL_SECONDS = 30 * 24 * 60 * 60;

const RoleSchema = z.enum(['user', 'assistant']);

// Формат v1: в нём API пишет и к нему приводит записи v2 при чтении.
export const HistoryRecordSchema = z.object({
  schemaVersion: z.literal(1),
  role: RoleSchema,
  content: z.string(),
  ts: z.string(),
});

export type HistoryRecord = z.infer<typeof HistoryRecordSchema>;

// Формат v2: режим хода и релиз, который записал строку; разбор хранится объектом, а не
// markdown. Ровно одно из content и review.
export const HistoryRecordV2Schema = z
  .object({
    schemaVersion: z.literal(2),
    role: RoleSchema,
    mode: z.enum(['question', 'clarify', 'answer', 'discuss']),
    release: z.string(),
    content: z.string().optional(),
    review: ReviewSchema.optional(),
    ts: z.string(),
  })
  .refine((r) => (r.content === undefined) !== (r.review === undefined), {
    message: 'ожидается ровно одно из content и review',
  });

export type HistoryRecordV2 = z.infer<typeof HistoryRecordV2Schema>;

// Обратное преобразование v2 → v1: им пользуются чтение и scripts/migrate-history.ts.
export function toV1(record: HistoryRecordV2): HistoryRecord {
  const content = record.review ? renderReview(record.review) : (record.content ?? '');
  return { schemaVersion: 1, role: record.role, content, ts: record.ts };
}

export interface HistoryStore {
  read(sessionId: string): Promise<HistoryRecord[]>;
  append(sessionId: string, records: HistoryRecord[]): Promise<void>;
  readAsked(clientId: string, role: string): Promise<string[]>;
  addAsked(clientId: string, role: string, question: string): Promise<void>;
  ping(): Promise<boolean>;
}

export function sessionKey(sessionId: string): string {
  return `session:${sessionId}`;
}

// ":" нет ни в clientId, ни в роли, поэтому ключ однозначен.
export function askedKey(clientId: string, role: string): string {
  return `asked:${clientId}:${role.toLowerCase()}`;
}

export function makeRecord(
  role: HistoryRecord['role'],
  content: string,
  now: Date = new Date(),
): HistoryRecord {
  return { schemaVersion: HISTORY_SCHEMA_VERSION, role, content, ts: now.toISOString() };
}

export function serializeRecord(record: HistoryRecord): string {
  return JSON.stringify(record);
}

export type ParsedRecord =
  | { record: HistoryRecord }
  // schemaVersion из записи или 'invalid', если запись не JSON или не прошла схему своей версии.
  | { skipped: string };

// Записи v1 и v2 приводятся к v1. Неизвестный формат пропускается, а не роняет /chat.
export function parseStoredRecord(raw: string): ParsedRecord {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return { skipped: 'invalid' };
  }
  const v1 = HistoryRecordSchema.safeParse(json);
  if (v1.success) return { record: v1.data };
  const v2 = HistoryRecordV2Schema.safeParse(json);
  if (v2.success) return { record: toV1(v2.data) };
  const version = (json as { schemaVersion?: unknown } | null)?.schemaVersion;
  const known = version === 1 || version === 2;
  return { skipped: typeof version === 'number' && !known ? String(version) : 'invalid' };
}

// Строка v2 → строка v1 для scripts/migrate-history.ts, для остальных записей null.
export function downgradeRecord(raw: string): string | null {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return null;
  }
  const v2 = HistoryRecordV2Schema.safeParse(json);
  return v2.success ? serializeRecord(toV1(v2.data)) : null;
}

export function parseRecord(raw: string): HistoryRecord | null {
  const parsed = parseStoredRecord(raw);
  return 'record' in parsed ? parsed.record : null;
}

// Минимальный набор команд Redis, который нужен хранилищу. Упрощает подмену в тестах.
export type RedisLike = Pick<Redis, 'lrange' | 'multi' | 'ping'>;

export class RedisHistoryStore implements HistoryStore {
  // onSkipped видит каждую пропущенную запись: молчаливая потеря истории после отката на версию,
  // которая не знает новый формат, должна быть видна в метриках.
  constructor(
    private readonly redis: RedisLike,
    private readonly pingTimeoutMs = 1000,
    private readonly onSkipped: (schemaVersion: string) => void = () => {},
  ) {}

  async read(sessionId: string): Promise<HistoryRecord[]> {
    const raw = await this.redis.lrange(sessionKey(sessionId), 0, -1);
    const records: HistoryRecord[] = [];
    for (const item of raw) {
      const parsed = parseStoredRecord(item);
      if ('record' in parsed) records.push(parsed.record);
      else this.onSkipped(parsed.skipped);
    }
    return records;
  }

  async append(sessionId: string, records: HistoryRecord[]): Promise<void> {
    if (records.length === 0) return;
    const key = sessionKey(sessionId);
    // RPUSH и EXPIRE в одной транзакции: TTL продлевается при каждой записи.
    await this.redis
      .multi()
      .rpush(key, ...records.map(serializeRecord))
      .expire(key, HISTORY_TTL_SECONDS)
      .exec();
  }

  async readAsked(clientId: string, role: string): Promise<string[]> {
    return this.redis.lrange(askedKey(clientId, role), -ASKED_LIMIT, -1);
  }

  async addAsked(clientId: string, role: string, question: string): Promise<void> {
    const key = askedKey(clientId, role);
    await this.redis
      .multi()
      .rpush(key, question)
      .ltrim(key, -ASKED_LIMIT, -1)
      .expire(key, ASKED_TTL_SECONDS)
      .exec();
  }

  async ping(): Promise<boolean> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<boolean>((resolve) => {
      timer = setTimeout(() => resolve(false), this.pingTimeoutMs);
    });
    try {
      const pong = this.redis.ping().then((reply) => reply === 'PONG');
      return await Promise.race([pong, timeout]);
    } catch {
      return false;
    } finally {
      clearTimeout(timer);
    }
  }
}
