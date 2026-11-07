// Outlook / Microsoft 365 mail + calendar (+ Microsoft To Do), straight from Microsoft Graph to this tab.
// MSAL.js for single-page apps, pinned. Tokens live in MSAL's in-memory cache only
// (cacheLocation 'memoryStorage'), so a page reload means signing in again. Read-only scopes.
import { parseRecurring, merchantFrom } from './subscriptions.js';

// Pinned: @azure/msal-browser 5.26.0 was published 2026-10-21. jsDelivr's +esm build bundles
// its one dependency (@azure/msal-common 16.14.3).
export const MSAL_VERSION = '5.26.0';
const MSAL_URL = `https://cdn.jsdelivr.net/npm/@azure/msal-browser@${MSAL_VERSION}/+esm`;
const MSAL_BRIDGE_URL = `https://cdn.jsdelivr.net/npm/@azure/msal-browser@${MSAL_VERSION}/redirect-bridge/+esm`;
export const MS_SCOPES = ['User.Read', 'Mail.Read', 'Calendars.Read', 'Tasks.Read'];
const GRAPH = 'https://graph.microsoft.com/v1.0';
const DAY = 86400000;

// ---------- pure helpers (exported for tests) ----------

const fromOf = (m) => {
  const ea = m?.from?.emailAddress || m?.sender?.emailAddress || {};
  return { name: String(ea.name || '').trim(), address: String(ea.address || '').trim().toLowerCase() };
};

/** Graph message -> normalized Email. */
export function normalizeGraphMessage(m, { withRecurring = false } = {}) {
  const f = fromOf(m);
  const from = f.name || f.address;
  const subject = String(m.subject || '').trim() || '(no subject)';
  const snippet = String(m.bodyPreview || '').replace(/\s+/g, ' ').trim();
  const t = new Date(m.receivedDateTime);
  const rawFrom = f.address ? `${f.name} <${f.address}>` : f.name;
  return {
    id: `outlook-${m.id}`,
    kind: 'email',
    from,
    subject,
    snippet,
    title: subject,
    detail: `${from} — ${snippet}`.slice(0, 300),
    date: (Number.isNaN(t.getTime()) ? new Date() : t).toISOString(),
    link: m.webLink || `https://outlook.office.com/mail/inbox/id/${encodeURIComponent(m.id)}`,
    recurring: withRecurring ? parseRecurring({ from: rawFrom, subject, snippet }) : null,
    source: 'outlook',
  };
}

/** "Prefer focused": drop Focused Inbox "Other", mail from me and no-reply senders. */
export function isGraphReplyCandidate(m, myAddresses = []) {
  if (m.inferenceClassification === 'other') return false;
  const { address } = fromOf(m);
  if (address && myAddresses.includes(address)) return false;
  if (/(?:^|[._-])(?:no-?reply|do-?not-?reply|mailer-daemon)(?:[._-]|@)/i.test(address)) return false;
  return true;
}

/**
 * Graph {dateTime, timeZone} -> ISO. With `Prefer: outlook.timezone` the dateTime is wall time in the
 * browser's zone (no offset, 7 fractional digits); if Graph fell back to UTC, it says so in timeZone.
 */
export function graphDateTimeToIso(dt) {
  if (!dt?.dateTime) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?/.exec(dt.dateTime);
  if (!m) return null;
  const [y, mo, d, h, mi, s = '0', frac = '0'] = m.slice(1);
  const ms = Number(frac.padEnd(3, '0').slice(0, 3));
  const tz = String(dt.timeZone || '');
  const isUtc = /^(?:utc|etc\/utc|gmt|z|coordinated universal time)$/i.test(tz) || /[zZ]$/.test(dt.dateTime);
  const t = isUtc ? Date.UTC(+y, +mo - 1, +d, +h, +mi, +s, ms) : new Date(+y, +mo - 1, +d, +h, +mi, +s, ms).getTime();
  return new Date(t).toISOString();
}

/** Graph calendarView event -> normalized Event, or null for declined/cancelled. */
export function normalizeGraphEvent(ev) {
  if (!ev || ev.isCancelled) return null;
  if (ev.responseStatus?.response === 'declined') return null;
  const start = graphDateTimeToIso(ev.start);
  const end = graphDateTimeToIso(ev.end) || start;
  if (!start) return null;
  return { id: `outlook-ev-${ev.id}`, title: ev.subject || '(busy)', start, end, allDay: Boolean(ev.isAllDay), source: 'outlook' };
}

/** Microsoft To Do task -> normalized Task. */
export function normalizeTodoTask(t, listName = '', now = Date.now()) {
  const due = t.dueDateTime?.dateTime ? String(t.dueDateTime.dateTime).slice(0, 10) : null;
  const created = new Date(t.createdDateTime).getTime();
  const body = String(t.body?.content || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  return {
    id: `mstodo-${t.id}`,
    kind: 'task',
    title: String(t.title || '').trim(),
    detail: (body || (listName ? `From your "${listName}" list` : '')).slice(0, 300),
    due,
    estimate_min: 30,
    created_days_ago: Number.isFinite(created) ? Math.max(0, Math.floor((now - created) / DAY)) : 0,
    source: 'mstodo',
  };
}

function dedupeByMerchant(emails) {
  const best = new Map();
  for (const e of emails) {
    const key = (e.recurring?.name || merchantFrom(e.from) || e.from).trim().toLowerCase();
    const prev = best.get(key);
    if (!prev || e.date > prev.date) best.set(key, e);
  }
  return [...best.values()];
}

// ---------- browser-only: MSAL ----------

/**
 * MSAL v5 popups finish on a "redirect bridge": the popup lands back on our origin and must post the
 * auth response to the opener over BroadcastChannel (Entra sends COOP headers, so the opener cannot
 * read the popup). index.js calls this at startup; it is a no-op unless this window is that popup.
 */
export function looksLikeMsalPopupResponse(loc = globalThis.location) {
  const raw = `${loc?.hash || ''}&${loc?.search || ''}`.replace(/^[#?]/, '');
  const p = new URLSearchParams(raw.replace(/[#?]/g, '&'));
  return p.has('state') && (p.has('code') || p.has('error')) && /client_info|session_state|error_description|code=/.test(raw);
}

export async function handleMsalRedirectBridge() {
  if (typeof window === 'undefined' || !looksLikeMsalPopupResponse(window.location)) return false;
  try {
    const { broadcastResponseToMainFrame } = await import(MSAL_BRIDGE_URL);
    await broadcastResponseToMainFrame();
    return true;
  } catch (err) {
    console.warn('Microsoft sign-in bridge failed', err?.errorCode || err?.message || err);
    return false;
  }
}

let msalPromise = null;
let pca = null;
let pcaClientId = null;

/** Loads MSAL from the CDN once. Call early so the Connect click opens the popup immediately. */
export function loadMsal() {
  if (!msalPromise) {
    msalPromise = import(MSAL_URL).catch((err) => {
      msalPromise = null;
      throw new Error(`Could not load Microsoft sign-in (MSAL) from cdn.jsdelivr.net: ${err?.message || err}`);
    });
  }
  return msalPromise;
}

async function getClient(clientId) {
  const msal = await loadMsal();
  if (pca && pcaClientId === clientId) return { msal, pca };
  pca = await msal.createStandardPublicClientApplication({
    auth: {
      clientId,
      authority: 'https://login.microsoftonline.com/common',
      redirectUri: window.location.origin,
      postLogoutRedirectUri: window.location.origin,
    },
    cache: { cacheLocation: 'memoryStorage' },
  });
  pcaClientId = clientId;
  return { msal, pca };
}

function friendlyMsalError(err) {
  const code = String(err?.errorCode || err?.code || '');
  const msg = String(err?.errorMessage || err?.message || err || '');
  if (code === 'popup_window_error' || code === 'empty_window_error' || /popup.*block/i.test(msg)) {
    return new Error('The Microsoft sign-in popup was blocked. Allow popups for this site, then click Connect again.');
  }
  if (code === 'user_cancelled') return new Error('The Microsoft sign-in window was closed before finishing. Click Connect to try again.');
  if (code === 'interaction_in_progress') return new Error('A Microsoft sign-in window is already open. Finish or close it first.');
  if (code === 'timed_out' || /bridge/i.test(code)) {
    // MSAL v5 cannot see the popup close (COOP), so a closed window surfaces as a 60 s timeout.
    return new Error('Microsoft sign-in did not finish (the window was closed, or it could not report back). Click Connect Outlook to try again.');
  }
  if (/AADSTS65001|AADSTS90094|consent_required|admin/i.test(msg + code)) {
    return new Error('Your Microsoft organization needs an admin to approve Bouncer (Mail.Read, Calendars.Read). Try a personal Outlook.com account, or ask IT.');
  }
  if (/AADSTS50011|redirect_uri/i.test(msg)) {
    return new Error(`Microsoft sign-in failed: ${window.location.origin} is not a Single-page application redirect URI on the app registration.`);
  }
  if (/AADSTS700016|AADSTS900144|invalid_client|unauthorized_client/i.test(msg)) {
    return new Error('Microsoft rejected the client ID. Check MS_CLIENT_ID and that the app allows personal and work accounts.');
  }
  if (code === 'access_denied' || /access_denied|AADSTS65004/i.test(msg)) return new Error('Microsoft access was denied on the consent screen.');
  return new Error(`Microsoft sign-in failed${code ? ` (${code})` : ''}: ${msg.slice(0, 200)}`);
}

async function getToken(clientId) {
  const { msal, pca: app } = await getClient(clientId);
  let account = app.getActiveAccount() || app.getAllAccounts()[0] || null;
  try {
    if (!account) {
      const login = await app.loginPopup({ scopes: MS_SCOPES, prompt: 'select_account' });
      account = login.account;
      app.setActiveAccount(account);
    }
    try {
      const r = await app.acquireTokenSilent({ scopes: MS_SCOPES, account });
      return { token: r.accessToken, account };
    } catch (err) {
      if (!(err instanceof msal.InteractionRequiredAuthError) && err?.errorCode !== 'no_tokens_found') throw err;
      const r = await app.acquireTokenPopup({ scopes: MS_SCOPES, account });
      return { token: r.accessToken, account: r.account || account };
    }
  } catch (err) {
    throw friendlyMsalError(err);
  }
}

// ---------- browser-only: Graph ----------

export function graphApiError(status, body) {
  const code = String(body?.error?.code || '');
  const msg = String(body?.error?.message || '');
  if (status === 401) return new Error('Your Microsoft sign-in expired (tokens last about 1 hour). Click Connect Outlook again.');
  if (status === 403) return new Error(`Microsoft Graph refused access (${code || '403'}). Your organization may block Mail.Read/Calendars.Read for third-party apps.`);
  if (status === 404 && /MailboxNotEnabled|ResourceNotFound/i.test(code)) return new Error('This Microsoft account has no Outlook mailbox.');
  if (status === 429) return new Error('Microsoft Graph is rate limiting us. Wait a minute and reconnect.');
  return new Error(`Microsoft Graph error ${status}${msg ? `: ${msg}` : ''}`);
}

function makeGraph(token) {
  return async (path, headers = {}) => {
    const r = await fetch(path.startsWith('http') ? path : `${GRAPH}${path}`, {
      headers: { Authorization: `Bearer ${token}`, ...headers },
    });
    if (!r.ok) throw graphApiError(r.status, await r.json().catch(() => null));
    return r.json();
  };
}

const MSG_SELECT = 'id,subject,from,receivedDateTime,bodyPreview,webLink,inferenceClassification';

async function fetchMail(graph, now) {
  const me = await graph('/me?$select=mail,userPrincipalName');
  const mine = [me.mail, me.userPrincipalName].filter(Boolean).map((x) => String(x).toLowerCase());
  const since = new Date(now.getTime() - 14 * DAY).toISOString();
  const inboxQs = `$top=40&$select=${MSG_SELECT}&$filter=${encodeURIComponent(`receivedDateTime ge ${since}`)}&$orderby=${encodeURIComponent('receivedDateTime desc')}`;
  const receiptsQs = `$search=${encodeURIComponent('"receipt OR invoice OR subscription"')}&$top=30&$select=${MSG_SELECT}`;
  const [inbox, receipts] = await Promise.all([
    graph(`/me/mailFolders/inbox/messages?${inboxQs}`),
    graph(`/me/messages?${receiptsQs}`).catch(() => ({ value: [] })),
  ]);
  const reply = (inbox.value || []).filter((m) => isGraphReplyCandidate(m, mine)).map((m) => normalizeGraphMessage(m));
  const cutoff = now.getTime() - 120 * DAY;
  const subs = dedupeByMerchant(
    (receipts.value || [])
      .filter((m) => new Date(m.receivedDateTime).getTime() >= cutoff)
      .map((m) => normalizeGraphMessage(m, { withRecurring: true }))
      .filter((e) => e.recurring)
  );
  const seen = new Set(subs.map((e) => e.id));
  return { account: mine[0] || null, emails: [...reply.filter((e) => !seen.has(e.id)), ...subs] };
}

async function fetchCalendar(graph, now) {
  const end = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999);
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  const qs = `startDateTime=${encodeURIComponent(now.toISOString())}&endDateTime=${encodeURIComponent(end.toISOString())}` +
    `&$select=subject,start,end,isAllDay,responseStatus,isCancelled&$orderby=start/dateTime&$top=100`;
  const data = await graph(`/me/calendarView?${qs}`, { Prefer: `outlook.timezone="${tz}"` });
  return (data.value || []).map(normalizeGraphEvent).filter(Boolean);
}

async function fetchTodo(graph, now) {
  const lists = await graph('/me/todo/lists?$top=50');
  const per = await Promise.all(
    (lists.value || []).map(async (l) => {
      const data = await graph(`/me/todo/lists/${encodeURIComponent(l.id)}/tasks?$filter=${encodeURIComponent("status ne 'completed'")}&$top=100`);
      return (data.value || []).filter((t) => String(t.title || '').trim()).map((t) => normalizeTodoTask(t, l.displayName, now.getTime()));
    })
  );
  return per.flat();
}

/**
 * Opens Microsoft's sign-in popup (call from a click handler) and returns the normalized workspace:
 * {source:'microsoft', account, emails, events, tasks, warnings}. To Do is best-effort.
 */
export async function connectMicrosoft({ clientId } = {}) {
  if (!clientId) throw new Error('Outlook is not set up yet: MS_CLIENT_ID is missing. See docs/CONNECTORS_SETUP.md.');
  const { token, account } = await getToken(clientId);
  const graph = makeGraph(token);
  const now = new Date();
  const [mail, events, tasks] = await Promise.allSettled([fetchMail(graph, now), fetchCalendar(graph, now), fetchTodo(graph, now)]);
  if (mail.status === 'rejected' && events.status === 'rejected') throw mail.reason;
  const warnings = [mail, events]
    .filter((r) => r.status === 'rejected')
    .map((r) => String(r.reason?.message || r.reason));
  if (tasks.status === 'rejected') warnings.push(`Microsoft To Do skipped: ${tasks.reason?.message || tasks.reason}`);
  return {
    source: 'microsoft',
    account: (mail.status === 'fulfilled' && mail.value.account) || account?.username || null,
    emails: mail.status === 'fulfilled' ? mail.value.emails : [],
    events: events.status === 'fulfilled' ? events.value : [],
    tasks: tasks.status === 'fulfilled' ? tasks.value : [],
    warnings,
  };
}
