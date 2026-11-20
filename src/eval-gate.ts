import { isDeepStrictEqual } from 'node:util';
import type { ReleaseManifest } from './release.js';

// Итог eval gate по наборам promptfoo: повторы упавших тестов, pass rate против порога и
// отчёт в markdown (Job Summary и комментарий в PR). Прогоны делает scripts/eval.ts.

// Что релиз меняет относительно base ветки PR: ревьюеру сразу видно, что смотреть в diff.
export function describeChange(current: ReleaseManifest, base: ReleaseManifest): string {
  const parts = [
    current.version === base.version
      ? `version ${current.version} без изменений`
      : `version ${base.version} → ${current.version}`,
    current.prompt.id !== base.prompt.id
      ? `prompt \`${base.prompt.id}\` → \`${current.prompt.id}\``
      : current.prompt.sha256 !== base.prompt.sha256
        ? `prompt \`${current.prompt.id}\`: sha256 изменился`
        : 'prompt без изменений',
    isDeepStrictEqual(current.model, base.model) ? 'model без изменений' : 'model изменена',
    current.evalDataset === base.evalDataset
      ? `dataset \`${current.evalDataset}\``
      : `dataset \`${base.evalDataset}\` → \`${current.evalDataset}\``,
  ];
  return `Относительно base: ${parts.join(', ')}.`;
}

// Результат одного теста в прогоне promptfoo.
export interface TestOutcome {
  description: string;
  success: boolean;
  costUsd: number;
  // Причина фейла: ошибка провайдера или объяснение grader.
  reason: string;
}

export interface SuiteResult {
  suite: string;
  passed: number;
  total: number;
  passRate: number;
  threshold: number;
  costUsd: number;
  tokens: number;
  ok: boolean;
  // Упали в первом прогоне, но прошли во всех повторах: шум LLM или grader, а не регресс.
  flaky: string[];
  failures: string[];
}

// Тест, упавший в первом прогоне, засчитывается, только если он прошёл в каждом повторе:
// один удачный повтор не перекрывает фейл, иначе gate пропустил бы нестабильную уязвимость.
// Ошибки провайдера (сеть, лимиты) повторяются так же и без успеха остаются фейлом.
export function applyRetries(
  suite: string,
  threshold: number,
  tokens: number,
  first: readonly TestOutcome[],
  retries: readonly (readonly TestOutcome[])[],
): SuiteResult {
  const seen = new Set<string>();
  for (const t of first) {
    if (seen.has(t.description)) {
      throw new Error(`в наборе ${suite} повторяется описание теста «${t.description}»`);
    }
    seen.add(t.description);
  }

  const flaky: string[] = [];
  const failures: string[] = [];
  for (const t of first.filter((x) => !x.success)) {
    const reruns = retries.map((run) => run.find((x) => x.description === t.description));
    const recovered = reruns.length > 0 && reruns.every((x) => x?.success === true);
    if (recovered) {
      flaky.push(`${t.description}: ${t.reason}`);
    } else {
      const last = reruns.findLast((x) => x !== undefined && !x.success);
      failures.push(`${t.description}: ${(last ?? t).reason}`);
    }
  }

  const total = first.length;
  const passed = total - failures.length;
  const passRate = total > 0 ? passed / total : 0;
  const costUsd = [first, ...retries].flat().reduce((sum, t) => sum + t.costUsd, 0);
  return {
    suite,
    passed,
    total,
    passRate,
    threshold,
    costUsd,
    tokens,
    ok: total > 0 && passRate >= threshold,
    flaky,
    failures,
  };
}

function percent(x: number): string {
  return `${(x * 100).toFixed(0)}%`;
}

export interface ReportContext {
  version: string;
  dataset: string;
  promptId: string;
  modelId: string;
  // Строка о том, что релиз меняет относительно base ветки PR; нет base — нет строки.
  baseLine?: string;
  // Ссылка на прогон workflow с отчётами в artifacts.
  runUrl?: string;
}

export function renderReport(ctx: ReportContext, results: readonly SuiteResult[]): string {
  const lines = [
    `### Eval gate: release ${ctx.version}, dataset ${ctx.dataset}`,
    '',
    `Prompt \`${ctx.promptId}\`, model \`${ctx.modelId}\`.`,
  ];
  if (ctx.baseLine) lines.push('', ctx.baseLine);
  lines.push(
    '',
    '| Набор | Пройдено | Pass rate | Порог | Flaky | Стоимость | Токены | Итог |',
    '|-------|----------|-----------|-------|-------|-----------|--------|------|',
    ...results.map(
      (r) =>
        `| ${r.suite} | ${r.passed}/${r.total} | ${percent(r.passRate)} | ` +
        `${percent(r.threshold)} | ${r.flaky.length} | $${r.costUsd.toFixed(4)} | ` +
        `${r.tokens} | ${r.ok ? 'OK' : 'FAIL'} |`,
    ),
  );
  for (const r of results.filter((x) => x.failures.length > 0)) {
    lines.push('', `**Не прошли (${r.suite}):**`, '', ...r.failures.map((f) => `- ${f}`));
  }
  for (const r of results.filter((x) => x.flaky.length > 0)) {
    lines.push(
      '',
      `**Flaky (${r.suite}), упали в первом прогоне и прошли во всех повторах:**`,
      '',
      ...r.flaky.map((f) => `- ${f}`),
    );
  }
  lines.push(
    '',
    'Стоимость считается по pricing из release.json, включает повторы и не включает grader ' +
      '(`llm-rubric`).',
  );
  if (ctx.runUrl) {
    lines.push('', `Отчёты promptfoo: artifact \`eval-reports\` в [прогоне](${ctx.runUrl}).`);
  }
  return lines.join('\n') + '\n';
}
