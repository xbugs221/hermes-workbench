import { terminalTheme, observeTerminalTheme } from './terminal-theme';
/**
 * 文件目的：使用 xterm 承载 Hermes TUI 与工作区原始 shell，并通过 SDK 建立认证 WebSocket。
 * 业务边界：终端只连接用户当前会话绑定的工作区，不自行拼接认证参数。
 */
import { FitAddon } from '@xterm/addon-fit';
import { Terminal } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';
import { sessionIdFromEvent } from './session-events';
import { uiText } from './ui-locale';
import {
  resetTerminalTextarea,
  shouldBlockComposingEnter,
  shouldRepairStaleMobileInput,
  shouldResetMobileTerminalInput,
} from './terminal-ime';
import {
  imageFilesFromTransfer,
  readClipboardImageFiles,
  transferMayContainImage,
  uploadWorkbenchFile,
  uploadWorkbenchImage,
} from './workbench-image-paste';
import {
  terminalHelperKeyInput,
  virtualCtrlInput,
  type TerminalHelperKey,
} from './terminal-helper-keys';
import { terminalProfileParam } from './terminal-profile';

type SDK = Record<string, any>;
type TerminalMode = 'chat' | 'shell';
type TerminalPanelProps = {
  mode: TerminalMode;
  profile: string;
  instanceId: string;
  resumeSessionId?: string;
  /** 新建会话首次连接时送入 TUI 的任务上下文；已恢复会话不重复发送。 */
  initialInput?: string;
  onSessionActivity?: (sessionId: string) => void;
  workspaceId: string;
  workspacePath: string;
  active?: boolean;
  visible?: boolean;
  attachmentInputRef?: { current: HTMLInputElement | null };
  onAttachmentUploadState?: (uploading: boolean) => void;
};

/** Keep one reconnectable PTY identity per Workbench terminal instance. */
function terminalAttachToken(mode: TerminalMode, profile: string, instanceId: string): string {
  const key = `hermes.workbench.${mode}.${profile}.${instanceId}.attach`;
  try {
    const existing = window.sessionStorage.getItem(key);
    if (existing) return existing;
    const token = globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random()}`;
    window.sessionStorage.setItem(key, token);
    return token;
  } catch {
    return `${Date.now()}-${Math.random()}`;
  }
}

/** 创建使用宿主 React 实例的元素，避免插件打包第二份 React。 */
function element(React: any, type: any, props?: Record<string, any> | null, ...children: any[]): any {
  return React.createElement(type, props, ...children);
}

/** 从 shell 的 JSON 信封或 PTY 二进制帧中提取终端字节。 */
function terminalPayload(value: unknown): string | Uint8Array | null {
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  const raw = String(value ?? '');
  if (!raw.startsWith('{')) return raw;
  try {
    const parsed = JSON.parse(raw);
    if (parsed.type === 'pong') return null;
    return typeof parsed.data === 'string'
      ? parsed.data
      : typeof parsed.output === 'string'
        ? parsed.output
        : raw;
  } catch {
    return raw;
  }
}

/** 把连接状态转换为当前界面的单语标签。 */
function terminalStatusLabel(status: string, mode: TerminalMode): string {
  if (status === 'open') return mode === 'chat' ? 'Hermes TUI' : 'Shell';
  if (status === 'connecting') return uiText('连接中', 'Connecting');
  if (status === 'closed') return uiText('已断开', 'Disconnected');
  if (status === 'error') return uiText('连接失败', 'Connection failed');
  return uiText('等待连接', 'Idle');
}


/** 创建可复用于聊天和右栏 shell 的原生 xterm 组件。 */
export function createTerminalPanel(sdk: SDK): (props: TerminalPanelProps) => any {
  const React = sdk.React;
  const { useEffect, useRef, useState } = sdk.hooks;

  return function TerminalPanel({
    mode,
    profile,
    instanceId,
    resumeSessionId = '',
    initialInput = '',
    onSessionActivity,
    workspaceId,
    workspacePath,
    active = true,
    visible = true,
    attachmentInputRef,
    onAttachmentUploadState,
  }: TerminalPanelProps): any {
    /** 用户路径：打开面板后连接目标终端，关闭或切换会话时完整释放 PTY。 */
    const hostRef = useRef(null as HTMLDivElement | null);
    const terminalRef = useRef(null as Terminal | null);
    const fitRef = useRef(null as FitAddon | null);
    const socketRef = useRef(null as WebSocket | null);
    const sendInputRef = useRef((data: string) => undefined as void);
    const internalFileInputRef = useRef(null as HTMLInputElement | null);
    const fileInputRef = attachmentInputRef || internalFileInputRef;
    const attachLocalFilesRef = useRef(async (_files: File[]) => undefined as void);
    const virtualCtrlRef = useRef(false);
    const onSessionActivityRef = useRef(onSessionActivity);
    onSessionActivityRef.current = onSessionActivity;
    const [retry, setRetry] = useState(0);
    const [status, setStatus] = useState('idle' as 'idle' | 'connecting' | 'open' | 'closed' | 'error');
    const [virtualCtrlActive, setVirtualCtrlActive] = useState(false);

    virtualCtrlRef.current = virtualCtrlActive;

    useEffect(() => {
      if (!active || !hostRef.current || !instanceId || !workspaceId) return undefined;
      let disposed = false;
      let resizeObserver: ResizeObserver | null = null;
      let inputDisposable: { dispose: () => void } | null = null;
      let eventSocket: WebSocket | null = null;
      let connectFallback: number | null = null;
      const terminal = new Terminal({
        allowProposedApi: false,
        convertEol: false,
        cursorBlink: true,
        fontFamily: 'var(--theme-font-mono, ui-monospace, SFMono-Regular, Menlo, monospace)',
        fontSize: window.matchMedia('(max-width: 640px)').matches ? 15 : 13,
        minimumContrastRatio: 4.5,
        scrollback: 5000,
        theme: terminalTheme(hostRef.current),
      });
      const fit = new FitAddon();
      terminal.loadAddon(fit);
      terminal.open(hostRef.current);
      const stopThemeObserver = observeTerminalTheme(hostRef.current, terminal);
      terminalRef.current = terminal;
      fitRef.current = fit;
      const mobileInput = window.matchMedia('(max-width: 640px)').matches;
      let composing = false;
      let pendingCompositionSubmit = false;
      const repairMobileInput = () => {
        const submitted = terminal.textarea?.value || '';
        if (!submitted) return;
        let repaired = false;
        const repair = () => {
          if (repaired || !shouldRepairStaleMobileInput(submitted, terminal.textarea?.value || '')) return;
          const socket = socketRef.current;
          // xterm has finished its IME callbacks but restored the submitted
          // sentence into both its textarea and the TUI composer. Ctrl+U clears
          // only that unchanged stale draft; normal keydown Enter has already
          // emptied textarea and never enters this branch.
          if (socket?.readyState === WebSocket.OPEN) socket.send('\x15');
          resetTerminalTextarea(terminal.textarea);
          repaired = true;
        };
        window.setTimeout(repair, 96);
        window.setTimeout(repair, 240);
      };
      const sendTerminalData = (data: string) => {
        const socket = socketRef.current;
        if (socket?.readyState === WebSocket.OPEN) socket.send(data);
        if (shouldResetMobileTerminalInput(mode, mobileInput, data)) repairMobileInput();
      };
      sendInputRef.current = sendTerminalData;
      const handleCompositionStart = () => { composing = true; };
      const handleCompositionEnd = () => {
        composing = false;
        if (!pendingCompositionSubmit) return;
        pendingCompositionSubmit = false;
        // xterm finalizes committed IME text in its own zero-delay callback.
        // Defer one additional task so CR is always sent after that text.
        window.setTimeout(() => window.setTimeout(() => sendTerminalData('\r'), 0), 0);
      };
      hostRef.current.addEventListener('compositionstart', handleCompositionStart, { capture: true });
      hostRef.current.addEventListener('compositionend', handleCompositionEnd, { capture: true });
      // 浏览器拥有剪贴板，Hermes 容器没有：Ctrl/Cmd+V 图片须先上传再经 PTY 执行 /image。
      let imagePasteDisposed = false;
      const attachImages = async (files: File[]) => {
        for (const file of files) {
          if (imagePasteDisposed) return;
          const path = await uploadWorkbenchImage(file, profile);
          const socket = socketRef.current;
          if (!socket || socket.readyState !== WebSocket.OPEN) throw new Error('chat is not connected');
          socket.send(`/image ${path}`);
          await new Promise<void>(resolve => window.setTimeout(resolve, 100));
          if (socketRef.current?.readyState === WebSocket.OPEN) socketRef.current.send('\r');
        }
        terminal.focus();
      };
      attachLocalFilesRef.current = async (files: File[]) => {
        for (const file of files) {
          if (imagePasteDisposed) return;
          if (file.type.startsWith('image/')) {
            await attachImages([file]);
            continue;
          }
          const path = await uploadWorkbenchFile(file, workspacePath);
          const socket = socketRef.current;
          if (!socket || socket.readyState !== WebSocket.OPEN) throw new Error('chat is not connected');
          // Leave ordinary file paths in the composer so the user can add a question before sending.
          socket.send(`${path} `);
        }
        terminal.focus();
      };
      const handleImagePaste = (event: ClipboardEvent) => {
        if (mode !== 'chat') return;
        const files = imageFilesFromTransfer(event.clipboardData);
        if (!files.length) return;
        event.preventDefault();
        event.stopPropagation();
        void attachImages(files).catch(reason => {
          terminal.writeln(`\r\n\u001b[31mImage paste failed: ${String(reason)}\u001b[0m`);
        });
      };
      const handleImageDragOver = (event: DragEvent) => {
        if (mode !== 'chat' || !transferMayContainImage(event.dataTransfer)) return;
        event.preventDefault();
        if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
      };
      const handleImageDrop = (event: DragEvent) => {
        if (mode !== 'chat') return;
        const files = imageFilesFromTransfer(event.dataTransfer);
        if (!files.length) return;
        event.preventDefault();
        event.stopPropagation();
        void attachImages(files).catch(reason => {
          terminal.writeln(`\r\n\u001b[31mImage drop failed: ${String(reason)}\u001b[0m`);
        });
      };
      hostRef.current.addEventListener('paste', handleImagePaste, { capture: true });
      hostRef.current.addEventListener('dragover', handleImageDragOver, { capture: true });
      hostRef.current.addEventListener('drop', handleImageDrop, { capture: true });

      // xterm converts Ctrl+V into a control byte before the browser's native
      // paste event can expose an image. Intercept both Ctrl+V and Cmd+V while
      // the user gesture is active, read browser clipboard blobs, then upload.
      terminal.attachCustomKeyEventHandler(event => {
        if (
          virtualCtrlRef.current
          && event.type === 'keydown'
          && !event.ctrlKey
          && !event.metaKey
          && !event.altKey
        ) {
          const input = virtualCtrlInput(event.key);
          if (input) {
            event.preventDefault();
            event.stopPropagation();
            sendTerminalData(input);
            return false;
          }
        }
        if (mode === 'chat' && shouldBlockComposingEnter(event, composing, mobileInput)) {
          pendingCompositionSubmit = true;
          event.preventDefault();
          return false;
        }
        if (
          mode !== 'chat'
          || event.type !== 'keydown'
          || (!event.ctrlKey && !event.metaKey)
          || event.key.toLowerCase() !== 'v'
        ) return true;
        event.preventDefault();
        void (async () => {
          try {
            const files = await readClipboardImageFiles(navigator.clipboard);
            if (files.length) {
              await attachImages(files);
              return;
            }
          } catch {
            // Clipboard.read may be denied; text fallback still preserves paste.
          }
          try {
            const text = await navigator.clipboard?.readText();
            if (text) terminal.paste(text);
          } catch (reason) {
            terminal.writeln(`\r\n\u001b[31mClipboard paste failed: ${String(reason)}\u001b[0m`);
          }
        })();
        return false;
      });
      setStatus('connecting');

      /** 重新计算终端尺寸，并把新行列数同步给目标 PTY。 */
      const fitTerminal = () => {
        if (disposed) return;
        try { fit.fit(); } catch { return; }
        const socket = socketRef.current;
        if (!socket || socket.readyState !== WebSocket.OPEN) return;
        socket.send(`\u001b[RESIZE:${terminal.cols};${terminal.rows}]`);
      };

      resizeObserver = new ResizeObserver(() => fitTerminal());
      resizeObserver.observe(hostRef.current);
      window.requestAnimationFrame(fitTerminal);

      /** 打开承载终端字节的主 PTY，并绑定输入、输出和连接状态。 */
      const openTerminalSocket = (url: string) => {
        if (disposed || socketRef.current) return;
        if (connectFallback !== null) {
          window.clearTimeout(connectFallback);
          connectFallback = null;
        }
        const socket = new WebSocket(url);
        socket.binaryType = 'arraybuffer';
        socketRef.current = socket;
        socket.onopen = () => {
          if (disposed) return;
          setStatus('open');
          fitTerminal();
          // 任务入口只在新会话的首次 PTY 连接写入，重连/恢复不得重复提交同一提示。
          if (mode === 'chat' && !resumeSessionId && initialInput) {
            const key = `hermes.workbench.initial-input.${profile}.${instanceId}`;
            try {
              if (window.sessionStorage.getItem(key) !== 'sent') {
                window.sessionStorage.setItem(key, 'sent');
                window.setTimeout(() => {
                  if (!disposed && socket.readyState === WebSocket.OPEN) socket.send(`${initialInput}\r`);
                }, 250);
              }
            } catch {
              // 私密模式下依然可用；最坏情况是重连后提示会重复一次。
              window.setTimeout(() => {
                if (!disposed && socket.readyState === WebSocket.OPEN) socket.send(`${initialInput}\r`);
              }, 250);
            }
          }
        };
        socket.onmessage = event => {
          const payload = terminalPayload(event.data);
          if (payload !== null) terminal.write(payload);
        };
        socket.onerror = () => !disposed && setStatus('error');
        socket.onclose = () => !disposed && setStatus('closed');
        inputDisposable = terminal.onData(data => {
          const input = virtualCtrlRef.current ? virtualCtrlInput(data) : null;
          sendTerminalData(input || data);
        });
      };

      /** 获取认证地址；聊天先订阅 sidecar 事件，以免遗漏新会话的精确 ID。 */
      const connect = async () => {
        const path = mode === 'chat' ? '/api/pty' : '/api/plugins/workbench/shell';
        const params: Record<string, string> = {
          channel: `workbench-${mode}-${instanceId}`,
          // `current` keeps the default chat on Dashboard's already-warm
          // in-process gateway. An explicit `default` would force a fresh
          // Python gateway and add roughly five seconds to every new tab.
          profile: terminalProfileParam(mode, profile),
          workspace: workspaceId,
          cwd: workspacePath,
        };
        if (mode === 'chat') {
          params.attach = terminalAttachToken(mode, profile, instanceId);
          if (resumeSessionId) params.resume = resumeSessionId;
        }
        try {
          const urlPromise = sdk.buildWsUrl(path, params);
          const eventsUrlPromise = mode === 'chat'
            ? sdk.buildWsUrl('/api/events', { channel: params.channel }).catch(() => null)
            : Promise.resolve(null);
          const [url, eventsUrl] = await Promise.all([urlPromise, eventsUrlPromise]);
          if (disposed) return;
          if (!eventsUrl) {
            openTerminalSocket(url);
            return;
          }
          eventSocket = new WebSocket(eventsUrl);
          eventSocket.onmessage = event => {
            const activeSessionId = sessionIdFromEvent(event.data);
            if (activeSessionId) onSessionActivityRef.current?.(activeSessionId);
          };
          eventSocket.onopen = () => openTerminalSocket(url);
          eventSocket.onerror = () => openTerminalSocket(url);
          // Resumed sessions already have a stable id, so event subscription is
          // advisory and must not add up to 500 ms to visible TUI history.
          if (resumeSessionId) openTerminalSocket(url);
          else connectFallback = window.setTimeout(() => openTerminalSocket(url), 500);
        } catch (error) {
          if (!disposed) {
            terminal.writeln(`\r\n\u001b[31m${String(error)}\u001b[0m`);
            setStatus('error');
          }
        }
      };
      void connect();

      return () => {
        disposed = true;
        imagePasteDisposed = true;
        hostRef.current?.removeEventListener('paste', handleImagePaste, { capture: true });
        hostRef.current?.removeEventListener('dragover', handleImageDragOver, { capture: true });
        hostRef.current?.removeEventListener('drop', handleImageDrop, { capture: true });
        hostRef.current?.removeEventListener('compositionstart', handleCompositionStart, { capture: true });
        hostRef.current?.removeEventListener('compositionend', handleCompositionEnd, { capture: true });
        if (connectFallback !== null) window.clearTimeout(connectFallback);
        resizeObserver?.disconnect();
        stopThemeObserver();
        inputDisposable?.dispose();
        eventSocket?.close();
        const socket = socketRef.current;
        if (socket?.readyState === WebSocket.CONNECTING) {
          socket.onmessage = null;
          socket.onerror = null;
          socket.onclose = null;
          socket.onopen = () => socket.close();
        } else {
          socket?.close();
        }
        socketRef.current = null;
        sendInputRef.current = () => undefined;
        attachLocalFilesRef.current = async () => undefined;
        terminal.dispose();
        terminalRef.current = null;
        fitRef.current = null;
      };
    }, [active, initialInput, instanceId, mode, profile, resumeSessionId, retry, workspaceId, workspacePath]);

    /** 显示后台预热的终端时重新适配尺寸，不重建 WebSocket 或 PTY。 */
    useEffect(() => {
      if (!visible) return undefined;
      const frame = window.requestAnimationFrame(() => {
        const terminal = terminalRef.current;
        const fit = fitRef.current;
        if (!terminal || !fit) return;
        try { fit.fit(); } catch { return; }
        const socket = socketRef.current;
        if (socket?.readyState === WebSocket.OPEN) {
          socket.send(`\u001b[RESIZE:${terminal.cols};${terminal.rows}]`);
        }
      });
      return () => window.cancelAnimationFrame(frame);
    }, [visible]);

    const helperKeys: Array<{ key: TerminalHelperKey; label: string; ariaLabel: string }> = [
      { key: 'escape', label: 'Esc', ariaLabel: uiText('退出键', 'Escape') },
      { key: 'tab', label: 'Tab', ariaLabel: uiText('制表键', 'Tab') },
      { key: 'arrowLeft', label: '←', ariaLabel: uiText('向左', 'Arrow left') },
      { key: 'arrowDown', label: '↓', ariaLabel: uiText('向下', 'Arrow down') },
      { key: 'arrowUp', label: '↑', ariaLabel: uiText('向上', 'Arrow up') },
      { key: 'arrowRight', label: '→', ariaLabel: uiText('向右', 'Arrow right') },
    ];

    /** 辅助键在 pointerdown 即发送，避免触屏按钮夺走 xterm 隐藏输入框焦点。 */
    const sendHelperKey = (key: TerminalHelperKey) => {
      sendInputRef.current(terminalHelperKeyInput(key, virtualCtrlRef.current));
      terminalRef.current?.focus();
    };

    return element(React, 'div', {
      className: `hti-terminal-frame is-${mode}${visible ? '' : ' is-prewarming'}`,
      'aria-hidden': !visible,
    },
      element(React, 'div', { className: 'hti-terminal-status' },
        element(React, 'span', { className: `hti-status-dot is-${status}`, 'aria-hidden': true }),
        element(React, 'span', null, terminalStatusLabel(status, mode)),
        status === 'closed' || status === 'error'
          ? element(React, 'button', { type: 'button', onClick: () => setRetry((value: number) => value + 1) }, uiText('重连', 'Reconnect'))
          : null),
      element(React, 'div', { ref: hostRef, className: 'hti-terminal-host' }),
      element(React, 'input', {
        ref: fileInputRef,
        className: 'hti-terminal-upload-input',
        type: 'file',
        multiple: true,
        tabIndex: -1,
        'aria-hidden': true,
        onChange: (event: Event) => {
          const input = event.currentTarget as HTMLInputElement;
          const files = Array.from(input.files || []);
          input.value = '';
          if (!files.length) return;
          onAttachmentUploadState?.(true);
          void attachLocalFilesRef.current(files).catch((reason: unknown) => {
            terminalRef.current?.writeln(`\r\n\u001b[31m${uiText('文件上传失败', 'File upload failed')}: ${String(reason)}\u001b[0m`);
          }).finally(() => onAttachmentUploadState?.(false));
        },
      }),
      visible ? element(React, 'div', {
        className: 'hti-terminal-keybar',
        role: 'toolbar',
        'aria-label': uiText('终端快捷辅助键', 'Terminal helper keys'),
      },
      element(React, 'button', {
        type: 'button',
        className: 'hti-terminal-helper-key is-ctrl',
        'aria-label': uiText('控制键', 'Control'),
        'aria-pressed': virtualCtrlActive,
        onPointerDown: (event: PointerEvent) => event.preventDefault(),
        onPointerUp: (event: PointerEvent) => {
          event.preventDefault();
          setVirtualCtrlActive((value: boolean) => !value);
          terminalRef.current?.focus();
        },
        onKeyDown: (event: KeyboardEvent) => {
          if (event.key !== 'Enter' && event.key !== ' ') return;
          event.preventDefault();
          setVirtualCtrlActive((value: boolean) => !value);
        },
      }, 'Ctrl'),
      ...helperKeys.map(helper => element(React, 'button', {
        key: helper.key,
        type: 'button',
        className: 'hti-terminal-helper-key',
        'aria-label': helper.ariaLabel,
        onPointerDown: (event: PointerEvent) => {
          event.preventDefault();
          sendHelperKey(helper.key);
        },
        onKeyDown: (event: KeyboardEvent) => {
          if (event.key !== 'Enter' && event.key !== ' ') return;
          event.preventDefault();
          sendHelperKey(helper.key);
        },
      }, helper.label))) : null);
  };
}
