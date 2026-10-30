import { describe, expect, it } from 'vitest';
import { checkManifest, datasetFingerprint, type RepoSnapshot } from '../src/manifest-check.js';
import { sha256, type ReleaseManifest } from '../src/release.js';

const V1 = 'Промпт v1\n';
const V2 = 'Промпт v2\n';

function manifest(overrides: Partial<ReleaseManifest> = {}): ReleaseManifest {
  return {
    version: '0.1.0',
    model: {
      id: 'deepseek-flash',
      temperature: 0.3,
      maxTokens: 1024,
      pricing: { inputPerMTok: 0.3, outputPerMTok: 1.2 },
    },
    prompt: { id: 'trainer-v1', sha256: sha256(V1) },
    evalDataset: 'golden-v1',
    ...overrides,
  };
}

function snapshot(
  m: ReleaseManifest | null,
  prompts: Record<string, string>,
  datasets: Record<string, string> = { 'golden-v1': 'fp-1' },
): RepoSnapshot {
  return {
    manifest: m === null ? null : JSON.stringify(m),
    prompts: new Map(Object.entries(prompts)),
    datasets: new Map(Object.entries(datasets)),
  };
}

const BASE = snapshot(manifest(), { 'trainer-v1': V1 });

describe('checkManifest', () => {
  it('без изменений относительно base — ок', () => {
    expect(checkManifest(snapshot(manifest(), { 'trainer-v1': V1 }), BASE)).toEqual([]);
  });

  it('правило 1: невалидный manifest', () => {
    const errors = checkManifest(snapshot(manifest({ version: 'v1' }), { 'trainer-v1': V1 }), BASE);
    expect(errors).toEqual([expect.stringMatching(/version: ожидается semver/)]);
  });

  it('правило 2: sha256 файла не совпадает с manifest', () => {
    const errors = checkManifest(snapshot(manifest(), { 'trainer-v1': V2 }), null);
    expect(errors).toEqual([expect.stringMatching(/sha256 промпта trainer-v1 не совпадает/)]);
  });

  it('правило 2: файла промпта нет', () => {
    const errors = checkManifest(snapshot(manifest(), {}), null);
    expect(errors).toEqual([expect.stringMatching(/prompts\/trainer-v1.md/)]);
  });

  it('правило 3: новый промпт без bump версии', () => {
    const current = manifest({ prompt: { id: 'trainer-v2', sha256: sha256(V2) } });
    const errors = checkManifest(snapshot(current, { 'trainer-v1': V1, 'trainer-v2': V2 }), BASE);
    expect(errors).toEqual([expect.stringMatching(/сделайте bump/)]);
  });

  it('правило 3: изменение model без bump версии', () => {
    const current = manifest({ model: { ...manifest().model, temperature: 0.7 } });
    const errors = checkManifest(snapshot(current, { 'trainer-v1': V1 }), BASE);
    expect(errors).toEqual([expect.stringMatching(/сделайте bump/)]);
  });

  it('правило 3: версия не может уменьшиться', () => {
    const base = snapshot(manifest({ version: '0.2.0' }), { 'trainer-v1': V1 });
    const errors = checkManifest(snapshot(manifest(), { 'trainer-v1': V1 }), base);
    expect(errors).toEqual([expect.stringMatching(/меньше, чем в base/)]);
  });

  it('новый промпт с новым id и bump версии — ок', () => {
    const current = manifest({
      version: '0.2.0',
      prompt: { id: 'trainer-v2', sha256: sha256(V2) },
    });
    expect(checkManifest(snapshot(current, { 'trainer-v1': V1, 'trainer-v2': V2 }), BASE)).toEqual(
      [],
    );
  });

  it('правило 4: правка выпущенного промпта запрещена даже с bump', () => {
    const current = manifest({
      version: '0.2.0',
      prompt: { id: 'trainer-v1', sha256: sha256(V2) },
    });
    const errors = checkManifest(snapshot(current, { 'trainer-v1': V2 }), BASE);
    expect(errors).toEqual([expect.stringMatching(/trainer-v1 уже выпущен и неизменяем/)]);
  });

  it('правило 5: каталога eval dataset нет', () => {
    const errors = checkManifest(snapshot(manifest(), { 'trainer-v1': V1 }, {}), null);
    expect(errors).toEqual([expect.stringMatching(/evals\/golden-v1\//)]);
  });

  it('правило 3: правка выпущенного dataset без bump версии', () => {
    const current = snapshot(manifest(), { 'trainer-v1': V1 }, { 'golden-v1': 'fp-2' });
    expect(checkManifest(current, BASE)).toEqual([expect.stringMatching(/сделайте bump/)]);
  });

  it('правка dataset с bump версии — ок', () => {
    const current = snapshot(
      manifest({ version: '0.1.1' }),
      { 'trainer-v1': V1 },
      { 'golden-v1': 'fp-2' },
    );
    expect(checkManifest(current, BASE)).toEqual([]);
  });

  it('каталог dataset появился впервые — bump не нужен', () => {
    const base = snapshot(manifest(), { 'trainer-v1': V1 }, {});
    expect(checkManifest(snapshot(manifest(), { 'trainer-v1': V1 }), base)).toEqual([]);
  });

  it('первый релиз: в base нет manifest, правила 3 и 4 не применяются', () => {
    const base = snapshot(null, { 'trainer-v1': 'старый текст' });
    expect(checkManifest(snapshot(manifest(), { 'trainer-v1': V1 }), base)).toEqual([]);
  });
});

describe('datasetFingerprint', () => {
  it('не зависит от порядка файлов и меняется при правке содержимого', () => {
    const a = datasetFingerprint(new Map([['a.yaml', '1'], ['b.yaml', '2']]));
    const b = datasetFingerprint(new Map([['b.yaml', '2'], ['a.yaml', '1']]));
    const c = datasetFingerprint(new Map([['a.yaml', '1'], ['b.yaml', '3']]));
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });
});
