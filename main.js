// Bouncer UI. All ranking/deciding lives in src/engine.js; this file only renders and records clicks.
import * as E from './src/engine.js';
import { buildDemoWorkspace, toScoreRequest, applyScores, ingest, setWorkspaceHost, loadWorkspace, STATE_VERSION } from './src/workspace.js';

const STORE_KEY = 'bouncer.state';
const $ = (sel) => document.querySelector(sel);
const now = () => new Date();

let state = null;
let aiOnline = null;
let undoAction = null;
let toastTimer = null;
let lastFocus = null;

// ---------- persistence ----------

function loadSaved() {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (!raw) return null;
    const s = JSON.parse(raw);
    return s && s.version === STATE_VERSION && Array.isArray(s.items) ? s : null;
  } catch {
    return null;
  }
}

function save() {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(state));
  } catch {
    /* private mode or storage blocked: the app still works for this session */
  }
}

async function freshDemo() {
  const r = await fetch('data/demo.json', { cache: 'no-store' });
  if (!r.ok) throw new Error(`Could not load demo data (${r.status})`);
  return buildDemoWorkspace(await r.json(), now());
}

// ---------- helpers ----------

function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'text') el.textContent = v;
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

const money = (n) => `$${Number(n).toFixed(2)}`;
const per = (period) => E.periodKey(period); // 'mo' | 'yr' | 'wk'
const SOURCE_LABELS = { demo: 'Demo', gmail: 'Gmail', google: 'Gmail', outlook: 'Outlook', microsoft: 'Outlook', calendar: 'Calendar', gcal: 'Calendar', 'google-calendar': 'Calendar', ics: 'Calendar', todoist: 'Todoist', gtasks: 'Google Tasks', mstodo: 'To Do', manual: 'You', setup: 'You' };
function sourceLabel(src) {
  const key = String(src || '').toLowerCase();
  if (SOURCE_LABELS[key]) return SOURCE_LABELS[key];
  if (!key) return 'Unknown';
  return key.charAt(0).toUpperCase() + key.slice(1);
}
const sourceBadge = (src) => h('span', { class: `source-badge src-${String(src || 'unknown').toLowerCase().replace(/[^a-z0-9-]/g, '')}`, 'data-testid': 'source-badge', text: sourceLabel(src) });
const lastUsedText = (d) => (d === null || d === undefined ? 'last used: unknown' : `last used ${d} day${d === 1 ? '' : 's'} ago`);
const itemById = (id) => state.items.find((it) => it.id === id);
const doneIds = () => Object.keys(state.done || {});
const droppedIds = () => Object.keys(state.dropped || {});
const ctx = (extra = {}) => ({
  now: now(),
  events: state.events,
  stopAt: state.stopAt,
  energy: state.energy,
  goals: state.goals,
  ...extra,
});
const senderName = (from) => String(from || '').replace(/\s*<.*>\s*$/, '') || from;

function urgencyLabel(item) {
  const d = E.daysUntil(item.due, now());
  if (d === null) return null;
  if (d < 0) return `overdue (+${E.URGENCY.overdue})`;
  if (d === 0) return `due today (+${E.URGENCY.today})`;
  if (d <= 3) return `due in ${d} day${d === 1 ? '' : 's'} (+${E.URGENCY.soon})`;
  return `due in ${d} days`;
}

// ---------- toast & undo ----------

function showToast(message, undo) {
  undoAction = undo || null;
  $('#toast-msg').textContent = message;
  $('#toast-undo').hidden = !undo;
  $('#toast').hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(hideToast, 8000);
}

function hideToast() {
  $('#toast').hidden = true;
  undoAction = null;
}

function runUndo() {
  const fn = undoAction;
  hideToast();
  if (fn) {
    fn();
    save();
    render();
  }
}

// ---------- tabs ----------

function setTab(name) {
  document.querySelectorAll('[role="tab"]').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === name)));
  document.querySelectorAll('.view').forEach((v) => (v.hidden = v.id !== `view-${name}`));
  render();
}

// ---------- render: Now ----------

function renderGoals() {
  const ol = $('#goals-list');
  ol.replaceChildren(
    ...state.goals.map((g, i) => h('li', { 'data-goal-index': i }, h('span', { class: 'goal-num', text: String(i + 1) }), h('span', { text: g }))),
  );
}

function renderTomorrow(n) {
  const tmr = new Date(n.getFullYear(), n.getMonth(), n.getDate() + 1, 9, 0, 0);
  const key = E.localDateKey(tmr);
  if (!state.tomorrow || state.tomorrow.date !== key) {
    const ranked = E.rankCandidates(state.items, { now: tmr, energy: 'high', exclude: [...doneIds(), ...droppedIds()] }).slice(0, 3);
    state.tomorrow = { date: key, ids: ranked.map((c) => c.item.id) };
    save();
  }
  $('#tomorrow-list').replaceChildren(
    ...state.tomorrow.ids
      .map(itemById)
      .filter(Boolean)
      .map((it) => {
        const goal = Number.isInteger(it.goal_index) ? state.goals[it.goal_index] : null;
        return h('li', {}, it.title, goal ? h('span', { class: 'pill', text: goal.split(' ').slice(0, 3).join(' ') }) : null);
      }),
  );
}

function pickCard(p, index) {
  const it = itemById(p.id);
  const isDone = !!state.done[p.id];
  const kindLabel = it.kind === 'email' ? `Reply to ${senderName(it.from)}` : 'Task';
  const fits = p.fitsBefore
    ? p.fitsBefore.kind === 'event'
      ? `fits before ${p.fitsBefore.name} at ${E.formatHHMM(new Date(p.fitsBefore.at))}`
      : `fits before stop-work at ${E.formatHHMM(new Date(p.fitsBefore.at))}`
    : '';
  const urg = urgencyLabel(it);
  return h(
    'article',
    { class: `pick${isDone ? ' done' : ''}`, 'data-testid': 'pick-card', 'data-item-id': p.id },
    h(
      'div',
      { class: 'pick-top' },
      h('div', {}, h('div', { class: 'pick-rank' }, `Pick ${index + 1} · ${kindLabel} `, sourceBadge(it.source)), h('h3', { class: 'pick-title', 'data-testid': 'pick-title', text: p.title })),
      h('div', { class: 'score', style: `--s:${Number(p.score) || 0}`, title: 'AI goal score (0-100)' }, String(p.score), h('small', { text: 'score' })),
    ),
    h('p', { class: `pick-goal${p.goal ? '' : ' none'}`, 'data-testid': 'pick-goal', text: p.goal || 'No goal: picked for urgency only' }),
    h('p', { class: 'pick-why', 'data-testid': 'pick-why', text: p.why ? `Why: ${p.why}` : 'Why: highest priority that fits' }),
    h(
      'div',
      { class: 'pick-meta' },
      h('span', { class: 'tag', text: `${p.estimate_min} min` }),
      h('span', { 'data-testid': 'pick-fits', text: fits }),
      urg ? h('span', { text: urg }) : null,
      h('span', { text: `priority ${p.priority}` }),
    ),
    h(
      'div',
      { class: 'pick-actions' },
      isDone
        ? h('button', { type: 'button', class: 'btn-skip', 'data-action': 'reopen', 'data-id': p.id, 'data-testid': 'btn-reopen', text: 'Reopen' })
        : [
            h('button', { type: 'button', class: 'btn-done', 'data-action': 'done', 'data-id': p.id, 'data-testid': 'btn-done', text: 'Done' }),
            h('button', { type: 'button', class: 'btn-skip', 'data-action': 'skip', 'data-id': p.id, 'data-testid': 'btn-skip', text: 'Skip' }),
          ],
    ),
  );
}

function renderNow() {
  renderGoals();
  const n = now();
  const past = E.isPastStop(n, state.stopAt);
  $('#lastcall-banner').hidden = !past;
  $('#now-controls').hidden = past;
  if (past) {
    renderTomorrow(n);
    return;
  }

  const free = E.minutesFree(state.events, n, state.stopAt);
  const ev = E.nextEvent(state.events, n);
  const fl = $('#free-line');
  fl.replaceChildren(
    ev
      ? h('span', {}, h('strong', { text: `${free} min free` }), ` before ${ev.title} at ${E.formatHHMM(new Date(ev.startMs))}. `, `Stop work at ${state.stopAt}.`)
      : h('span', {}, h('strong', { text: `${free} min free` }), ` until stop-work at ${state.stopAt}.`),
  );

  document.querySelectorAll('[data-energy]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.energy === state.energy)));

  const picksEl = $('#picks');
  const empty = $('#picks-empty');
  const pace = $('#pace-status');
  if (!Array.isArray(state.picks)) {
    picksEl.replaceChildren();
    empty.hidden = false;
    pace.hidden = true;
    return;
  }
  const picks = E.explainIds(state.items, state.picks, ctx());
  picksEl.replaceChildren(...picks.map(pickCard));
  if (!picks.length) {
    empty.hidden = false;
    empty.textContent = `Nothing on the list fits in ${free} minutes. Take the breather.`;
  } else {
    empty.hidden = true;
  }
  const doneCount = picks.filter((p) => state.done[p.id]).length;
  pace.hidden = doneCount < 1;
  pace.textContent = doneCount >= picks.length && picks.length ? `${doneCount} of ${picks.length} done. That's the night. Ask again for more.` : `${doneCount} of ${picks.length} done`;
}

// ---------- render: Inbox ----------

function renderInbox() {
  const emails = state.items.filter((it) => it.kind === 'email' && !state.dropped[it.id]);
  const bounced = [];
  const allowed = [];
  for (const e of emails) {
    const q = E.quarantineInfo(e);
    if (q) bounced.push({ e, q });
    else allowed.push(e);
  }
  allowed.sort((a, b) => b.score - a.score || String(a.id).localeCompare(String(b.id), 'en', { numeric: true }));

  const badge = $('#door-badge');
  badge.textContent = `${bounced.length} bounced at the door`;
  badge.classList.toggle('zero', bounced.length === 0);

  $('#quarantine-wrap').hidden = bounced.length === 0;
  $('#quarantine-list').replaceChildren(
    ...bounced.map(({ e, q }) =>
      h(
        'li',
        { class: 'q-item', 'data-testid': 'quarantine-item', 'data-item-id': e.id },
        h('div', { class: 'q-from' }, sourceBadge(e.source), ' ', e.from || ''),
        h('div', { class: 'q-subject', text: e.subject || e.title }),
        h('blockquote', { class: 'q-quote', 'data-testid': 'quarantine-quote', text: `"${q.quote || e.detail}"` }),
        h('p', { class: 'q-label', text: 'Not on the list: this email tried to give your assistant orders. Bouncer never follows instructions from emails.' }),
        h('div', { class: 'q-locks', text: `Flagged by: ${[q.llm ? 'AI score' : null, q.regex ? 'pattern check' : null].filter(Boolean).join(' + ')}. Quarantined items are never ranked and offer no actions.` }),
      ),
    ),
  );

  $('#inbox-list').replaceChildren(
    ...allowed.map((e) => {
      const goal = Number.isInteger(e.goal_index) ? state.goals[e.goal_index] : null;
      return h(
        'li',
        { class: `mail${e.score < 20 ? ' low' : ''}`, 'data-testid': 'inbox-item', 'data-item-id': e.id },
        h('div', { class: 'score', style: `--s:${Number(e.score) || 0}`, title: 'AI goal score (0-100)' }, String(e.score), h('small', { text: 'score' })),
        h(
          'div',
          {},
          h('div', { class: 'mail-from' }, sourceBadge(e.source), ' ', e.from || ''),
          h(
            'div',
            { class: 'mail-subject' },
            e.link ? h('a', { href: e.link, target: '_blank', rel: 'noopener noreferrer', text: e.subject || e.title }) : e.subject || e.title,
            e.recurring ? h('span', { class: 'pill', text: `${money(e.recurring.amount)}/${per(e.recurring.period)}` }) : null,
          ),
          h('p', { class: 'mail-snippet', text: e.detail || '' }),
          h('p', { class: 'mail-why' }, goal ? h('span', { class: 'goal-tag', text: `Moves: ${goal}. ` }) : 'No goal. ', e.why || ''),
        ),
      );
    }),
  );
}

// ---------- render: Last Call ----------

function renderLastCall() {
  const lc = E.lastCall(state.items, { exclude: [...droppedIds(), ...doneIds()], goals: state.goals });
  $('#subs-total').replaceChildren(
    `You'd save ${money(lc.monthlyTotal)}/month`,
    h('small', { text: `${money(lc.monthlyTotal * 12)} a year across ${lc.subs.length} subscription${lc.subs.length === 1 ? '' : 's'}. Bouncer drafts; you cancel.` }),
  );

  $('#subs-list').replaceChildren(
    ...lc.subs.map((s) =>
      h(
        'li',
        { class: 'row', 'data-testid': 'sub-item', 'data-item-id': s.id, 'data-sub-name': s.name },
        h(
          'div',
          { class: 'row-main' },
          h('div', { class: 'row-title' }, s.name, ' ', sourceBadge(s.source)),
          h(
            'div',
            { class: 'row-meta' },
            h('span', { class: s.fit < E.SUB_FIT_MIN ? 'bad' : '', text: `Goal fit ${s.fit}/100` }),
            ' · ',
            h('span', { class: s.last_used_days_ago !== null && s.last_used_days_ago > E.SUB_IDLE_DAYS ? 'bad' : '', text: lastUsedText(s.last_used_days_ago) }),
          ),
          s.why ? h('div', { class: 'row-meta', text: s.why }) : null,
        ),
        h(
          'div',
          { class: 'row-actions' },
          h('div', { class: 'row-amount' }, `${money(s.amount)}/${per(s.period)}`, h('small', { text: per(s.period) === 'mo' ? 'monthly' : `${money(s.monthly)}/mo` })),
          h('button', { type: 'button', class: 'btn-draft', 'data-action': 'draft', 'data-id': s.id, 'data-testid': 'btn-draft-cancel', text: 'Draft cancellation' }),
        ),
      ),
    ),
  );
  if (!lc.subs.length) $('#subs-list').append(h('li', { class: 'empty', text: 'Every subscription is earning its spot.' }));

  $('#keep-wrap').hidden = lc.keep.length === 0;
  $('#keep-list').replaceChildren(
    ...lc.keep.map((s) =>
      h(
        'li',
        { class: 'row', 'data-testid': 'keep-item', 'data-item-id': s.id },
        h(
          'div',
          { class: 'row-main' },
          h('div', { class: 'row-title' }, s.name, ' ', sourceBadge(s.source)),
          h('div', { class: 'row-meta' }, h('span', { class: 'good', text: `Goal fit ${s.fit}/100` }), ` · ${lastUsedText(s.last_used_days_ago)} · ${s.goal ? `moves: ${s.goal}` : s.why}`),
        ),
        h('div', { class: 'row-amount' }, `${money(s.amount)}/${per(s.period)}`),
      ),
    ),
  );

  $('#drop-list').replaceChildren(
    ...lc.drops.map((t) =>
      h(
        'li',
        { class: 'row', 'data-testid': 'drop-item', 'data-item-id': t.id },
        h(
          'div',
          { class: 'row-main' },
          h('div', { class: 'row-title' }, t.title, ' ', sourceBadge(t.source)),
          h('div', { class: 'row-meta' }, h('span', { class: 'bad', text: `Score ${t.score}` }), ` · sitting for ${t.created_days_ago} days · ${t.why || 'moves no goal'}`),
        ),
        h('div', { class: 'row-actions' }, h('button', { type: 'button', class: 'btn-drop', 'data-action': 'drop', 'data-id': t.id, 'data-testid': 'btn-drop', text: 'Drop' })),
      ),
    ),
  );
  if (!lc.drops.length) $('#drop-list').append(h('li', { class: 'empty', text: 'Nothing stale. The list is tight.' }));
}

// ---------- render: Setup ----------

function renderAiStatus() {
  const pill = $('#ai-pill');
  const st = $('#ai-status');
  const scored = state.scoredBy === 'claude' ? 'Current scores come from Claude.' : 'Current scores are the cached demo scores.';
  if (aiOnline === null) {
    pill.textContent = 'checking AI...';
    st.textContent = 'Checking AI status...';
    return;
  }
  pill.className = `ai-pill ${aiOnline ? 'on' : 'off'}`;
  st.className = `ai-status ${aiOnline ? 'on' : 'off'}`;
  pill.textContent = aiOnline ? 'AI: Claude on' : 'AI offline';
  st.textContent = aiOnline
    ? `AI status: online (Claude Haiku scores, code decides). ${scored}`
    : `AI status: offline, using cached scores. New tasks are scored by an offline keyword check. ${scored}`;
}

function renderSetup() {
  const gi = $('#goals-input');
  if (document.activeElement !== gi) gi.value = state.goals.join('\n');
  const si = $('#stop-time-input');
  if (document.activeElement !== si) si.value = state.stopAt;
  renderAiStatus();
}

function render() {
  renderNow();
  renderInbox();
  renderLastCall();
  renderSetup();
}

// ---------- actions ----------

function whatNow() {
  const res = E.pickTop3(state.items, ctx({ exclude: [...doneIds(), ...droppedIds()] }));
  state.picks = res.picks.map((p) => p.id);
  state.skipped = [];
  save();
  renderNow();
}

function markDone(id) {
  const it = itemById(id);
  state.done[id] = true;
  showToast(`Done: ${it?.title || id}`, () => delete state.done[id]);
}

function reopen(id) {
  const it = itemById(id);
  delete state.done[id];
  showToast(`Reopened: ${it?.title || id}`, () => (state.done[id] = true));
}

function skip(id) {
  const slot = state.picks.indexOf(id);
  if (slot === -1) return;
  const prevPicks = [...state.picks];
  const prevSkipped = [...state.skipped];
  state.skipped = [...state.skipped, id];
  const res = E.replacePick(state.items, state.picks, slot, ctx({ exclude: [...state.skipped, ...doneIds(), ...droppedIds()] }));
  state.picks = res.ids;
  const it = itemById(id);
  const msg = res.replacement ? `Skipped "${it?.title}". Next up: ${res.replacement.title}` : `Skipped "${it?.title}". Nothing else fits right now.`;
  showToast(msg, () => {
    state.picks = prevPicks;
    state.skipped = prevSkipped;
  });
}

function drop(id) {
  const it = itemById(id);
  state.dropped[id] = true;
  showToast(`Dropped: ${it?.title || id}`, () => delete state.dropped[id]);
}

function setEnergy(level) {
  if (state.energy === level) return;
  state.energy = level;
  if (Array.isArray(state.picks)) whatNow();
  save();
  renderNow();
}

function cancellationDraft(sub) {
  const period = { yr: 'year', wk: 'week' }[per(sub.period)] || 'month';
  const why = [];
  if (sub.fit < E.SUB_FIT_MIN) why.push('it no longer supports the goals I am focusing on');
  if (sub.last_used_days_ago !== null && sub.last_used_days_ago > E.SUB_IDLE_DAYS) why.push(`I have not used it in ${sub.last_used_days_ago} days`);
  if (/muse/i.test(sub.name)) why.push('I have moved goal planning to a tool that does not need access to my inbox');
  return [
    `Subject: Please cancel my ${sub.name} subscription`,
    '',
    `Hi ${sub.name} team,`,
    '',
    `Please cancel my ${sub.name} subscription (${money(sub.amount)} per ${period}) and turn off automatic renewal, effective at the end of the current billing period.`,
    '',
    why.length ? `I'm cancelling because ${why.join(', and ')}.` : "It's no longer a fit for me right now.",
    '',
    "Please confirm the cancellation in writing, including the date my access ends and that I won't be charged again. No retention offer needed, but thank you for the service.",
    '',
    'Account email: [your account email]',
    '',
    'Thank you,',
    '[Your name]',
  ].join('\n');
}

function openDraft(id) {
  const lc = E.lastCall(state.items, { exclude: [...droppedIds(), ...doneIds()], goals: state.goals });
  const sub = lc.subs.find((s) => s.id === id) || lc.keep.find((s) => s.id === id);
  if (!sub) return;
  lastFocus = document.activeElement;
  $('#draft-title').textContent = `Cancel ${sub.name}`;
  $('#draft-text').value = cancellationDraft(sub);
  $('#copy-msg').textContent = '';
  $('#draft-modal').hidden = false;
  $('#btn-copy-draft').focus();
}

function closeDraft() {
  $('#draft-modal').hidden = true;
  if (lastFocus && lastFocus.focus) lastFocus.focus();
}

async function copyDraft() {
  const ta = $('#draft-text');
  const msg = $('#copy-msg');
  try {
    await navigator.clipboard.writeText(ta.value);
    msg.textContent = 'Copied. Paste it into your email.';
  } catch {
    try {
      ta.removeAttribute('readonly');
      ta.select();
      const ok = document.execCommand('copy');
      ta.setAttribute('readonly', '');
      msg.textContent = ok ? 'Copied. Paste it into your email.' : 'Select the text and copy it manually.';
    } catch {
      msg.textContent = 'Select the text and copy it manually.';
    }
  }
}

function setupMsg(text) {
  $('#setup-msg').textContent = text;
}

/** Read the Setup form into state. Returns number of tasks added. */
function applySetupForm() {
  const goals = $('#goals-input')
    .value.split(/\r?\n/)
    .map((g) => g.trim())
    .filter(Boolean)
    .slice(0, 8);
  if (goals.length) state.goals = goals;
  const parsed = E.parseTaskLines($('#tasks-input').value, now(), state.goals);
  const existing = new Set(state.items.map((it) => it.id));
  const fresh = parsed.filter((t) => !existing.has(t.id));
  state.items = [...fresh, ...state.items];
  $('#tasks-input').value = '';
  const st = $('#stop-time-input').value;
  if (E.parseHHMM(st) !== null) state.stopAt = st;
  save();
  return fresh.length;
}

function saveSetup() {
  const before = JSON.parse(JSON.stringify(state));
  const added = applySetupForm();
  render();
  setupMsg(`Saved. ${added ? `${added} task${added === 1 ? '' : 's'} added (scored by offline keyword check; press Rescore for Claude).` : 'Goals and stop time updated.'}`);
  showToast('Setup saved', () => (state = before));
}

/** Ask Claude to score every item. auto=true is the connector path (no form read, no undo toast). */
async function rescore({ auto = false } = {}) {
  const btn = $('#btn-rescore');
  const before = JSON.parse(JSON.stringify(state));
  if (!auto) applySetupForm();
  btn.disabled = true;
  btn.textContent = 'Rescoring...';
  setupMsg('Asking Claude to score every item against your goals...');
  try {
    // Small batches in parallel: one 36-item call takes ~8 s, a 15-item call ~3 s.
    const { goals, items } = toScoreRequest(state);
    const BATCH = 15;
    const batches = [];
    for (let i = 0; i < items.length; i += BATCH) batches.push(items.slice(i, i + BATCH));
    const scoreBatch = async (batch) => {
      const controller = new AbortController();
      const t = setTimeout(() => controller.abort(), 25000);
      try {
        const r = await fetch('api/score', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ goals, items: batch }),
          signal: controller.signal,
        });
        const data = await r.json().catch(() => ({}));
        if (!r.ok || !Array.isArray(data.scores)) throw new Error(data.error || `HTTP ${r.status}`);
        return data.scores;
      } finally {
        clearTimeout(t);
      }
    };
    const results = await Promise.allSettled(batches.map(scoreBatch));
    const scores = results.filter((x) => x.status === 'fulfilled').flatMap((x) => x.value);
    if (!scores.length) throw new Error('No batch scored');
    const failed = results.filter((x) => x.status === 'rejected').length;
    const res = applyScores(state.items, scores);
    state.items = res.items;
    state.scoredBy = 'claude';
    state.tomorrow = null;
    aiOnline = true;
    save();
    render();
    setupMsg(`Rescored ${res.applied} items with Claude${failed ? ` (${failed} of ${batches.length} batches failed; those keep offline scores)` : ''}. The code re-ranked them.`);
    if (!auto) showToast('Rescored with Claude', () => (state = before));
    return true;
  } catch {
    aiOnline = false;
    save();
    render();
    setupMsg('AI offline, using cached scores.');
    return false;
  } finally {
    btn.disabled = false;
    btn.textContent = 'Rescore with Claude';
  }
}

async function resetDemo() {
  const before = JSON.parse(JSON.stringify(state));
  try {
    state = await freshDemo();
  } catch (err) {
    setupMsg(String(err.message || err));
    return;
  }
  save();
  render();
  setupMsg('Demo workspace restored.');
  showToast('Demo reset', () => (state = before));
}

/** Connector entry point behind loadWorkspace(ws, {merge}) in src/workspace.js. */
async function hostLoad(ws, { merge = false } = {}) {
  const before = JSON.parse(JSON.stringify(state));
  state = ingest(state, ws, { merge, keepScores: false });
  save();
  render();
  const n = (ws?.emails?.length || 0) + (ws?.tasks?.length || 0);
  const ev = ws?.events?.length || 0;
  const parts = [];
  if (n || !ev) parts.push(`${n} item${n === 1 ? '' : 's'}`);
  if (ev) parts.push(`${ev} event${ev === 1 ? '' : 's'}`);
  showToast(`Loaded ${parts.join(' and ')} from ${sourceLabel(ws?.source)}`, () => (state = before));
  const rescored = await rescore({ auto: true });
  return { items: state.items.length, events: state.events.length, rescored };
}

async function checkHealth() {
  try {
    const r = await fetch('api/health', { cache: 'no-store' });
    const data = await r.json();
    aiOnline = !!data.ai;
  } catch {
    aiOnline = false;
  }
  renderAiStatus();
}

// ---------- wiring ----------

function wire() {
  document.addEventListener('click', (ev) => {
    const tab = ev.target.closest('[role="tab"]');
    if (tab) return setTab(tab.dataset.tab);
    const energy = ev.target.closest('[data-energy]');
    if (energy) return setEnergy(energy.dataset.energy);
    const act = ev.target.closest('[data-action]');
    if (act) {
      const id = act.dataset.id;
      const fn = { done: markDone, skip, reopen, drop, draft: openDraft }[act.dataset.action];
      if (fn) {
        fn(id);
        if (act.dataset.action !== 'draft') {
          save();
          render();
        }
      }
      return;
    }
    if (ev.target === $('#draft-modal')) closeDraft();
  });
  $('#btn-what-now').addEventListener('click', whatNow);
  $('#toast-undo').addEventListener('click', runUndo);
  $('#btn-close-draft').addEventListener('click', closeDraft);
  $('#btn-copy-draft').addEventListener('click', copyDraft);
  $('#btn-save-setup').addEventListener('click', saveSetup);
  $('#btn-rescore').addEventListener('click', rescore);
  $('#btn-reset-demo').addEventListener('click', resetDemo);
  const stop = $('#stop-time-input');
  const onStop = () => {
    if (E.parseHHMM(stop.value) === null) return;
    state.stopAt = stop.value;
    save();
    renderNow();
  };
  stop.addEventListener('input', onStop);
  stop.addEventListener('change', onStop);
  $('#goals-input').addEventListener('change', () => {
    const goals = $('#goals-input').value.split(/\r?\n/).map((g) => g.trim()).filter(Boolean).slice(0, 8);
    if (goals.length) {
      state.goals = goals;
      save();
      renderNow();
    }
  });
  document.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape' && !$('#draft-modal').hidden) closeDraft();
  });
  // Keep "minutes free" and the stop-time banner honest while the page sits open.
  setInterval(() => {
    if (!$('#view-now').hidden) renderNow();
  }, 30000);
}

async function init() {
  wire();
  const params = new URLSearchParams(location.search);
  const forceDemo = params.get('demo') === '1';
  state = forceDemo ? null : loadSaved();
  if (!state) {
    try {
      state = await freshDemo();
    } catch (err) {
      document.querySelector('main').prepend(h('p', { class: 'banner', text: `Could not load the demo workspace: ${err.message}` }));
      return;
    }
    save();
  }
  render();
  setWorkspaceHost({ load: hostLoad });
  window.bouncer = Object.freeze({ loadWorkspace });
  document.body.dataset.ready = 'true';
  checkHealth();
}

init();
