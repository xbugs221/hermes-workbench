// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { connectRealtime } from '../dashboard/src/realtime-connection';
class Socket extends EventTarget {
  static CONNECTING = 0; static OPEN = 1; static CLOSING = 2; static CLOSED = 3;
  static instances: Socket[] = [];
  readyState = 0;
  constructor(public url: string) { super(); Socket.instances.push(this); }
  close() { this.readyState = 3; this.dispatchEvent(new Event('close')); }
}
let stop: () => void;
let hidden = false;
const callbacks = { message: vi.fn(), error: vi.fn(), open: vi.fn(), socket: vi.fn() };
const visibility = (value: boolean) => { hidden = value; document.dispatchEvent(new Event('visibilitychange')); };
beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(10000); vi.stubGlobal('WebSocket', Socket);
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden });
  hidden = false; Socket.instances = []; vi.clearAllMocks();
  stop = connectRealtime('ws://test', callbacks);
});
afterEach(() => { stop(); vi.useRealTimers(); vi.unstubAllGlobals(); });
test('foreground bypasses maximum backoff and ignores retired socket events', () => {
  visibility(true);
  for (const delay of [150,300,600,1200,2400,4800]) {
    Socket.instances.at(-1)!.close(); vi.advanceTimersByTime(delay);
  }
  const old = Socket.instances.at(-1)!; old.close();
  const count = Socket.instances.length;
  visibility(false);
  expect(Socket.instances.length).toBe(count + 1);
  old.dispatchEvent(new Event('error')); old.dispatchEvent(new Event('close'));
  expect(callbacks.error).not.toHaveBeenCalled();
  vi.advanceTimersByTime(5000);
  expect(Socket.instances.length).toBe(count + 1);
});
test('replaces apparently open connection after suspension without duplicate focus connect', () => {
  Socket.instances[0].readyState = Socket.OPEN;
  visibility(true); vi.advanceTimersByTime(2000); visibility(false);
  window.dispatchEvent(new Event('focus'));
  expect(Socket.instances.length).toBe(2);
  Socket.instances[0].dispatchEvent(new MessageEvent('message', {data:'stale'}));
  expect(callbacks.message).not.toHaveBeenCalled();
  Socket.instances[1].dispatchEvent(new MessageEvent('message', {data:'fresh'}));
  expect(callbacks.message).toHaveBeenCalledTimes(1);
});
test('first disconnect retries within 150ms; disposal cancels retries and listeners', () => {
  Socket.instances[0].close(); vi.advanceTimersByTime(149);
  expect(Socket.instances.length).toBe(1);
  vi.advanceTimersByTime(1); expect(Socket.instances.length).toBe(2);
  Socket.instances[1].close(); stop();
  window.dispatchEvent(new Event('online')); vi.advanceTimersByTime(10000);
  expect(Socket.instances.length).toBe(2);
});
test('online immediately replaces stale connection', () => {
  window.dispatchEvent(new Event('online'));
  expect(Socket.instances.length).toBe(2);
  Socket.instances[1].dispatchEvent(new Event('open'));
  expect(callbacks.open).toHaveBeenCalledTimes(1);
});
