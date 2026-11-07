// Any calendar by ICS link (or .ics file): a small RFC 5545 reader for "what's left today".
// Handles line folding, DTSTART/DTEND with TZID / UTC (Z) / floating / VALUE=DATE, DURATION,
// SUMMARY, STATUS:CANCELLED, EXDATE, RECURRENCE-ID overrides, and simple DAILY/WEEKLY RRULEs
// (FREQ, INTERVAL, UNTIL, COUNT, BYDAY, WKST). Anything more complex only shows its first instance.

const DAY = 86400000;
const MAX_ICS_BYTES = 2 * 1024 * 1024;
const WEEKDAYS = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 };
const SIMPLE_RRULE_PARTS = new Set(['FREQ', 'INTERVAL', 'UNTIL', 'COUNT', 'BYDAY', 'WKST']);

// Outlook/Exchange publish Windows zone names. The common ones, mapped to IANA.
const WINDOWS_TZ = {
  'pacific standard time': 'America/Los_Angeles',
  'mountain standard time': 'America/Denver',
  'us mountain standard time': 'America/Phoenix',
  'central standard time': 'America/Chicago',
  'eastern standard time': 'America/New_York',
  'atlantic standard time': 'America/Halifax',
  'alaskan standard time': 'America/Anchorage',
  'hawaiian standard time': 'Pacific/Honolulu',
  'sa pacific standard time': 'America/Bogota',
  'e. south america standard time': 'America/Sao_Paulo',
  'gmt standard time': 'Europe/London',
  'greenwich standard time': 'Atlantic/Reykjavik',
  'w. europe standard time': 'Europe/Berlin',
  'romance standard time': 'Europe/Paris',
  'central europe standard time': 'Europe/Budapest',
  'central european standard time': 'Europe/Warsaw',
  'gtb standard time': 'Europe/Bucharest',
  'fle standard time': 'Europe/Kiev',
  'russian standard time': 'Europe/Moscow',
  'israel standard time': 'Asia/Jerusalem',
  'arabian standard time': 'Asia/Dubai',
  'india standard time': 'Asia/Kolkata',
  'china standard time': 'Asia/Shanghai',
  'singapore standard time': 'Asia/Singapore',
  'tokyo standard time': 'Asia/Tokyo',
  'korea standard time': 'Asia/Seoul',
  'aus eastern standard time': 'Australia/Sydney',
  'e. australia standard time': 'Australia/Brisbane',
  'new zealand standard time': 'Pacific/Auckland',
  'utc': 'UTC',
  'coordinated universal time': 'UTC',
};
// "(UTC-08:00) Pacific Time (US & Canada)" style names.
const TZ_HINTS = [
  [/pacific time/i, 'America/Los_Angeles'],
  [/mountain time/i, 'America/Denver'],
  [/central time/i, 'America/Chicago'],
  [/eastern time/i, 'America/New_York'],
  [/dublin|edinburgh|lisbon|london/i, 'Europe/London'],
  [/amsterdam|berlin|bern|rome|stockholm|vienna/i, 'Europe/Berlin'],
  [/brussels|copenhagen|madrid|paris/i, 'Europe/Paris'],
  [/chennai|kolkata|mumbai|new delhi/i, 'Asia/Kolkata'],
  [/beijing|chongqing|hong kong|urumqi/i, 'Asia/Shanghai'],
  [/osaka|sapporo|tokyo/i, 'Asia/Tokyo'],
  [/canberra|melbourne|sydney/i, 'Australia/Sydney'],
];

// ---------- text ----------

/** RFC 5545 3.1: a CRLF followed by a space or tab continues the previous line. */
export function unfold(text) {
  return String(text || '')
    .replace(/^﻿/, '')
    .replace(/\r\n?/g, '\n')
    .replace(/\n[ \t]/g, '');
}

/** "DTSTART;TZID="America/New_York":20261107T090000" -> {name, params, value}. Colons in quotes are kept. */
export function parseLine(line) {
  let inQuote = false;
  let colon = -1;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') inQuote = !inQuote;
    else if (c === ':' && !inQuote) {
      colon = i;
      break;
    }
  }
  if (colon < 0) return null;
  const head = line.slice(0, colon);
  const value = line.slice(colon + 1);
  const parts = head.match(/(?:[^;"]+|"[^"]*")+/g) || [];
  const name = (parts.shift() || '').trim().toUpperCase();
  const params = {};
  for (const p of parts) {
    const eq = p.indexOf('=');
    if (eq > 0) params[p.slice(0, eq).trim().toUpperCase()] = p.slice(eq + 1).trim().replace(/^"|"$/g, '');
  }
  return { name, params, value };
}

const unescapeText = (v) => String(v || '').replace(/\\([\\;,nN])/g, (_, c) => (c === 'n' || c === 'N' ? '\n' : c));

// ---------- time zones ----------

const tzValid = new Map();
function isValidTz(tz) {
  if (!tzValid.has(tz)) {
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: tz });
      tzValid.set(tz, true);
    } catch {
      tzValid.set(tz, false);
    }
  }
  return tzValid.get(tz);
}

/** TZID -> IANA zone name, 'UTC', or null (treat as floating/local time). */
export function resolveTzid(tzid) {
  if (!tzid) return null;
  let t = String(tzid).trim().replace(/^"|"$/g, '');
  if (isValidTz(t)) return t;
  // "/mozilla.org/20050126_1/America/New_York" and similar prefixes.
  const tail = t.split('/').filter(Boolean);
  for (let i = 0; i < tail.length - 1; i++) {
    const cand = tail.slice(i).join('/');
    if (/^[A-Z][A-Za-z_]+\/[A-Za-z_]/.test(cand) && isValidTz(cand)) return cand;
  }
  const win = WINDOWS_TZ[t.toLowerCase()];
  if (win) return win;
  for (const [re, zone] of TZ_HINTS) if (re.test(t)) return zone;
  const off = /(?:UTC|GMT)\s*([+-])(\d{1,2})(?::?00)?\b/i.exec(t);
  if (off) {
    const h = Number(off[2]);
    if (h === 0) return 'UTC';
    if (h <= 14) return `Etc/GMT${off[1] === '+' ? '-' : '+'}${h}`; // Etc/GMT signs are inverted
  }
  return null;
}

const dtfCache = new Map();
function zoneParts(ms, tz) {
  let dtf = dtfCache.get(tz);
  if (!dtf) {
    dtf = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    dtfCache.set(tz, dtf);
  }
  const p = {};
  for (const { type, value } of dtf.formatToParts(new Date(ms))) p[type] = Number(value);
  return { y: p.year, mo: p.month, d: p.day, h: p.hour === 24 ? 0 : p.hour, mi: p.minute, s: p.second };
}

/** Wall-clock time in `tz` (IANA, 'UTC', or null = local) -> epoch ms. */
export function wallToMs(y, mo, d, h = 0, mi = 0, s = 0, tz = null) {
  if (!tz) return new Date(y, mo - 1, d, h, mi, s).getTime();
  const guess = Date.UTC(y, mo - 1, d, h, mi, s);
  if (tz === 'UTC') return guess;
  const offsetAt = (t) => {
    const p = zoneParts(t, tz);
    return Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi, p.s) - Math.floor(t / 1000) * 1000;
  };
  const o1 = offsetAt(guess);
  let t = guess - o1;
  const o2 = offsetAt(t);
  if (o2 !== o1) t = guess - o2;
  return t;
}

/** Epoch ms -> wall-clock parts in `tz` (null = local). dayNum counts calendar days since 1970-01-01. */
function msToWall(ms, tz) {
  let p;
  if (!tz) {
    const dt = new Date(ms);
    p = { y: dt.getFullYear(), mo: dt.getMonth() + 1, d: dt.getDate(), h: dt.getHours(), mi: dt.getMinutes(), s: dt.getSeconds() };
  } else if (tz === 'UTC') {
    const dt = new Date(ms);
    p = { y: dt.getUTCFullYear(), mo: dt.getUTCMonth() + 1, d: dt.getUTCDate(), h: dt.getUTCHours(), mi: dt.getUTCMinutes(), s: dt.getUTCSeconds() };
  } else {
    p = zoneParts(ms, tz);
  }
  return { ...p, dayNum: Math.round(Date.UTC(p.y, p.mo - 1, p.d) / DAY) };
}

const dayNumToYmd = (n) => {
  const dt = new Date(n * DAY);
  return { y: dt.getUTCFullYear(), mo: dt.getUTCMonth() + 1, d: dt.getUTCDate() };
};
const weekday = (dayNum) => (((dayNum + 4) % 7) + 7) % 7; // 1970-01-01 was a Thursday
const localDayNum = (date) => Math.round(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) / DAY);
const localMidnightMs = (dayNum) => {
  const { y, mo, d } = dayNumToYmd(dayNum);
  return new Date(y, mo - 1, d).getTime();
};

// ---------- values ----------

/**
 * DATE or DATE-TIME value -> {allDay, dayNum, ms, tz, wall}. All-day values are calendar dates
 * (dayNum); timed values carry epoch ms and the zone used for recurrence math.
 */
export function parseDateValue(value, params = {}) {
  const v = String(value || '').trim();
  const dm = /^(\d{4})(\d{2})(\d{2})$/.exec(v);
  if (dm || params.VALUE === 'DATE') {
    const m = dm || /^(\d{4})(\d{2})(\d{2})/.exec(v);
    if (!m) return null;
    const dayNum = Math.round(Date.UTC(+m[1], +m[2] - 1, +m[3]) / DAY);
    return { allDay: true, dayNum, ms: localMidnightMs(dayNum), tz: null };
  }
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})?(Z)?$/i.exec(v);
  if (!m) return null;
  const [y, mo, d, h, mi] = [+m[1], +m[2], +m[3], +m[4], +m[5]];
  const s = m[6] ? +m[6] : 0;
  const tz = m[7] ? 'UTC' : resolveTzid(params.TZID);
  const ms = wallToMs(y, mo, d, h, mi, s, tz);
  return { allDay: false, ms, tz, wall: { h, mi, s }, dayNum: Math.round(Date.UTC(y, mo - 1, d) / DAY) };
}

/** "PT1H30M" / "P1D" / "-PT15M" -> ms. */
export function parseDuration(v) {
  const m = /^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/i.exec(String(v || '').trim());
  if (!m) return null;
  const ms = ((+m[2] || 0) * 7 * DAY) + ((+m[3] || 0) * DAY) + ((+m[4] || 0) * 3600000) + ((+m[5] || 0) * 60000) + ((+m[6] || 0) * 1000);
  return m[1] === '-' ? -ms : ms;
}

/** RRULE value -> simple rule, or null when it uses anything beyond DAILY/WEEKLY basics. */
export function parseRrule(value) {
  const parts = {};
  for (const kv of String(value || '').split(';')) {
    const [k, v] = kv.split('=');
    if (k && v !== undefined) parts[k.trim().toUpperCase()] = v.trim();
  }
  if (!['DAILY', 'WEEKLY'].includes(parts.FREQ)) return null;
  if (Object.keys(parts).some((k) => !SIMPLE_RRULE_PARTS.has(k))) return null;
  const interval = parts.INTERVAL ? Number(parts.INTERVAL) : 1;
  if (!Number.isInteger(interval) || interval < 1) return null;
  let byday = null;
  if (parts.BYDAY) {
    byday = new Set();
    for (const d of parts.BYDAY.split(',')) {
      const code = d.trim().toUpperCase();
      if (!(code in WEEKDAYS)) return null; // "1MO", "-1FR": monthly-style, not simple
      byday.add(WEEKDAYS[code]);
    }
  }
  const count = parts.COUNT ? Number(parts.COUNT) : null;
  if (count !== null && (!Number.isInteger(count) || count < 1)) return null;
  const until = parts.UNTIL ? parseDateValue(parts.UNTIL, {}) : null;
  if (parts.UNTIL && !until) return null;
  const wkst = parts.WKST ? WEEKDAYS[parts.WKST.toUpperCase()] ?? 1 : 1;
  return { freq: parts.FREQ, interval, byday, count, until, wkst };
}

/** Does the rule produce an occurrence on calendar day `d` (event-local), given first day `s`? */
function ruleMatchesDay(rule, s, d, firstWeekday) {
  if (d < s) return false;
  const wd = weekday(d);
  if (rule.freq === 'DAILY') {
    if ((d - s) % rule.interval !== 0) return false;
    return !rule.byday || rule.byday.has(wd);
  }
  const days = rule.byday || new Set([firstWeekday]);
  if (!days.has(wd)) return false;
  const weekStart = (x) => x - ((weekday(x) - rule.wkst + 7) % 7);
  const weeks = Math.round((weekStart(d) - weekStart(s)) / 7);
  return weeks % rule.interval === 0;
}

// ---------- calendar ----------

function readEvents(text) {
  const lines = unfold(text).split('\n');
  const events = [];
  let cur = null;
  let depth = 0; // nested components inside VEVENT (VALARM)
  for (const raw of lines) {
    const line = raw.trimEnd();
    if (!line) continue;
    const upper = line.toUpperCase();
    if (upper === 'BEGIN:VEVENT') {
      cur = { exdates: [] };
      depth = 0;
      continue;
    }
    if (!cur) continue;
    if (upper === 'END:VEVENT') {
      events.push(cur);
      cur = null;
      continue;
    }
    if (upper.startsWith('BEGIN:')) depth++;
    else if (upper.startsWith('END:')) depth = Math.max(0, depth - 1);
    if (depth > 0 || upper.startsWith('END:')) continue;
    const p = parseLine(line);
    if (!p) continue;
    switch (p.name) {
      case 'UID': cur.uid = p.value.trim(); break;
      case 'SUMMARY': cur.summary = unescapeText(p.value).trim(); break;
      case 'DTSTART': cur.dtstart = parseDateValue(p.value, p.params); break;
      case 'DTEND': cur.dtend = parseDateValue(p.value, p.params); break;
      case 'DURATION': cur.duration = parseDuration(p.value); break;
      case 'RRULE': cur.rruleRaw = p.value; cur.rrule = parseRrule(p.value); break;
      case 'RECURRENCE-ID': cur.recurrenceId = parseDateValue(p.value, p.params); break;
      case 'STATUS': cur.status = p.value.trim().toUpperCase(); break;
      case 'EXDATE':
        for (const v of p.value.split(',')) {
          const x = parseDateValue(v, p.params);
          if (x) cur.exdates.push(x);
        }
        break;
      default:
        break;
    }
  }
  return events;
}

/** X-WR-CALNAME, if the feed has one. */
export function calendarName(text) {
  const m = /^X-WR-CALNAME(?:;[^:]*)?:(.*)$/im.exec(unfold(text));
  return m ? unescapeText(m[1]).trim() : '';
}

/**
 * ICS text -> today's remaining events (end after `now`, start before local midnight), sorted.
 * All-day events that cover today are included with allDay: true. Pure: no I/O, no globals.
 */
export function parseICS(text, now = new Date()) {
  const nowMs = now.getTime();
  const today = localDayNum(now);
  const dayEndMs = localMidnightMs(today + 1);
  const raw = readEvents(text).filter((e) => e.dtstart);

  // RECURRENCE-ID overrides replace one instance of a recurring series.
  const overrides = new Map();
  for (const e of raw) {
    if (!e.recurrenceId || !e.uid) continue;
    if (!overrides.has(e.uid)) overrides.set(e.uid, { ms: new Set(), days: new Set() });
    const o = overrides.get(e.uid);
    if (e.recurrenceId.allDay) o.days.add(e.recurrenceId.dayNum);
    else o.ms.add(e.recurrenceId.ms);
  }

  const out = [];
  const push = (e, startMs, endMs, allDay, startDay, endDay) => {
    if (allDay) {
      if (!(startDay <= today && today < endDay)) return;
    } else if (!(endMs > nowMs && startMs < dayEndMs) && !(endMs === startMs && startMs >= nowMs && startMs < dayEndMs)) {
      return;
    }
    out.push({
      id: `ics-${e.uid || e.summary || 'event'}-${allDay ? startDay : startMs}`,
      title: e.summary || '(busy)',
      start: new Date(allDay ? localMidnightMs(startDay) : startMs).toISOString(),
      end: new Date(allDay ? localMidnightMs(endDay) : endMs).toISOString(),
      allDay,
      source: 'ics',
    });
  };

  for (const e of raw) {
    if (e.status === 'CANCELLED') continue;
    const st = e.dtstart;
    if (st.allDay) {
      const lenDays = e.dtend?.allDay ? Math.max(1, e.dtend.dayNum - st.dayNum) : e.duration ? Math.max(1, Math.round(e.duration / DAY)) : 1;
      if (e.rrule && !e.recurrenceId) {
        expand(e, st.dayNum, lenDays, (d) => push(e, 0, 0, true, d, d + lenDays));
      } else {
        push(e, 0, 0, true, st.dayNum, st.dayNum + lenDays);
      }
      continue;
    }
    const durMs = e.dtend && !e.dtend.allDay ? Math.max(0, e.dtend.ms - st.ms) : e.duration != null ? Math.max(0, e.duration) : 0;
    if (e.rrule && !e.recurrenceId) {
      const tz = st.tz;
      const firstLocal = msToWall(st.ms, tz);
      const from = msToWall(Math.min(nowMs, localMidnightMs(today)), tz).dayNum - 1 - Math.ceil(durMs / DAY);
      const to = msToWall(dayEndMs, tz).dayNum;
      expand(e, firstLocal.dayNum, 0, (d) => {
        const { y, mo, d: dd } = dayNumToYmd(d);
        const startMs = wallToMs(y, mo, dd, firstLocal.h, firstLocal.mi, firstLocal.s, tz);
        push(e, startMs, startMs + durMs, false);
        return startMs;
      }, { from, to, tz });
    } else {
      push(e, st.ms, st.ms + durMs, false);
    }
  }

  function expand(e, startDay, lenDays, emit, range) {
    const rule = e.rrule;
    const first = weekday(startDay);
    const from = range ? range.from : today - (lenDays - 1);
    const to = range ? range.to : today;
    const ov = overrides.get(e.uid);
    const exMs = new Set(e.exdates.filter((x) => !x.allDay).map((x) => x.ms));
    const exDays = new Set(e.exdates.filter((x) => x.allDay).map((x) => x.dayNum));
    for (let d = Math.max(from, startDay); d <= to; d++) {
      if (!ruleMatchesDay(rule, startDay, d, first)) continue;
      if (rule.count) {
        let n = 0;
        for (let k = startDay; k <= d && n <= rule.count; k++) if (ruleMatchesDay(rule, startDay, k, first)) n++;
        if (n > rule.count) break;
      }
      if (rule.until?.allDay && d > rule.until.dayNum) break;
      if (rule.until && !rule.until.allDay && !range && localMidnightMs(d) > rule.until.ms) break;
      if (range) {
        const { y, mo, d: dd } = dayNumToYmd(d);
        const st = e.dtstart;
        const w = msToWall(st.ms, range.tz);
        const occMs = wallToMs(y, mo, dd, w.h, w.mi, w.s, range.tz);
        if (rule.until && !rule.until.allDay && occMs > rule.until.ms) break;
        if (exMs.has(occMs) || exDays.has(d)) continue;
        if (ov && (ov.ms.has(occMs) || ov.days.has(d))) continue;
      } else {
        if (exDays.has(d) || exMs.has(localMidnightMs(d))) continue;
        if (ov && ov.days.has(d)) continue;
      }
      emit(d);
    }
  }

  return out.sort((a, b) => (a.allDay === b.allDay ? a.start.localeCompare(b.start) : a.allDay ? -1 : 1));
}

// ---------- browser glue ----------

function toWorkspace(text, label) {
  const events = parseICS(text, new Date());
  return { source: 'ics', account: calendarName(text) || label || null, emails: [], events, tasks: [] };
}

/** Fetches an ICS/webcal link through our /api/ics proxy (the link is a secret; it is not stored). */
export async function connectICS({ url } = {}) {
  const u = String(url || '').trim();
  if (!u) throw new Error('Paste your calendar\'s ICS link first (it starts with https:// or webcal://).');
  if (!/^(https|webcal):\/\//i.test(u)) throw new Error('That does not look like an ICS link. It should start with https:// or webcal://.');
  const r = await fetch(`/api/ics?url=${encodeURIComponent(u)}`, { headers: { Accept: 'text/calendar' } });
  if (!r.ok) {
    const body = await r.json().catch(() => null);
    throw new Error(body?.error || `Could not fetch that calendar (HTTP ${r.status}).`);
  }
  const text = await r.text();
  if (!/BEGIN:VCALENDAR/i.test(text)) throw new Error('That link did not return an ICS calendar.');
  return toWorkspace(text, 'ICS calendar');
}

/** Reads an uploaded .ics file entirely in the browser. */
export async function connectICSFile(file) {
  if (!file) throw new Error('Choose an .ics file first.');
  if (file.size > MAX_ICS_BYTES) throw new Error('That .ics file is over 2 MB. Export a smaller date range.');
  const text = await file.text();
  if (!/BEGIN:VCALENDAR/i.test(text)) throw new Error('That file is not an ICS calendar (no BEGIN:VCALENDAR).');
  return toWorkspace(text, file.name);
}
