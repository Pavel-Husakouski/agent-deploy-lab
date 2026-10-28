import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

// Консольный клиент: REPL на readline, ответ API печатается по мере прихода SSE-событий.
const API_URL = process.env['API_URL'] ?? 'http://localhost:3000';
const STATE_DIR = join(homedir(), '.agent-deploy-lab');
const SESSION_FILE = join(STATE_DIR, 'session');

async function loadSession(): Promise<string> {
  try {
    const id = (await readFile(SESSION_FILE, 'utf8')).trim();
    if (id) return id;
  } catch {
    // Файла ещё нет: создадим новую сессию ниже.
  }
  return newSession();
}

async function newSession(): Promise<string> {
  const id = randomUUID();
  await mkdir(STATE_DIR, { recursive: true });
  await writeFile(SESSION_FILE, `${id}\n`, 'utf8');
  return id;
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

async function sendMessage(sessionId: string, message: string): Promise<void> {
  const res = await fetch(`${API_URL}/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sessionId, message }),
  });
  if (!res.ok || !res.body) {
    console.error(`\n[ошибка API ${res.status}] ${await res.text()}`);
    return;
  }
  for await (const { event, data } of readSse(res.body)) {
    if (event === 'message') {
      const { delta } = JSON.parse(data) as { delta: string };
      process.stdout.write(delta);
    } else if (event === 'done') {
      process.stdout.write('\n');
      return;
    } else if (event === 'error') {
      const { message: text } = JSON.parse(data) as { message: string };
      console.error(`\n[ошибка LLM] ${text}`);
      return;
    }
  }
  console.error('\n[поток оборвался без события done]');
}

async function main(): Promise<void> {
  let sessionId = await loadSession();
  console.log(`API: ${API_URL}, сессия: ${sessionId}`);
  console.log('Команды: /new — новая сессия, /exit — выход. Напишите «начнём», чтобы начать.');

  const rl = createInterface({ input: process.stdin, output: process.stdout, prompt: '> ' });
  // При вводе через pipe readline закрывается по EOF, пока ещё печатается ответ.
  let closed = false;
  rl.once('close', () => {
    closed = true;
  });
  const prompt = () => {
    if (!closed) rl.prompt();
  };
  prompt();
  for await (const input of rl) {
    const line = input.trim();
    if (line === '/exit') break;
    if (line === '/new') {
      sessionId = await newSession();
      console.log(`Новая сессия: ${sessionId}`);
    } else if (line) {
      try {
        await sendMessage(sessionId, line);
      } catch (err) {
        console.error(`[не удалось связаться с API] ${err instanceof Error ? err.message : err}`);
      }
    }
    prompt();
  }
  rl.close();
}

await main();
