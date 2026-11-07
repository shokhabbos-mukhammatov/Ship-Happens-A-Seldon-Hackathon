// Gmail + Google Calendar + Google Tasks, straight from Google to this browser tab.
// Google Identity Services token client (implicit grant, read-only scopes). The access token lives
// only in this module's memory: never localStorage, never sent to our server.
import { parseRecurring, merchantFrom, splitFrom } from './subscriptions.js';

const GIS_SRC = 'https://accounts.google.com/gsi/client';
export const GOOGLE_SCOPES = [
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/calendar.readonly',
  'https://www.googleapis.com/auth/tasks.readonly',
];
const GMAIL = 'https://gmail.googleapis.com/gmail/v1/users/me';
const CAL = 'https://www.googleapis.com/calendar/v3';
const TASKS = 'https://tasks.googleapis.com/tasks/v1';
const NEEDS_REPLY_Q = 'in:inbox newer_than:14d -category:promotions -category:social -category:forums';
const RECEIPTS_Q = 'newer_than:120d (subject:(receipt OR invoice OR "your subscription" OR renewal OR "payment confirmation"))';
const MAX_PARALLEL = 8;

// ---------- pure helpers (exported for tests) ----------

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'" };
/** Gmail snippets are HTML-escaped ("Don&#39;t"). */
export function decodeEntities(str) {
  return String(str || '').replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    const k = e.toLowerCase();
    if (k[0] === '#') {
      const code = k[1] === 'x' ? parseInt(k.slice(2), 16) : parseInt(k.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[k] ?? m;
  });
}

const header = (msg, name) => {
  const h = (msg?.payload?.headers || []).find((x) => String(x.name).toLowerCase() === name.toLowerCase());
  return h ? String(h.value) : '';
};

/** Display name if there is one, else the address. */
export function displayFrom(from) {
  const { name, email } = splitFrom(from);
  return name || email || String(from || '');
}

export function detailOf(from, snippet) {
  return `${from} — ${snippet}`.slice(0, 300);
}

/**
 * Gmail API message (format=metadata) -> normalized Email.
 * opts.userEmail picks the right signed-in account in the Gmail web link.
 */
export function normalizeGmailMessage(msg, { userEmail = '', withRecurring = false } = {}) {
  const rawFrom = header(msg, 'From');
  const from = displayFrom(rawFrom);
  const subject = decodeEntities(header(msg, 'Subject')).trim() || '(no subject)';
  const snippet = decodeEntities(msg.snippet || '').trim();
  const ms = Number(msg.internalDate);
  const fallback = new Date(header(msg, 'Date'));
  const date = new Date(Number.isFinite(ms) && ms > 0 ? ms : Number.isNaN(fallback.getTime()) ? Date.now() : fallback.getTime()).toISOString();
  const auth = userEmail ? `?authuser=${encodeURIComponent(userEmail)}` : '';
  return {
    id: `gmail-${msg.id}`,
    kind: 'email',
    from,
    subject,
    snippet,
    title: subject,
    detail: detailOf(from, snippet),
    date,
    link: `https://mail.google.com/mail/u/0/${auth}#all/${msg.threadId || msg.id}`,
    recurring: withRecurring ? parseRecurring({ from: rawFrom, subject, snippet }) : null,
    source: 'gmail',
  };
}

/** True when a message looks like it needs a human reply (not a list mail, not from me, not a no-reply). */
export function isReplyCandidate(msg, userEmail = '') {
  if (header(msg, 'List-Unsubscribe')) return false;
  const { email } = splitFrom(header(msg, 'From'));
  if (userEmail && email === String(userEmail).toLowerCase()) return false;
  if (/(?:^|[._-])(?:no-?reply|do-?not-?reply|mailer-daemon)(?:[._-]|@)/i.test(email)) return false;
  return true;
}

/** Keep one email per merchant (the most recent one). */
export function dedupeByMerchant(emails) {
  const best = new Map();
  for (const e of emails) {
    const key = (e.recurring?.name || merchantFrom(e.from) || e.from).trim().toLowerCase();
    const prev = best.get(key);
    if (!prev || e.date > prev.date) best.set(key, e);
  }
  return [...best.values()];
}

/** Local end of the day that contains `now`. */
export function endOfLocalDay(now = new Date()) {
  return new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999);
}

function localDateToIso(ymd) {
  const [y, m, d] = String(ymd).split('-').map(Number);
  return new Date(y, m - 1, d).toISOString();
}

/** Google Calendar event -> normalized Event, or null for declined/cancelled/noise. */
export function normalizeGoogleEvent(ev) {
  if (!ev || ev.status === 'cancelled') return null;
  if (ev.eventType === 'workingLocation') return null;
  const me = (ev.attendees || []).find((a) => a.self);
  if (me && me.responseStatus === 'declined') return null;
  const allDay = Boolean(ev.start?.date && !ev.start?.dateTime);
  const start = allDay ? localDateToIso(ev.start.date) : new Date(ev.start?.dateTime).toISOString();
  const end = allDay
    ? localDateToIso(ev.end?.date || ev.start.date)
    : new Date(ev.end?.dateTime || ev.start?.dateTime).toISOString();
  return { id: `gcal-${ev.id}`, title: ev.summary || '(busy)', start, end, allDay, source: 'gcal' };
}

const daysSince = (iso, now = Date.now()) => {
  const t = new Date(iso).getTime();
  return Number.isFinite(t) ? Math.max(0, Math.floor((now - t) / 86400000)) : 0;
};

/** Google Tasks task -> normalized Task. Google Tasks has no created time, so `updated` stands in. */
export function normalizeGoogleTask(t, listTitle = '', now = Date.now()) {
  const notes = String(t.notes || '').trim();
  return {
    id: `gtasks-${t.id}`,
    kind: 'task',
    title: String(t.title || '').trim(),
    detail: (notes || (listTitle ? `From your "${listTitle}" list` : '')).slice(0, 300),
    due: t.due ? String(t.due).slice(0, 10) : null,
    estimate_min: 30,
    created_days_ago: daysSince(t.updated, now),
    source: 'gtasks',
  };
}

// ---------- browser-only: auth ----------

let gisPromise = null;
/** Loads the Google Identity Services script once. Call early so the click handler is fast. */
export function loadGis() {
  if (globalThis.google?.accounts?.oauth2) return Promise.resolve(globalThis.google);
  if (gisPromise) return gisPromise;
  gisPromise = new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = GIS_SRC;
    s.async = true;
    s.defer = true;
    s.onload = () => (globalThis.google?.accounts?.oauth2 ? resolve(globalThis.google) : reject(new Error('Google sign-in script loaded but is not usable.')));
    s.onerror = () => {
      gisPromise = null;
      reject(new Error('Could not load Google sign-in (accounts.google.com). Check your network or ad blocker.'));
    };
    document.head.appendChild(s);
  });
  return gisPromise;
}

const tokenClients = new Map();
let pendingToken = null; // {resolve, reject} for the one consent popup in flight
function requestToken(google, clientId) {
  return new Promise((resolve, reject) => {
    if (pendingToken) pendingToken.reject({ type: 'superseded' });
    pendingToken = { resolve, reject };
    let client = tokenClients.get(clientId);
    if (!client) {
      const settle = (fn) => (arg) => {
        const p = pendingToken;
        pendingToken = null;
        if (p) p[fn](arg);
      };
      client = google.accounts.oauth2.initTokenClient({
        client_id: clientId,
        scope: GOOGLE_SCOPES.join(' '),
        include_granted_scopes: true,
        callback: settle('resolve'),
        error_callback: settle('reject'),
      });
      tokenClients.set(clientId, client);
    }
    client.requestAccessToken({ prompt: '' });
  }).then(
    (resp) => {
      if (resp?.error) throw friendlyAuthError(resp.error, resp.error_description);
      if (!resp?.access_token) throw new Error('Google did not return an access token. Try again.');
      return resp;
    },
    (err) => {
      throw friendlyAuthError(err?.type || err?.error || 'unknown', err?.message);
    }
  );
}

function friendlyAuthError(code, desc) {
  const c = String(code || '');
  if (c === 'popup_failed_to_open') return new Error('The Google sign-in popup was blocked. Allow popups for this site, then click Connect again.');
  if (c === 'superseded') return new Error('A newer Google sign-in was started.');
  if (c === 'popup_closed') return new Error('The Google sign-in window was closed before finishing. Click Connect to try again.');
  if (c === 'access_denied') return new Error('Google access was denied. If you are not a test user on the Google Cloud project, ask the owner to add you (see docs/CONNECTORS_SETUP.md).');
  if (c === 'invalid_client' || c === 'unauthorized_client') return new Error('Google rejected the client ID. Check GOOGLE_CLIENT_ID and the Authorized JavaScript origins.');
  if (/origin/i.test(desc || '')) return new Error(`Google sign-in failed: this site's origin (${location.origin}) is not an Authorized JavaScript origin for the client ID.`);
  return new Error(`Google sign-in failed (${c}${desc ? `: ${desc}` : ''}).`);
}

// ---------- browser-only: REST ----------

function limiter(max) {
  let active = 0;
  const queue = [];
  const next = () => {
    if (active >= max || queue.length === 0) return;
    active++;
    const { fn, resolve, reject } = queue.shift();
    Promise.resolve()
      .then(fn)
      .then(resolve, reject)
      .finally(() => {
        active--;
        next();
      });
  };
  return (fn) =>
    new Promise((resolve, reject) => {
      queue.push({ fn, resolve, reject });
      next();
    });
}

/** Turns a Google API error response into a message a non-expert can act on. */
export function googleApiError(status, body, apiName) {
  const err = body?.error || {};
  const reasons = [...(err.errors || []).map((e) => e.reason), ...(err.details || []).map((d) => d.reason)].filter(Boolean);
  const msg = String(err.message || '');
  if (status === 401) return new Error('Your Google sign-in expired (tokens last about 1 hour). Click Connect again.');
  if (status === 403 && (reasons.includes('SERVICE_DISABLED') || reasons.includes('accessNotConfigured') || /has not been used|is disabled/i.test(msg))) {
    return new Error(`The ${apiName} is not enabled in your Google Cloud project. Open console.cloud.google.com, APIs & Services, Library, search "${apiName}", click Enable, wait a minute, then reconnect.`);
  }
  if (status === 403 && (reasons.includes('insufficientPermissions') || reasons.includes('ACCESS_TOKEN_SCOPE_INSUFFICIENT') || /insufficient/i.test(msg))) {
    return new Error(`Bouncer was not given read access to ${apiName}. Click Connect again and tick every checkbox on Google's consent screen.`);
  }
  if (status === 429 || reasons.includes('rateLimitExceeded') || reasons.includes('userRateLimitExceeded')) {
    return new Error(`${apiName} is rate limiting us. Wait a minute and reconnect.`);
  }
  return new Error(`${apiName} error ${status}${msg ? `: ${msg}` : ''}`);
}

function makeGet(token, run) {
  return (url, apiName) =>
    run(async () => {
      const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
      if (!r.ok) throw googleApiError(r.status, await r.json().catch(() => null), apiName);
      return r.json();
    });
}

async function listMessages(get, q, maxResults) {
  const url = `${GMAIL}/messages?q=${encodeURIComponent(q)}&maxResults=${maxResults}`;
  const data = await get(url, 'Gmail API');
  return data.messages || [];
}

function getMetadata(get, id) {
  const hs = ['From', 'Subject', 'Date', 'List-Unsubscribe'].map((h) => `metadataHeaders=${h}`).join('&');
  return get(`${GMAIL}/messages/${id}?format=metadata&${hs}`, 'Gmail API');
}

async function fetchGmail(get) {
  const profile = await get(`${GMAIL}/profile`, 'Gmail API');
  const userEmail = String(profile.emailAddress || '').toLowerCase();
  const [inboxRefs, receiptRefs] = await Promise.all([listMessages(get, NEEDS_REPLY_Q, 40), listMessages(get, RECEIPTS_Q, 30)]);
  const [inbox, receipts] = await Promise.all([
    Promise.all(inboxRefs.map((m) => getMetadata(get, m.id))),
    Promise.all(receiptRefs.map((m) => getMetadata(get, m.id))),
  ]);
  const reply = inbox.filter((m) => isReplyCandidate(m, userEmail)).map((m) => normalizeGmailMessage(m, { userEmail }));
  const subs = dedupeByMerchant(
    receipts.map((m) => normalizeGmailMessage(m, { userEmail, withRecurring: true })).filter((e) => e.recurring)
  );
  const seen = new Set(subs.map((e) => e.id));
  return { userEmail, emails: [...reply.filter((e) => !seen.has(e.id)), ...subs] };
}

async function fetchCalendar(get, now) {
  const qs = new URLSearchParams({
    timeMin: now.toISOString(),
    timeMax: endOfLocalDay(now).toISOString(),
    singleEvents: 'true',
    orderBy: 'startTime',
    maxResults: '100',
  });
  const data = await get(`${CAL}/calendars/primary/events?${qs}`, 'Google Calendar API');
  return (data.items || []).map(normalizeGoogleEvent).filter(Boolean);
}

async function fetchTasks(get, now) {
  const lists = await get(`${TASKS}/users/@me/lists?maxResults=100`, 'Google Tasks API');
  const perList = await Promise.all(
    (lists.items || []).map(async (l) => {
      const data = await get(`${TASKS}/lists/${encodeURIComponent(l.id)}/tasks?showCompleted=false&showHidden=false&maxResults=100`, 'Google Tasks API');
      return (data.items || []).filter((t) => t.title && t.title.trim() && t.status !== 'completed').map((t) => normalizeGoogleTask(t, l.title, now.getTime()));
    })
  );
  return perList.flat();
}

/**
 * Opens Google's consent popup (call from a click handler) and returns the normalized workspace:
 * {source:'google', account, emails, events, tasks, warnings}. One failing API becomes a warning;
 * if every API fails, it throws the first error.
 */
export async function connectGoogle({ clientId } = {}) {
  if (!clientId) throw new Error('Google is not set up yet: GOOGLE_CLIENT_ID is missing. See docs/CONNECTORS_SETUP.md.');
  const google = await loadGis();
  const resp = await requestToken(google, clientId);
  const has = (scope) => google.accounts.oauth2.hasGrantedAnyScope(resp, scope);
  const get = makeGet(resp.access_token, limiter(MAX_PARALLEL));
  const now = new Date();
  const skipped = (name) => Promise.reject(new Error(`${name} access was not granted (unticked on the consent screen).`));

  const [gmail, events, tasks] = await Promise.allSettled([
    has(GOOGLE_SCOPES[0]) ? fetchGmail(get) : skipped('Gmail'),
    has(GOOGLE_SCOPES[1]) ? fetchCalendar(get, now) : skipped('Calendar'),
    has(GOOGLE_SCOPES[2]) ? fetchTasks(get, now) : skipped('Google Tasks'),
  ]);
  const results = [gmail, events, tasks];
  if (results.every((r) => r.status === 'rejected')) throw gmail.reason;
  return {
    source: 'google',
    account: gmail.status === 'fulfilled' ? gmail.value.userEmail : null,
    emails: gmail.status === 'fulfilled' ? gmail.value.emails : [],
    events: events.status === 'fulfilled' ? events.value : [],
    tasks: tasks.status === 'fulfilled' ? tasks.value : [],
    warnings: results.filter((r) => r.status === 'rejected').map((r) => String(r.reason?.message || r.reason)),
  };
}
