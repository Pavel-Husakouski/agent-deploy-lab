import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { parseArgs } from 'node:util';
import type { ChatTurn } from '../prompt.js';
import { IdSchema, RoleSchema } from '../prompt.js';
import { decideAction, parseInput, REVIEWED_HINT, type Stage } from './input.js';
import { boldEnabled, createBoldRenderer } from './style.js';

// Консольный клиент: REPL на readline, ответ API печатается по мере прихода SSE-событий.
const API_URL = process.env['API_URL'] ?? 'http://localhost:13000';
const STATE_DIR = join(homedir(), '.agent-deploy-lab');
const ROLE_FILE = join(STATE_DIR, 'role');
const CLIENT_ID_FILE = join(STATE_DIR, 'client-id');

async function loadRole(): Promise<string | undefined> {
  try {
    const role = RoleSchema.safeParse(await readFile(ROLE_FILE, 'utf8'));
    return role.success ? role.data : undefined;
  } catch {
    // Файла ещё нет: роль спросим на старте.
    return undefined;
  }
}

async function saveRole(role: string): Promise<void> {
  await mkdir(STATE_DIR, { recursive: true });
  await writeFile(ROLE_FILE, `${role}\n`, 'utf8');
}

// clientId переживает перезапуск CLI: по нему API помнит уже заданные вопросы.
async function loadClientId(): Promise<string> {
  try {
    const saved = IdSchema.safeParse((await readFile(CLIENT_ID_FILE, 'utf8')).trim());
    if (saved.success) return saved.data;
  } catch {
    // Файла ещё нет: создадим новый идентификатор.
  }
  const clientId = randomUUID();
  await mkdir(STATE_DIR, { recursive: true });
  await writeFile(CLIENT_ID_FILE, `${clientId}\n`, 'utf8');
  return clientId;
}

interface SseEvent {
  event: string;
  data: string;
}

// Разбирает поток SSE на события. Поддерживает только поля event и data (этого хватает API).
async function* readSse(body: ReadableStream<Uint8Array>): AsyncGenerator<SseEvent> {
  const decoder = new TextDecoder();
  let buffer = '';
  for await (const chunk of body) {
    buffer += decoder.decode(chunk, { stream: true });
    let sep: number;
    while ((sep = buffer.indexOf('\n\n')) !== -1) {
      const block = buffer.slice(0, sep);
      buffer = buffer.slice(sep + 2);
      let event = 'message';
      const data: string[] = [];
      for (const line of block.split('\n')) {
        if (line.startsWith('event:')) event = line.slice(6).trim();
        else if (line.startsWith('data:')) data.push(line.slice(5).trimStart());
      }
      yield { event, data: data.join('\n') };
    }
  }
}

// Возвращает true, если ответ дошёл до конца: от этого зависит следующий шаг тренировки.
async function sendTurn(sessionId: string, role: string, turn: ChatTurn): Promise<boolean> {
  // Вопрос печатается жирным целиком, в остальных ответах — только **выделенное**.
  const render = createBoldRenderer(
    boldEnabled(process.stdout.isTTY, process.env['NO_COLOR']),
    turn.mode === 'question',
  );
  let res: Response;
  try {
    res = await fetch(`${API_URL}/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId, role, ...turn }),
    });
    if (!res.ok || !res.body) {
      console.error(`\n[ошибка API ${res.status}] ${await res.text()}`);
      return false;
    }
    for await (const { event, data } of readSse(res.body)) {
      if (event === 'message') {
        const { delta } = JSON.parse(data) as { delta: string };
        process.stdout.write(render.write(delta));
      } else if (event === 'done') {
        process.stdout.write(`${render.end()}\n`);
        return true;
      } else if (event === 'error') {
        const { message: text } = JSON.parse(data) as { message: string };
        console.error(`\n[ошибка LLM] ${text}`);
        return false;
      }
    }
    console.error('\n[поток оборвался без события done]');
  } catch (err) {
    console.error(`[не удалось связаться с API] ${err instanceof Error ? err.message : err}`);
  }
  return false;
}

async function main(): Promise<void> {
  const { values } = parseArgs({ options: { role: { type: 'string' } } });
  const rl = createInterface({ input: process.stdin, output: process.stdout, prompt: '> ' });
  // Итератор создаётся сразу: строки из pipe, пришедшие раньше первого чтения, не потеряются.
  const lines = rl[Symbol.asyncIterator]();
  // При вводе через pipe readline закрывается по EOF, пока ещё печатается ответ.
  let closed = false;
  rl.once('close', () => {
    closed = true;
  });
  const prompt = (text = '> ') => {
    if (closed) return;
    rl.setPrompt(text);
    rl.prompt();
  };

  async function askRole(): Promise<string | undefined> {
    const saved = await loadRole();
    for (;;) {
      prompt(saved ? `Роль [${saved}]: ` : 'Роль (например, Node AWS Developer): ');
      const { value, done } = await lines.next();
      if (done) return undefined;
      const parsed = RoleSchema.safeParse(String(value).trim() || saved || '');
      if (parsed.success) return parsed.data;
      console.error(`Некорректная роль: ${parsed.error.issues[0]?.message}`);
    }
  }

  let initialRole: string | undefined;
  if (values.role !== undefined) {
    const parsed = RoleSchema.safeParse(values.role);
    if (!parsed.success) {
      console.error(`Некорректная роль: ${parsed.error.issues[0]?.message}`);
      process.exitCode = 2;
      rl.close();
      return;
    }
    initialRole = parsed.data;
  } else {
    initialRole = await askRole();
  }
  if (!initialRole) {
    rl.close();
    return;
  }
  let role = initialRole;
  await saveRole(role);
  console.log(`API: ${API_URL}, роль: ${role}`);
  console.log('Ответ — просто текст, уточнение до ответа — "? текст".');
  console.log('После разбора: любой текст — уточнение, Enter — новый вопрос.');
  console.log('Команды: /new — другой вопрос, /role <название> — сменить роль, /exit — выход.');

  // Каждый новый вопрос — новая сессия: из прошлой переиспользуется только название роли.
  // Контекст живёт, пока пользователь уточняет, и сбрасывается при переходе к новому вопросу.
  const clientId = await loadClientId();
  let sessionId = '';
  let stage: Stage = 'no_question';
  const nextQuestion = async () => {
    sessionId = randomUUID();
    console.log(`\n─── новый вопрос, роль: ${role} ───`);
    const ok = await sendTurn(sessionId, role, { mode: 'question', clientId });
    stage = ok ? 'awaiting_answer' : 'no_question';
  };

  await nextQuestion();
  prompt();
  for (;;) {
    const { value, done } = await lines.next();
    if (done) break;
    const action = decideAction(stage, parseInput(String(value)));
    if (action.kind === 'exit') break;
    if (action.kind === 'hint') {
      console.log(action.text);
    } else if (action.kind === 'next_question') {
      await nextQuestion();
    } else if (action.kind === 'retry_question') {
      console.log('Текущего вопроса нет, запрашиваю новый. Сообщение не отправлено.');
      await nextQuestion();
    } else if (action.kind === 'set_role') {
      const parsed = RoleSchema.safeParse(action.role);
      if (parsed.success) {
        role = parsed.data;
        await saveRole(role);
        await nextQuestion();
      } else {
        console.error(`Некорректная роль: ${parsed.error.issues[0]?.message}`);
      }
    } else if (action.kind === 'send') {
      const ok = await sendTurn(sessionId, role, { mode: action.mode, message: action.text });
      if (ok && action.mode === 'answer') stage = 'reviewed';
      if (ok && stage === 'reviewed') console.log(`\n${REVIEWED_HINT}`);
    }
    prompt();
  }
  rl.close();
}

await main();
