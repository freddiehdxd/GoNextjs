export default function StatusBadge({ status }: { status: string }) {
  const map: Record<string, string> = {
    online:   'badge-green',
    running:  'badge-green',
    stopped:  'badge-gray',
    errored:  'badge-red',
    unknown:  'badge-gray',
    launching:'badge-gray',
  };
  return <span className={map[status] ?? 'badge-gray'}>{status}</span>;
}
