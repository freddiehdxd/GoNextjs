import { useState, useEffect, useRef } from 'react';
import { X, ChevronDown } from 'lucide-react';
import { api, CronJob } from '@/lib/api';

const PRESETS = [
  { label: 'Every 5 minutes', value: '*/5 * * * *' },
  { label: 'Hourly',          value: '0 * * * *'   },
  { label: 'Daily midnight',  value: '0 0 * * *'   },
  { label: 'Weekly (Sun)',    value: '0 0 * * 0'   },
  { label: 'Monthly',        value: '0 0 1 * *'   },
  { label: 'Custom…',        value: '__custom__'  },
];

const ACTIONS = [
  { label: 'Restart app',              value: 'restart' },
  { label: 'Deploy (git pull + rebuild)', value: 'deploy' },
];

interface Props {
  job: CronJob | null;
  appId: string | null;
  onClose: () => void;
  onSaved: () => void;
}

function Dropdown({ options, value, onChange }: {
  options: { label: string; value: string }[];
  value: string;
  onChange: (v: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const selected = options.find(o => o.value === value);

  useEffect(() => {
    function handle(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener('mousedown', handle);
    return () => document.removeEventListener('mousedown', handle);
  }, []);

  return (
    <div ref={ref} className="relative">
      <button type="button" onClick={() => setOpen(o => !o)}
        className="w-full flex items-center justify-between rounded-lg border border-white/10 px-3 py-2 text-sm text-gray-100 transition-colors focus:outline-none focus:border-violet-500/50"
        style={{ background: 'rgba(255,255,255,0.05)' }}>
        <span>{selected?.label ?? value}</span>
        <ChevronDown size={13} className={`text-gray-500 transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>
      {open && (
        <div className="absolute z-50 mt-1 w-full rounded-lg overflow-hidden shadow-xl"
          style={{ background: '#1a1a2e', border: '1px solid rgba(255,255,255,0.1)' }}>
          {options.map(o => (
            <button key={o.value} type="button"
              onClick={() => { onChange(o.value); setOpen(false); }}
              className={`w-full text-left px-3 py-2 text-sm transition-colors
                ${o.value === value
                  ? 'bg-violet-600/30 text-violet-300'
                  : 'text-gray-300 hover:bg-white/[0.06]'}`}>
              {o.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export default function CronJobModal({ job, appId, onClose, onSaved }: Props) {
  const [name, setName] = useState(job?.name ?? '');
  const [preset, setPreset] = useState('0 0 * * *');
  const [customSchedule, setCustomSchedule] = useState('');
  const [isCustom, setIsCustom] = useState(false);
  const [type, setType] = useState<'command' | 'action'>(job?.action ? 'action' : 'command');
  const [command, setCommand] = useState(job?.command ?? '');
  const [action, setAction] = useState(job?.action ?? 'restart');
  const [maxRuntime, setMaxRuntime] = useState(job?.max_runtime ?? 300);
  const [enabled, setEnabled] = useState(job?.enabled ?? true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (job) {
      const matched = PRESETS.find(p => p.value === job.schedule && p.value !== '__custom__');
      if (matched) {
        setPreset(job.schedule);
        setIsCustom(false);
      } else {
        setPreset('__custom__');
        setCustomSchedule(job.schedule);
        setIsCustom(true);
      }
    }
  }, [job]);

  function getSchedule(): string {
    return isCustom ? customSchedule : preset;
  }

  async function save() {
    setSaving(true);
    setError('');

    const payload = {
      app_id: appId,
      name,
      schedule: getSchedule(),
      command: type === 'command' ? command : null,
      action: type === 'action' ? action : null,
      max_runtime: maxRuntime,
      enabled,
    };

    const res = job
      ? await api.put(`/cron/jobs/${job.id}`, payload)
      : await api.post('/cron/jobs', payload);

    if (res.success) {
      onSaved();
    } else {
      setError(res.error ?? 'Failed to save');
    }
    setSaving(false);
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/70 backdrop-blur-sm" onClick={onClose} />
      <div className="relative w-full max-w-md rounded-2xl overflow-hidden animate-slide-up"
        style={{ background: '#0d0d1a', border: '1px solid rgba(255,255,255,0.1)' }}>

        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-white/[0.07]">
          <h2 className="text-sm font-semibold text-white">{job ? 'Edit Cron Job' : 'New Cron Job'}</h2>
          <button onClick={onClose} className="text-gray-500 hover:text-gray-300 transition-colors">
            <X size={15} />
          </button>
        </div>

        {/* Body */}
        <div className="px-5 py-4 space-y-4">
          {/* Name */}
          <div>
            <label className="block text-xs font-medium text-gray-400 mb-1.5">Name</label>
            <input value={name} onChange={e => setName(e.target.value)}
              placeholder="e.g. Nightly cleanup"
              className="w-full rounded-lg bg-white/5 border border-white/10 px-3 py-2 text-sm text-gray-100 placeholder-gray-600 focus:outline-none focus:border-violet-500/50" />
          </div>

          {/* Schedule */}
          <div>
            <label className="block text-xs font-medium text-gray-400 mb-1.5">Schedule</label>
            <Dropdown
              options={PRESETS}
              value={isCustom ? '__custom__' : preset}
              onChange={v => {
                if (v === '__custom__') {
                  setIsCustom(true);
                  setPreset('__custom__');
                } else {
                  setIsCustom(false);
                  setPreset(v);
                }
              }}
            />
            {isCustom && (
              <input value={customSchedule} onChange={e => setCustomSchedule(e.target.value)}
                placeholder="*/5 * * * *"
                className="mt-2 w-full rounded-lg bg-white/5 border border-white/10 px-3 py-2 text-sm text-gray-100 font-mono placeholder-gray-600 focus:outline-none focus:border-violet-500/50" />
            )}
          </div>

          {/* Type toggle */}
          <div>
            <label className="block text-xs font-medium text-gray-400 mb-1.5">Type</label>
            <div className="flex rounded-lg overflow-hidden border border-white/10">
              <button
                onClick={() => setType('command')}
                className={`flex-1 py-2 text-xs font-medium transition-colors
                  ${type === 'command' ? 'bg-violet-600 text-white' : 'bg-white/5 text-gray-400 hover:text-gray-200'}`}>
                Shell Command
              </button>
              {appId !== null && (
                <button
                  onClick={() => setType('action')}
                  className={`flex-1 py-2 text-xs font-medium transition-colors
                    ${type === 'action' ? 'bg-violet-600 text-white' : 'bg-white/5 text-gray-400 hover:text-gray-200'}`}>
                  App Action
                </button>
              )}
            </div>
          </div>

          {/* Command / Action */}
          {type === 'command' ? (
            <div>
              <label className="block text-xs font-medium text-gray-400 mb-1.5">Command</label>
              <textarea value={command} onChange={e => setCommand(e.target.value)}
                rows={3}
                placeholder="node scripts/cleanup.js"
                className="w-full rounded-lg bg-white/5 border border-white/10 px-3 py-2 text-sm text-gray-100 font-mono placeholder-gray-600 focus:outline-none focus:border-violet-500/50 resize-none" />
            </div>
          ) : (
            <div>
              <label className="block text-xs font-medium text-gray-400 mb-1.5">Action</label>
              <Dropdown options={ACTIONS} value={action} onChange={setAction} />
            </div>
          )}

          {/* Max runtime */}
          <div>
            <label className="block text-xs font-medium text-gray-400 mb-1.5">
              Max runtime (seconds) — 0 = unlimited
            </label>
            <input type="number" min={0} value={maxRuntime}
              onChange={e => setMaxRuntime(Number(e.target.value))}
              className="w-full rounded-lg bg-white/5 border border-white/10 px-3 py-2 text-sm text-gray-100 focus:outline-none focus:border-violet-500/50" />
          </div>

          {/* Enabled */}
          <label className="flex items-center gap-3 cursor-pointer">
            <input type="checkbox" checked={enabled} onChange={e => setEnabled(e.target.checked)}
              className="w-4 h-4 rounded accent-violet-500" />
            <span className="text-sm text-gray-300">Enabled</span>
          </label>

          {error && <p className="text-xs text-red-400">{error}</p>}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-3 px-5 py-4 border-t border-white/[0.07]">
          <button onClick={onClose} className="px-4 py-2 text-sm text-gray-400 hover:text-gray-200 transition-colors">
            Cancel
          </button>
          <button onClick={save} disabled={saving}
            className="px-4 py-2 text-sm font-medium text-white bg-violet-600 hover:bg-violet-500 rounded-xl transition-colors disabled:opacity-50">
            {saving ? 'Saving…' : (job ? 'Save Changes' : 'Create Job')}
          </button>
        </div>
      </div>
    </div>
  );
}
