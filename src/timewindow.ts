// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Turns English and German time expressions in a recall query ("last week",
// "letzten Monat", "im März", "vor 3 Tagen", "since Monday") into a time window,
// without a language model. Days and weeks are UTC; weeks start on Monday.

export interface TimeWindow {
  /** Inclusive start, epoch milliseconds. */
  from: number;
  /** Exclusive end, epoch milliseconds. */
  to: number;
  /** The words of the query that produced the window (lowercase, without diacritics). */
  text: string;
}

const DAY = 86_400_000;

const MONTHS: Record<string, number> = {
  january: 0, jan: 0, januar: 0, janner: 0,
  february: 1, feb: 1, februar: 1,
  march: 2, mar: 2, marz: 2, maerz: 2,
  april: 3, apr: 3,
  may: 4, mai: 4,
  june: 5, jun: 5, juni: 5,
  july: 6, jul: 6, juli: 6,
  august: 7, aug: 7,
  september: 8, sep: 8, sept: 8,
  october: 9, oct: 9, oktober: 9, okt: 9,
  november: 10, nov: 10,
  december: 11, dec: 11, dezember: 11, dez: 11,
};

const WEEKDAYS: Record<string, number> = {
  sunday: 0, sonntag: 0,
  monday: 1, montag: 1,
  tuesday: 2, dienstag: 2,
  wednesday: 3, mittwoch: 3,
  thursday: 4, donnerstag: 4,
  friday: 5, freitag: 5,
  saturday: 6, samstag: 6, sonnabend: 6,
};

const NUMBERS: Record<string, number> = {
  a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, twelve: 12,
  ein: 1, eine: 1, einem: 1, einer: 1, einen: 1, zwei: 2, drei: 3, vier: 4, funf: 5, sechs: 6, sieben: 7, acht: 8, neun: 9, zehn: 10, zwolf: 12,
  couple: 2, paar: 3, few: 3,
};

type Unit = "day" | "week" | "month" | "year";

function unitOf(word: string): Unit | null {
  if (/^(days?|tage?n?|tages)$/.test(word)) return "day";
  if (/^(weeks?|wochen?)$/.test(word)) return "week";
  if (/^(months?|monate?n?|monats)$/.test(word)) return "month";
  if (/^(years?|jahre?n?|jahres)$/.test(word)) return "year";
  return null;
}

function num(word: string): number | null {
  if (/^\d{1,3}$/.test(word)) return Number(word);
  return NUMBERS[word] ?? null;
}

function startOfDay(t: number): number {
  return Math.floor(t / DAY) * DAY;
}

function startOfWeek(t: number): number {
  const d = startOfDay(t);
  const weekday = (new Date(d).getUTCDay() + 6) % 7; // Monday = 0
  return d - weekday * DAY;
}

function monthWindow(year: number, month: number): [number, number] {
  return [Date.UTC(year, month, 1), Date.UTC(year, month + 1, 1)];
}

/** The window of one calendar unit that contains `t`. */
function unitWindow(unit: Unit, t: number): [number, number] {
  const d = new Date(t);
  switch (unit) {
    case "day":
      return [startOfDay(t), startOfDay(t) + DAY];
    case "week":
      return [startOfWeek(t), startOfWeek(t) + 7 * DAY];
    case "month":
      return monthWindow(d.getUTCFullYear(), d.getUTCMonth());
    case "year":
      return [Date.UTC(d.getUTCFullYear(), 0, 1), Date.UTC(d.getUTCFullYear() + 1, 0, 1)];
  }
}

/** `t` moved by n calendar units (negative = back). */
function shift(unit: Unit, t: number, n: number): number {
  const d = new Date(t);
  switch (unit) {
    case "day":
      return t + n * DAY;
    case "week":
      return t + n * 7 * DAY;
    case "month":
      return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + n, Math.min(d.getUTCDate(), 28));
    case "year":
      return Date.UTC(d.getUTCFullYear() + n, d.getUTCMonth(), Math.min(d.getUTCDate(), 28));
  }
}

/** Most recent month with this index that has started by `now`. */
function recentMonth(month: number, now: number): number {
  const d = new Date(now);
  return month <= d.getUTCMonth() ? d.getUTCFullYear() : d.getUTCFullYear() - 1;
}

function validDay(year: number, month: number, day: number): [number, number] | null {
  const t = Date.UTC(year, month, day);
  const d = new Date(t);
  if (d.getUTCMonth() !== month || d.getUTCDate() !== day) return null;
  return [t, t + DAY];
}

type Rule = { re: RegExp; window: (m: RegExpExecArray, now: number) => [number, number] | null };

const MONTH_NAMES = Object.keys(MONTHS).sort((a, b) => b.length - a.length).join("|");
const WEEKDAY_NAMES = Object.keys(WEEKDAYS).join("|");
const NUMBER_WORDS = `\\d{1,3}|${Object.keys(NUMBERS).sort((a, b) => b.length - a.length).join("|")}`;
const UNIT_WORDS = "days?|weeks?|months?|years?|tagen?|tage|wochen?|monaten?|monate|jahren?|jahre";

// Most specific first. Every rule runs on folded text (lowercase, no diacritics).
const RULES: Rule[] = [
  // 2026-03-14, 14.03.2026, 14.3.26
  {
    re: /\b(\d{4})-(\d{2})-(\d{2})\b/g,
    window: (m) => validDay(Number(m[1]), Number(m[2]) - 1, Number(m[3])),
  },
  {
    re: /\b(\d{1,2})\.(\d{1,2})\.(\d{4}|\d{2})\b/g,
    window: (m) => validDay(m[3]!.length === 2 ? 2000 + Number(m[3]) : Number(m[3]), Number(m[2]) - 1, Number(m[1])),
  },
  // 2026-03
  {
    re: /\b(\d{4})-(\d{2})\b(?!-)/g,
    window: (m) => (Number(m[2]) >= 1 && Number(m[2]) <= 12 ? monthWindow(Number(m[1]), Number(m[2]) - 1) : null),
  },
  // 14 march 2026, 14. marz, am 14. marz
  {
    re: new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th|\\.)?\\s+(?:of\\s+)?(${MONTH_NAMES})\\b\\.?(?:,?\\s+(\\d{4}))?`, "g"),
    window: (m, now) => {
      const month = MONTHS[m[2]!]!;
      return validDay(m[3] ? Number(m[3]) : recentMonth(month, now), month, Number(m[1]));
    },
  },
  // march 14, march 14th 2026
  {
    re: new RegExp(`\\b(${MONTH_NAMES})\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b(?!\\d)(?:,?\\s+(\\d{4}))?`, "g"),
    window: (m, now) => {
      const month = MONTHS[m[1]!]!;
      return validDay(m[3] ? Number(m[3]) : recentMonth(month, now), month, Number(m[2]));
    },
  },
  // march 2026, im marz 2026
  {
    re: new RegExp(`\\b(${MONTH_NAMES})\\s+(\\d{4})\\b`, "g"),
    window: (m) => monthWindow(Number(m[2]), MONTHS[m[1]!]!),
  },
  // in march, im marz, during may (a bare month name needs a preposition; "may" is also a verb)
  {
    re: new RegExp(`\\b(?:in|im|during|seit|since|until|bis|before)\\s+(?:the\\s+month\\s+of\\s+|monat\\s+)?(${MONTH_NAMES})\\b`, "g"),
    window: (m, now) => {
      const month = MONTHS[m[1]!]!;
      return monthWindow(recentMonth(month, now), month);
    },
  },
  // in 2025, im jahr 2025, year 2025
  {
    re: /\b(?:in|im|year|jahr|during)\s+(?:jahr\s+|year\s+)?((?:19|20)\d{2})\b/g,
    window: (m) => [Date.UTC(Number(m[1]), 0, 1), Date.UTC(Number(m[1]) + 1, 0, 1)],
  },
  // 3 days ago, a week ago, vor 3 tagen, vor einer woche
  {
    re: new RegExp(`\\b(${NUMBER_WORDS})\\s+(${UNIT_WORDS})\\s+ago\\b`, "g"),
    window: (m, now) => ago(m[1]!, m[2]!, now),
  },
  {
    re: new RegExp(`\\bvor\\s+(${NUMBER_WORDS})\\s+(${UNIT_WORDS})\\b`, "g"),
    window: (m, now) => ago(m[1]!, m[2]!, now),
  },
  // the last 3 days, past two weeks, in den letzten 3 tagen, vergangene 2 wochen
  {
    re: new RegExp(`\\b(?:last|past|previous|letzten|letzte|vergangenen|vergangene|zuruckliegenden)\\s+(${NUMBER_WORDS})\\s+(${UNIT_WORDS})\\b`, "g"),
    window: (m, now) => {
      const n = num(m[1]!);
      const unit = unitOf(m[2]!);
      if (n === null || !unit || n < 1) return null;
      return [shift(unit, now, -n), now + 1];
    },
  },
  // day before yesterday, vorgestern, yesterday, gestern, today, heute
  { re: /\b(?:day before yesterday|vorgestern)\b/g, window: (_m, now) => unitWindow("day", now - 2 * DAY) },
  { re: /\b(?:yesterday|gestern)\b/g, window: (_m, now) => unitWindow("day", now - DAY) },
  { re: /\b(?:today|heute|this morning|heute morgen|tonight|heute abend)\b/g, window: (_m, now) => unitWindow("day", now) },
  // last monday, letzten montag, on friday, am freitag
  {
    re: new RegExp(`\\b(last|previous|letzten|letzter|vergangenen|vorigen|on|am|this|diesen)\\s+(${WEEKDAY_NAMES})\\b`, "g"),
    window: (m, now) => {
      const target = WEEKDAYS[m[2]!]!;
      const today = new Date(startOfDay(now)).getUTCDay();
      let back = (today - target + 7) % 7;
      if (back === 0 && /^(last|previous|letzten|letzter|vergangenen|vorigen)$/.test(m[1]!)) back = 7;
      return unitWindow("day", now - back * DAY);
    },
  },
  // last week, letzte woche, last month, letzten monat, last year, letztes jahr
  {
    re: /\b(?:last|previous|letzte|letzten|letzter|letztes|vergangene|vergangenen|vergangenes|vorige|vorigen|voriges)\s+(week|woche|month|monat|year|jahr)\b/g,
    window: (m, now) => {
      const unit = unitOf(m[1]!)!;
      return unitWindow(unit, shift(unit, now, -1));
    },
  },
  // this week, diese woche, this month, diesen monat, this year, dieses jahr
  {
    re: /\b(?:this|current|diese|dieser|diesen|dieses|in dieser|in diesem)\s+(week|woche|month|monat|year|jahr)\b/g,
    window: (m, now) => {
      const unit = unitOf(m[1]!)!;
      return [unitWindow(unit, now)[0], now + 1];
    },
  },
  // recently, lately, kurzlich, neulich, vor kurzem: the last 30 days
  {
    re: /\b(?:recently|lately|the other day|kurzlich|neulich|vor kurzem|letztens|in letzter zeit)\b/g,
    window: (_m, now) => [now - 30 * DAY, now + 1],
  },
];

function ago(numberWord: string, unitWord: string, now: number): [number, number] | null {
  const n = num(numberWord);
  const unit = unitOf(unitWord);
  if (n === null || !unit) return null;
  return unitWindow(unit, shift(unit, now, -n));
}

function fold(text: string): string {
  return text.normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/ß/g, "ss").toLowerCase();
}

/**
 * The time window a query talks about, or null when it names none. The first
 * (most specific) rule that matches wins. "since X" / "seit X" stretches the
 * window to now; "before X" / "until X" / "bis X" ends it where X starts.
 * Windows never reach past `now`.
 */
export function parseTimeWindow(query: string, now = Date.now()): TimeWindow | null {
  const text = fold(query);
  for (const rule of RULES) {
    rule.re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = rule.re.exec(text))) {
      const w = rule.window(m, now);
      if (!w || !(w[0] < w[1])) continue;
      let [from, to] = w;
      const before = text.slice(Math.max(0, m.index - 12), m.index);
      const lead = m[0];
      if (/\b(?:since|seit)\s*$/.test(before) || /^(?:since|seit)\b/.test(lead)) to = now + 1;
      else if (/\b(?:before|until|till|bis(?: zum| zur)?)\s*$/.test(before) || /^(?:before|until|bis)\b/.test(lead)) {
        to = from;
        from = 0;
      }
      if (from > now) continue; // a future window has nothing to recall
      to = Math.min(to, now + 1);
      if (!(from < to)) continue;
      return { from, to, text: m[0].trim() };
    }
  }
  return null;
}

/**
 * A time range given by an agent as ISO dates or times (or epoch milliseconds).
 * A date without a time is a whole UTC day, so to = "2026-11-20" includes that
 * day. Returns undefined for a missing bound and throws on an invalid one.
 */
export function parseRangeBound(value: unknown, end: boolean): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("invalid time");
    return value;
  }
  if (typeof value !== "string" || value.length > 40) throw new Error("invalid time");
  const t = Date.parse(value);
  if (!Number.isFinite(t)) throw new Error("invalid time");
  return end && /^\d{4}-\d{2}-\d{2}$/.test(value.trim()) ? t + DAY : t;
}
