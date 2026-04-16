import { useState, useEffect, useCallback, useMemo } from 'react';
import {
  MessageSquare, Trash2, RefreshCw, Search, Plus, ExternalLink,
  ArrowUpDown, ArrowUp, ArrowDown, ChevronLeft, ChevronRight,
  Pencil, Check, X, Download,
} from 'lucide-react';
import type { Session } from '@/types/api';
import { getSessions, deleteSession, renameSession } from '@/lib/api';
import { SESSION_STORAGE_KEY } from '@/lib/ws';
import { generateUUID } from '@/lib/uuid';
import { useNavigate, useSearchParams } from 'react-router-dom';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function relativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const seconds = Math.floor(diff / 1000);
  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
  });
}

// ---------------------------------------------------------------------------
// Sort
// ---------------------------------------------------------------------------

type SortColumn = 'name' | 'messages' | 'last_activity' | 'created_at';
type SortDir = 'asc' | 'desc';

function sortSessions(list: Session[], col: SortColumn, dir: SortDir): Session[] {
  const sorted = [...list].sort((a, b) => {
    let cmp = 0;
    switch (col) {
      case 'name':
        cmp = (a.name ?? a.session_id).localeCompare(b.name ?? b.session_id);
        break;
      case 'messages':
        cmp = a.message_count - b.message_count;
        break;
      case 'last_activity':
        cmp = new Date(a.last_activity).getTime() - new Date(b.last_activity).getTime();
        break;
      case 'created_at':
        cmp = new Date(a.created_at).getTime() - new Date(b.created_at).getTime();
        break;
    }
    return dir === 'asc' ? cmp : -cmp;
  });
  return sorted;
}

// ---------------------------------------------------------------------------
// Page sizes
// ---------------------------------------------------------------------------

const PAGE_SIZES = [10, 25, 50, 100] as const;

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function Sessions() {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();

  const [sessions, setSessions] = useState<Session[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [deleting, setDeleting] = useState(false);

  // Sort state
  const [sortCol, setSortCol] = useState<SortColumn>('last_activity');
  const [sortDir, setSortDir] = useState<SortDir>('desc');

  // Pagination
  const [page, setPage] = useState(0);
  const [pageSize, setPageSize] = useState<number>(25);

  // Inline rename
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');

  const activeSessionId = sessionStorage.getItem(SESSION_STORAGE_KEY) ?? '';

  // ---------------------------------------------------------------------------
  // Data fetching
  // ---------------------------------------------------------------------------

  const fetchSessions = useCallback(() => {
    setLoading(true);
    getSessions()
      .then((data) => setSessions(data))
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { fetchSessions(); }, [fetchSessions]);

  // URL-sync: read ?session= for deep-linking
  useEffect(() => {
    const sid = searchParams.get('session');
    if (sid) {
      sessionStorage.setItem(SESSION_STORAGE_KEY, sid);
    }
  }, [searchParams]);

  // ---------------------------------------------------------------------------
  // Derived data
  // ---------------------------------------------------------------------------

  const filtered = useMemo(() => {
    if (!searchQuery.trim()) return sessions;
    const q = searchQuery.toLowerCase();
    return sessions.filter((s) =>
      s.session_id.toLowerCase().includes(q) ||
      (s.name ?? '').toLowerCase().includes(q)
    );
  }, [sessions, searchQuery]);

  const sorted = useMemo(() => sortSessions(filtered, sortCol, sortDir), [filtered, sortCol, sortDir]);

  const totalPages = Math.max(1, Math.ceil(sorted.length / pageSize));
  const safePage = Math.min(page, totalPages - 1);
  const pageStart = safePage * pageSize;
  const pageEnd = pageStart + pageSize;
  const pageRows = sorted.slice(pageStart, pageEnd);

  // Reset page when filters change
  useEffect(() => { setPage(0); }, [searchQuery, pageSize]);

  // ---------------------------------------------------------------------------
  // Selection
  // ---------------------------------------------------------------------------

  const toggleSelect = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const allOnPageSelected = pageRows.length > 0 && pageRows.every((s) => selectedIds.has(s.session_id));
  const someOnPageSelected = pageRows.some((s) => selectedIds.has(s.session_id));

  const toggleSelectAll = () => {
    if (allOnPageSelected) {
      setSelectedIds((prev) => {
        const next = new Set(prev);
        for (const s of pageRows) next.delete(s.session_id);
        return next;
      });
    } else {
      setSelectedIds((prev) => {
        const next = new Set(prev);
        for (const s of pageRows) next.add(s.session_id);
        return next;
      });
    }
  };

  // ---------------------------------------------------------------------------
  // Actions
  // ---------------------------------------------------------------------------

  const handleDeleteSelected = async () => {
    if (selectedIds.size === 0) return;
    if (!confirm(`Delete ${selectedIds.size} session(s)?`)) return;
    setDeleting(true);
    for (const id of selectedIds) {
      try { await deleteSession(id); } catch { /* ignore */ }
    }
    setSelectedIds(new Set());
    setDeleting(false);
    fetchSessions();
  };

  const handleDeleteOne = async (id: string) => {
    if (!confirm('Delete this session?')) return;
    try { await deleteSession(id); fetchSessions(); } catch { /* ignore */ }
  };

  const handleOpenChat = (sessionId: string) => {
    sessionStorage.setItem(SESSION_STORAGE_KEY, sessionId);
    window.dispatchEvent(new CustomEvent('zeroclaw-session-change', { detail: { sessionId } }));
    navigate(`/agent?session=${sessionId}`);
  };

  const handleNewChat = () => {
    const newId = generateUUID();
    sessionStorage.setItem(SESSION_STORAGE_KEY, newId);
    window.dispatchEvent(new CustomEvent('zeroclaw-session-change', { detail: { sessionId: newId } }));
    navigate(`/agent?session=${newId}`);
  };

  // Inline rename
  const startRename = (session: Session) => {
    setRenamingId(session.session_id);
    setRenameValue(session.name ?? '');
  };

  const commitRename = async () => {
    if (!renamingId) return;
    const trimmed = renameValue.trim();
    try {
      await renameSession(renamingId, trimmed || renamingId.slice(0, 12));
      fetchSessions();
    } catch { /* ignore */ }
    setRenamingId(null);
  };

  const cancelRename = () => { setRenamingId(null); };

  // Export sessions list as JSON
  const handleExport = () => {
    const data = JSON.stringify(sorted, null, 2);
    const blob = new Blob([data], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `zeroclaw-sessions-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  // ---------------------------------------------------------------------------
  // Sort header helper
  // ---------------------------------------------------------------------------

  const SortHeader = ({ col, label, className }: { col: SortColumn; label: string; className?: string }) => {
    const active = sortCol === col;
    return (
      <th
        className={`p-3 text-left text-[10px] uppercase tracking-wider font-semibold cursor-pointer select-none hover:opacity-80 ${className ?? ''}`}
        style={{ color: active ? 'var(--pc-accent)' : 'var(--pc-text-faint)' }}
        onClick={() => {
          if (active) {
            setSortDir((d) => d === 'asc' ? 'desc' : 'asc');
          } else {
            setSortCol(col);
            setSortDir(col === 'name' ? 'asc' : 'desc');
          }
        }}
      >
        <span className="inline-flex items-center gap-1">
          {label}
          {active ? (
            sortDir === 'asc' ? <ArrowUp className="h-3 w-3" /> : <ArrowDown className="h-3 w-3" />
          ) : (
            <ArrowUpDown className="h-3 w-3 opacity-30" />
          )}
        </span>
      </th>
    );
  };

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="h-8 w-8 border-2 rounded-full animate-spin"
          style={{ borderColor: 'var(--pc-border)', borderTopColor: 'var(--pc-accent)' }} />
      </div>
    );
  }

  return (
    <div className="p-6 space-y-4 animate-fade-in">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <MessageSquare className="h-5 w-5" style={{ color: 'var(--pc-accent)' }} />
          <h2 className="text-sm font-semibold uppercase tracking-wider"
            style={{ color: 'var(--pc-text-primary)' }}>
            Sessions ({sessions.length})
          </h2>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={handleExport} title="Export sessions"
            className="p-2 rounded-xl transition-colors"
            style={{ color: 'var(--pc-text-muted)', border: '1px solid var(--pc-border)' }}>
            <Download className="h-4 w-4" />
          </button>
          <button onClick={fetchSessions} title="Refresh"
            className="p-2 rounded-xl transition-colors"
            style={{ color: 'var(--pc-text-muted)', border: '1px solid var(--pc-border)' }}>
            <RefreshCw className="h-4 w-4" />
          </button>
          <button onClick={handleNewChat}
            className="btn-electric px-3 py-1.5 text-sm font-medium rounded-xl flex items-center gap-1.5"
            style={{ color: 'white' }}>
            <Plus className="h-4 w-4" /> New Chat
          </button>
        </div>
      </div>

      {/* Search + page size */}
      <div className="flex items-center gap-3">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4"
            style={{ color: 'var(--pc-text-faint)' }} />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Filter sessions..."
            className="input-electric w-full pl-9 pr-3 py-2 text-sm"
          />
        </div>
        <select
          value={pageSize}
          onChange={(e) => setPageSize(Number(e.target.value))}
          className="text-sm rounded-lg px-2 py-2"
          style={{ background: 'var(--pc-bg-elevated)', border: '1px solid var(--pc-border)', color: 'var(--pc-text-primary)' }}
        >
          {PAGE_SIZES.map((n) => (
            <option key={n} value={n}>{n} per page</option>
          ))}
        </select>
      </div>

      {error && (
        <div className="rounded-xl border p-3 text-sm"
          style={{ background: 'rgba(239, 68, 68, 0.08)', borderColor: 'rgba(239, 68, 68, 0.2)', color: '#f87171' }}>
          {error}
        </div>
      )}

      {/* Bulk actions bar */}
      {selectedIds.size > 0 && (
        <div className="flex items-center gap-3 rounded-xl border px-4 py-2"
          style={{ background: 'var(--pc-accent-glow)', borderColor: 'var(--pc-accent-dim)' }}>
          <span className="text-sm font-medium" style={{ color: 'var(--pc-text-primary)' }}>
            {selectedIds.size} selected
          </span>
          <button onClick={() => setSelectedIds(new Set())}
            className="text-xs px-2 py-1 rounded-lg"
            style={{ color: 'var(--pc-text-muted)', border: '1px solid var(--pc-border)' }}>
            Deselect
          </button>
          <button onClick={handleDeleteSelected} disabled={deleting}
            className="text-xs px-2 py-1 rounded-lg flex items-center gap-1"
            style={{ background: 'rgba(239, 68, 68, 0.1)', color: '#f87171', border: '1px solid rgba(239, 68, 68, 0.3)' }}>
            <Trash2 className="h-3 w-3" />
            {deleting ? 'Deleting...' : 'Delete'}
          </button>
        </div>
      )}

      {/* Sessions table */}
      <div className="rounded-2xl border overflow-hidden"
        style={{ background: 'var(--pc-bg-elevated)', borderColor: 'var(--pc-border)' }}>
        <table className="w-full text-sm">
          <thead>
            <tr style={{ borderBottom: '1px solid var(--pc-border)' }}>
              <th className="p-3 w-10">
                <input
                  type="checkbox"
                  checked={allOnPageSelected}
                  ref={(el) => { if (el) el.indeterminate = someOnPageSelected && !allOnPageSelected; }}
                  onChange={toggleSelectAll}
                  className="rounded"
                />
              </th>
              <SortHeader col="name" label="Session" />
              <SortHeader col="messages" label="Messages" />
              <SortHeader col="last_activity" label="Last Active" />
              <SortHeader col="created_at" label="Created" />
              <th className="p-3 w-24 text-right text-[10px] uppercase tracking-wider font-semibold"
                style={{ color: 'var(--pc-text-faint)' }}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {pageRows.length === 0 ? (
              <tr>
                <td colSpan={6} className="p-8 text-center" style={{ color: 'var(--pc-text-muted)' }}>
                  {searchQuery ? 'No matching sessions' : 'No sessions yet'}
                </td>
              </tr>
            ) : pageRows.map((session) => (
              <tr key={session.session_id}
                className="transition-colors"
                style={{
                  borderBottom: '1px solid var(--pc-border)',
                  background: session.session_id === activeSessionId ? 'var(--pc-accent-glow)' : undefined,
                }}
                onMouseEnter={(e) => { if (session.session_id !== activeSessionId) e.currentTarget.style.background = 'var(--pc-hover)'; }}
                onMouseLeave={(e) => { if (session.session_id !== activeSessionId) e.currentTarget.style.background = ''; }}
              >
                <td className="p-3">
                  <input
                    type="checkbox"
                    checked={selectedIds.has(session.session_id)}
                    onChange={() => toggleSelect(session.session_id)}
                    className="rounded"
                  />
                </td>
                <td className="p-3">
                  <div className="flex flex-col">
                    {renamingId === session.session_id ? (
                      <div className="flex items-center gap-1">
                        <input
                          type="text"
                          value={renameValue}
                          onChange={(e) => setRenameValue(e.target.value)}
                          onKeyDown={(e) => { if (e.key === 'Enter') commitRename(); if (e.key === 'Escape') cancelRename(); }}
                          autoFocus
                          className="text-sm px-2 py-0.5 rounded-md w-40"
                          style={{ background: 'var(--pc-bg-base)', border: '1px solid var(--pc-accent-dim)', color: 'var(--pc-text-primary)' }}
                        />
                        <button onClick={commitRename} className="p-0.5" style={{ color: '#34d399' }}><Check className="h-3.5 w-3.5" /></button>
                        <button onClick={cancelRename} className="p-0.5" style={{ color: 'var(--pc-text-muted)' }}><X className="h-3.5 w-3.5" /></button>
                      </div>
                    ) : (
                      <span className="font-medium truncate max-w-[200px]"
                        style={{ color: 'var(--pc-text-primary)' }}>
                        {session.name || session.session_id.slice(0, 12) + '...'}
                        {session.session_id === activeSessionId && (
                          <span className="ml-2 text-[9px] px-1.5 py-0.5 rounded-full" style={{ background: 'var(--pc-accent)', color: 'white' }}>active</span>
                        )}
                      </span>
                    )}
                    <span className="text-[10px] font-mono"
                      style={{ color: 'var(--pc-text-faint)' }}>
                      {session.session_id.slice(0, 8)}
                    </span>
                  </div>
                </td>
                <td className="p-3 tabular-nums" style={{ color: 'var(--pc-text-muted)' }}>
                  {session.message_count}
                </td>
                <td className="p-3" style={{ color: 'var(--pc-text-muted)' }}>
                  <span title={formatDate(session.last_activity)}>
                    {relativeTime(session.last_activity)}
                  </span>
                </td>
                <td className="p-3" style={{ color: 'var(--pc-text-faint)' }}>
                  <span title={formatDate(session.created_at)}>
                    {relativeTime(session.created_at)}
                  </span>
                </td>
                <td className="p-3 text-right">
                  <div className="flex items-center justify-end gap-1">
                    <button onClick={() => startRename(session)}
                      className="p-1.5 rounded-lg transition-colors"
                      style={{ color: 'var(--pc-text-muted)' }}
                      title="Rename">
                      <Pencil className="h-3.5 w-3.5" />
                    </button>
                    <button onClick={() => handleOpenChat(session.session_id)}
                      className="p-1.5 rounded-lg transition-colors"
                      style={{ color: 'var(--pc-text-muted)' }}
                      title="Open in chat">
                      <ExternalLink className="h-3.5 w-3.5" />
                    </button>
                    <button onClick={() => handleDeleteOne(session.session_id)}
                      className="p-1.5 rounded-lg transition-colors"
                      style={{ color: 'var(--pc-text-muted)' }}
                      onMouseEnter={(e) => { e.currentTarget.style.color = '#f87171'; }}
                      onMouseLeave={(e) => { e.currentTarget.style.color = 'var(--pc-text-muted)'; }}
                      title="Delete session">
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Pagination */}
      {sorted.length > pageSize && (
        <div className="flex items-center justify-between text-sm" style={{ color: 'var(--pc-text-muted)' }}>
          <span>
            {pageStart + 1}–{Math.min(pageEnd, sorted.length)} of {sorted.length} sessions
          </span>
          <div className="flex items-center gap-2">
            <button onClick={() => setPage((p) => Math.max(0, p - 1))} disabled={safePage === 0}
              className="p-1.5 rounded-lg disabled:opacity-30"
              style={{ border: '1px solid var(--pc-border)' }}>
              <ChevronLeft className="h-4 w-4" />
            </button>
            <span className="text-xs tabular-nums">
              Page {safePage + 1} of {totalPages}
            </span>
            <button onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))} disabled={safePage >= totalPages - 1}
              className="p-1.5 rounded-lg disabled:opacity-30"
              style={{ border: '1px solid var(--pc-border)' }}>
              <ChevronRight className="h-4 w-4" />
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
