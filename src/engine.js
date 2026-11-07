// Bouncer ranking engine. "The AI scores, the code decides."
// Pure, deterministic functions: no DOM, no network, no Date.now() inside.
// Every function that depends on time takes `now` explicitly.

export const URGENCY = { overdue: 20, today: 15, soon: 8 };
export const LOW_ENERGY_MAX_MIN = 20;
export const DROP_SCORE_MAX = 20; // tasks scoring below this...
export const DROP_AGE_DAYS = 14; // ...and older than this are Last Call candidates
export const SUB_FIT_MIN = 30; // subscriptions with goal fit below this...
export const SUB_IDLE_DAYS = 30; // ...or unused longer than this are Last Call candidates
export const DEFAULT_TASK_MIN = 30; // connector tasks without an estimate
export const REPLY_MIN = 10; // high-scoring emails without an estimate are treated as a 10-minute reply
export const REPLY_SCORE_MIN = 70;

// ---------- dates ----------

const pad = (n) => String(n).padStart(2, '0');

/** Local calendar date as YYYY-MM-DD. */
export function localDateKey(date) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** Local date key `offset` days from `now` (null offset -> null). */
export function dateKeyFromOffset(now, offset) {
  if (offset === null || offset === undefined || Number.isNaN(Number(offset))) return null;
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() + Number(offset));
  return localDateKey(d);
}

/** Whole calendar days from today (local) until the due date. Negative = overdue.
 *  Accepts "YYYY-MM-DD" (a calendar date) or a full ISO timestamp (read in local time). */
export function daysUntil(dueKey, now) {
  if (!dueKey) return null;
  const s = String(dueKey);
  let y, m, d;
  const plain = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (plain) [y, m, d] = plain.slice(1).map(Number);
  else {
    const t = new Date(s);
    if (Number.isNaN(t.getTime())) return null;
    [y, m, d] = [t.getFullYear(), t.getMonth() + 1, t.getDate()];
  }
  if (!y || !m || !d) return null;
  const due = Date.UTC(y, m - 1, d);
  const today = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
  return Math.round((due - today) / 86400000);
}

/** "HH:MM" -> minutes since midnight (invalid -> null). */
export function parseHHMM(str) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(str || '').trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

export function formatHHMM(date) {
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** Today's stop-work moment as a Date (defaults to 18:00 on bad input). */
export function stopDate(now, stopAt = '18:00') {
  const mins = parseHHMM(stopAt) ?? parseHHMM('18:00');
  return new Date(now.getFullYear(), now.getMonth(), now.getDate(), Math.floor(mins / 60), mins % 60, 0, 0);
}

export function isPastStop(now, stopAt = '18:00') {
  return now.getTime() >= stopDate(now, stopAt).getTime();
}

// ---------- urgency & priority ----------

export function urgency(item, now) {
  const days = daysUntil(item.due, now);
  if (days === null) return 0;
  if (days < 0) return URGENCY.overdue;
  if (days === 0) return URGENCY.today;
  if (days <= 3) return URGENCY.soon;
  return 0;
}

export function priority(item, now) {
  return clampScore(item.score) + urgency(item, now);
}

export function clampScore(n) {
  const v = Math.round(Number(n));
  if (!Number.isFinite(v)) return 0;
  return Math.max(0, Math.min(100, v));
}

// ---------- prompt-injection prefilter (lock #2) ----------

export const INJECTION_PATTERNS = [
  /\bignore (?:all |any )?(?:of )?(?:your|the|my|previous|prior|above|earlier)(?: \w+){0,2} (?:instructions|rules|prompts?)\b/i,
  /\bdisregard (?:all |any )?(?:your|the|previous|prior|above|earlier)(?: \w+){0,2} (?:instructions|rules|prompts?)\b/i,
  /\bnote (?:for|to) (?:your|the|any) (?:ai|assistant|ai assistant|agent|bot)\b/i,
  /\b(?:ai|assistant|agent)s?,? (?:please )?(?:you must|must now|should now)\b/i,
  /\bforward\b.{0,60}\binvoices?\b/i,
  /\bdelete this (?:e-?mail|message)\b/i,
  /\b(?:reveal|print|show) (?:your|the) (?:system )?prompt\b/i,
  /\bnew instructions\s*:/i,
];

/** Regex prefilter. Returns {flagged, quote}; quote is the offending sentence(s). */
export function heuristicInjection(text) {
  const src = String(text || '');
  if (!src.trim()) return { flagged: false, quote: null };
  const sentences = src.split(/(?<=[.!?])\s+/);
  const hits = [];
  for (const s of sentences) {
    if (INJECTION_PATTERNS.some((re) => re.test(s)) && !hits.includes(s.trim())) hits.push(s.trim());
  }
  if (!hits.length && INJECTION_PATTERNS.some((re) => re.test(src))) hits.push(src.trim());
  return hits.length ? { flagged: true, quote: hits.join(' ') } : { flagged: false, quote: null };
}

export function itemText(item) {
  return [item.title, item.subject, item.detail, item.snippet].filter(Boolean).join(' \n');
}

/** Two locks: quarantined if the LLM flagged it OR the regex does. The code decides. */
export function quarantineInfo(item) {
  const regex = heuristicInjection(itemText(item));
  const llm = !!item.injection;
  if (!llm && !regex.flagged) return null;
  return {
    llm,
    regex: regex.flagged,
    quote: item.injection_quote || regex.quote || null,
  };
}

export function isQuarantined(item) {
  return quarantineInfo(item) !== null;
}

// ---------- calendar ----------

export const eventTitle = (e) => (e && (e.title || e.name)) || 'your next event';

/** Next timed event that starts after now. All-day events do not block time. */
export function nextEvent(events, now) {
  const t = now.getTime();
  return (
    (events || [])
      .filter((e) => e && !e.allDay)
      .map((e) => ({ ...e, title: eventTitle(e), startMs: new Date(e.start).getTime() }))
      .filter((e) => Number.isFinite(e.startMs) && e.startMs > t)
      .sort((a, b) => a.startMs - b.startMs)[0] || null
  );
}

/** Minutes until the next calendar event, or until stop-work time if there is no event. */
export function minutesFree(events, now, stopAt = '18:00') {
  const ev = nextEvent(events, now);
  const end = ev ? ev.startMs : stopDate(now, stopAt).getTime();
  return Math.max(0, Math.round((end - now.getTime()) / 60000));
}

// ---------- ranking & packing ----------

function compareIds(a, b) {
  return String(a).localeCompare(String(b), 'en', { numeric: true });
}

/** Minutes an item takes. Tasks default to 30. Emails need an estimate, or count as a
 *  10-minute reply when they score >= 70 and are not receipts. Otherwise null (not pickable). */
export function effectiveEstimate(item) {
  const est = Number(item?.estimate_min);
  if (est > 0) return est;
  if (item?.kind === 'task') return DEFAULT_TASK_MIN;
  if (item?.kind === 'email' && !item.recurring && clampScore(item.score) >= REPLY_SCORE_MIN) return REPLY_MIN;
  return null;
}

/** Items eligible for "do it now": tasks and actionable emails, not quarantined. */
export function isPickable(item) {
  if (!item) return false;
  if (item.kind !== 'task' && item.kind !== 'email') return false;
  if (effectiveEstimate(item) === null) return false;
  return !isQuarantined(item);
}

/** Ranked candidates (desc). Low energy prefers items <= 20 min, then priority. */
export function rankCandidates(items, { now, energy = 'high', exclude = [] } = {}) {
  const ex = new Set(exclude);
  return items
    .filter((it) => isPickable(it) && !ex.has(it.id))
    .map((it) => ({ item: it, est: effectiveEstimate(it), urgency: urgency(it, now), priority: priority(it, now) }))
    .sort((a, b) => {
      if (energy === 'low') {
        const sa = a.est <= LOW_ENERGY_MAX_MIN ? 0 : 1;
        const sb = b.est <= LOW_ENERGY_MAX_MIN ? 0 : 1;
        if (sa !== sb) return sa - sb;
      }
      return (
        b.priority - a.priority ||
        a.est - b.est ||
        compareIds(a.item.id, b.item.id)
      );
    });
}

function explain(c, goals, fitsBefore) {
  const it = c.item;
  const gi = Number.isInteger(it.goal_index) ? it.goal_index : null;
  return {
    id: it.id,
    kind: it.kind,
    title: it.title,
    score: clampScore(it.score),
    urgency: c.urgency,
    priority: c.priority,
    goal_index: gi,
    goal: gi !== null && goals && goals[gi] ? goals[gi] : null,
    why: it.why || '',
    estimate_min: c.est ?? effectiveEstimate(it),
    source: it.source || null,
    fitsBefore,
  };
}

function fitsBeforeInfo(events, now, stopAt) {
  const ev = nextEvent(events, now);
  if (ev) return { name: ev.title, at: new Date(ev.startMs).toISOString(), kind: 'event' };
  return { name: 'stop-work time', at: stopDate(now, stopAt).toISOString(), kind: 'stop' };
}

/**
 * Walk candidates by priority and take each one whose estimate fits the remaining
 * free minutes, until there are `count` picks.
 */
export function pickTop3(items, { now, events = [], stopAt = '18:00', energy = 'high', exclude = [], goals = [], count = 3 } = {}) {
  const free = minutesFree(events, now, stopAt);
  const fitsBefore = fitsBeforeInfo(events, now, stopAt);
  let remaining = free;
  const picks = [];
  for (const c of rankCandidates(items, { now, energy, exclude })) {
    if (picks.length >= count) break;
    if (c.est <= remaining) {
      picks.push(explain(c, goals, fitsBefore));
      remaining -= c.est;
    }
  }
  return { picks, minutesFree: free, remaining, fitsBefore };
}

/**
 * Replace the pick in `slot` with the next eligible item that fits the minutes left
 * after the other (kept) picks. Returns {ids, replacement}. If nothing fits, the slot is removed.
 */
export function replacePick(items, currentIds, slot, { now, events = [], stopAt = '18:00', energy = 'high', exclude = [], goals = [] } = {}) {
  const byId = new Map(items.map((it) => [it.id, it]));
  const kept = currentIds.filter((_, i) => i !== slot);
  const used = kept.reduce((sum, id) => sum + (effectiveEstimate(byId.get(id)) || 0), 0);
  const free = minutesFree(events, now, stopAt);
  const remaining = free - used;
  const fitsBefore = fitsBeforeInfo(events, now, stopAt);
  const ranked = rankCandidates(items, { now, energy, exclude: [...exclude, ...currentIds] });
  const next = ranked.find((c) => c.est <= remaining);
  const ids = [...currentIds];
  if (next) {
    ids[slot] = next.item.id;
    return { ids, replacement: explain(next, goals, fitsBefore) };
  }
  ids.splice(slot, 1);
  return { ids, replacement: null };
}

/** Explain a list of pick ids (for re-rendering saved picks). */
export function explainIds(items, ids, { now, events = [], stopAt = '18:00', goals = [] } = {}) {
  const byId = new Map(items.map((it) => [it.id, it]));
  const fitsBefore = fitsBeforeInfo(events, now, stopAt);
  return ids
    .map((id) => byId.get(id))
    .filter(Boolean)
    .map((it) => explain({ item: it, est: effectiveEstimate(it), urgency: urgency(it, now), priority: priority(it, now) }, goals, fitsBefore));
}

// ---------- Last Call ----------

/** Normalise a billing period to 'mo' | 'yr' | 'wk' (connectors send 'mo'|'yr'). */
export function periodKey(period) {
  const p = String(period || 'mo').toLowerCase();
  if (/^(yr|year|yearly|annual|annually|y)$/.test(p)) return 'yr';
  if (/^(wk|week|weekly|w)$/.test(p)) return 'wk';
  return 'mo';
}

export function monthlyCost(recurring) {
  if (!recurring) return 0;
  const amt = Number(recurring.amount) || 0;
  const p = periodKey(recurring.period);
  if (p === 'yr') return amt / 12;
  if (p === 'wk') return (amt * 52) / 12;
  return amt;
}

export const round2 = (n) => Math.round(n * 100) / 100;

/**
 * Last Call: what to stop doing (old, low-value tasks) and stop paying
 * (subscriptions with low goal fit or unused for a month).
 */
export function lastCall(items, { exclude = [], goals = [] } = {}) {
  const ex = new Set(exclude);
  const drops = items
    .filter(
      (it) =>
        it.kind === 'task' &&
        !ex.has(it.id) &&
        clampScore(it.score) < DROP_SCORE_MAX &&
        Number(it.created_days_ago) > DROP_AGE_DAYS &&
        !isQuarantined(it),
    )
    .sort((a, b) => b.created_days_ago - a.created_days_ago || compareIds(a.id, b.id));

  // One row per subscription: several receipts for the same service collapse to the latest.
  const byName = new Map();
  for (const it of items) {
    if (!it.recurring || ex.has(it.id) || isQuarantined(it)) continue;
    const key = String(it.recurring.name || it.id).trim().toLowerCase();
    const prev = byName.get(key);
    if (!prev || String(it.date || '') > String(prev.date || '')) byName.set(key, it);
  }
  const subs = [];
  const keep = [];
  for (const it of byName.values()) {
    const fit = clampScore(it.score);
    const known = it.last_used_days_ago !== null && it.last_used_days_ago !== undefined && Number.isFinite(Number(it.last_used_days_ago));
    const idle = known ? Number(it.last_used_days_ago) : null;
    const reasons = [];
    if (fit < SUB_FIT_MIN) reasons.push(`Goal fit ${fit}/100`);
    if (idle !== null && idle > SUB_IDLE_DAYS) reasons.push(`unused for ${idle} days`);
    const gi = Number.isInteger(it.goal_index) ? it.goal_index : null;
    const row = {
      id: it.id,
      name: it.recurring.name,
      amount: Number(it.recurring.amount),
      period: periodKey(it.recurring.period),
      source: it.source || null,
      monthly: round2(monthlyCost(it.recurring)),
      fit,
      last_used_days_ago: idle,
      goal: gi !== null && goals[gi] ? goals[gi] : null,
      why: it.why || '',
      reasons,
    };
    (reasons.length ? subs : keep).push(row);
  }
  subs.sort((a, b) => b.monthly - a.monthly || compareIds(a.id, b.id));
  keep.sort((a, b) => b.fit - a.fit || compareIds(a.id, b.id));
  const monthlyTotal = round2(subs.reduce((s, r) => s + monthlyCost({ amount: r.amount, period: r.period }), 0));
  return { drops, subs, keep, monthlyTotal };
}

// ---------- heuristic scoring (offline fallback for new items) ----------

const STOP = new Set('the and for with our your from into by of to a an in on at run keep ship close'.split(' '));
const SYNONYMS = [
  [/seed|round|raise|fund/i, ['investor', 'investors', 'vc', 'angel', 'deck', 'pitch', 'term', 'diligence', 'cap table', 'raise', 'round', 'seed', 'partner']],
  [/onboarding|ship|launch|v2/i, ['onboarding', 'signup', 'sign-up', 'activation', 'figma', 'design', 'copy', 'v2', 'funnel', 'bug', 'launch', 'ux']],
  [/marathon|run|race/i, ['run', 'running', 'race', 'miles', 'tempo', 'intervals', 'physio', 'shoes', 'training', 'marathon', 'long run']],
  [/family|sunday|offline/i, ['family', 'kids', 'dinner', 'sunday', 'offline', 'phone', 'phones', 'weekend']],
];

export function goalKeywords(goal) {
  const words = String(goal)
    .toLowerCase()
    .split(/[^a-z0-9$.-]+/)
    .filter((w) => w.length >= 3 && !STOP.has(w) && !/^\$?[\d.]+[mk]?$/.test(w));
  for (const [re, syn] of SYNONYMS) if (re.test(goal)) words.push(...syn);
  return [...new Set(words)];
}

/** Keyword match against goals. Deterministic; used when the AI is offline. */
export function heuristicScore(text, goals) {
  const t = ` ${String(text).toLowerCase()} `;
  let best = { goal_index: null, hits: [] };
  goals.forEach((g, i) => {
    const hits = goalKeywords(g).filter((k) => new RegExp(`(^|[^a-z0-9])${k.replace(/[.$-]/g, '\\$&')}([^a-z0-9]|$)`).test(t));
    if (hits.length > best.hits.length) best = { goal_index: i, hits };
  });
  if (!best.hits.length) return { score: 25, goal_index: null, why: 'No goal keywords matched (offline check)' };
  return {
    score: Math.min(85, 45 + 12 * best.hits.length),
    goal_index: best.goal_index,
    why: `Matches "${best.hits[0]}" (offline keyword check)`,
  };
}

// ---------- Setup parsing ----------

export function hashId(str) {
  let h = 2166136261;
  for (const ch of String(str)) {
    h ^= ch.codePointAt(0);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36);
}

/** Parse pasted tasks: one per line, optional "Title | 30m | due:+2". */
export function parseTaskLines(text, now, goals = []) {
  const out = [];
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const parts = line.split('|').map((p) => p.trim());
    const title = parts[0];
    if (!title) continue;
    let estimate = 30;
    let dueOffset = null;
    for (const p of parts.slice(1)) {
      let m;
      if ((m = /^(\d+)\s*(?:m|min|mins|minutes)?$/i.exec(p))) estimate = Number(m[1]);
      else if ((m = /^(\d+(?:\.\d+)?)\s*h(?:r|rs|ours?)?$/i.exec(p))) estimate = Math.round(Number(m[1]) * 60);
      else if ((m = /^due:\s*([+-]?\d+)$/i.exec(p))) dueOffset = Number(m[1]);
      else if (/^due:\s*today$/i.test(p)) dueOffset = 0;
      else if (/^due:\s*tomorrow$/i.test(p)) dueOffset = 1;
    }
    const h = heuristicScore(title, goals);
    out.push({
      id: `u${hashId(title.toLowerCase())}`,
      kind: 'task',
      title,
      detail: '',
      due: dateKeyFromOffset(now, dueOffset),
      estimate_min: Math.max(1, estimate),
      created_days_ago: 0,
      score: h.score,
      goal_index: h.goal_index,
      why: h.why,
      scored_by: 'heuristic',
      unscored: true,
      source: 'manual',
    });
  }
  return out;
}
