import type { Redis } from 'ioredis';
import { z } from 'zod';

export const HISTORY_SCHEMA_VERSION = 1;
export const HISTORY_TTL_SECONDS = 7 * 24 * 60 * 60;

// Формат записи истории в Redis. schemaVersion нужен для будущих миграций и отката (этап 7).
export const HistoryRecordSchema = z.object({
  schemaVersion: z.literal(HISTORY_SCHEMA_VERSION),
  role: z.enum(['user', 'assistant']),
  content: z.string(),
  ts: z.string(),
});

export type HistoryRecord = z.infer<typeof HistoryRecordSchema>;

export interface HistoryStore {
  read(sessionId: string): Promise<HistoryRecord[]>;
  append(sessionId: string, records: HistoryRecord[]): Promise<void>;
  ping(): Promise<boolean>;
}

export function sessionKey(sessionId: string): string {
  return `session:${sessionId}`;
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

// Возвращает null для записей неизвестного формата: такие записи пропускаются, а не роняют /chat.
export function parseRecord(raw: string): HistoryRecord | null {
  try {
    const parsed = HistoryRecordSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

// Минимальный набор команд Redis, который нужен хранилищу. Упрощает подмену в тестах.
export type RedisLike = Pick<Redis, 'lrange' | 'multi' | 'ping'>;

export class RedisHistoryStore implements HistoryStore {
  constructor(
    private readonly redis: RedisLike,
    private readonly pingTimeoutMs = 1000,
  ) {}

  async read(sessionId: string): Promise<HistoryRecord[]> {
    const raw = await this.redis.lrange(sessionKey(sessionId), 0, -1);
    return raw.map(parseRecord).filter((r): r is HistoryRecord => r !== null);
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
