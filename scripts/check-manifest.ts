import { execFileSync } from 'node:child_process';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { checkManifest, datasetFingerprint, type RepoSnapshot } from '../src/manifest-check.js';

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

// Группирует файлы evals/<id>/... по id dataset и считает fingerprint каждого.
function fingerprints(files: Map<string, string>): Map<string, string> {
  const byDataset = new Map<string, Map<string, string>>();
  for (const [path, text] of files) {
    const [, id, ...rest] = path.split('/');
    if (id === undefined || rest.length === 0) continue;
    if (!byDataset.has(id)) byDataset.set(id, new Map());
    byDataset.get(id)?.set(rest.join('/'), text);
  }
  return new Map([...byDataset].map(([id, ds]) => [id, datasetFingerprint(ds)]));
}

async function readCurrent(): Promise<RepoSnapshot> {
  const manifest = await readFile('release.json', 'utf8').catch(() => null);
  const prompts = new Map<string, string>();
  for (const file of await readdir('prompts')) {
    if (!file.endsWith('.md')) continue;
    prompts.set(file.slice(0, -3), await readFile(`prompts/${file}`, 'utf8'));
  }
  const evalFiles = new Map<string, string>();
  const entries = await readdir('evals', { recursive: true, withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    const path = join(entry.parentPath, entry.name);
    if (!entry.isFile() || path.split('/').includes('node_modules')) continue;
    evalFiles.set(path, await readFile(path, 'utf8'));
  }
  return { manifest, prompts, datasets: fingerprints(evalFiles) };
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
  const evalFiles = new Map<string, string>();
  for (const path of git('ls-tree', '-r', '--name-only', baseRef, 'evals/').split('\n')) {
    const text = path ? gitShow(path) : null;
    if (text !== null) evalFiles.set(path, text);
  }
  return { manifest: gitShow('release.json'), prompts, datasets: fingerprints(evalFiles) };
}

const errors = checkManifest(await readCurrent(), readBase());
if (errors.length > 0) {
  console.error(`check:manifest (base ${baseRef}): FAIL`);
  for (const error of errors) console.error(`  - ${error}`);
  process.exit(1);
}
console.log(`check:manifest (base ${baseRef}): OK`);
