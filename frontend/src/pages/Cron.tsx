import { useEffect, useState, useCallback } from 'react';
import { Clock, Plus, Play, ToggleLeft, ToggleRight, Trash2, Edit2, ChevronDown, ChevronRight } from 'lucide-react';
import Shell from '@/components/Shell';
import StatusBadge from '@/components/StatusBadge';
import Modal from '@/components/Modal';
import { api, CronJob, CronRun } from '@/lib/api';
import CronJobModal from '@/components/CronJobModal';

function relativeTime(iso: string | null): string {
  if (!iso) return 'Never';
  const diff = Date.now() - new Date(iso).getTime();
  const sec = Math.floor(diff / 1000);
  if (sec < 60) return `${sec}s ago`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m ago`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}h ago`;
  return `${Math.floor(sec / 86400)}d ago`;
}

function duration(run: CronRun): string {
  if (!run.finished_at) return '…';
  const ms = new Date(run.finished_at).getTime() - new Date(run.started_at).getTime();
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

export default function Cron() {
  const [jobs, setJobs] = useState<CronJob[]>([]);
  const [loading, setLoading] = useState(true);
  const [expandedJob, setExpandedJob] = useState<string | null>(null);
  const [runs, setRuns] = useState<Record<string, CronRun[]>>({});
  const [outputModal, setOutputModal] = useState<{ jobId: string; runId: number } | null>(null);
  const [outputText, setOutputText] = useState('');
  const [showJobModal, setShowJobModal] = useState(false);
  const [editingJob, setEditingJob] = useState<CronJob | null>(null);
  const [acting, setActing] = useState<string | null>(null);

  const fetchJobs = useCallback(async () => {
    const res = await api.get<CronJob[]>('/cron/jobs');
    if (res.success && res.data) {
      setJobs(res.data.filter(j => j.app_id === null));
    }
    setLoading(false);
  }, []);

  useEffect(() => { fetchJobs(); }, [fetchJobs]);

  // Poll runs for expanded job every 5s
  const fetchRuns = useCallback(async (jobId: string) => {
    const res = await api.get<CronRun[]>(`/cron/jobs/${jobId}/runs`);
    if (res.success && res.data) {
      setRuns(prev => ({ ...prev, [jobId]: res.data! }));
    }
  }, []);

  useEffect(() => {
    if (!expandedJob) return;
    fetchRuns(expandedJob);
    const iv = setInterval(() => fetchRuns(expandedJob), 5000);
    return () => clearInterval(iv);
  }, [expandedJob, fetchRuns]);

  async function toggleJob(id: string) {
    setActing(id + ':toggle');
    await api.post(`/cron/jobs/${id}/toggle`);
    await fetchJobs();
    setActing(null);
  }

  async function runNow(id: string) {
    setActing(id + ':run');
    await api.post(`/cron/jobs/${id}/run`);
    setActing(null);
  }

  async function deleteJob(id: string) {
    if (!confirm('Delete this cron job?')) return;
    await api.delete(`/cron/jobs/${id}`);
    await fetchJobs();
  }

  async function showOutput(jobId: string, runId: number) {
    setOutputModal({ jobId, runId });
    const res = await api.get<{ output: string }>(`/cron/jobs/${jobId}/runs/${runId}/output`);
    setOutputText(res.data?.output ?? '');
  }

  if (loading) {
    return (
      <Shell>
        <div className="flex items-center justify-center py-32">
          <span className="h-6 w-6 rounded-full border-2 border-violet-500/30 border-t-violet-500 animate-spin" />
        </div>
      </Shell>
    );
  }

  return (
    <Shell>
      <div className="max-w-5xl mx-auto px-6 py-8">
        {/* Header */}
        <div className="flex items-center justify-between mb-8">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-violet-600/20 border border-violet-500/20">
              <Clock size={18} className="text-violet-400" />
            </div>
            <div>
              <h1 className="text-xl font-bold text-white">Cron Jobs</h1>
              <p className="text-xs text-gray-500 mt-0.5">Server-wide scheduled tasks</p>
            </div>
          </div>
          <button
            onClick={() => { setEditingJob(null); setShowJobModal(true); }}
            className="flex items-center gap-2 rounded-xl bg-violet-600 hover:bg-violet-500 px-4 py-2 text-sm font-medium text-white transition-colors"
          >
            <Plus size={14} /> Add Job
          </button>
        </div>

        {/* Jobs list */}
        {jobs.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-24 text-center">
            <Clock size={36} className="text-gray-700 mb-3" />
            <p className="text-gray-400 font-medium">No cron jobs yet</p>
            <p className="text-xs text-gray-600 mt-1">Add a server-wide scheduled task</p>
          </div>
        ) : (
          <div className="space-y-2">
            {jobs.map(job => (
              <div key={job.id} className="rounded-xl border border-white/[0.06] overflow-hidden"
                style={{ background: 'rgba(255,255,255,0.02)' }}>
                {/* Job row */}
                <div
                  className="flex items-center gap-4 px-4 py-3 cursor-pointer hover:bg-white/[0.02] transition-colors"
                  onClick={() => setExpandedJob(expandedJob === job.id ? null : job.id)}
                >
                  <button className="text-gray-600 hover:text-gray-400 transition-colors shrink-0">
                    {expandedJob === job.id
                      ? <ChevronDown size={14} />
                      : <ChevronRight size={14} />}
                  </button>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-gray-200 truncate">{job.name}</p>
                    <p className="text-xs text-gray-500 font-mono mt-0.5">{job.schedule}</p>
                  </div>
                  <div className="hidden sm:block text-xs text-gray-500 shrink-0">
                    Last: {relativeTime(job.last_run_at)}
                  </div>
                  <div className="hidden sm:block text-xs text-gray-500 shrink-0">
                    Next: {relativeTime(job.next_run_at)}
                  </div>
                  <button
                    onClick={e => { e.stopPropagation(); toggleJob(job.id); }}
                    className="text-gray-500 hover:text-violet-400 transition-colors shrink-0"
                    title={job.enabled ? 'Disable' : 'Enable'}
                  >
                    {job.enabled ? <ToggleRight size={18} className="text-emerald-400" /> : <ToggleLeft size={18} />}
                  </button>
                  <button
                    onClick={e => { e.stopPropagation(); runNow(job.id); }}
                    disabled={acting === job.id + ':run'}
                    className="text-gray-500 hover:text-blue-400 transition-colors shrink-0"
                    title="Run now"
                  >
                    <Play size={14} />
                  </button>
                  <button
                    onClick={e => { e.stopPropagation(); setEditingJob(job); setShowJobModal(true); }}
                    className="text-gray-500 hover:text-gray-300 transition-colors shrink-0"
                  >
                    <Edit2 size={14} />
                  </button>
                  <button
                    onClick={e => { e.stopPropagation(); deleteJob(job.id); }}
                    className="text-gray-500 hover:text-red-400 transition-colors shrink-0"
                  >
                    <Trash2 size={14} />
                  </button>
                </div>

                {/* Run history */}
                {expandedJob === job.id && (
                  <div className="border-t border-white/[0.05] px-4 py-3">
                    <p className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-2">Run History</p>
                    {!runs[job.id] || runs[job.id].length === 0 ? (
                      <p className="text-xs text-gray-600">No runs yet</p>
                    ) : (
                      <div className="space-y-1">
                        {runs[job.id].map(run => (
                          <div key={run.id}
                            className="flex items-center gap-3 py-1.5 px-2 rounded-lg hover:bg-white/[0.02] cursor-pointer transition-colors"
                            onClick={() => showOutput(job.id, run.id)}
                          >
                            <StatusBadge status={run.status} />
                            <span className="text-xs text-gray-400">{relativeTime(run.started_at)}</span>
                            <span className="text-xs text-gray-600">{duration(run)}</span>
                            <span className="text-xs text-gray-600 font-mono truncate flex-1">{run.output}</span>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Output modal */}
      {outputModal && (
        <Modal title="Run Output" onClose={() => setOutputModal(null)}>
          <div className="p-4">
            <pre className="text-xs text-gray-300 font-mono bg-black/40 rounded-lg p-4 overflow-auto max-h-96 whitespace-pre-wrap">
              {outputText || '(empty)'}
            </pre>
          </div>
        </Modal>
      )}

      {/* Add/Edit job modal */}
      {showJobModal && (
        <CronJobModal
          job={editingJob}
          appId={null}
          onClose={() => setShowJobModal(false)}
          onSaved={() => { setShowJobModal(false); fetchJobs(); }}
        />
      )}
    </Shell>
  );
}
