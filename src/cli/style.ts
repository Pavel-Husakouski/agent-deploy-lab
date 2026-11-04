// Жирный только в терминале: в файле и pipe escape-коды были бы мусором. NO_COLOR — общепринятый
// способ отключить стили, пустое значение его не включает.
export function boldEnabled(isTty: boolean | undefined, noColor: string | undefined): boolean {
  return Boolean(isTty) && !noColor;
}

// Сброс в каждом фрагменте: при ошибке или обрыве потока терминал не останется жирным.
export function bold(text: string): string {
  return `\x1b[1m${text}\x1b[0m`;
}
