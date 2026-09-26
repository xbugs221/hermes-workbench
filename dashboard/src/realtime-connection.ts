/** Reconnect immediately after browser suspension; fence callbacks from retired sockets. */
export function connectRealtime(url: string, callbacks: {
  message: (event: MessageEvent) => void;
  error: () => void;
  open: () => void;
  socket: (socket: WebSocket | null) => void;
}) {
  let socket: WebSocket | null = null;
  let disposed = false;
  let failures = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let hiddenAt = document.hidden ? Date.now() : 0;
  const connect = () => {
    if (disposed) return;
    clearTimeout(timer);
    const previous = socket;
    socket = null;
    previous?.close();
    const current = new WebSocket(url);
    socket = current;
    callbacks.socket(current);
    const active = () => !disposed && socket === current;
    current.addEventListener('message', event => { if (active()) callbacks.message(event); });
    current.addEventListener('open', () => {
      if (!active()) return;
      failures = 0;
      callbacks.open();
    });
    current.addEventListener('error', () => { if (active()) callbacks.error(); });
    current.addEventListener('close', () => {
      if (!active()) return;
      socket = null;
      callbacks.socket(null);
      timer = setTimeout(connect, Math.min(5000, 150 * 2 ** Math.min(failures++, 6)));
    });
  };
  const resume = (force = false) => {
    if (document.hidden || disposed) return;
    if (force || !socket || socket.readyState >= WebSocket.CLOSING) {
      failures = 0;
      connect();
    }
  };
  const visibility = () => {
    if (document.hidden) hiddenAt = Date.now();
    else {
      const suspended = hiddenAt !== 0 && Date.now() - hiddenAt >= 1000;
      hiddenAt = 0;
      resume(suspended);
    }
  };
  const focus = () => resume();
  const online = () => resume(true);
  const pageshow = (event: PageTransitionEvent) => resume(event.persisted);
  document.addEventListener('visibilitychange', visibility);
  window.addEventListener('focus', focus);
  window.addEventListener('online', online);
  window.addEventListener('pageshow', pageshow);
  connect();
  return () => {
    disposed = true;
    clearTimeout(timer);
    document.removeEventListener('visibilitychange', visibility);
    window.removeEventListener('focus', focus);
    window.removeEventListener('online', online);
    window.removeEventListener('pageshow', pageshow);
    socket?.close();
    socket = null;
    callbacks.socket(null);
  };
}
