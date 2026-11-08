// Workspace ingestion. Demo data and real connectors go through the same path:
//   source -> normalized workspace {source, emails, events, tasks} -> ingest() -> app state
// Connectors (src/connectors/*) call loadWorkspace(ws, {merge}).
import { dateKeyFromOffset, parseHHMM, clampScore, heuristicScore, periodKey } from './engine.js';

export const STATE_VERSION = 3;
const SCORE_FIELDS = ['score', 'goal_index', 'why', 'injection', 'injection_quote'];

// ---------- normalization (the connector contract) ----------

const s = (v, max = 2000) => (v === null || v === undefined ? '' : String(v)).slice(0, max);
const isoOrNull = (v) => {
  if (!v) return null;
  const t = new Date(v);
  return Number.isNaN(t.getTime()) ? null : t.toISOString();
};
const dueOrNull = (v) => {
  if (!v) return null;
  const str = String(v);
  if (/^\d{4}-\d{2}-\d{2}$/.test(str)) return str;
  return isoOrNull(str);
};

/** Keep score fields only when they are present (demo cache, or a previous Claude run). */
function scoreExtras(raw) {
  const out = {};
  if (raw.score !== undefined && raw.score !== null) out.score = clampScore(raw.score);
  if (raw.goal_index !== undefined) out.goal_index = Number.isInteger(raw.goal_index) ? raw.goal_index : null;
  if (typeof raw.why === 'string') out.why = raw.why;
  if (raw.injection !== undefined) out.injection = !!raw.injection;
  if (raw.injection_quote !== undefined) out.injection_quote = raw.injection_quote || null;
  if (raw.estimate_min !== undefined && raw.kind === 'email') out.estimate_min = Number(raw.estimate_min) || undefined;
  if (raw.last_used_days_ago !== undefined) out.last_used_days_ago = raw.last_used_days_ago;
  return out;
}

export function normalizeEmail(raw, source) {
  const r = raw.recurring;
  const recurring =
    r && r.name !== undefined && Number.isFinite(Number(r.amount))
      ? { name: s(r.name, 120), amount: Number(r.amount), period: periodKey(r.period) }
      : null;
  const subject = s(raw.subject ?? raw.title, 300);
  const snippet = s(raw.snippet ?? raw.detail, 2000);
  return {
    ...scoreExtras({ ...raw, kind: 'email' }),
    id: s(raw.id, 128),
    kind: 'email',
    from: s(raw.from, 200),
    subject,
    snippet,
    title: s(raw.title ?? subject, 300),
    detail: s(raw.detail ?? snippet, 2000),
    date: isoOrNull(raw.date),
    link: raw.link ? s(raw.link, 1000) : null,
    recurring,
    due: dueOrNull(raw.due),
    source: s(raw.source || source || 'unknown', 40),
  };
}

export function normalizeTask(raw, source) {
  const est = Number(raw.estimate_min);
  return {
    ...scoreExtras({ ...raw, kind: 'task' }),
    id: s(raw.id, 128),
    kind: 'task',
    title: s(raw.title, 300),
    detail: s(raw.detail, 2000),
    due: dueOrNull(raw.due),
    estimate_min: est > 0 ? est : 30,
    created_days_ago: Number(raw.created_days_ago) || 0,
    source: s(raw.source || source || 'unknown', 40),
  };
}

export function normalizeEvent(raw, source) {
  return {
    id: s(raw.id || `${raw.title}-${raw.start}`, 200),
    title: s(raw.title ?? raw.name, 300),
    start: isoOrNull(raw.start),
    end: isoOrNull(raw.end),
    allDay: !!raw.allDay,
    source: s(raw.source || source || 'unknown', 40),
  };
}

export function normalizeWorkspace(ws) {
  const source = ws?.source || 'unknown';
  const ok = (x) => x && x.id !== undefined && x.id !== null && String(x.id) !== '';
  return {
    source,
    emails: (ws?.emails || []).filter(ok).map((e) => normalizeEmail(e, source)),
    tasks: (ws?.tasks || []).filter(ok).map((t) => normalizeTask(t, source)),
    events: (ws?.events || []).map((e) => normalizeEvent(e, source)).filter((e) => e.start),
  };
}

// ---------- demo.json -> normalized workspace ----------

/**
 * The demo keeps the spec's 18:00 stop time, but if the demo is opened within an hour
 * of (or after) 18:00 it moves stop time to 23:59 so the demo day still works for
 * evening judges and QA agents in other time zones.
 */
export function demoStopTime(now, base = '18:00') {
  const baseMin = parseHHMM(base) ?? 18 * 60;
  const nowMin = now.getHours() * 60 + now.getMinutes();
  return nowMin >= baseMin - 60 ? '23:59' : base;
}

/** Turn demo.json's relative offsets into the connector shape (plus cached demo scores). */
export function demoToWorkspace(demo, now) {
  return {
    source: 'demo',
    tasks: (demo.tasks || []).map((t) => ({ ...t, kind: 'task', due: dateKeyFromOffset(now, t.due), source: 'demo' })),
    emails: (demo.emails || []).map((e, i) => ({
      ...e,
      kind: 'email',
      title: e.subject,
      detail: e.snippet,
      date: new Date(now.getTime() - (i + 1) * 47 * 60000).toISOString(),
      link: null,
      recurring: e.recurring || null,
      due: dateKeyFromOffset(now, e.due),
      source: 'demo',
    })),
    events: (demo.calendar || []).map((ev, i) => {
      const start = new Date(now.getTime() + ev.start_offset_min * 60000);
      const end = new Date(start.getTime() + (ev.duration_min || 30) * 60000);
      return { id: `demo-ev${i + 1}`, title: ev.name, start: start.toISOString(), end: end.toISOString(), allDay: false, source: 'demo' };
    }),
  };
}

// ---------- ingest ----------

export function emptyState(now = new Date()) {
  return {
    version: STATE_VERSION,
    loadedAt: now.toISOString(),
    sources: [],
    goals: [],
    items: [],
    events: [],
    stopAt: '18:00',
    energy: 'high',
    picks: null,
    done: {},
    skipped: [],
    dropped: {},
    tomorrow: null,
    scoredBy: 'cache',
  };
}

/** Strip any incoming scores and give each item the offline heuristic score (marked unscored). */
export function markUnscored(item, goals) {
  const clean = { ...item };
  for (const f of SCORE_FIELDS) delete clean[f];
  const h = heuristicScore(`${clean.title} ${clean.detail || ''}`, goals);
  return { ...clean, score: h.score, goal_index: h.goal_index, why: h.why, injection: false, injection_quote: null, scored_by: 'heuristic', unscored: true };
}

/**
 * Pure: fold a workspace into state. keepScores=true keeps cached scores (demo);
 * otherwise items are marked unscored and heuristically scored until Claude rescores them.
 * merge=true upserts by id; merge=false replaces items and events.
 */
export function ingest(state, ws, { merge = false, keepScores = false } = {}) {
  const n = normalizeWorkspace(ws);
  const incoming = [...n.tasks, ...n.emails].map((it) =>
    keepScores && it.score !== undefined
      ? { ...it, injection: !!it.injection, injection_quote: it.injection_quote || null, goal_index: it.goal_index ?? null, why: it.why || '', scored_by: 'cache', unscored: false }
      : markUnscored(it, state.goals),
  );
  const upsert = (oldList, newList) => {
    if (!merge) return newList;
    const ids = new Set(newList.map((x) => x.id));
    return [...newList, ...oldList.filter((x) => !ids.has(x.id))];
  };
  return {
    ...state,
    sources: merge ? [...new Set([...(state.sources || []), n.source])] : [n.source],
    items: upsert(state.items || [], incoming),
    events: upsert(state.events || [], n.events),
    picks: null,
    skipped: [],
    tomorrow: null,
  };
}

export function buildDemoWorkspace(demo, now) {
  const base = { ...emptyState(now), goals: [...(demo.goals || [])], stopAt: demoStopTime(now, demo.stop_work_at || '18:00') };
  return ingest(base, demoToWorkspace(demo, now), { merge: false, keepScores: true });
}

/** Shape sent to /api/score. Unscored items go first (the API caps the batch). */
export function toScoreRequest(state, max = 80) {
  const ordered = [...state.items].sort((a, b) => Number(!!b.unscored) - Number(!!a.unscored));
  return {
    goals: state.goals,
    items: ordered.slice(0, max).map((it) => ({
      id: it.id,
      kind: it.kind,
      title: it.title,
      detail: it.kind === 'email' ? `From: ${it.from || ''}\n${it.detail || ''}` : it.detail || '',
      due: it.due || null,
    })),
  };
}

/** Merge AI scores into items. Unknown ids are ignored; injection flags only ever add. */
export function applyScores(items, scores) {
  const byId = new Map((scores || []).map((sc) => [sc.id, sc]));
  let applied = 0;
  const next = items.map((it) => {
    const sc = byId.get(it.id);
    if (!sc) return it;
    applied++;
    return {
      ...it,
      score: clampScore(sc.score),
      goal_index: Number.isInteger(sc.goal_index) ? sc.goal_index : null,
      why: typeof sc.why === 'string' && sc.why.trim() ? sc.why.trim() : it.why,
      injection: !!(it.injection || sc.injection),
      injection_quote: sc.injection ? sc.injection_quote || it.injection_quote || null : it.injection_quote || null,
      scored_by: 'claude',
      unscored: false,
    };
  });
  return { items: next, applied };
}

// ---------- integration hook for connectors ----------

let resolveHost;
const hostReady = new Promise((r) => (resolveHost = r));

/** Called once by main.js with {load(ws, opts)}. */
export function setWorkspaceHost(host) {
  resolveHost(host);
}

/**
 * Public hook for connectors: store a normalized workspace {source, emails, events, tasks},
 * mark its items unscored (heuristic score meanwhile) and trigger "Rescore with Claude".
 * Resolves to {items, events, rescored: boolean}.
 */
export async function loadWorkspace(ws, { merge = false } = {}) {
  const host = await Promise.race([
    hostReady,
    new Promise((_, rej) => setTimeout(() => rej(new Error('Bouncer app is not running on this page')), 10000)),
  ]);
  return host.load(ws, { merge });
}
