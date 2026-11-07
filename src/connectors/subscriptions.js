// Detects recurring charges ("Last Call") in receipt-style emails. Pure, no I/O.
//   parseRecurring({from, subject, snippet}) -> {name, amount, period: 'mo'|'yr'} | null

const MONTH_RE = /(?:\/\s?|\bper\s|\ba\s|\bevery\s)?\b(?:month|monthly|mo|mth)\b/i;
const YEAR_RE = /(?:\/\s?|\bper\s|\ba\s|\bevery\s)?\b(?:year|yearly|annual|annually|yr)\b/i;
const RECURRING_HINT_RE = /\b(?:subscription|subscribed|renewal|renews?|renewed|membership|recurring|auto-?renew)\b/i;
// Words that make a display name a mailbox label, not a merchant ("Receipts", "Billing Team").
const GENERIC_NAME_RE = /^(?:no-?reply|do-?not-?reply|receipts?|billing|payments?|invoices?|orders?|support|team|notifications?|accounts?|info|hello|mail|store|service)$/i;
const TRAILING_GENERIC_RE = /\s+(?:billing|receipts?|payments?|invoices?|orders?|support|team|notifications?|accounts?)(?:\s+team)?$/i;
const SLD_GENERIC = new Set(['co', 'com', 'org', 'net', 'ac', 'gov', 'edu']);
const SUBDOMAIN_NOISE = new Set(['email', 'mail', 'e', 'em', 'info', 'news', 'billing', 'receipts', 'account', 'accounts', 'notifications', 'mailer', 'mg', 'send', 'reply', 'no-reply', 'noreply']);

/** Splits `"Name" <addr@x.com>` into {name, email}. */
export function splitFrom(from) {
  const str = String(from || '').trim();
  const m = /^(.*?)\s*<([^>]+)>\s*$/.exec(str);
  if (m) return { name: m[1].replace(/^["']|["']$/g, '').trim(), email: m[2].trim().toLowerCase() };
  if (str.includes('@')) return { name: '', email: str.toLowerCase() };
  return { name: str, email: '' };
}

const titleCase = (w) => (w ? w.charAt(0).toUpperCase() + w.slice(1) : w);

/** "billing@email.netflix.co.uk" -> "Netflix". */
export function merchantFromDomain(email) {
  const host = String(email || '').split('@')[1] || '';
  const labels = host.toLowerCase().split('.').filter(Boolean);
  if (labels.length === 0) return '';
  let i = labels.length - 2;
  if (i >= 1 && labels[labels.length - 1].length === 2 && SLD_GENERIC.has(labels[i])) i -= 1;
  if (i < 0) i = 0;
  while (i > 0 && SUBDOMAIN_NOISE.has(labels[i])) i -= 1;
  return titleCase(labels[i]);
}

/** Merchant name from the sender display name, falling back to the domain. */
export function merchantFrom(from) {
  const { name, email } = splitFrom(from);
  let n = name.replace(/\s+via\s+.*$/i, '').replace(TRAILING_GENERIC_RE, '').trim();
  n = n.replace(/^(?:your\s+)?receipt\s+from\s+/i, '').trim();
  if (!n || GENERIC_NAME_RE.test(n) || n.includes('@')) n = merchantFromDomain(email || (name.includes('@') ? name : ''));
  return n.slice(0, 80);
}

/** First money amount in the text. Returns a number or null. */
export function parseAmount(text) {
  const t = String(text || '');
  const num = '(\\d{1,3}(?:[,.\\s]\\d{3})*(?:[.,]\\d{1,2})?|\\d+(?:[.,]\\d{1,2})?)';
  const prefix = new RegExp(`(?:US\\$|\\$|USD\\s?|€|EUR\\s?|£|GBP\\s?)\\s?${num}`, 'i');
  const suffix = new RegExp(`${num}\\s?(?:USD|EUR|GBP|€|£)(?![a-z])`, 'i');
  const m = prefix.exec(t) || suffix.exec(t);
  if (!m) return null;
  return toNumber(m[1]);
}

function toNumber(raw) {
  let s = raw.replace(/\s/g, '');
  // "1,299.00" / "1.299,00" / "9,99" / "9.99"
  const lastSep = Math.max(s.lastIndexOf('.'), s.lastIndexOf(','));
  if (lastSep >= 0 && s.length - lastSep - 1 <= 2) {
    s = s.slice(0, lastSep).replace(/[.,]/g, '') + '.' + s.slice(lastSep + 1);
  } else {
    s = s.replace(/[.,]/g, '');
  }
  const n = Number(s);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : null;
}

/** 'mo' | 'yr' | null. A period word right after the amount wins, then the first one in the text. */
export function parsePeriod(text, amountIndex = -1) {
  const t = String(text || '');
  if (amountIndex >= 0) {
    const near = t.slice(amountIndex, amountIndex + 28);
    const nm = MONTH_RE.exec(near);
    const ny = YEAR_RE.exec(near);
    if (nm || ny) {
      if (nm && ny) return nm.index <= ny.index ? 'mo' : 'yr';
      return nm ? 'mo' : 'yr';
    }
  }
  const m = MONTH_RE.exec(t);
  const y = YEAR_RE.exec(t);
  if (m && y) return m.index <= y.index ? 'mo' : 'yr';
  if (m) return 'mo';
  if (y) return 'yr';
  return null;
}

/**
 * Recurring charge in a receipt email, or null when the email is not a subscription.
 * Needs an amount and either a period word or a subscription/renewal word (defaults to monthly).
 */
export function parseRecurring({ from, subject, snippet } = {}) {
  const text = `${subject || ''} \n ${snippet || ''}`;
  const amount = parseAmount(text);
  if (amount === null || amount <= 0) return null;
  const amountIndex = text.search(/(?:US\$|\$|USD|€|EUR|£|GBP)\s?\d|\d[\d.,]*\s?(?:USD|EUR|GBP|€|£)/i);
  let period = parsePeriod(text, amountIndex);
  if (!period && RECURRING_HINT_RE.test(text)) period = 'mo';
  if (!period) return null;
  const name = merchantFrom(from) || 'Subscription';
  return { name, amount, period };
}
