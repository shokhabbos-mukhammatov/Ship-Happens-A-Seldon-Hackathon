// Todoist tasks via our /api/todoist pass-through (the user's personal API token is sent per
// request in a header, kept in memory only, never stored on the server or in localStorage).

const DAY = 86400000;
const UNIT_MIN = { minute: 1, day: 8 * 60 };

/** Todoist API v1 task -> normalized Task. */
export function normalizeTodoistTask(t, now = Date.now()) {
  const added = new Date(t.added_at).getTime();
  const dur = t.duration && Number(t.duration.amount) > 0 ? Number(t.duration.amount) * (UNIT_MIN[t.duration.unit] || 1) : null;
  const due = t.due?.date ? String(t.due.date).slice(0, 10) : t.deadline?.date ? String(t.deadline.date).slice(0, 10) : null;
  return {
    id: `todoist-${t.id}`,
    kind: 'task',
    title: String(t.content || '').trim(),
    detail: String(t.description || '').trim().slice(0, 300),
    due,
    estimate_min: dur ? Math.min(dur, 8 * 60) : 30,
    created_days_ago: Number.isFinite(added) ? Math.max(0, Math.floor((now - added) / DAY)) : 0,
    source: 'todoist',
  };
}

export async function connectTodoist({ token } = {}) {
  const tok = String(token || '').trim();
  if (!tok) throw new Error('Paste your Todoist API token first (Todoist, Settings, Integrations, Developer).');
  const r = await fetch('/api/todoist', { headers: { Authorization: `Bearer ${tok}` } });
  const data = await r.json().catch(() => null);
  if (!r.ok) throw new Error(data?.error || `Todoist connection failed (HTTP ${r.status}).`);
  const now = Date.now();
  const tasks = (data?.results || [])
    .filter((t) => !t.checked && !t.is_deleted && String(t.content || '').trim())
    .map((t) => normalizeTodoistTask(t, now));
  return { source: 'todoist', emails: [], events: [], tasks };
}
