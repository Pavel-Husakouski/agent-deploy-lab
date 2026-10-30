import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';

// Release manifest: всё, что влияет на поведение агента, кроме кода (код версионируется тегом
// образа). Правила изменения manifest проверяет scripts/check-manifest.ts.
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

export const ReleaseManifestSchema = z.strictObject({
  version: z.string().regex(SEMVER, 'ожидается semver вида 1.2.3'),
  model: z.strictObject({
    id: z.string().min(1),
    temperature: z.number().min(0).max(2),
    maxTokens: z.number().int().positive(),
    // Цена в USD за 1M токенов, по ней считается метрика стоимости.
    pricing: z.strictObject({
      inputPerMTok: z.number().nonnegative(),
      outputPerMTok: z.number().nonnegative(),
    }),
  }),
  prompt: z.strictObject({
    id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/, 'допустимы a-z, 0-9 и "-"'),
    sha256: z.string().regex(/^[0-9a-f]{64}$/, 'ожидается sha256 в hex'),
  }),
  evalDataset: z.string().min(1),
});

export type ReleaseManifest = z.infer<typeof ReleaseManifestSchema>;

export interface Release {
  manifest: ReleaseManifest;
  systemPrompt: string;
}

export function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

export function promptPath(promptId: string): string {
  return join('prompts', `${promptId}.md`);
}

// Разбирает manifest из JSON-текста. Ошибка содержит все нарушения схемы.
export function parseManifest(text: string): ReleaseManifest {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (err) {
    throw new Error(`release.json не JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  const parsed = ReleaseManifestSchema.safeParse(json);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
      .join('; ');
    throw new Error(`Некорректный release.json: ${issues}`);
  }
  return parsed.data;
}

// Загружает manifest и промпт из корня репозитория. Несовпадение sha256 роняет старт API:
// процесс не должен работать с промптом, который не соответствует релизу.
export async function loadRelease(root = '.'): Promise<Release> {
  const manifest = parseManifest(await readFile(join(root, 'release.json'), 'utf8'));
  const systemPrompt = await readFile(join(root, promptPath(manifest.prompt.id)), 'utf8');
  const actual = sha256(systemPrompt);
  if (actual !== manifest.prompt.sha256) {
    throw new Error(
      `sha256 промпта ${manifest.prompt.id} не совпадает с release.json: ` +
        `ожидается ${manifest.prompt.sha256}, в файле ${actual}`,
    );
  }
  return { manifest, systemPrompt };
}

// Сравнение semver без pre-release: >0, если a новее b.
export function compareSemver(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}
