export default function StatusBadge({ status }: { status: string }) {
  const cfg: Record<string, { cls: string; dot: string; label: string }> = {
    online:    { cls: 'badge-green',  dot: 'bg-emerald-400', label: 'Online'   },
    running:   { cls: 'badge-green',  dot: 'bg-emerald-400', label: 'Running'  },
    stopped:   { cls: 'badge-gray',   dot: 'bg-gray-500',    label: 'Stopped'  },
    errored:   { cls: 'badge-red',    dot: 'bg-red-400',     label: 'Error'    },
    unknown:   { cls: 'badge-gray',   dot: 'bg-gray-600',    label: 'Unknown'  },
    launching: { cls: 'badge-yellow', dot: 'bg-amber-400',   label: 'Starting' },
    success:   { cls: 'badge-green',  dot: 'bg-emerald-400', label: 'Success'  },
    error:     { cls: 'badge-red',    dot: 'bg-red-400',     label: 'Error'    },
    timeout:   { cls: 'badge-yellow', dot: 'bg-amber-400',   label: 'Timeout'  },
    missed:    { cls: 'badge-gray',   dot: 'bg-gray-500',    label: 'Missed'   },
  };
  const { cls, dot, label } = cfg[status] ?? cfg['unknown'];
  return (
    <span className={cls}>
      <span className={`inline-block h-1.5 w-1.5 rounded-full ${dot} ${status === 'online' || status === 'running' ? 'animate-pulse' : ''}`} />
      {label}
    </span>
  );
}
