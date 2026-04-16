import { useState, useEffect, useRef, useCallback } from 'react';
import { Send, Bot, User, AlertCircle, Copy, Check, Plus, Search, X, Download, Paperclip, Brain, PanelRightClose, PanelRightOpen } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { useSearchParams } from 'react-router-dom';
import type { Session, WsMessage } from '@/types/api';
import { WebSocketClient, getOrCreateSessionId, SESSION_STORAGE_KEY } from '@/lib/ws';
import { generateUUID } from '@/lib/uuid';
import { useDraft } from '@/hooks/useDraft';
import { t } from '@/lib/i18n';
import { getSessionMessages, getSessions, getStatus, getConfig, putConfig } from '@/lib/api';
import ToolCallCard from '@/components/ToolCallCard';
import type { ToolCallInfo } from '@/components/ToolCallCard';
import {
  loadChatHistory,
  mapServerMessagesToPersisted,
  persistedToUiMessages,
  saveChatHistory,
  uiMessagesToPersisted,
} from '@/lib/chatHistoryStorage';

// ---------------------------------------------------------------------------
// Input history — arrow-up/down cycles through past inputs per session
// ---------------------------------------------------------------------------

class InputHistory {
  private store = new Map<string, string[]>();
  private cursor = new Map<string, number>();
  private maxPerSession = 50;

  push(sessionId: string, text: string) {
    const arr = this.store.get(sessionId) ?? [];
    if (arr[arr.length - 1] === text) return; // dedup consecutive
    arr.push(text);
    if (arr.length > this.maxPerSession) arr.shift();
    this.store.set(sessionId, arr);
    this.cursor.delete(sessionId);
  }

  prev(sessionId: string): string | undefined {
    const arr = this.store.get(sessionId);
    if (!arr?.length) return undefined;
    const cur = this.cursor.get(sessionId) ?? arr.length;
    const next = Math.max(0, cur - 1);
    this.cursor.set(sessionId, next);
    return arr[next];
  }

  next(sessionId: string): string | undefined {
    const arr = this.store.get(sessionId);
    if (!arr?.length) return undefined;
    const cur = this.cursor.get(sessionId) ?? arr.length;
    const next = Math.min(arr.length, cur + 1);
    this.cursor.set(sessionId, next);
    return next >= arr.length ? '' : arr[next];
  }
}

const inputHistory = new InputHistory();

// ---------------------------------------------------------------------------
// Model route helpers (folded from ModelSelector component)
// ---------------------------------------------------------------------------

interface ModelRoute {
  provider: string;
  model: string;
  hint?: string;
}

/**
 * Parse [[model_routes]] entries from a TOML config string.
 */
function parseModelRoutes(toml: string): ModelRoute[] {
  const routes: ModelRoute[] = [];
  const blocks = toml.split(/\[\[model_routes\]\]/);
  for (let i = 1; i < blocks.length; i++) {
    const block = blocks[i]!;
    const nextSection = new RegExp('^\\[(?!\\[model_routes\\])', 'm');
    const sectionEnd = block.search(nextSection);
    const content = sectionEnd === -1 ? block : block.slice(0, sectionEnd);

    const providerMatch = content.match(/^\s*provider\s*=\s*"([^"]+)"/m);
    const modelMatch = content.match(/^\s*model\s*=\s*"([^"]+)"/m);
    const hintMatch = content.match(/^\s*hint\s*=\s*"([^"]+)"/m);
    if (providerMatch && modelMatch) {
      routes.push({
        provider: providerMatch[1]!,
        model: modelMatch[1]!,
        hint: hintMatch?.[1],
      });
    }
  }
  return routes;
}

/**
 * Update the default_provider and default_model in a TOML config string.
 */
function updateDefaultModel(toml: string, provider: string, model: string): string {
  let updated = toml;

  if (/^\s*default_provider\s*=/m.test(updated)) {
    updated = updated.replace(/^(\s*default_provider\s*=\s*).*$/m, `$1"${provider}"`);
  } else {
    const aiMatch = updated.match(/^\[ai\]\s*$/m);
    if (aiMatch && aiMatch.index !== undefined) {
      const insertPos = aiMatch.index + aiMatch[0].length;
      updated = `${updated.slice(0, insertPos)}\ndefault_provider = "${provider}"${updated.slice(insertPos)}`;
    } else {
      updated += `\n[ai]\ndefault_provider = "${provider}"\n`;
    }
  }

  if (/^\s*default_model\s*=/m.test(updated)) {
    updated = updated.replace(/^(\s*default_model\s*=\s*).*$/m, `$1"${model}"`);
  } else {
    const providerLine = updated.match(/^\s*default_provider\s*=.*$/m);
    if (providerLine && providerLine.index !== undefined) {
      const insertPos = providerLine.index + providerLine[0].length;
      updated = `${updated.slice(0, insertPos)}\ndefault_model = "${model}"${updated.slice(insertPos)}`;
    }
  }

  return updated;
}

// ---------------------------------------------------------------------------
// Chat types
// ---------------------------------------------------------------------------

interface ChatMessage {
  id: string;
  role: 'user' | 'agent';
  content: string;
  thinking?: string;
  markdown?: boolean;
  toolCall?: ToolCallInfo;
  timestamp: Date;
}

const DRAFT_KEY = 'agent-chat';

export default function AgentChat() {
  const [searchParams, setSearchParams] = useSearchParams();
  // URL-sync: if ?session= is present, use it as the initial session
  const initialSessionId = searchParams.get('session') || getOrCreateSessionId();
  const sessionIdRef = useRef(initialSessionId);
  // Sync sessionStorage on mount
  if (sessionStorage.getItem(SESSION_STORAGE_KEY) !== initialSessionId) {
    sessionStorage.setItem(SESSION_STORAGE_KEY, initialSessionId);
  }
  const { draft, saveDraft, clearDraft } = useDraft(DRAFT_KEY);

  // Message search state
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const searchInputRef = useRef<HTMLInputElement>(null);

  // Thinking level
  const [thinkingLevel, setThinkingLevel] = useState<string>('default');

  // File attachments
  const [attachments, setAttachments] = useState<File[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Split pane sidebar (for tool output / markdown preview)
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [sidebarContent, setSidebarContent] = useState<string>('');
  const [sidebarTitle, setSidebarTitle] = useState<string>('');
  const [splitRatio, setSplitRatio] = useState(0.6);
  const splitDragRef = useRef(false);
  const [messages, setMessages] = useState<ChatMessage[]>(() => {
    // Synchronously hydrate from localStorage so messages survive tab switches
    // without a flash of empty state. Server hydration may override later.
    const persisted = loadChatHistory(sessionIdRef.current);
    return persisted.length > 0 ? persistedToUiMessages(persisted) : [];
  });
  const [historyReady, setHistoryReady] = useState(false);
  const [input, setInput] = useState(draft);
  const [typing, setTyping] = useState(false);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // --- Session & model controls state (OpenClaw-style inline header) ---
  const [sessions, setSessions] = useState<Session[]>([]);
  const [currentProvider, setCurrentProvider] = useState<string | null>(null);
  const [currentModel, setCurrentModel] = useState<string>('');
  const [modelRoutes, setModelRoutes] = useState<ModelRoute[]>([]);
  const [switchingModel, setSwitchingModel] = useState(false);

  const wsRef = useRef<WebSocketClient | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const pendingContentRef = useRef('');
  const pendingThinkingRef = useRef('');
  // Snapshot of thinking captured at chunk_reset, so it survives the reset.
  const capturedThinkingRef = useRef('');
  const [streamingContent, setStreamingContent] = useState('');
  const [streamingThinking, setStreamingThinking] = useState('');

  // Persist draft to in-memory store so it survives route changes
  useEffect(() => {
    saveDraft(input);
  }, [input, saveDraft]);

  // Fetch sessions list and current model/provider + available routes
  const fetchSessions = useCallback(async () => {
    try {
      const data = await getSessions();
      data.sort((a, b) => new Date(b.last_activity).getTime() - new Date(a.last_activity).getTime());
      setSessions(data);
    } catch {
      // Non-critical
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [status, configToml] = await Promise.all([getStatus(), getConfig()]);
        if (cancelled) return;
        setCurrentProvider(status.provider);
        setCurrentModel(status.model);
        setModelRoutes(parseModelRoutes(configToml));
      } catch {
        // Non-critical
      }
    })();
    fetchSessions();
    return () => { cancelled = true; };
  }, [fetchSessions]);

  // Refresh session list when session changes
  useEffect(() => {
    const handler = () => { fetchSessions(); };
    window.addEventListener('zeroclaw-session-change', handler);
    return () => window.removeEventListener('zeroclaw-session-change', handler);
  }, [fetchSessions]);

  // --- Session dropdown handler (with URL sync) ---
  const handleSessionSelect = useCallback((e: React.ChangeEvent<HTMLSelectElement>) => {
    const newSessionId = e.target.value;
    if (newSessionId === sessionIdRef.current) return;
    setSearchParams({ session: newSessionId }, { replace: true });
    window.dispatchEvent(new CustomEvent('zeroclaw-session-change', { detail: { sessionId: newSessionId } }));
  }, [setSearchParams]);

  // --- New chat handler (with URL sync) ---
  const handleNewChat = useCallback(() => {
    const newId = generateUUID();
    sessionStorage.setItem(SESSION_STORAGE_KEY, newId);
    setSearchParams({ session: newId }, { replace: true });
    window.dispatchEvent(new CustomEvent('zeroclaw-session-change', { detail: { sessionId: newId } }));
  }, [setSearchParams]);

  // --- Model select handler ---
  const handleModelSelect = useCallback(async (e: React.ChangeEvent<HTMLSelectElement>) => {
    const value = e.target.value;
    if (!value) return; // "Default" selected, no change
    const [provider, ...modelParts] = value.split('/');
    const model = modelParts.join('/');
    if (!provider || !model) return;
    if (provider === currentProvider && model === currentModel) return;

    setSwitchingModel(true);
    try {
      const configToml = await getConfig();
      const updated = updateDefaultModel(configToml, provider, model);
      await putConfig(updated);
      setCurrentProvider(provider);
      setCurrentModel(model);
    } catch {
      // Failed — keep current
    } finally {
      setSwitchingModel(false);
    }
  }, [currentProvider, currentModel]);

  // Hydrate chat from server (preferred) or localStorage fallback
  useEffect(() => {
    const sid = sessionIdRef.current;
    let cancelled = false;

    (async () => {
      try {
        const res = await getSessionMessages(sid);
        if (cancelled) return;
        if (res.session_persistence && res.messages.length > 0) {
          setMessages((prev) =>
            prev.length > 0 ? prev : persistedToUiMessages(mapServerMessagesToPersisted(res.messages)),
          );
        } else if (!res.session_persistence) {
          setMessages((prev) => {
            if (prev.length > 0) return prev;
            const ls = loadChatHistory(sid);
            return ls.length ? persistedToUiMessages(ls) : prev;
          });
        }
      } catch {
        if (!cancelled) {
          setMessages((prev) => {
            if (prev.length > 0) return prev;
            const ls = loadChatHistory(sid);
            return ls.length ? persistedToUiMessages(ls) : prev;
          });
        }
      } finally {
        if (!cancelled) setHistoryReady(true);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  // Mirror transcript to localStorage (bounded); server remains source of truth when persistence is on
  useEffect(() => {
    if (!historyReady) return;
    saveChatHistory(sessionIdRef.current, uiMessagesToPersisted(messages));
  }, [messages, historyReady]);

  // Shared WebSocket message handler — stored in a ref so it can be reused
  // when reconnecting after a session switch.
  const wsMessageHandlerRef = useRef<(msg: WsMessage) => void>(() => {});

  /** Wire up event handlers on a WebSocketClient and connect it. */
  const setupAndConnectWs = useCallback((ws: WebSocketClient) => {
    ws.onOpen = () => {
      setConnected(true);
      setError(null);
    };

    ws.onClose = (ev: CloseEvent) => {
      setConnected(false);
      if (ev.code !== 1000 && ev.code !== 1001) {
        setError(`Connection closed unexpectedly (code: ${ev.code}). Please check your configuration.`);
      }
    };

    ws.onError = () => {
      setError(t('agent.connection_error'));
    };

    ws.onMessage = (msg: WsMessage) => wsMessageHandlerRef.current(msg);

    ws.connect();
    wsRef.current = ws;
  }, []);

  // Populate the message handler ref (runs once, closures are stable over state setters)
  useEffect(() => {
    wsMessageHandlerRef.current = (msg: WsMessage) => {
      switch (msg.type) {
        case 'session_start':
        case 'connected':
          break;

        case 'thinking':
          setTyping(true);
          pendingThinkingRef.current += msg.content ?? '';
          setStreamingThinking(pendingThinkingRef.current);
          break;

        case 'chunk':
          setTyping(true);
          pendingContentRef.current += msg.content ?? '';
          setStreamingContent(pendingContentRef.current);
          break;

        case 'chunk_reset':
          // Server signals that the authoritative done message follows.
          // Snapshot thinking before clearing display state.
          capturedThinkingRef.current = pendingThinkingRef.current;
          pendingContentRef.current = '';
          pendingThinkingRef.current = '';
          setStreamingContent('');
          setStreamingThinking('');
          break;

        case 'message':
        case 'done': {
          const content = msg.full_response ?? msg.content ?? pendingContentRef.current;
          const thinking = capturedThinkingRef.current || pendingThinkingRef.current || undefined;
          if (content) {
            setMessages((prev) => [
              ...prev,
              {
                id: generateUUID(),
                role: 'agent',
                content,
                thinking,
                markdown: true,
                timestamp: new Date(),
              },
            ]);
          }
          pendingContentRef.current = '';
          pendingThinkingRef.current = '';
          capturedThinkingRef.current = '';
          setStreamingContent('');
          setStreamingThinking('');
          setTyping(false);
          break;
        }

        case 'tool_call': {
          const toolName = msg.name ?? 'unknown';
          const toolArgs = msg.args;
          setMessages((prev) => {
            // Dedup: backend streaming may re-send tool_call events before execution.
            // Skip if an unresolved card with the same name+args already exists.
            const argsKey = JSON.stringify(toolArgs ?? {});
            const isDuplicate = prev.some(
              (m) => m.toolCall
                && m.toolCall.output === undefined
                && m.toolCall.name === toolName
                && JSON.stringify(m.toolCall.args ?? {}) === argsKey,
            );
            if (isDuplicate) return prev;

            return [
              ...prev,
              {
                id: generateUUID(),
                role: 'agent' as const,
                content: `${t('agent.tool_call_prefix')} ${toolName}(${argsKey})`,
                toolCall: { name: toolName, args: toolArgs },
                timestamp: new Date(),
              },
            ];
          });
          break;
        }

        case 'tool_result': {
          setMessages((prev) => {
            // Forward scan: find the FIRST unresolved toolCall (order-guaranteed by backend)
            const idx = prev.findIndex((m) => m.toolCall && m.toolCall.output === undefined);
            if (idx !== -1) {
              const updated = [...prev];
              const existing = prev[idx]!;
              updated[idx] = {
                ...existing,
                toolCall: { ...existing.toolCall!, output: msg.output ?? '' },
              };
              return updated;
            }
            // Fallback: no unresolved call found — append standalone card
            return [
              ...prev,
              {
                id: generateUUID(),
                role: 'agent' as const,
                content: `${t('agent.tool_result_prefix')} ${msg.output ?? ''}`,
                toolCall: { name: msg.name ?? 'unknown', output: msg.output ?? '' },
                timestamp: new Date(),
              },
            ];
          });
          break;
        }

        case 'cron_result': {
          const cronOutput = msg.output ?? '';
          if (cronOutput) {
            setMessages((prev) => [
              ...prev,
              {
                id: generateUUID(),
                role: 'agent' as const,
                content: cronOutput,
                markdown: true,
                timestamp: new Date(msg.timestamp ?? Date.now()),
              },
            ]);
          }
          break;
        }

        case 'error':
          setMessages((prev) => [
            ...prev,
            {
              id: generateUUID(),
              role: 'agent',
              content: `${t('agent.error_prefix')} ${msg.message ?? t('agent.unknown_error')}`,
              timestamp: new Date(),
            },
          ]);
          if (msg.code === 'AGENT_INIT_FAILED' || msg.code === 'AUTH_ERROR' || msg.code === 'PROVIDER_ERROR') {
            setError(`Configuration error: ${msg.message}. Please check your provider settings (API key, model, etc.).`);
          } else if (msg.code === 'INVALID_JSON' || msg.code === 'UNKNOWN_MESSAGE_TYPE' || msg.code === 'EMPTY_CONTENT') {
            setError(`Message error: ${msg.message}`);
          }
          setTyping(false);
          pendingContentRef.current = '';
          pendingThinkingRef.current = '';
          setStreamingContent('');
          setStreamingThinking('');
          break;
      }
    };
  }, []);

  // Initial WebSocket connection
  useEffect(() => {
    const ws = new WebSocketClient();
    setupAndConnectWs(ws);

    return () => {
      ws.disconnect();
    };
  }, [setupAndConnectWs]);

  // Listen for session-change events (from SessionPanel or external triggers)
  useEffect(() => {
    const handleSessionChange = (e: Event) => {
      const detail = (e as CustomEvent<{ sessionId: string }>).detail;
      const newSessionId = detail.sessionId;

      // Disconnect current WebSocket
      if (wsRef.current) {
        wsRef.current.disconnect();
      }

      // Update session ref
      sessionIdRef.current = newSessionId;
      sessionStorage.setItem(SESSION_STORAGE_KEY, newSessionId);

      // Clear current messages and streaming state
      setMessages([]);
      setTyping(false);
      setError(null);
      pendingContentRef.current = '';
      pendingThinkingRef.current = '';
      capturedThinkingRef.current = '';
      setStreamingContent('');
      setStreamingThinking('');

      // Load history for the new session
      (async () => {
        try {
          const res = await getSessionMessages(newSessionId);
          if (res.session_persistence && res.messages.length > 0) {
            setMessages(persistedToUiMessages(mapServerMessagesToPersisted(res.messages)));
          } else {
            const ls = loadChatHistory(newSessionId);
            if (ls.length > 0) {
              setMessages(persistedToUiMessages(ls));
            }
          }
        } catch {
          const ls = loadChatHistory(newSessionId);
          if (ls.length > 0) {
            setMessages(persistedToUiMessages(ls));
          }
        }
      })();

      // Reconnect WebSocket with new session
      const ws = new WebSocketClient();
      setupAndConnectWs(ws);
    };

    window.addEventListener('zeroclaw-session-change', handleSessionChange);
    return () => window.removeEventListener('zeroclaw-session-change', handleSessionChange);
  }, [setupAndConnectWs]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, typing, streamingContent]);

  const handleSend = () => {
    const trimmed = input.trim();
    if (!trimmed || !wsRef.current?.connected) return;

    setMessages((prev) => [
      ...prev,
      {
        id: generateUUID(),
        role: 'user',
        content: trimmed,
        timestamp: new Date(),
      },
    ]);

    try {
      inputHistory.push(sessionIdRef.current, trimmed);
      wsRef.current.sendMessage(trimmed);
      setTyping(true);
      pendingContentRef.current = '';
      pendingThinkingRef.current = '';
    } catch {
      setError(t('agent.send_error'));
    }

    setInput('');
    clearDraft();
    if (inputRef.current) {
      inputRef.current.style.height = 'auto';
      inputRef.current.focus();
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
      return;
    }
    // Input history: arrow up/down when input is empty
    if (e.key === 'ArrowUp' && !input.trim()) {
      e.preventDefault();
      const prev = inputHistory.prev(sessionIdRef.current);
      if (prev !== undefined) setInput(prev);
      return;
    }
    if (e.key === 'ArrowDown' && !input.trim()) {
      e.preventDefault();
      const next = inputHistory.next(sessionIdRef.current);
      if (next !== undefined) setInput(next);
      return;
    }
    // Cmd/Ctrl+F: open message search
    if (e.key === 'f' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      setSearchOpen(true);
      setTimeout(() => searchInputRef.current?.focus(), 50);
    }
  };

  const handleTextareaChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setInput(e.target.value);
    e.target.style.height = 'auto';
    e.target.style.height = `${Math.min(e.target.scrollHeight, 200)}px`;
  };

  const handleCopy = useCallback((msgId: string, content: string) => {
    const onSuccess = () => {
      setCopiedId(msgId);
      setTimeout(() => setCopiedId((prev) => (prev === msgId ? null : prev)), 2000);
    };

    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(content).then(onSuccess).catch(() => {
        // Fallback for insecure contexts (HTTP)
        fallbackCopy(content) && onSuccess();
      });
    } else {
      fallbackCopy(content) && onSuccess();
    }
  }, []);

  /**
   * Fallback copy using a temporary textarea for HTTP contexts
   * where navigator.clipboard is unavailable.
   */
  function fallbackCopy(text: string): boolean {
    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.style.position = 'fixed';
    textarea.style.opacity = '0';
    document.body.appendChild(textarea);
    textarea.select();
    try {
      document.execCommand('copy');
      return true;
    } catch {
      return false;
    } finally {
      document.body.removeChild(textarea);
    }
  }

  return (
    <div className="flex flex-col h-[calc(100vh-3.5rem)]">
      {/* Connection status bar */}
      {error && (
        <div className="px-4 py-2 border-b flex items-center gap-2 text-sm animate-fade-in" style={{ background: 'rgba(239, 68, 68, 0.08)', borderColor: 'rgba(239, 68, 68, 0.2)', color: '#f87171', }}>
          <AlertCircle className="h-4 w-4 shrink-0" />
          {error}
        </div>
      )}

      {/* Message search bar */}
      {searchOpen && (
        <div className="flex items-center gap-2 px-4 py-2 border-b animate-fade-in" style={{ borderColor: 'var(--pc-border)', background: 'var(--pc-bg-surface)' }}>
          <Search className="h-4 w-4 shrink-0" style={{ color: 'var(--pc-text-faint)' }} />
          <input
            ref={searchInputRef}
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Escape') { setSearchOpen(false); setSearchQuery(''); } }}
            placeholder="Search messages..."
            className="flex-1 text-sm bg-transparent outline-none"
            style={{ color: 'var(--pc-text-primary)' }}
          />
          {searchQuery && (
            <span className="text-[10px] tabular-nums" style={{ color: 'var(--pc-text-faint)' }}>
              {messages.filter((m) => m.content.toLowerCase().includes(searchQuery.toLowerCase())).length} matches
            </span>
          )}
          <button onClick={() => { setSearchOpen(false); setSearchQuery(''); }}
            className="p-1 rounded-lg" style={{ color: 'var(--pc-text-muted)' }}>
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      )}

      {/* Chat controls row — OpenClaw-style inline session + model selectors */}
      <div className="flex items-center gap-2 px-4 py-2 border-b" style={{ borderColor: 'var(--pc-border)', background: 'var(--pc-bg-surface)' }}>
        {/* Session select */}
        <select
          value={sessionIdRef.current}
          onChange={handleSessionSelect}
          className="text-sm rounded-lg px-2 py-1.5 min-w-0 max-w-[220px] truncate"
          style={{ background: 'var(--pc-bg-elevated)', border: '1px solid var(--pc-border)', color: 'var(--pc-text-primary)' }}
        >
          {sessions.length === 0 && (
            <option value={sessionIdRef.current}>
              {sessionIdRef.current.slice(0, 8)}...
            </option>
          )}
          {sessions.map((s) => (
            <option key={s.session_id} value={s.session_id}>
              {s.name || `Session ${s.session_id.slice(0, 8)}`} ({s.message_count} msgs)
            </option>
          ))}
        </select>

        {/* Model select */}
        <select
          value={currentProvider && currentModel ? `${currentProvider}/${currentModel}` : ''}
          onChange={handleModelSelect}
          disabled={switchingModel}
          className="text-sm rounded-lg px-2 py-1.5 min-w-0 max-w-[260px] truncate"
          style={{
            background: 'var(--pc-bg-elevated)',
            border: '1px solid var(--pc-border)',
            color: 'var(--pc-text-primary)',
            opacity: switchingModel ? 0.6 : 1,
          }}
        >
          <option value="">
            Default ({currentModel ? `${currentProvider ?? 'unknown'}/${currentModel}` : 'loading...'})
          </option>
          {modelRoutes.map((r) => (
            <option key={`${r.provider}/${r.model}`} value={`${r.provider}/${r.model}`}>
              {r.hint ? `${r.hint} \u2014 ` : ''}{r.provider}/{r.model}
            </option>
          ))}
        </select>

        {/* Thinking level */}
        <select
          value={thinkingLevel}
          onChange={(e) => setThinkingLevel(e.target.value)}
          className="text-sm rounded-lg px-2 py-1.5 min-w-0 max-w-[140px]"
          style={{ background: 'var(--pc-bg-elevated)', border: '1px solid var(--pc-border)', color: 'var(--pc-text-primary)' }}
          title="Thinking level"
        >
          <option value="default">Thinking: Default</option>
          <option value="off">Thinking: Off</option>
          <option value="minimal">Thinking: Minimal</option>
          <option value="low">Thinking: Low</option>
          <option value="medium">Thinking: Medium</option>
          <option value="high">Thinking: High</option>
        </select>

        {/* Sidebar toggle */}
        <button
          type="button"
          title={sidebarOpen ? "Close sidebar" : "Open sidebar"}
          onClick={() => setSidebarOpen(!sidebarOpen)}
          className="flex items-center justify-center rounded-lg p-1.5 transition-all shrink-0"
          style={{
            background: sidebarOpen ? 'var(--pc-accent-glow)' : 'var(--pc-bg-elevated)',
            border: `1px solid ${sidebarOpen ? 'var(--pc-accent-dim)' : 'var(--pc-border)'}`,
            color: sidebarOpen ? 'var(--pc-accent)' : 'var(--pc-text-muted)',
          }}
        >
          {sidebarOpen ? <PanelRightClose className="h-4 w-4" /> : <PanelRightOpen className="h-4 w-4" />}
        </button>

        {/* Search toggle */}
        <button
          type="button"
          title="Search messages (Ctrl+F)"
          onClick={() => { setSearchOpen(!searchOpen); setTimeout(() => searchInputRef.current?.focus(), 50); }}
          className="flex items-center justify-center rounded-lg p-1.5 transition-all shrink-0"
          style={{
            background: searchOpen ? 'var(--pc-accent-glow)' : 'var(--pc-bg-elevated)',
            border: `1px solid ${searchOpen ? 'var(--pc-accent-dim)' : 'var(--pc-border)'}`,
            color: searchOpen ? 'var(--pc-accent)' : 'var(--pc-text-muted)',
          }}
        >
          <Search className="h-4 w-4" />
        </button>

        {/* Export markdown */}
        <button
          type="button"
          title="Export as Markdown"
          onClick={() => {
            const md = messages.map((m) =>
              `**${m.role === 'user' ? 'User' : 'Agent'}** (${m.timestamp.toLocaleString()}):\n\n${m.content}\n`
            ).join('\n---\n\n');
            const blob = new Blob([md], { type: 'text/markdown' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `chat-${sessionIdRef.current.slice(0, 8)}-${new Date().toISOString().slice(0, 10)}.md`;
            a.click();
            URL.revokeObjectURL(url);
          }}
          className="flex items-center justify-center rounded-lg p-1.5 transition-all shrink-0"
          style={{
            background: 'var(--pc-bg-elevated)',
            border: '1px solid var(--pc-border)',
            color: 'var(--pc-text-muted)',
          }}
          onMouseEnter={(e) => { e.currentTarget.style.borderColor = 'var(--pc-accent-dim)'; e.currentTarget.style.color = 'var(--pc-text-primary)'; }}
          onMouseLeave={(e) => { e.currentTarget.style.borderColor = 'var(--pc-border)'; e.currentTarget.style.color = 'var(--pc-text-muted)'; }}
        >
          <Download className="h-4 w-4" />
        </button>

        {/* New Chat */}
        <button
          type="button"
          title="New chat"
          onClick={handleNewChat}
          className="flex items-center justify-center rounded-lg p-1.5 transition-all shrink-0"
          style={{
            background: 'var(--pc-bg-elevated)',
            border: '1px solid var(--pc-border)',
            color: 'var(--pc-text-muted)',
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.borderColor = 'var(--pc-accent-dim)';
            e.currentTarget.style.color = 'var(--pc-text-primary)';
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.borderColor = 'var(--pc-border)';
            e.currentTarget.style.color = 'var(--pc-text-muted)';
          }}
        >
          <Plus className="h-4 w-4" />
        </button>
      </div>

      {/* Main content: split pane (messages + optional sidebar) */}
      <div className="flex-1 flex overflow-hidden">
      {/* Messages area */}
      <div className="overflow-y-auto p-4 space-y-4" style={{ flex: sidebarOpen ? splitRatio : 1, transition: 'flex 0.2s' }}>
        {messages.length === 0 && (
          <div className="flex flex-col items-center justify-center h-full text-center animate-fade-in" style={{ color: 'var(--pc-text-muted)' }}>
            <div className="h-16 w-16 rounded-3xl flex items-center justify-center mb-4 animate-float" style={{ background: 'var(--pc-accent-glow)' }}>
              <Bot className="h-8 w-8" style={{ color: 'var(--pc-accent)' }} />
            </div>
            <p className="text-lg font-semibold mb-1" style={{ color: 'var(--pc-text-primary)' }}>ZeroClaw Agent</p>
            <p className="text-sm" style={{ color: 'var(--pc-text-muted)' }}>{t('agent.start_conversation')}</p>
          </div>
        )}

        {messages.map((msg, idx) => {
          const isSearchMatch = searchQuery && msg.content.toLowerCase().includes(searchQuery.toLowerCase());
          const dimmed = searchQuery && !isSearchMatch;
          return (
          <div
            key={msg.id}
            className={`group flex items-start gap-3 ${
              msg.role === 'user' ? 'flex-row-reverse animate-slide-in-right' : 'animate-slide-in-left'
            }`}
            style={{ animationDelay: `${Math.min(idx * 30, 200)}ms`, opacity: dimmed ? 0.3 : 1, transition: 'opacity 0.2s' }}
          >
            <div
              className="flex-shrink-0 w-9 h-9 rounded-2xl flex items-center justify-center border"
              style={{
                background: msg.role === 'user' ? 'var(--pc-accent)' : 'var(--pc-bg-elevated)',
                borderColor: msg.role === 'user' ? 'var(--pc-accent)' : 'var(--pc-border)',
              }}
            >
              {msg.role === 'user' ? (
                <User className="h-4 w-4 text-white" />
              ) : (
                <Bot className="h-4 w-4" style={{ color: 'var(--pc-accent)' }} />
              )}
            </div>
            <div className="relative max-w-[75%]">
              <div
                className="rounded-2xl px-4 py-3 border"
                style={
                  msg.role === 'user'
                    ? { background: 'var(--pc-accent-glow)', borderColor: 'var(--pc-accent-dim)', color: 'var(--pc-text-primary)', }
                    : { background: 'var(--pc-bg-elevated)', borderColor: 'var(--pc-border)', color: 'var(--pc-text-primary)', }
                }
              >
                {msg.thinking && (
                  <details className="mb-2">
                    <summary className="text-xs cursor-pointer select-none" style={{ color: 'var(--pc-text-muted)' }}>Thinking</summary>
                    <pre className="text-xs mt-1 whitespace-pre-wrap break-words leading-relaxed overflow-auto max-h-60 p-2 rounded-lg" style={{ color: 'var(--pc-text-muted)', background: 'var(--pc-bg-surface)' }}>{msg.thinking}</pre>
                  </details>
                )}
                {msg.toolCall ? (
                  <div className="cursor-pointer" onClick={() => {
                    if (msg.toolCall?.output) {
                      setSidebarTitle(`Tool: ${msg.toolCall.name}`);
                      setSidebarContent(msg.toolCall.output);
                      setSidebarOpen(true);
                    }
                  }}>
                    <ToolCallCard toolCall={msg.toolCall} />
                  </div>
                ) : msg.markdown ? (
                  <div className="text-sm break-words leading-relaxed chat-markdown"><ReactMarkdown remarkPlugins={[remarkGfm]}>{msg.content}</ReactMarkdown></div>
                ) : (
                  <p className="text-sm whitespace-pre-wrap break-words leading-relaxed">{msg.content}</p>
                )}
                <p
                  className="text-[10px] mt-1.5" style={{ color: msg.role === 'user' ? 'var(--pc-accent-light)' : 'var(--pc-text-faint)' }}>
                  {msg.timestamp.toLocaleTimeString()}
                </p>
              </div>
              <button
                onClick={() => handleCopy(msg.id, msg.content)}
                aria-label={t('agent.copy_message')}
                className="absolute top-1 right-1 opacity-0 group-hover:opacity-100 transition-all p-1.5 rounded-xl"
                style={{ background: 'var(--pc-bg-elevated)', border: '1px solid var(--pc-border)', color: 'var(--pc-text-muted)', }}
                onMouseEnter={(e) => { e.currentTarget.style.color = 'var(--pc-text-primary)'; e.currentTarget.style.borderColor = 'var(--pc-accent-dim)'; }}
                onMouseLeave={(e) => { e.currentTarget.style.color = 'var(--pc-text-muted)'; e.currentTarget.style.borderColor = 'var(--pc-border)'; }}
              >
                {copiedId === msg.id ? (
                  <Check className="h-3 w-3" style={{ color: '#34d399' }} />
                ) : (
                  <Copy className="h-3 w-3" />
                )}
              </button>
            </div>
          </div>
          );
        })}

        {typing && (
          <div className="flex items-start gap-3 animate-fade-in">
            <div className="flex-shrink-0 w-9 h-9 rounded-2xl flex items-center justify-center border" style={{ background: 'var(--pc-bg-elevated)', borderColor: 'var(--pc-border)' }}>
              <Bot className="h-4 w-4" style={{ color: 'var(--pc-accent)' }} />
            </div>
            {streamingContent || streamingThinking ? (
              <div className="rounded-2xl px-4 py-3 border max-w-[75%]" style={{ background: 'var(--pc-bg-elevated)', borderColor: 'var(--pc-border)', color: 'var(--pc-text-primary)' }}>
                {streamingThinking && (
                  <details className="mb-2" open={!streamingContent}>
                    <summary className="text-xs cursor-pointer select-none" style={{ color: 'var(--pc-text-muted)' }}>Thinking{!streamingContent && '...'}</summary>
                    <pre className="text-xs mt-1 whitespace-pre-wrap break-words leading-relaxed overflow-auto max-h-60 p-2 rounded-lg" style={{ color: 'var(--pc-text-muted)', background: 'var(--pc-bg-surface)' }}>{streamingThinking}</pre>
                  </details>
                )}
                {streamingContent && <p className="text-sm whitespace-pre-wrap break-words leading-relaxed">{streamingContent}</p>}
              </div>
            ) : (
              <div className="rounded-2xl px-4 py-3 border flex items-center gap-1.5" style={{ background: 'var(--pc-bg-elevated)', borderColor: 'var(--pc-border)' }}>
                <span className="bounce-dot w-1.5 h-1.5 rounded-full" style={{ background: 'var(--pc-accent)' }} />
                <span className="bounce-dot w-1.5 h-1.5 rounded-full" style={{ background: 'var(--pc-accent)' }} />
                <span className="bounce-dot w-1.5 h-1.5 rounded-full" style={{ background: 'var(--pc-accent)' }} />
              </div>
            )}
          </div>
        )}

        <div ref={messagesEndRef} />
      </div>

      {/* Resizable drag handle + Sidebar */}
      {sidebarOpen && (
        <>
          <div
            className="w-1 cursor-col-resize hover:bg-[var(--pc-accent)] transition-colors shrink-0"
            style={{ background: 'var(--pc-border)' }}
            onMouseDown={() => {
              splitDragRef.current = true;
              const onMove = (e: MouseEvent) => {
                if (!splitDragRef.current) return;
                const container = (e.target as HTMLElement).closest('.flex-1.flex');
                if (!container) return;
                const rect = container.getBoundingClientRect();
                const ratio = Math.max(0.3, Math.min(0.8, (e.clientX - rect.left) / rect.width));
                setSplitRatio(ratio);
              };
              const onUp = () => { splitDragRef.current = false; window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp); };
              window.addEventListener('mousemove', onMove);
              window.addEventListener('mouseup', onUp);
            }}
          />
          <div className="overflow-y-auto border-l" style={{ flex: 1 - splitRatio, borderColor: 'var(--pc-border)', background: 'var(--pc-bg-surface)' }}>
            <div className="flex items-center justify-between px-4 py-2 border-b" style={{ borderColor: 'var(--pc-border)' }}>
              <span className="text-xs font-semibold uppercase tracking-wider" style={{ color: 'var(--pc-text-faint)' }}>
                {sidebarTitle || 'Details'}
              </span>
              <button onClick={() => setSidebarOpen(false)} className="p-1 rounded-lg" style={{ color: 'var(--pc-text-muted)' }}>
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
            <div className="p-4">
              {sidebarContent ? (
                <div className="text-sm break-words leading-relaxed chat-markdown">
                  <ReactMarkdown remarkPlugins={[remarkGfm]}>{sidebarContent}</ReactMarkdown>
                </div>
              ) : (
                <p className="text-sm" style={{ color: 'var(--pc-text-muted)' }}>
                  Click a tool result or message to view details here.
                </p>
              )}
            </div>
          </div>
        </>
      )}
      </div>{/* end split pane */}

      {/* Input area */}
      <div className="border-t p-4" style={{ borderColor: 'var(--pc-border)', background: 'var(--pc-bg-surface)' }}>
        {/* Attachment preview */}
        {attachments.length > 0 && (
          <div className="flex flex-wrap gap-2 mb-2 max-w-4xl mx-auto">
            {attachments.map((file, i) => (
              <div key={`${file.name}-${i}`} className="flex items-center gap-1.5 px-2 py-1 rounded-lg text-xs"
                style={{ background: 'var(--pc-bg-elevated)', border: '1px solid var(--pc-border)', color: 'var(--pc-text-primary)' }}>
                <Paperclip className="h-3 w-3" style={{ color: 'var(--pc-text-faint)' }} />
                <span className="max-w-[120px] truncate">{file.name}</span>
                <span className="text-[10px]" style={{ color: 'var(--pc-text-faint)' }}>
                  {file.size < 1024 ? `${file.size}B` : file.size < 1048576 ? `${(file.size / 1024).toFixed(0)}KB` : `${(file.size / 1048576).toFixed(1)}MB`}
                </span>
                <button onClick={() => setAttachments((prev) => prev.filter((_, j) => j !== i))}
                  className="p-0.5 rounded" style={{ color: 'var(--pc-text-muted)' }}>
                  <X className="h-3 w-3" />
                </button>
              </div>
            ))}
          </div>
        )}

        <div className="flex items-center gap-2 max-w-4xl mx-auto">
          {/* Attach file button */}
          <input
            ref={fileInputRef}
            type="file"
            multiple
            className="hidden"
            onChange={(e) => {
              if (e.target.files) {
                setAttachments((prev) => [...prev, ...Array.from(e.target.files!)]);
                e.target.value = '';
              }
            }}
          />
          <button
            type="button"
            title="Attach file"
            onClick={() => fileInputRef.current?.click()}
            className="flex items-center justify-center rounded-2xl p-2.5 transition-all shrink-0"
            style={{ background: 'var(--pc-bg-elevated)', border: '1px solid var(--pc-border)', color: 'var(--pc-text-muted)' }}
            onMouseEnter={(e) => { e.currentTarget.style.borderColor = 'var(--pc-accent-dim)'; e.currentTarget.style.color = 'var(--pc-text-primary)'; }}
            onMouseLeave={(e) => { e.currentTarget.style.borderColor = 'var(--pc-border)'; e.currentTarget.style.color = 'var(--pc-text-muted)'; }}
          >
            <Paperclip className="h-4 w-4" />
          </button>

          <textarea
            ref={inputRef}
            rows={1}
            value={input}
            onChange={handleTextareaChange}
            onKeyDown={handleKeyDown}
            onPaste={(e) => {
              // Handle pasted images
              const items = e.clipboardData?.items;
              if (!items) return;
              const files: File[] = [];
              for (const item of Array.from(items)) {
                if (item.kind === 'file') {
                  const file = item.getAsFile();
                  if (file) files.push(file);
                }
              }
              if (files.length > 0) {
                e.preventDefault();
                setAttachments((prev) => [...prev, ...files]);
              }
            }}
            placeholder={connected ? t('agent.type_message') : t('agent.connecting')}
            disabled={!connected}
            className="input-electric flex-1 px-4 text-sm resize-none disabled:opacity-40"
            style={{ minHeight: '44px', maxHeight: '200px', paddingTop: '10px', paddingBottom: '10px' }}
          />
          <button
            type='button'
            onClick={handleSend}
            disabled={!connected || (!input.trim() && attachments.length === 0)}
            className="btn-electric flex-shrink-0 rounded-2xl flex items-center justify-center"
            style={{ color: 'white', width: '40px', height: '40px' }}
          >
            <Send className="h-5 w-5" />
          </button>
        </div>
        <div className="flex items-center justify-center mt-2 gap-2">
          <span
            className="status-dot"
            style={connected
              ? { background: 'var(--color-status-success)', boxShadow: '0 0 6px var(--color-status-success)' }
              : { background: 'var(--color-status-error)', boxShadow: '0 0 6px var(--color-status-error)' }
            }
          />
          <span className="text-[10px]" style={{ color: 'var(--pc-text-faint)' }}>
            {connected ? t('agent.connected_status') : t('agent.disconnected_status')}
          </span>
        </div>
      </div>
    </div>
  );
}
