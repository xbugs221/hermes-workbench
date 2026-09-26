interface NamedSession { id: string; title?: string }

/** Persisted names win; first-message text only fills an unnamed session. */
export function resolveSessionTitle(current: NamedSession, detail?: NamedSession | null, firstMessage = ''): string {
  for (const session of [detail, current]) {
    const title = session?.title?.trim();
    if (title && title !== session?.id) return title;
  }
  return firstMessage.split(/\r?\n/)[0].trim().slice(0, 80) || current.id;
}
