import { isDeepStrictEqual } from 'node:util';
import { compareSemver, parseManifest, sha256, type ReleaseManifest } from './release.js';

// Состояние репозитория для проверки: текст release.json, промпты по id и eval datasets
// (id → fingerprint содержимого каталога evals/<id>/, см. datasetFingerprint).
export interface RepoSnapshot {
  manifest: string | null;
  prompts: ReadonlyMap<string, string>;
  datasets: ReadonlyMap<string, string>;
}

// Fingerprint каталога dataset: sha256 от отсортированных пар «путь + содержимое».
export function datasetFingerprint(files: ReadonlyMap<string, string>): string {
  const parts = [...files.keys()].sort().map((path) => `${path}\0${files.get(path)}\0`);
  return sha256(parts.join(''));
}

// Поля manifest, изменение которых меняет поведение агента и требует bump версии.
function behaviorOf(m: ReleaseManifest) {
  return { model: m.model, prompt: m.prompt, evalDataset: m.evalDataset };
}

// Правила (возвращает список нарушений, пустой список = проверка пройдена):
// 1. release.json валиден по схеме, version в semver;
// 2. sha256 файла промпта совпадает с prompt.sha256;
// 3. если изменились промпт, model, evalDataset или содержимое этого dataset, version выросла
//    относительно base;
// 4. выпущенный промпт (есть в base) неизменяем: новый текст = новый файл и новый id;
// 5. каталог evals/<evalDataset>/ существует.
// Если в base нет release.json (первый релиз), правила 3 и 4 не применяются.
export function checkManifest(current: RepoSnapshot, base: RepoSnapshot | null): string[] {
  if (current.manifest === null) return ['release.json не найден'];

  let manifest: ReleaseManifest;
  try {
    manifest = parseManifest(current.manifest);
  } catch (err) {
    return [err instanceof Error ? err.message : String(err)];
  }

  const errors: string[] = [];
  const { id } = manifest.prompt;
  const prompt = current.prompts.get(id);
  if (prompt === undefined) {
    errors.push(`промпт ${id} не найден: ожидается файл prompts/${id}.md`);
  } else if (sha256(prompt) !== manifest.prompt.sha256) {
    errors.push(
      `sha256 промпта ${id} не совпадает с release.json: в файле ${sha256(prompt)}, ` +
        `в manifest ${manifest.prompt.sha256}`,
    );
  }

  if (!current.datasets.has(manifest.evalDataset)) {
    errors.push(
      `eval dataset ${manifest.evalDataset} не найден: ожидается каталог ` +
        `evals/${manifest.evalDataset}/`,
    );
  }

  if (base?.manifest == null) return errors;

  let baseManifest: ReleaseManifest;
  try {
    baseManifest = parseManifest(base.manifest);
  } catch {
    // Невалидный manifest в base не должен блокировать его исправление.
    return errors;
  }

  // Dataset считается изменённым, только если он уже был в base: появление каталога для
  // dataset, который manifest и так указывал, поведение релиза не меняет.
  const baseDataset = base.datasets.get(manifest.evalDataset);
  const datasetChanged =
    baseDataset !== undefined && baseDataset !== current.datasets.get(manifest.evalDataset);

  const cmp = compareSemver(manifest.version, baseManifest.version);
  if (cmp < 0) {
    errors.push(`version ${manifest.version} меньше, чем в base (${baseManifest.version})`);
  } else if (
    cmp === 0 &&
    (datasetChanged || !isDeepStrictEqual(behaviorOf(manifest), behaviorOf(baseManifest)))
  ) {
    errors.push(
      `промпт, model, evalDataset или содержимое dataset изменились, а version осталась ` +
        `${manifest.version}: сделайте bump`,
    );
  }

  for (const [releasedId, releasedText] of base.prompts) {
    const text = current.prompts.get(releasedId);
    if (text !== undefined && text !== releasedText) {
      errors.push(
        `промпт ${releasedId} уже выпущен и неизменяем: ` +
          `создайте новый файл с новым id и укажите его в release.json`,
      );
    }
  }

  return errors;
}
