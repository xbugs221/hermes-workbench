/** Locale helpers for plugin-owned UI. Raw paths, commands, and user content are never translated. */
export function chineseUI(root: Pick<Document, 'documentElement'> = document): boolean {
  // Some native routes briefly render without an html `lang` attribute while
  // the shell is hydrating. Treat that neutral state as the dashboard's
  // Simplified Chinese default; an explicit non-Chinese language still wins.
  const lang = root.documentElement.lang.trim().toLowerCase();
  return !lang || lang.startsWith('zh');
}

export function uiText(chinese: string, english: string, root: Pick<Document, 'documentElement'> = document): string {
  return chineseUI(root) ? chinese : english;
}
