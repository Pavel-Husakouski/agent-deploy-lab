import { spawnSync } from 'node:child_process';
import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { parseManifest } from '../src/release.js';

// Eval gate: прогоняет наборы promptfoo из evals/<evalDataset>/ для текущего release.json и
// падает, если pass rate набора ниже порога. Итог пишется в stdout и в GitHub Job Summary.
// Запуск: npm run eval [-- --suite golden]. Ключ DeepSeek: DEEPSEEK_API_KEY в окружении или
// в .env (его читает promptfoo).

// Порог pass rate по набору. LLM недетерминирован, поэтому golden допускает 1 случайный фейл
// из 10; injection не допускает ни одного.
const SUITES = { golden: 0.9, injection: 1 } as const;
type Suite = keyof typeof SUITES;

const PROMPTFOO = join('evals', 'node_modules', '.bin', 'promptfoo');
const REPORTS = 'reports';

const { values } = parseArgs({ options: { suite: { type: 'string', multiple: true } } });
const suites = (values.suite ?? Object.keys(SUITES)) as Suite[];
for (const suite of suites) {
  if (!(suite in SUITES)) {
    console.error(`неизвестный набор ${suite}, доступны: ${Object.keys(SUITES).join(', ')}`);
    process.exit(2);
  }
}

const manifest = parseManifest(await readFile('release.json', 'utf8'));
const datasetDir = join('evals', manifest.evalDataset);
await mkdir(REPORTS, { recursive: true });

interface EvalResult {
  success: boolean;
  cost?: number;
  error?: string;
  testCase: { description?: string };
  gradingResult?: { reason?: string } | null;
}

interface EvalOutput {
  results: {
    stats: { successes: number; failures: number; errors: number; tokenUsage: { total: number } };
    results: EvalResult[];
  };
}

interface SuiteSummary {
  suite: Suite;
  passed: number;
  total: number;
  passRate: number;
  threshold: number;
  costUsd: number;
  tokens: number;
  ok: boolean;
  failures: string[];
}

function runSuite(suite: Suite): Promise<SuiteSummary> {
  const config = join(datasetDir, `${suite}.yaml`);
  const json = join(REPORTS, `${suite}.json`);
  const result = spawnSync(
    PROMPTFOO,
    [
      'eval',
      ...['-c', config],
      ...['-o', json, join(REPORTS, `${suite}.html`)],
      '--no-cache',
      '--no-share',
      '--no-progress-bar',
      '--no-table',
    ],
    {
      stdio: 'inherit',
      env: {
        ...process.env,
        // Решение о прохождении принимает этот скрипт по порогу набора, а не promptfoo.
        PROMPTFOO_FAILED_TEST_EXIT_CODE: '0',
        PROMPTFOO_DISABLE_TELEMETRY: '1',
        PROMPTFOO_DISABLE_UPDATE: '1',
      },
    },
  );
  if (result.error || result.status !== 0) {
    throw new Error(`promptfoo ${suite} завершился с ошибкой: ${result.error ?? result.status}`);
  }
  return summarize(suite, json);
}

async function summarize(suite: Suite, jsonPath: string): Promise<SuiteSummary> {
  const { results } = JSON.parse(await readFile(jsonPath, 'utf8')) as EvalOutput;
  const { successes, failures, errors, tokenUsage } = results.stats;
  // Ошибки провайдера (сеть, лимиты) считаются непройденными тестами: gate не зелёный «вслепую».
  const total = successes + failures + errors;
  const passRate = total > 0 ? successes / total : 0;
  const threshold = SUITES[suite];
  return {
    suite,
    passed: successes,
    total,
    passRate,
    threshold,
    costUsd: results.results.reduce((sum, r) => sum + (r.cost ?? 0), 0),
    tokens: tokenUsage.total,
    ok: total > 0 && passRate >= threshold,
    failures: results.results
      .filter((r) => !r.success)
      .map((r) => {
        const reason = (r.error ?? r.gradingResult?.reason ?? '').replace(/\s+/g, ' ');
        return `${r.testCase.description ?? 'без описания'}: ${reason.slice(0, 300)}`;
      }),
  };
}

function percent(x: number): string {
  return `${(x * 100).toFixed(0)}%`;
}

function render(summaries: SuiteSummary[]): string {
  const lines = [
    `### Eval gate: release ${manifest.version}, dataset ${manifest.evalDataset}`,
    '',
    `Prompt \`${manifest.prompt.id}\`, model \`${manifest.model.id}\`.`,
    '',
    '| Набор | Пройдено | Pass rate | Порог | Стоимость | Токены | Итог |',
    '|-------|----------|-----------|-------|-----------|--------|------|',
    ...summaries.map(
      (s) =>
        `| ${s.suite} | ${s.passed}/${s.total} | ${percent(s.passRate)} | ` +
        `${percent(s.threshold)} | $${s.costUsd.toFixed(4)} | ${s.tokens} | ` +
        `${s.ok ? 'OK' : 'FAIL'} |`,
    ),
  ];
  for (const s of summaries.filter((x) => x.failures.length > 0)) {
    lines.push('', `**Не прошли (${s.suite}):**`, '', ...s.failures.map((f) => `- ${f}`));
  }
  lines.push(
    '',
    'Стоимость считается по pricing из release.json и не включает grader (`llm-rubric`).',
  );
  return lines.join('\n') + '\n';
}

const summaries: SuiteSummary[] = [];
for (const suite of suites) summaries.push(await runSuite(suite));

const report = render(summaries);
console.log(`\n${report}`);
if (process.env['GITHUB_STEP_SUMMARY']) {
  await appendFile(process.env['GITHUB_STEP_SUMMARY'], report);
}
process.exit(summaries.every((s) => s.ok) ? 0 : 1);
