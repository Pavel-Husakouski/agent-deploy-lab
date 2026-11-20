import { parseArgs } from 'node:util';
import { Redis } from 'ioredis';
import { downgradeRecord } from '../src/history.js';

// Обратная миграция истории v2 → v1: нужна, если откат уходит на релиз, который не читает v2
// (раньше 0.11.0). Записи v1 и записи другого формата не трогает, TTL ключа сохраняет.
// В кластере Redis открывается через port-forward:
//   kubectl --context kind-llm-platform -n agent port-forward svc/redis 16379:6379
//   npm run migrate:history -- --url redis://localhost:16379 --dry-run
const { values } = parseArgs({
  options: {
    url: { type: 'string', default: process.env['REDIS_URL'] ?? 'redis://localhost:6379' },
    to: { type: 'string', default: '1' },
    'dry-run': { type: 'boolean', default: false },
  },
});
if (values.to !== '1') {
  console.error('поддерживается только --to 1');
  process.exit(2);
}
const dryRun = values['dry-run'];

const redis = new Redis(values.url, { maxRetriesPerRequest: 2 });
let keys = 0;
let migrated = 0;

// WATCH: если API допишет в сессию между чтением и записью, транзакция не пройдёт и ключ
// перечитывается, новые реплики не теряются.
async function migrateKey(key: string): Promise<void> {
  for (let attempt = 0; attempt < 5; attempt++) {
    await redis.watch(key);
    const items = await redis.lrange(key, 0, -1);
    const converted = items.map(downgradeRecord);
    const changed = converted.filter((c) => c !== null).length;
    if (changed === 0 || dryRun) {
      await redis.unwatch();
      migrated += changed;
      if (changed > 0) console.log(`${key}: ${changed} из ${items.length} записей v2`);
      return;
    }
    const ttl = await redis.pttl(key);
    const tx = redis
      .multi()
      .del(key)
      .rpush(key, ...converted.map((c, i) => c ?? items[i]!));
    if (ttl > 0) tx.pexpire(key, ttl);
    if ((await tx.exec()) !== null) {
      migrated += changed;
      console.log(`${key}: ${changed} из ${items.length} записей переведены в v1`);
      return;
    }
  }
  throw new Error(`${key}: сессия меняется слишком часто, повторите позже`);
}

try {
  let cursor = '0';
  do {
    const [next, batch] = await redis.scan(cursor, 'MATCH', 'session:*', 'COUNT', 100);
    cursor = next;
    for (const key of batch) {
      keys++;
      await migrateKey(key);
    }
  } while (cursor !== '0');
  const verb = dryRun ? 'нашлось бы для миграции' : 'переведено в v1';
  console.log(`сессий: ${keys}, записей v2 ${verb}: ${migrated}`);
} finally {
  redis.disconnect();
}
