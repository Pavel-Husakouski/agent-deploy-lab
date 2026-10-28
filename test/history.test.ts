import { describe, expect, it } from 'vitest';
import {
  HISTORY_TTL_SECONDS,
  RedisHistoryStore,
  makeRecord,
  parseRecord,
  serializeRecord,
  sessionKey,
  type RedisLike,
} from '../src/history.js';

// Фейк Redis: реализует только команды, которые использует RedisHistoryStore.
function fakeRedis() {
  const lists = new Map<string, string[]>();
  const ttl = new Map<string, number>();
  const redis = {
    async lrange(key: string, start: number, stop: number) {
      const list = lists.get(key) ?? [];
      return list.slice(start, stop === -1 ? undefined : stop + 1);
    },
    multi() {
      const ops: Array<() => void> = [];
      const tx = {
        rpush(key: string, ...values: string[]) {
          ops.push(() => lists.set(key, [...(lists.get(key) ?? []), ...values]));
          return tx;
        },
        expire(key: string, seconds: number) {
          ops.push(() => ttl.set(key, seconds));
          return tx;
        },
        async exec() {
          ops.forEach((op) => op());
          return [];
        },
      };
      return tx;
    },
    async ping() {
      return 'PONG';
    },
  };
  return { redis: redis as unknown as RedisLike, lists, ttl };
}

describe('формат записей истории', () => {
  it('запись содержит schemaVersion 1, role, content и ts в ISO 8601', () => {
    const record = makeRecord('user', 'вопрос', new Date('2026-10-28T12:00:00Z'));
    expect(JSON.parse(serializeRecord(record))).toEqual({
      schemaVersion: 1,
      role: 'user',
      content: 'вопрос',
      ts: '2026-10-28T12:00:00.000Z',
    });
  });

  it('parseRecord читает свой формат и отбрасывает чужой', () => {
    const record = makeRecord('assistant', 'ответ');
    expect(parseRecord(serializeRecord(record))).toEqual(record);
    expect(parseRecord('не json')).toBeNull();
    expect(parseRecord(JSON.stringify({ ...record, schemaVersion: 2 }))).toBeNull();
    expect(parseRecord(JSON.stringify({ ...record, role: 'system' }))).toBeNull();
  });

  it('ключ сессии имеет вид session:{id}', () => {
    expect(sessionKey('abc')).toBe('session:abc');
  });
});

describe('RedisHistoryStore', () => {
  it('пишет записи в list по ключу сессии, обновляет TTL и читает их обратно', async () => {
    const { redis, lists, ttl } = fakeRedis();
    const store = new RedisHistoryStore(redis);
    const records = [makeRecord('user', 'q'), makeRecord('assistant', 'a')];

    await store.append('s1', records);

    expect(lists.get('session:s1')).toEqual(records.map(serializeRecord));
    expect(ttl.get('session:s1')).toBe(HISTORY_TTL_SECONDS);
    expect(HISTORY_TTL_SECONDS).toBe(7 * 24 * 3600);
    expect(await store.read('s1')).toEqual(records);
  });

  it('пропускает битые записи при чтении', async () => {
    const { redis, lists } = fakeRedis();
    const good = makeRecord('user', 'q');
    lists.set('session:s1', ['{битая', serializeRecord(good)]);

    expect(await new RedisHistoryStore(redis).read('s1')).toEqual([good]);
  });

  it('ping возвращает true на PONG', async () => {
    const { redis } = fakeRedis();
    expect(await new RedisHistoryStore(redis).ping()).toBe(true);
  });
});
