import { describe, expect, it } from 'vitest';
import {
  ASKED_LIMIT,
  ASKED_TTL_SECONDS,
  HISTORY_TTL_SECONDS,
  RedisHistoryStore,
  downgradeRecord,
  makeRecord,
  parseRecord,
  parseStoredRecord,
  toV1,
  type HistoryRecordV2,
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
        ltrim(key: string, start: number, stop: number) {
          ops.push(() =>
            lists.set(key, (lists.get(key) ?? []).slice(start, stop === -1 ? undefined : stop + 1)),
          );
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
    expect(parseRecord(JSON.stringify({ ...record, schemaVersion: 3 }))).toBeNull();
    expect(parseRecord(JSON.stringify({ ...record, role: 'system' }))).toBeNull();
  });
});

describe('чтение записей v2 (совместимость с откатом)', () => {
  const ts = '2026-11-20T12:00:00.000Z';
  const review = {
    kind: 'review' as const,
    score: 7,
    reason: 'по делу',
    good: 'назвал canary',
    missing: ['rollback state'],
    reference: ['повторный деплой manifest'],
  };
  const v2 = (extra: Partial<HistoryRecordV2>): HistoryRecordV2 => ({
    schemaVersion: 2,
    role: 'assistant',
    mode: 'answer',
    release: '0.12.0',
    ts,
    ...extra,
  });

  it('текстовая запись v2 приводится к v1 без поля mode и release', () => {
    const raw = JSON.stringify(v2({ role: 'user', mode: 'clarify', content: 'уточни' }));
    expect(parseRecord(raw)).toEqual({ schemaVersion: 1, role: 'user', content: 'уточни', ts });
  });

  it('разбор v2 хранится объектом, при чтении становится markdown как в v1', () => {
    const raw = JSON.stringify(v2({ review }));
    const record = parseRecord(raw);
    expect(record?.schemaVersion).toBe(1);
    expect(record?.content).toContain('**Оценка:** 7/10, по делу');
    expect(record?.content).toContain('- повторный деплой manifest');
    expect(toV1(v2({ review: { kind: 'redirect', text: 'вернёмся к вопросу' } })).content).toBe(
      'вернёмся к вопросу',
    );
  });

  it('v2 без content и review или с обоими не читается', () => {
    expect(parseStoredRecord(JSON.stringify(v2({})))).toEqual({ skipped: 'invalid' });
    expect(parseStoredRecord(JSON.stringify(v2({ content: 'x', review })))).toEqual({
      skipped: 'invalid',
    });
  });

  it('неизвестная версия пропускается с номером версии, битая запись — как invalid', () => {
    expect(parseStoredRecord(JSON.stringify({ schemaVersion: 3, role: 'user' }))).toEqual({
      skipped: '3',
    });
    expect(parseStoredRecord('{битая')).toEqual({ skipped: 'invalid' });
  });

  it('downgradeRecord переводит v2 в v1, остальное не трогает', () => {
    const raw = JSON.stringify(v2({ review }));
    expect(JSON.parse(downgradeRecord(raw)!)).toEqual(parseRecord(raw));
    expect(downgradeRecord(serializeRecord(makeRecord('user', 'q')))).toBeNull();
    expect(downgradeRecord(JSON.stringify({ schemaVersion: 3 }))).toBeNull();
    expect(downgradeRecord('{битая')).toBeNull();
  });
});

describe('ключи', () => {
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

  it('пропускает битые записи при чтении и сообщает о каждой', async () => {
    const { redis, lists } = fakeRedis();
    const good = makeRecord('user', 'q');
    const future = JSON.stringify({ schemaVersion: 3, role: 'assistant', parts: [] });
    lists.set('session:s1', ['{битая', serializeRecord(good), future]);
    const skipped: string[] = [];

    const store = new RedisHistoryStore(redis, undefined, (v) => skipped.push(v));
    expect(await store.read('s1')).toEqual([good]);
    expect(skipped).toEqual(['invalid', '3']);
  });

  it('читает сессию, в которую писали и v1, и v2', async () => {
    const { redis, lists } = fakeRedis();
    const question = makeRecord('assistant', 'Что такое canary?');
    const answer = JSON.stringify({
      schemaVersion: 2,
      role: 'user',
      mode: 'answer',
      release: '0.12.0',
      content: 'часть трафика',
      ts: question.ts,
    });
    lists.set('session:s1', [serializeRecord(question), answer]);

    const records = await new RedisHistoryStore(redis).read('s1');
    expect(records.map((r) => [r.schemaVersion, r.role, r.content])).toEqual([
      [1, 'assistant', 'Что такое canary?'],
      [1, 'user', 'часть трафика'],
    ]);
  });

  it('хранит только последние вопросы клиента по роли, с TTL', async () => {
    const { redis, ttl } = fakeRedis();
    const store = new RedisHistoryStore(redis);

    for (let i = 0; i < ASKED_LIMIT + 2; i++) await store.addAsked('c1', 'Data Engineer', `q${i}`);

    const asked = await store.readAsked('c1', 'data engineer');
    expect(asked).toHaveLength(ASKED_LIMIT);
    expect(asked.at(-1)).toBe(`q${ASKED_LIMIT + 1}`);
    expect(asked[0]).toBe('q2');
    expect(ttl.get('asked:c1:data engineer')).toBe(ASKED_TTL_SECONDS);
    expect(await store.readAsked('c2', 'Data Engineer')).toEqual([]);
  });

  it('ping возвращает true на PONG', async () => {
    const { redis } = fakeRedis();
    expect(await new RedisHistoryStore(redis).ping()).toBe(true);
  });
});
