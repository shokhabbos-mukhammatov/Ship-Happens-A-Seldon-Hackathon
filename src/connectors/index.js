// Connector UI glue: renders Connect buttons into #connector-buttons (if the page has it) and hands
// each normalized workspace to loadWorkspace(ws, {merge: true}) from ../workspace.js.
// Tokens stay in memory inside the connector modules; nothing here persists them.
import { connectGoogle, loadGis } from './google.js';
import { connectMicrosoft, loadMsal, looksLikeMsalPopupResponse, handleMsalRedirectBridge } from './microsoft.js';
import { connectICS, connectICSFile } from './ics.js';
import { connectTodoist } from './todoist.js';

const SETUP_HINT = 'Needs setup: see docs/CONNECTORS_SETUP.md';
const LABELS = { google: 'Gmail', microsoft: 'Outlook', ics: 'ICS calendar', todoist: 'Todoist' };

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** "Connected: Gmail · 23 emails · 4 events · 6 tasks" */
export function summarize(ws) {
  const label = LABELS[ws?.source] || ws?.source || 'source';
  const parts = [`Connected: ${label}`];
  if (ws?.source !== 'ics' && ws?.source !== 'todoist') parts.push(plural(ws?.emails?.length || 0, 'email'));
  if (ws?.source !== 'todoist') parts.push(plural(ws?.events?.length || 0, 'event'));
  if (ws?.source !== 'ics') parts.push(plural(ws?.tasks?.length || 0, 'task'));
  let line = parts.join(' · ');
  if (ws?.warnings?.length) line += ` (skipped: ${ws.warnings.join(' ')})`;
  return line;
}

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'text') node.textContent = v;
    else if (k === 'class') node.className = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of children) if (c) node.append(c);
  return node;
}

async function deliver(ws) {
  try {
    const mod = await import('../workspace.js');
    if (typeof mod.loadWorkspace !== 'function') throw new Error('loadWorkspace is not exported');
    await mod.loadWorkspace(ws, { merge: true });
  } catch (err) {
    console.warn('Bouncer connectors: could not hand the workspace to the app', err);
  }
}

let config = { googleClientId: null, microsoftClientId: null };
let statusEl = null;

function setStatus(msg, kind = 'info') {
  if (!statusEl) return;
  statusEl.textContent = msg;
  statusEl.dataset.kind = kind;
}

/** Wraps a connect call: busy state, status line, hand-off. Must be called from the click handler. */
function run(button, label, connect) {
  return async () => {
    if (button.disabled) return;
    button.disabled = true;
    button.setAttribute('aria-busy', 'true');
    setStatus(`Connecting to ${label}…`);
    try {
      const ws = await connect();
      await deliver(ws);
      setStatus(summarize(ws), ws.warnings?.length ? 'warn' : 'ok');
    } catch (err) {
      setStatus(String(err?.message || err), 'error');
    } finally {
      button.disabled = false;
      button.removeAttribute('aria-busy');
    }
  };
}

function providerButton({ testid, text, clientId, onConnect }) {
  const btn = el('button', { type: 'button', class: 'btn-secondary', 'data-testid': testid, text });
  if (!clientId) {
    btn.disabled = true;
    btn.title = SETUP_HINT;
    return el('div', { class: 'connector' }, btn, el('small', { class: 'connector-hint', 'data-testid': `${testid}-hint`, text: SETUP_HINT }));
  }
  btn.addEventListener('click', run(btn, text.replace(/^Connect /, ''), onConnect));
  return el('div', { class: 'connector' }, btn);
}

// Scoped to #connector-buttons; uses the app's theme variables with fallbacks.
const CSS = `
#connector-buttons { align-items: center; }
#connector-buttons .connector { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
#connector-buttons input[type=url], #connector-buttons input[type=password] {
  min-width: 240px; padding: 10px 12px; border-radius: 10px; font: inherit;
  border: 1px solid var(--line, #333); background: var(--panel, transparent); color: var(--text, inherit); }
#connector-buttons button:disabled { opacity: 0.5; cursor: not-allowed; }
#connector-buttons button[aria-busy=true] { cursor: wait; }
#connector-buttons .connector-hint, #connector-buttons .connector-file { color: var(--muted, #999); font-size: 13px; }
#connector-buttons .connector-status { flex-basis: 100%; margin: 4px 0 0; font-size: 14px; color: var(--muted, #999); }
#connector-buttons .connector-status[data-kind=ok] { color: var(--green, #6c6); }
#connector-buttons .connector-status[data-kind=warn] { color: var(--brass-2, #d4a54a); }
#connector-buttons .connector-status[data-kind=error] { color: var(--red, #e66); }
`;

function injectStyles() {
  if (document.getElementById('connector-styles')) return;
  document.head.append(el('style', { id: 'connector-styles', text: CSS }));
}

export function mountConnectors(container) {
  if (!container || container.dataset.connectorsMounted === '1') return;
  container.dataset.connectorsMounted = '1';
  container.replaceChildren();
  injectStyles();

  const google = providerButton({
    testid: 'btn-connect-google',
    text: 'Connect Gmail + Google Calendar',
    clientId: config.googleClientId,
    onConnect: () => connectGoogle({ clientId: config.googleClientId }),
  });
  const microsoft = providerButton({
    testid: 'btn-connect-microsoft',
    text: 'Connect Outlook',
    clientId: config.microsoftClientId,
    onConnect: () => connectMicrosoft({ clientId: config.microsoftClientId }),
  });

  const icsInput = el('input', {
    type: 'url',
    'data-testid': 'ics-url-input',
    placeholder: 'ICS calendar link (https:// or webcal://)',
    'aria-label': 'ICS calendar link',
    autocomplete: 'off',
    spellcheck: 'false',
  });
  const icsBtn = el('button', { type: 'button', class: 'btn-secondary', 'data-testid': 'btn-connect-ics', text: 'Connect' });
  const icsGo = run(icsBtn, 'your calendar', () => connectICS({ url: icsInput.value }));
  icsBtn.addEventListener('click', icsGo);
  icsInput.addEventListener('keydown', (e) => e.key === 'Enter' && icsGo());

  const fileInput = el('input', { type: 'file', accept: '.ics,text/calendar', 'data-testid': 'ics-file-input', 'aria-label': 'Upload an .ics file' });
  fileInput.addEventListener('change', async () => {
    const file = fileInput.files?.[0];
    if (!file) return;
    await run(fileInput, file.name, () => connectICSFile(file))();
    fileInput.value = '';
  });

  const todoInput = el('input', {
    type: 'password',
    'data-testid': 'todoist-token-input',
    placeholder: 'Todoist API token',
    'aria-label': 'Todoist API token',
    autocomplete: 'off',
  });
  const todoBtn = el('button', { type: 'button', class: 'btn-secondary', 'data-testid': 'btn-connect-todoist', text: 'Connect Todoist' });
  const todoGo = run(todoBtn, 'Todoist', async () => {
    const ws = await connectTodoist({ token: todoInput.value });
    todoInput.value = ''; // do not keep the token around in the DOM
    return ws;
  });
  todoBtn.addEventListener('click', todoGo);
  todoInput.addEventListener('keydown', (e) => e.key === 'Enter' && todoGo());

  statusEl = el('p', { class: 'connector-status', 'data-testid': 'connector-status', role: 'status', 'aria-live': 'polite' });

  container.append(
    google,
    microsoft,
    el('div', { class: 'connector connector-ics' }, icsInput, icsBtn),
    el('label', { class: 'connector connector-file' }, el('span', { text: 'or upload .ics ' }), fileInput),
    el('div', { class: 'connector connector-todoist' }, todoInput, todoBtn),
    statusEl
  );
  setStatus('Read-only. Mail and calendar go straight from the provider to this browser.');
}

function preload() {
  // Warm the sign-in libraries so the click opens the popup right away (popup blockers allow
  // window.open only shortly after a click).
  const idle = globalThis.requestIdleCallback || ((fn) => setTimeout(fn, 300));
  idle(() => {
    if (config.googleClientId) loadGis().catch(() => {});
    if (config.microsoftClientId) loadMsal().catch(() => {});
  });
}

export async function initConnectors() {
  if (typeof document === 'undefined') return;
  // This window may be the Microsoft sign-in popup returning to our origin: hand the response back.
  if (looksLikeMsalPopupResponse(window.location)) {
    await handleMsalRedirectBridge();
    return;
  }
  try {
    const r = await fetch('/api/config', { headers: { Accept: 'application/json' } });
    if (r.ok) config = { ...config, ...(await r.json()) };
  } catch {
    // No config endpoint: provider buttons render as "Needs setup".
  }
  const tryMount = () => {
    const c = document.getElementById('connector-buttons');
    if (c && c.dataset.connectorsMounted !== '1') mountConnectors(c);
  };
  tryMount();
  // The app may re-render its setup panel; remount if the container is replaced.
  new MutationObserver(tryMount).observe(document.body, { childList: true, subtree: true });
  preload();
}

initConnectors();
