// Жирный только в терминале: в файле и pipe escape-коды были бы мусором. NO_COLOR — общепринятый
// способ отключить стили, пустое значение его не включает.
export function boldEnabled(isTty: boolean | undefined, noColor: string | undefined): boolean {
  return Boolean(isTty) && !noColor;
}

// Сброс в каждом фрагменте: при ошибке или обрыве потока терминал не останется жирным.
export function bold(text: string): string {
  return `\x1b[1m${text}\x1b[0m`;
}

export interface BoldRenderer {
  write(delta: string): string;
  end(): string;
}

// Потоковый рендер **жирного**: модель отвечает в markdown, а терминал его не понимает. Маркеры
// убираются всегда, escape-коды добавляются только при styled. Маркер может прийти разрезанным
// между фрагментами, поэтому «*» в конце фрагмента ждёт следующего. allBold — весь текст жирный.
export function createBoldRenderer(styled: boolean, allBold = false): BoldRenderer {
  let strong = false;
  let pending = '';
  const emit = (text: string) => (text && styled && (allBold || strong) ? bold(text) : text);

  return {
    write(delta) {
      const text = pending + delta;
      pending = '';
      let out = '';
      let run = '';
      for (let i = 0; i < text.length; i++) {
        if (text.startsWith('**', i)) {
          out += emit(run);
          run = '';
          strong = !strong;
          i++;
        } else if (text[i] === '*' && i === text.length - 1) {
          pending = '*';
        } else {
          run += text[i];
        }
      }
      return out + emit(run);
    },
    end() {
      const rest = emit(pending);
      pending = '';
      return rest;
    },
  };
}
