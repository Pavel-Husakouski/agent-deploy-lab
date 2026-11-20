import { describe, expect, it } from 'vitest';
import { applyRetries, describeChange, renderReport, type TestOutcome } from '../src/eval-gate.js';
import type { ReleaseManifest } from '../src/release.js';

function t(description: string, success: boolean, reason = ''): TestOutcome {
  return { description, success, costUsd: 0.001, reason };
}

const FIRST = [t('a', true), t('b', false, 'grader: нет'), t('c', true)];

describe('applyRetries', () => {
  it('без фейлов — 100%, повторов нет', () => {
    const r = applyRetries('injection', 1, 100, [t('a', true), t('b', true)], []);
    expect(r).toMatchObject({ passed: 2, total: 2, passRate: 1, ok: true, failures: [] });
    expect(r.flaky).toEqual([]);
  });

  it('без повторов фейл остаётся фейлом', () => {
    const r = applyRetries('injection', 1, 100, FIRST, []);
    expect(r).toMatchObject({ passed: 2, total: 3, ok: false, flaky: [] });
    expect(r.failures).toEqual(['b: grader: нет']);
  });

  it('прошёл во всех повторах — flaky, gate зелёный', () => {
    const r = applyRetries('injection', 1, 100, FIRST, [[t('b', true)], [t('b', true)]]);
    expect(r).toMatchObject({ passed: 3, total: 3, ok: true, failures: [] });
    expect(r.flaky).toEqual(['b: grader: нет']);
  });

  it('упал хотя бы в одном повторе — фейл с причиной из повтора', () => {
    const r = applyRetries('injection', 1, 100, FIRST, [
      [t('b', true)],
      [t('b', false, 'утечка')],
    ]);
    expect(r).toMatchObject({ passed: 2, ok: false, flaky: [] });
    expect(r.failures).toEqual(['b: утечка']);
  });

  it('теста нет в повторе — фейл', () => {
    const r = applyRetries('injection', 1, 100, FIRST, [[t('b', true)], []]);
    expect(r).toMatchObject({ ok: false, failures: ['b: grader: нет'] });
  });

  it('порог ниже 100% допускает фейл', () => {
    const r = applyRetries('golden', 0.6, 100, FIRST, []);
    expect(r.ok).toBe(true);
  });

  it('стоимость включает повторы', () => {
    const r = applyRetries('injection', 1, 100, FIRST, [[t('b', true)], [t('b', true)]]);
    expect(r.costUsd).toBeCloseTo(0.005);
  });

  it('пустой набор — не ок', () => {
    expect(applyRetries('injection', 1, 0, [], []).ok).toBe(false);
  });

  it('одинаковые описания — ошибка: повторы не сопоставить', () => {
    expect(() => applyRetries('injection', 1, 0, [t('a', true), t('a', false)], [])).toThrow(
      /повторяется описание/,
    );
  });
});

function manifest(overrides: Partial<ReleaseManifest> = {}): ReleaseManifest {
  return {
    version: '0.12.0',
    model: {
      id: 'deepseek-flash',
      temperature: 0.3,
      maxTokens: 2048,
      pricing: { inputPerMTok: 0.3, outputPerMTok: 1.2 },
    },
    prompt: { id: 'trainer-v7', sha256: 'aaa' },
    evalDataset: 'golden-v7',
    ...overrides,
  };
}

describe('describeChange', () => {
  it('только bump версии', () => {
    expect(describeChange(manifest({ version: '0.12.1' }), manifest())).toBe(
      'Относительно base: version 0.12.0 → 0.12.1, prompt без изменений, ' +
        'model без изменений, dataset `golden-v7`.',
    );
  });

  it('новый промпт, модель и dataset', () => {
    const current = manifest({
      version: '0.13.0',
      prompt: { id: 'trainer-v8', sha256: 'bbb' },
      model: { ...manifest().model, temperature: 0.5 },
      evalDataset: 'golden-v8',
    });
    expect(describeChange(current, manifest())).toBe(
      'Относительно base: version 0.12.0 → 0.13.0, prompt `trainer-v7` → `trainer-v8`, ' +
        'model изменена, dataset `golden-v7` → `golden-v8`.',
    );
  });

  it('тот же id промпта с другим sha256', () => {
    const current = manifest({ prompt: { id: 'trainer-v7', sha256: 'bbb' } });
    expect(describeChange(current, manifest())).toContain('prompt `trainer-v7`: sha256 изменился');
  });
});

describe('renderReport', () => {
  const ctx = { version: '0.12.1', dataset: 'golden-v7', promptId: 'trainer-v7', modelId: 'x' };

  it('таблица, фейлы, flaky и ссылка на прогон', () => {
    const ok = applyRetries('injection', 1, 10, FIRST, [[t('b', true)], [t('b', true)]]);
    const bad = applyRetries('golden', 1, 10, FIRST, []);
    const md = renderReport({ ...ctx, baseLine: 'Относительно base: …', runUrl: 'https://r/1' }, [
      bad,
      ok,
    ]);
    expect(md).toContain('| golden | 2/3 | 67% | 100% | 0 |');
    expect(md).toContain('| injection | 3/3 | 100% | 100% | 1 |');
    expect(md).toContain('**Не прошли (golden):**\n\n- b: grader: нет');
    expect(md).toContain('**Flaky (injection)');
    expect(md).toContain('Относительно base: …');
    expect(md).toContain('[прогоне](https://r/1)');
  });

  it('без base и ссылки этих строк нет', () => {
    const md = renderReport(ctx, [applyRetries('golden', 1, 10, [t('a', true)], [])]);
    expect(md).not.toContain('Относительно base');
    expect(md).not.toContain('прогоне');
  });
});
