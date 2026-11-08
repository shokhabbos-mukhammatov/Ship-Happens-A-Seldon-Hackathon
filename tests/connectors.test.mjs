// node --test tests/connectors.test.mjs
// Runs in America/New_York so local-time handling is exercised (not just UTC).
process.env.TZ = 'America/New_York';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseICS, parseRrule, resolveTzid, unfold, parseDuration } from '../src/connectors/ics.js';
import { parseRecurring, merchantFrom, parseAmount } from '../src/connectors/subscriptions.js';
import {
  normalizeGmailMessage,
  isReplyCandidate,
  dedupeByMerchant,
  normalizeGoogleEvent,
  normalizeGoogleTask,
  decodeEntities,
  googleApiError,
} from '../src/connectors/google.js';
import {
  normalizeGraphMessage,
  isGraphReplyCandidate,
  normalizeGraphEvent,
  graphDateTimeToIso,
  normalizeTodoTask,
  looksLikeMsalPopupResponse,
  MSAL_VERSION,
} from '../src/connectors/microsoft.js';
import { normalizeTodoistTask } from '../src/connectors/todoist.js';
import { summarize } from '../src/connectors/index.js';
import icsHandler, { validateIcsUrl, isPrivateAddress, assertPublicHost } from '../api/ics.js';
import configHandler from '../api/config.js';
import todoistHandler, { tokenFrom } from '../api/todoist.js';

// Mon 9 Nov 2026, 09:00 in New York (14:00 UTC).
const NOW = new Date('2026-11-09T14:00:00Z');

const cal = (...events) =>
  ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//test//EN', 'X-WR-CALNAME:Work', ...events.flat(), 'END:VCALENDAR'].join('\r\n');
const vevent = (lines) => ['BEGIN:VEVENT', ...lines, 'END:VEVENT'];

// ---------- parseICS ----------

test('ICS: TZID wall time converts to the right instant (Paris 18:00 = 12:00 New York)', () => {
  const evs = parseICS(cal(vevent(['UID:tz-1', 'DTSTART;TZID=Europe/Paris:20261109T180000', 'DTEND;TZID=Europe/Paris:20261109T190000', 'SUMMARY:Paris call'])), NOW);
  assert.equal(evs.length, 1);
  assert.equal(evs[0].title, 'Paris call');
  assert.equal(evs[0].start, '2026-11-09T17:00:00.000Z');
  assert.equal(evs[0].end, '2026-11-09T18:00:00.000Z');
  assert.equal(evs[0].allDay, false);
  assert.equal(evs[0].source, 'ics');
});

test('ICS: quoted TZID, Mozilla-prefixed TZID and Windows zone names resolve', () => {
  assert.equal(resolveTzid('"America/Chicago"'), 'America/Chicago');
  assert.equal(resolveTzid('/mozilla.org/20050126_1/America/New_York'), 'America/New_York');
  assert.equal(resolveTzid('Pacific Standard Time'), 'America/Los_Angeles');
  assert.equal(resolveTzid('(UTC+01:00) Brussels, Copenhagen, Madrid, Paris'), 'Europe/Paris');
  assert.equal(resolveTzid('Not/AZone'), null);
  const evs = parseICS(cal(vevent(['UID:win', 'DTSTART;TZID=Eastern Standard Time:20261109T130000', 'DTEND;TZID=Eastern Standard Time:20261109T133000', 'SUMMARY:Outlook meeting'])), NOW);
  assert.equal(evs[0].start, '2026-11-09T18:00:00.000Z');
});

test('ICS: UTC events, only today\'s remaining ones (past and tomorrow are dropped)', () => {
  const text = cal(
    vevent(['UID:u1', 'DTSTART:20261109T200000Z', 'DTEND:20261109T203000Z', 'SUMMARY:Standup']),
    vevent(['UID:u2', 'DTSTART:20261109T130000Z', 'DTEND:20261109T133000Z', 'SUMMARY:Already over']),
    vevent(['UID:u3', 'DTSTART:20261109T133000Z', 'DTEND:20261109T143000Z', 'SUMMARY:In progress']),
    vevent(['UID:u4', 'DTSTART:20261110T150000Z', 'DTEND:20261110T160000Z', 'SUMMARY:Tomorrow']),
    vevent(['UID:u5', 'DTSTART:20261110T040000Z', 'DTEND:20261110T043000Z', 'SUMMARY:Late tonight local']),
    vevent(['UID:u6', 'DTSTART:20261109T210000Z', 'DURATION:PT45M', 'SUMMARY:Has duration']),
    vevent(['UID:u7', 'DTSTART:20261109T220000Z', 'DTEND:20261109T230000Z', 'STATUS:CANCELLED', 'SUMMARY:Cancelled'])
  );
  const evs = parseICS(text, NOW);
  assert.deepEqual(evs.map((e) => e.title), ['In progress', 'Standup', 'Has duration', 'Late tonight local']);
  assert.equal(evs[1].start, '2026-11-09T20:00:00.000Z');
  assert.equal(evs[2].end, '2026-11-09T21:45:00.000Z');
});

test('ICS: all-day VALUE=DATE events are allDay and start at local midnight', () => {
  const text = cal(
    vevent(['UID:a1', 'DTSTART;VALUE=DATE:20261109', 'DTEND;VALUE=DATE:20261110', 'SUMMARY:Offsite']),
    vevent(['UID:a2', 'DTSTART;VALUE=DATE:20261108', 'DTEND;VALUE=DATE:20261111', 'SUMMARY:Conference']),
    vevent(['UID:a3', 'DTSTART;VALUE=DATE:20261108', 'SUMMARY:Yesterday only'])
  );
  const evs = parseICS(text, NOW);
  assert.deepEqual(evs.map((e) => e.title).sort(), ['Conference', 'Offsite']);
  const off = evs.find((e) => e.title === 'Offsite');
  assert.equal(off.allDay, true);
  assert.equal(off.start, '2026-11-09T05:00:00.000Z'); // midnight in New York
  assert.equal(off.end, '2026-11-10T05:00:00.000Z');
});

test('ICS: weekly RRULE keeps wall time across DST and honours BYDAY, EXDATE, COUNT, UNTIL', () => {
  const text = cal(
    // Started Mon 5 Oct (EDT). Today Mon 9 Nov is EST: 16:00 local must stay 16:00 local (21:00Z).
    vevent(['UID:w1', 'DTSTART;TZID=America/New_York:20261005T160000', 'DTEND;TZID=America/New_York:20261005T163000', 'RRULE:FREQ=WEEKLY;BYDAY=MO,WE', 'SUMMARY:1:1 with Sam']),
    vevent(['UID:w2', 'DTSTART;TZID=America/New_York:20261012T110000', 'DTEND;TZID=America/New_York:20261012T120000', 'RRULE:FREQ=WEEKLY', 'EXDATE;TZID=America/New_York:20261109T110000', 'SUMMARY:Skipped today']),
    vevent(['UID:w3', 'DTSTART:20261005T170000Z', 'DTEND:20261005T180000Z', 'RRULE:FREQ=WEEKLY;COUNT=2', 'SUMMARY:Count ran out']),
    vevent(['UID:w4', 'DTSTART:20261005T170000Z', 'DTEND:20261005T180000Z', 'RRULE:FREQ=WEEKLY;UNTIL=20261101T000000Z', 'SUMMARY:Until passed']),
    vevent(['UID:w5', 'DTSTART;TZID=America/New_York:20261026T150000', 'DTEND;TZID=America/New_York:20261026T153000', 'RRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=MO', 'SUMMARY:Biweekly']),
    vevent(['UID:w6', 'DTSTART;TZID=America/New_York:20261019T150000', 'DTEND;TZID=America/New_York:20261019T153000', 'RRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=MO', 'SUMMARY:Off week'])
  );
  const evs = parseICS(text, NOW);
  assert.deepEqual(evs.map((e) => e.title), ['Biweekly', '1:1 with Sam']);
  assert.equal(evs.find((e) => e.title === '1:1 with Sam').start, '2026-11-09T21:00:00.000Z');
  assert.equal(evs.find((e) => e.title === 'Biweekly').start, '2026-11-09T20:00:00.000Z');
});

test('ICS: daily RRULE, RECURRENCE-ID override, complex rules skipped, folded lines unfolded', () => {
  const text = cal(
    vevent(['UID:d1', 'DTSTART:20261101T190000Z', 'DTEND:20261101T191500Z', 'RRULE:FREQ=DAILY;INTERVAL=2', 'SUMMARY:Every other day']),
    vevent(['UID:d2', 'DTSTART:20261101T180000Z', 'DTEND:20261101T183000Z', 'RRULE:FREQ=DAILY', 'SUMMARY:Daily sync']),
    vevent(['UID:d2', 'RECURRENCE-ID:20261109T180000Z', 'DTSTART:20261109T220000Z', 'DTEND:20261109T223000Z', 'SUMMARY:Daily sync (moved)']),
    vevent(['UID:m1', 'DTSTART:20261012T190000Z', 'DTEND:20261012T200000Z', 'RRULE:FREQ=MONTHLY;BYDAY=2MO', 'SUMMARY:Monthly board']),
    vevent(['UID:f1', 'DTSTART:20261109T230000Z', 'DTEND:20261109T233000Z', 'SUMMARY:A very long title that', '  wraps onto a folded line\\, with an escaped comma'])
  );
  const evs = parseICS(text, NOW);
  assert.deepEqual(evs.map((e) => e.title), ['Every other day', 'Daily sync (moved)', 'A very long title that wraps onto a folded line, with an escaped comma']);
  assert.equal(parseRrule('FREQ=MONTHLY;BYDAY=2MO'), null);
  assert.equal(parseRrule('FREQ=WEEKLY;BYSETPOS=1;BYDAY=MO'), null);
  assert.deepEqual([...parseRrule('FREQ=WEEKLY;BYDAY=MO,FR').byday], [1, 5]);
  assert.equal(unfold('A\r\n B\r\n\tC'), 'ABC');
  assert.equal(parseDuration('PT1H30M'), 5400000);
  assert.equal(parseDuration('P1D'), 86400000);
});

test('ICS: recurring all-day events and VALARM properties do not leak', () => {
  const text = cal(
    vevent(['UID:ad1', 'DTSTART;VALUE=DATE:20261102', 'DTEND;VALUE=DATE:20261103', 'RRULE:FREQ=WEEKLY', 'SUMMARY:Gym Monday']),
    vevent(['UID:al1', 'DTSTART:20261109T190000Z', 'DTEND:20261109T200000Z', 'SUMMARY:Real title', 'BEGIN:VALARM', 'ACTION:DISPLAY', 'SUMMARY:Alarm text', 'TRIGGER:-PT10M', 'END:VALARM'])
  );
  const evs = parseICS(text, NOW);
  assert.deepEqual(evs.map((e) => [e.title, e.allDay]), [['Gym Monday', true], ['Real title', false]]);
});

// ---------- parseRecurring ----------

test('parseRecurring: monthly membership with display-name merchant', () => {
  assert.deepEqual(parseRecurring({ from: 'Netflix <info@account.netflix.com>', subject: 'Your Netflix membership', snippet: 'We charged $15.49 for your monthly plan.' }), { name: 'Netflix', amount: 15.49, period: 'mo' });
});

test('parseRecurring: annual plan', () => {
  assert.deepEqual(parseRecurring({ from: 'Notion <billing@mail.notion.so>', subject: 'Receipt for your annual plan', snippet: 'Total: $96.00, billed yearly. Thanks!' }), { name: 'Notion', amount: 96, period: 'yr' });
});

test('parseRecurring: euro with decimal comma, per month', () => {
  assert.deepEqual(parseRecurring({ from: 'Spotify <no-reply@spotify.com>', subject: 'Your receipt', snippet: 'Premium Individual €10,99 per month' }), { name: 'Spotify', amount: 10.99, period: 'mo' });
});

test('parseRecurring: subscription word defaults to monthly; GBP', () => {
  assert.deepEqual(parseRecurring({ from: 'The Economist <subs@economist.com>', subject: 'Your subscription renewal', snippet: '£189 will be charged on 1 December.' }), { name: 'The Economist', amount: 189, period: 'mo' });
});

test('parseRecurring: bare address falls back to the domain; USD prefix; thousands separator', () => {
  assert.deepEqual(parseRecurring({ from: 'billing@figma.com', subject: 'Invoice #4821', snippet: 'USD 1,245.00 for Figma Organization, renews monthly' }), { name: 'Figma', amount: 1245, period: 'mo' });
});

test('parseRecurring: period right after the amount wins ($99/yr)', () => {
  assert.deepEqual(parseRecurring({ from: 'Receipts <receipts@email.apple.com>', subject: 'Your receipt from Apple', snippet: 'iCloud+ $99/yr. Read our monthly newsletter.' }), { name: 'Apple', amount: 99, period: 'yr' });
});

test('parseRecurring: non-receipts and one-off receipts return null', () => {
  assert.equal(parseRecurring({ from: 'Sarah Chen <sarah@northbeam.vc>', subject: 'Lunch next week?', snippet: 'Want to grab lunch Thursday?' }), null);
  assert.equal(parseRecurring({ from: 'Uber Receipts <noreply@uber.com>', subject: 'Your Tuesday evening trip', snippet: 'Total $23.10. Thanks for riding.' }), null);
  assert.equal(parseRecurring({ from: 'Acme <billing@acme.com>', subject: 'Your subscription', snippet: 'No amount here' }), null);
  assert.equal(parseRecurring({}), null);
});

test('merchant and amount helpers', () => {
  assert.equal(merchantFrom('"Figma Billing" <billing@figma.com>'), 'Figma');
  assert.equal(merchantFrom('no-reply@email.disneyplus.co.uk'), 'Disneyplus');
  assert.equal(parseAmount('Total 9.99 USD'), 9.99);
  assert.equal(parseAmount('nothing'), null);
});

// ---------- Gmail normalizer ----------

const gmailMsg = (id, headers, snippet, extra = {}) => ({
  id,
  threadId: `t-${id}`,
  snippet,
  internalDate: String(Date.parse('2026-11-09T12:30:00Z')),
  payload: { headers: Object.entries(headers).map(([name, value]) => ({ name, value })) },
  ...extra,
});

test('Gmail: metadata message -> Email', () => {
  const m = gmailMsg('18c1', { From: 'Sarah Chen <sarah@northbeam.vc>', Subject: 'Re: Seed round', Date: 'Mon, 9 Nov 2026 07:30:00 -0500' }, 'Can you confirm Thursday? Don&#39;t forget the deck &amp; metrics');
  const e = normalizeGmailMessage(m, { userEmail: 'me@startup.io' });
  assert.equal(e.id, 'gmail-18c1');
  assert.equal(e.kind, 'email');
  assert.equal(e.from, 'Sarah Chen');
  assert.equal(e.subject, 'Re: Seed round');
  assert.equal(e.title, 'Re: Seed round');
  assert.equal(e.snippet, "Can you confirm Thursday? Don't forget the deck & metrics");
  assert.equal(e.detail, "Sarah Chen — Can you confirm Thursday? Don't forget the deck & metrics");
  assert.equal(e.date, '2026-11-09T12:30:00.000Z');
  assert.equal(e.link, 'https://mail.google.com/mail/u/0/?authuser=me%40startup.io#all/t-18c1');
  assert.equal(e.recurring, null);
  assert.equal(e.source, 'gmail');
  assert.ok(normalizeGmailMessage(gmailMsg('x', { From: 'a@b.co' }, 'y'.repeat(500))).detail.length <= 300);
});

test('Gmail: reply candidates skip List-Unsubscribe, my own mail and no-reply senders', () => {
  assert.equal(isReplyCandidate(gmailMsg('1', { From: 'Sarah <sarah@x.vc>' }, ''), 'me@x.io'), true);
  assert.equal(isReplyCandidate(gmailMsg('2', { From: 'News <news@x.com>', 'List-Unsubscribe': '<mailto:u@x.com>' }, ''), 'me@x.io'), false);
  assert.equal(isReplyCandidate(gmailMsg('3', { From: 'Me <ME@x.io>' }, ''), 'me@x.io'), false);
  assert.equal(isReplyCandidate(gmailMsg('4', { From: 'Shop <no-reply@shop.com>' }, ''), 'me@x.io'), false);
});

test('Gmail: receipts get recurring and de-duplicate by merchant, keeping the latest', () => {
  const older = gmailMsg('r1', { From: 'Netflix <info@netflix.com>', Subject: 'Your membership renewal' }, 'Charged $15.49 monthly', { internalDate: String(Date.parse('2026-09-09T00:00:00Z')) });
  const newer = gmailMsg('r2', { From: 'Netflix <info@netflix.com>', Subject: 'Your membership renewal' }, 'Charged $17.99 monthly', { internalDate: String(Date.parse('2026-10-09T00:00:00Z')) });
  const other = gmailMsg('r3', { From: 'Figma <billing@figma.com>', Subject: 'Receipt' }, '$15/mo Professional');
  const list = dedupeByMerchant([older, newer, other].map((m) => normalizeGmailMessage(m, { withRecurring: true })));
  assert.equal(list.length, 2);
  const nf = list.find((e) => e.recurring.name === 'Netflix');
  assert.equal(nf.id, 'gmail-r2');
  assert.deepEqual(nf.recurring, { name: 'Netflix', amount: 17.99, period: 'mo' });
});

test('Google Calendar/Tasks normalizers', () => {
  assert.equal(normalizeGoogleEvent({ id: 'd', summary: 'Declined', start: { dateTime: '2026-11-09T15:00:00-05:00' }, end: { dateTime: '2026-11-09T16:00:00-05:00' }, attendees: [{ email: 'me@x.io', self: true, responseStatus: 'declined' }] }), null);
  assert.deepEqual(normalizeGoogleEvent({ id: 'e', summary: 'Design review', start: { dateTime: '2026-11-09T15:00:00-05:00' }, end: { dateTime: '2026-11-09T16:00:00-05:00' }, attendees: [{ self: true, responseStatus: 'accepted' }] }), { id: 'gcal-e', title: 'Design review', start: '2026-11-09T20:00:00.000Z', end: '2026-11-09T21:00:00.000Z', allDay: false, source: 'gcal' });
  const allDay = normalizeGoogleEvent({ id: 'h', summary: 'Holiday', start: { date: '2026-11-09' }, end: { date: '2026-11-10' } });
  assert.equal(allDay.allDay, true);
  assert.equal(allDay.start, '2026-11-09T05:00:00.000Z');
  const t = normalizeGoogleTask({ id: 'k', title: 'Send metrics', notes: 'MRR + burn', due: '2026-11-10T00:00:00.000Z', updated: '2026-11-06T14:00:00Z' }, 'My Tasks', NOW.getTime());
  assert.deepEqual(t, { id: 'gtasks-k', kind: 'task', title: 'Send metrics', detail: 'MRR + burn', due: '2026-11-10', estimate_min: 30, created_days_ago: 3, source: 'gtasks' });
  assert.equal(decodeEntities('&lt;b&gt; &#x41; &quot;'), '<b> A "');
});

test('Google API errors name the API to enable', () => {
  const e = googleApiError(403, { error: { code: 403, message: 'Google Tasks API has not been used in project 123 before or it is disabled.', errors: [{ reason: 'accessNotConfigured' }], details: [{ reason: 'SERVICE_DISABLED' }] } }, 'Google Tasks API');
  assert.match(e.message, /Google Tasks API is not enabled/);
  assert.match(googleApiError(401, null, 'Gmail API').message, /expired/);
});

// ---------- Graph normalizer ----------

test('Graph: message -> Email, focused preference and self filter', () => {
  const m = {
    id: 'AAMkAD=',
    subject: 'Contract redlines',
    from: { emailAddress: { name: 'Priya Patel', address: 'Priya@Legal.example' } },
    receivedDateTime: '2026-11-09T13:05:00Z',
    bodyPreview: 'Attached the redlines.\r\nCan you sign by Friday?',
    webLink: 'https://outlook.office365.com/owa/?ItemID=AAMkAD%3D&exvsurl=1',
    inferenceClassification: 'focused',
  };
  const e = normalizeGraphMessage(m);
  assert.deepEqual(e, {
    id: 'outlook-AAMkAD=',
    kind: 'email',
    from: 'Priya Patel',
    subject: 'Contract redlines',
    snippet: 'Attached the redlines. Can you sign by Friday?',
    title: 'Contract redlines',
    detail: 'Priya Patel — Attached the redlines. Can you sign by Friday?',
    date: '2026-11-09T13:05:00.000Z',
    link: 'https://outlook.office365.com/owa/?ItemID=AAMkAD%3D&exvsurl=1',
    recurring: null,
    source: 'outlook',
  });
  assert.equal(isGraphReplyCandidate(m, ['me@corp.example']), true);
  assert.equal(isGraphReplyCandidate({ ...m, inferenceClassification: 'other' }, []), false);
  assert.equal(isGraphReplyCandidate(m, ['priya@legal.example']), false);
  const r = normalizeGraphMessage({ ...m, from: { emailAddress: { name: 'Adobe', address: 'mail@mail.adobe.com' } }, subject: 'Your invoice', bodyPreview: 'Creative Cloud US$59.99/mo' }, { withRecurring: true });
  assert.deepEqual(r.recurring, { name: 'Adobe', amount: 59.99, period: 'mo' });
});

test('Graph: calendar events honour Prefer timezone, drop declined/cancelled', () => {
  assert.equal(graphDateTimeToIso({ dateTime: '2026-11-09T14:00:00.0000000', timeZone: 'America/New_York' }), '2026-11-09T19:00:00.000Z');
  assert.equal(graphDateTimeToIso({ dateTime: '2026-11-09T14:00:00.0000000', timeZone: 'UTC' }), '2026-11-09T14:00:00.000Z');
  const ev = normalizeGraphEvent({ id: 'X1', subject: 'Board prep', start: { dateTime: '2026-11-09T14:00:00.0000000', timeZone: 'America/New_York' }, end: { dateTime: '2026-11-09T15:00:00.0000000', timeZone: 'America/New_York' }, isAllDay: false, responseStatus: { response: 'accepted' } });
  assert.deepEqual(ev, { id: 'outlook-ev-X1', title: 'Board prep', start: '2026-11-09T19:00:00.000Z', end: '2026-11-09T20:00:00.000Z', allDay: false, source: 'outlook' });
  assert.equal(normalizeGraphEvent({ ...ev, start: { dateTime: '2026-11-09T14:00:00' }, responseStatus: { response: 'declined' } }), null);
  assert.equal(normalizeGraphEvent({ id: 'c', isCancelled: true, start: { dateTime: '2026-11-09T14:00:00' } }), null);
  const td = normalizeTodoTask({ id: 'T', title: 'Renew passport', body: { content: '<p>Bring photos</p>' }, dueDateTime: { dateTime: '2026-11-12T00:00:00.0000000', timeZone: 'UTC' }, createdDateTime: '2026-11-01T10:00:00Z' }, 'Tasks', NOW.getTime());
  assert.deepEqual(td, { id: 'mstodo-T', kind: 'task', title: 'Renew passport', detail: 'Bring photos', due: '2026-11-12', estimate_min: 30, created_days_ago: 8, source: 'mstodo' });
});

test('MSAL popup response detection and pinned version', () => {
  assert.equal(looksLikeMsalPopupResponse({ hash: '#code=abc&client_info=xyz&state=s1&session_state=q', search: '' }), true);
  assert.equal(looksLikeMsalPopupResponse({ hash: '', search: '?error=access_denied&error_description=no&state=s1' }), true);
  assert.equal(looksLikeMsalPopupResponse({ hash: '#inbox', search: '' }), false);
  assert.match(MSAL_VERSION, /^\d+\.\d+\.\d+$/);
});

test('Todoist v1 task -> Task', () => {
  const t = normalizeTodoistTask({ id: '6X7', content: 'Draft launch post', description: 'For Product Hunt', due: { date: '2026-11-10', is_recurring: false, string: 'tomorrow' }, duration: { amount: 45, unit: 'minute' }, added_at: '2026-11-04T09:00:00Z' }, NOW.getTime());
  assert.deepEqual(t, { id: 'todoist-6X7', kind: 'task', title: 'Draft launch post', detail: 'For Product Hunt', due: '2026-11-10', estimate_min: 45, created_days_ago: 5, source: 'todoist' });
  assert.equal(normalizeTodoistTask({ id: '1', content: 'x', due: { date: '2026-11-10T09:00:00' } }).due, '2026-11-10');
  assert.equal(normalizeTodoistTask({ id: '1', content: 'x', due: null }).due, null);
  assert.equal(tokenFrom({ headers: { authorization: 'Bearer 0123456789abcdef0123456789abcdef01234567' } }), '0123456789abcdef0123456789abcdef01234567');
  assert.equal(tokenFrom({ headers: {} }), null);
});

test('status line summary', () => {
  assert.equal(summarize({ source: 'google', emails: Array(23), events: Array(4), tasks: Array(6) }), 'Connected: Gmail · 23 emails · 4 events · 6 tasks');
  assert.equal(summarize({ source: 'ics', events: [1] }), 'Connected: ICS calendar · 1 event');
});

// ---------- /api/ics URL validator ----------

test('api/ics validator: rejects http, localhost, private, link-local; rewrites webcal', () => {
  const bad = [
    'http://calendar.google.com/x.ics',
    'https://localhost/x.ics',
    'https://LOCALHOST./x.ics',
    'https://api.localhost/x.ics',
    'https://10.0.0.5/x.ics',
    'https://10.1.2.3:443/x.ics',
    'https://169.254.169.254/latest/meta-data',
    'https://127.0.0.1/x.ics',
    'https://0x7f.1/x.ics',
    'https://[::1]/x.ics',
    'https://[::ffff:10.0.0.1]/x.ics',
    'https://[fe80::1]/x.ics',
    'https://192.168.1.10/x.ics',
    'https://172.20.0.1/x.ics',
    'https://user:pw@calendar.google.com/x.ics',
    'https://calendar.google.com:8443/x.ics',
    'https://intranet/x.ics',
    'ftp://example.com/x.ics',
    'file:///etc/passwd',
    'not a url',
    '',
  ];
  for (const u of bad) assert.throws(() => validateIcsUrl(u), (e) => e.status === 400, u);
  assert.equal(validateIcsUrl('webcal://p123-caldav.icloud.com/published/2/abc').href, 'https://p123-caldav.icloud.com/published/2/abc');
  assert.equal(validateIcsUrl('https://calendar.google.com/calendar/ical/x%40gmail.com/private-abc/basic.ics').protocol, 'https:');
});

test('api/ics private address table', () => {
  for (const ip of ['10.0.0.1', '127.0.0.1', '169.254.169.254', '172.31.255.255', '192.168.0.1', '100.64.0.1', '0.0.0.0', '::1', '::', 'fd00::1', 'fe80::abcd', '::ffff:127.0.0.1', '::ffff:7f00:1', '64:ff9b::a00:1']) {
    assert.equal(isPrivateAddress(ip), true, ip);
  }
  for (const ip of ['8.8.8.8', '142.250.72.14', '172.32.0.1', '2607:f8b0:4004:800::200e']) assert.equal(isPrivateAddress(ip), false, ip);
});

test('api/ics DNS check rejects names that resolve to loopback', async () => {
  await assert.rejects(assertPublicHost('localhost'), (e) => e.status === 400);
});

// ---------- handlers with mock req/res ----------

function mockRes() {
  const res = { statusCode: 200, headers: {}, body: '' };
  res.setHeader = (k, v) => (res.headers[k.toLowerCase()] = v);
  res.end = (b) => (res.body = b || '');
  return res;
}

test('api/ics handler: http://localhost is rejected with 400 and the URL is not echoed', async () => {
  const res = mockRes();
  await icsHandler({ method: 'GET', url: '/api/ics?url=http%3A%2F%2Flocalhost%2Fsecret-token-123' }, res);
  assert.equal(res.statusCode, 400);
  assert.match(res.headers['content-type'], /application\/json/);
  assert.ok(!res.body.includes('secret-token-123'));
  const res2 = mockRes();
  await icsHandler({ method: 'POST', url: '/api/ics' }, res2);
  assert.equal(res2.statusCode, 405);
});

test('api/config handler returns public client ids from env', () => {
  const prev = { g: process.env.GOOGLE_CLIENT_ID, m: process.env.MS_CLIENT_ID };
  process.env.GOOGLE_CLIENT_ID = 'g-123.apps.googleusercontent.com';
  delete process.env.MS_CLIENT_ID;
  const res = mockRes();
  configHandler({ method: 'GET', url: '/api/config' }, res);
  assert.deepEqual(JSON.parse(res.body), { googleClientId: 'g-123.apps.googleusercontent.com', microsoftClientId: null });
  if (prev.g === undefined) delete process.env.GOOGLE_CLIENT_ID;
  else process.env.GOOGLE_CLIENT_ID = prev.g;
  if (prev.m !== undefined) process.env.MS_CLIENT_ID = prev.m;
});

test('api/todoist handler: missing token is a 400 without calling Todoist', async () => {
  const res = mockRes();
  await todoistHandler({ method: 'GET', url: '/api/todoist', headers: {} }, res);
  assert.equal(res.statusCode, 400);
});

test('cleanClientId tolerates pasted scheme, quotes, spaces and slashes', async () => {
  const { cleanClientId } = await import('../api/config.js');
  const id = '714995040650-abc.apps.googleusercontent.com';
  assert.equal(cleanClientId(`https://${id}`), id);
  assert.equal(cleanClientId(` "${id}"\n`), id);
  assert.equal(cleanClientId(`${id}/`), id);
  assert.equal(cleanClientId(id), id);
  assert.equal(cleanClientId(''), null);
  assert.equal(cleanClientId(undefined), null);
});
