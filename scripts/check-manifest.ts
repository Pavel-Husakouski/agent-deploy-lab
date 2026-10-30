import { execFileSync } from 'node:child_process';
import { readdir, readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { checkManifest, type RepoSnapshot } from '../src/manifest-check.js';

// Проверка release.json относительно base ref (по умолчанию origin/main).
// Запуск: npm run check:manifest [-- --base <ref>]
const { values } = parseArgs({ options: { base: { type: 'string', default: 'origin/main' } } });
const baseRef = values.base;

function git(...args: string[]): string {
  return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function gitShow(path: string): string | null {
  try {
    return git('show', `${baseRef}:${path}`);
  } catch {
    return null;
  }
}

async function readCurrent(): Promise<RepoSnapshot> {
  const manifest = await readFile('release.json', 'utf8').catch(() => null);
  const prompts = new Map<string, string>();
  for (const file of await readdir('prompts')) {
    if (!file.endsWith('.md')) continue;
    prompts.set(file.slice(0, -3), await readFile(`prompts/${file}`, 'utf8'));
  }
  return { manifest, prompts };
}

function readBase(): RepoSnapshot {
  try {
    git('rev-parse', '--verify', '--quiet', `${baseRef}^{commit}`);
  } catch {
    console.error(`base ref ${baseRef} не найден: выполните git fetch или укажите --base`);
    process.exit(2);
  }
  const prompts = new Map<string, string>();
  const files = git('ls-tree', '--name-only', baseRef, 'prompts/').split('\n').filter(Boolean);
  for (const file of files) {
    const text = file.endsWith('.md') ? gitShow(file) : null;
    if (text !== null) prompts.set(file.slice('prompts/'.length, -3), text);
  }
  return { manifest: gitShow('release.json'), prompts };
}

const errors = checkManifest(await readCurrent(), readBase());
if (errors.length > 0) {
  console.error(`check:manifest (base ${baseRef}): FAIL`);
  for (const error of errors) console.error(`  - ${error}`);
  process.exit(1);
}
console.log(`check:manifest (base ${baseRef}): OK`);
