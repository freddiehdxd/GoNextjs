'use client';
import { useEffect, useState, useCallback, useRef, Suspense } from 'react';
import { useSearchParams } from 'next/navigation';
import { Terminal, RotateCcw, Download, ChevronDown } from 'lucide-react';
import Shell from '@/components/Shell';
import { api, App } from '@/lib/api';

type LogSource = 'app' | 'nginx-access' | 'nginx-error';

function LogsContent() {
  const searchParams = useSearchParams();
  const initialApp   = searchParams.get('app') ?? '';

  const [apps,       setApps]       = useState<App[]>([]);
  const [source,     setSource]     = useState<LogSource>('app');
  const [appName,    setAppName]    = useState(initialApp);
  const [lines,      setLines]      = useState(200);
  const [log,        setLog]        = useState('');
  const [loading,    setLoading]    = useState(false);
  const [autoScroll, setAutoScroll] = useState(true);
  const termRef = useRef<HTMLPreElement>(null);

  useEffect(() => {
    api.get<App[]>('/apps').then((r) => {
      if (r.data) {
        setApps(r.data);
        if (initialApp && r.data.find((a) => a.name === initialApp)) {
          setAppName(initialApp);
          setSource('app');
        }
      }
    });
  }, [initialApp]);

  const fetchLogs = useCallback(async () => {
    setLoading(true);
    let res: { success: boolean; data?: { log: string } };
    if (source === 'app') {
      if (!appName) { setLog(''); setLoading(false); return; }
      res = await api.get<{ log: string }>(`/logs/app/${appName}?lines=${lines}`);
    } else {
      const type = source === 'nginx-error' ? 'error' : 'access';
      res = await api.get<{ log: string }>(`/logs/nginx?type=${type}&lines=${lines}`);
    }
    if (res.success && res.data) setLog(res.data.log);
    setLoading(false);
  }, [source, appName, lines]);

  useEffect(() => { fetchLogs(); }, [fetchLogs]);

  useEffect(() => {
    if (autoScroll && termRef.current) {
      termRef.current.scrollTop = termRef.current.scrollHeight;
    }
  }, [log, autoScroll]);

  function downloadLog() {
    const blob = new Blob([log], { type: 'text/plain' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href = url;
    a.download = `${source}-${Date.now()}.log`;
    a.click();
    URL.revokeObjectURL(url);
  }

  function colorLine(line: string): string {
    if (!line) return 'text-gray-700';
    if (/error|Error|ERROR|fatal|FATAL|uncaughtException/i.test(line)) return 'text-red-400';
    if (/warn|WARN|warning/i.test(line))                                return 'text-amber-400';
    if (/info|INFO/i.test(line))                                        return 'text-blue-400';
    if (/✓|success|started|online|ready|compiled/i.test(line))         return 'text-emerald-400';
    if (/ (GET|POST|PUT|DELETE|PATCH) /i.test(line))                    return 'text-cyan-400/80';
    return 'text-gray-400';
  }

  const logLines = log.split('\n');

  return (
    <Shell>
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-white">Logs</h1>
        <p className="text-sm text-gray-600 mt-1">App and NGINX log viewer</p>
      </div>

      {/* Controls */}
      <div className="flex items-center gap-3 flex-wrap mb-4">
        {/* Source tabs */}
        <div className="flex items-center gap-1 rounded-xl border border-white/[0.07] p-1"
          style={{ background: 'rgba(255,255,255,0.02)' }}>
          {([
            { id: 'app',          label: 'App' },
            { id: 'nginx-access', label: 'NGINX Access' },
            { id: 'nginx-error',  label: 'NGINX Error' },
          ] as { id: LogSource; label: string }[]).map((s) => (
            <button
              key={s.id}
              onClick={() => setSource(s.id)}
              className={`rounded-lg px-3 py-1.5 text-xs font-medium transition-all ${
                source === s.id
                  ? 'bg-violet-600 text-white shadow shadow-violet-500/20'
                  : 'text-gray-500 hover:text-white'
              }`}
            >
              {s.label}
            </button>
          ))}
        </div>

        {/* App selector */}
        {source === 'app' && (
          <select
            className="input w-44 py-1.5"
            value={appName}
            onChange={(e) => setAppName(e.target.value)}
          >
            <option value="">Select app…</option>
            {apps.map((a) => <option key={a.id} value={a.name}>{a.name}</option>)}
          </select>
        )}

        {/* Line count */}
        <select
          className="input w-32 py-1.5"
          value={lines}
          onChange={(e) => setLines(Number(e.target.value))}
        >
          {[50, 100, 200, 500, 1000].map((n) => (
            <option key={n} value={n}>Last {n}</option>
          ))}
        </select>

        {/* Right actions */}
        <div className="flex gap-2 ml-auto">
          <button
            onClick={() => setAutoScroll((v) => !v)}
            className={`btn-ghost text-xs py-1.5 ${autoScroll ? 'text-violet-400' : ''}`}
          >
            <ChevronDown size={13} />
            Auto {autoScroll ? 'ON' : 'OFF'}
          </button>
          <button onClick={fetchLogs} disabled={loading} className="btn-ghost text-xs py-1.5">
            <RotateCcw size={13} className={loading ? 'animate-spin' : ''} />
            Refresh
          </button>
          {log && (
            <button onClick={downloadLog} className="btn-ghost text-xs py-1.5">
              <Download size={13} /> Download
            </button>
          )}
        </div>
      </div>

      {/* Terminal window */}
      <div className="rounded-2xl border border-white/[0.07] overflow-hidden"
        style={{ background: 'rgba(0,0,0,0.45)' }}>
        {/* Window chrome */}
        <div className="flex items-center gap-3 px-4 py-2.5 border-b border-white/[0.05]"
          style={{ background: 'rgba(255,255,255,0.02)' }}>
          <div className="flex gap-1.5">
            <div className="h-2.5 w-2.5 rounded-full" style={{ background: 'rgba(239,68,68,0.5)' }} />
            <div className="h-2.5 w-2.5 rounded-full" style={{ background: 'rgba(245,158,11,0.5)' }} />
            <div className="h-2.5 w-2.5 rounded-full" style={{ background: 'rgba(16,185,129,0.5)' }} />
          </div>
          <Terminal size={11} className="text-gray-700" />
          <span className="text-xs text-gray-600 font-mono flex-1 truncate">
            {source === 'app'
              ? (appName ? `pm2 logs ${appName} --lines ${lines}` : 'no app selected')
              : source === 'nginx-access'
                ? `/var/log/nginx/access.log`
                : `/var/log/nginx/error.log`}
          </span>
          <span className="text-[10px] text-gray-700 font-mono">{logLines.filter(Boolean).length} lines</span>
        </div>

        {/* Content */}
        {loading ? (
          <div className="p-6 flex items-center gap-3">
            <span className="h-3.5 w-3.5 rounded-full border-2 border-violet-500/30 border-t-violet-500 animate-spin shrink-0" />
            <span className="text-xs text-gray-600 font-mono">Fetching logs…</span>
          </div>
        ) : !log || (source === 'app' && !appName) ? (
          <div className="p-12 flex flex-col items-center gap-3 text-center">
            <Terminal size={30} className="text-gray-800" />
            <p className="text-gray-600 text-sm">
              {source === 'app' ? 'Select an app above to view its logs' : 'No log data found'}
            </p>
          </div>
        ) : (
          <pre
            ref={termRef}
            className="p-4 text-xs leading-relaxed overflow-auto font-mono"
            style={{ maxHeight: '70vh', minHeight: '300px' }}
          >
            {logLines.map((line, i) => (
              <div
                key={i}
                className={`${colorLine(line)} hover:bg-white/[0.015] px-1 rounded transition-colors`}
              >
                <span className="text-gray-800 mr-3 select-none text-[10px]">
                  {String(i + 1).padStart(4, ' ')}
                </span>
                {line || '\u00a0'}
              </div>
            ))}
          </pre>
        )}
      </div>
    </Shell>
  );
}

export default function LogsPage() {
  return (
    <Suspense fallback={<Shell><div className="text-gray-600 text-sm">Loading…</div></Shell>}>
      <LogsContent />
    </Suspense>
  );
}
