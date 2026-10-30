import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { compareSemver, loadRelease, parseManifest, sha256 } from '../src/release.js';

const PROMPT = 'Ты — тренер.\n';

function manifest(overrides: Record<string, unknown> = {}) {
  return {
    version: '0.1.0',
    model: {
      id: 'deepseek-flash',
      temperature: 0.3,
      maxTokens: 1024,
      pricing: { inputPerMTok: 0.3, outputPerMTok: 1.2 },
    },
    prompt: { id: 'trainer-v1', sha256: sha256(PROMPT) },
    evalDataset: 'golden-v1',
    ...overrides,
  };
}

async function repo(manifestJson: unknown, prompt = PROMPT): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'release-'));
  await mkdir(join(root, 'prompts'));
  await writeFile(join(root, 'release.json'), JSON.stringify(manifestJson));
  await writeFile(join(root, 'prompts', 'trainer-v1.md'), prompt);
  return root;
}

describe('parseManifest', () => {
  it('принимает корректный manifest', () => {
    expect(parseManifest(JSON.stringify(manifest()))).toEqual(manifest());
  });

  it.each([
    ['version не semver', { version: '1.0' }],
    ['лишнее поле', { extra: true }],
    ['sha256 не hex', { prompt: { id: 'trainer-v1', sha256: 'abc' } }],
  ])('отклоняет: %s', (_name, overrides) => {
    expect(() => parseManifest(JSON.stringify(manifest(overrides)))).toThrow(
      /Некорректный release.json/,
    );
  });

  it('отклоняет не JSON', () => {
    expect(() => parseManifest('{')).toThrow(/не JSON/);
  });
});

describe('loadRelease', () => {
  it('читает manifest и промпт по id', async () => {
    const release = await loadRelease(await repo(manifest()));
    expect(release.systemPrompt).toBe(PROMPT);
    expect(release.manifest.version).toBe('0.1.0');
  });

  it('падает, если sha256 промпта не совпадает с manifest', async () => {
    const root = await repo(manifest(), PROMPT + 'правка\n');
    await expect(loadRelease(root)).rejects.toThrow(/sha256 промпта trainer-v1 не совпадает/);
  });
});

describe('compareSemver', () => {
  it('сравнивает по major, minor, patch численно', () => {
    expect(compareSemver('1.10.0', '1.9.9')).toBeGreaterThan(0);
    expect(compareSemver('1.2.3', '1.2.3')).toBe(0);
    expect(compareSemver('0.9.0', '1.0.0')).toBeLessThan(0);
  });
});
