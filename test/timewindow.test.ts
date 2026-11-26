// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";
import { parseTimeWindow } from "../src/timewindow";

// Thursday, 26 November 2026, 10:00 UTC
const now = Date.UTC(2026, 10, 26, 10);
const day = (y: number, m: number, d: number) => Date.UTC(y, m - 1, d);
const w = (q: string) => {
  const r = parseTimeWindow(q, now);
  return r && [new Date(r.from).toISOString().slice(0, 10), new Date(r.to - 1).toISOString().slice(0, 10)];
};

describe("parseTimeWindow", () => {
  it("returns null without a time expression", () => {
    expect(parseTimeWindow("which license do I use", now)).toBeNull();
    expect(parseTimeWindow("you may deploy with wrangler", now)).toBeNull();
    expect(parseTimeWindow("Node 26 in 2 repos", now)).toBeNull();
  });

  it("understands days in English and German", () => {
    expect(w("what did we decide yesterday")).toEqual(["2026-11-25", "2026-11-25"]);
    expect(w("was haben wir gestern entschieden")).toEqual(["2026-11-25", "2026-11-25"]);
    expect(w("vorgestern")).toEqual(["2026-11-24", "2026-11-24"]);
    expect(w("today's deploy")).toEqual(["2026-11-26", "2026-11-26"]);
    expect(w("3 days ago")).toEqual(["2026-11-23", "2026-11-23"]);
    expect(w("vor drei Tagen")).toEqual(["2026-11-23", "2026-11-23"]);
  });

  it("understands weeks, months and years", () => {
    expect(w("last week")).toEqual(["2026-11-16", "2026-11-22"]);
    expect(w("letzte Woche")).toEqual(["2026-11-16", "2026-11-22"]);
    expect(w("in der vergangenen Woche")).toEqual(["2026-11-16", "2026-11-22"]);
    expect(w("this week")).toEqual(["2026-11-23", "2026-11-26"]);
    expect(w("letzten Monat")).toEqual(["2026-10-01", "2026-10-31"]);
    expect(w("letztes Jahr")).toEqual(["2025-01-01", "2025-12-31"]);
    expect(w("vor einer Woche")).toEqual(["2026-11-16", "2026-11-22"]);
    expect(w("in the last 10 days")).toEqual(["2026-11-16", "2026-11-26"]);
    expect(w("in den letzten zwei Wochen")).toEqual(["2026-11-12", "2026-11-26"]);
    expect(w("in 2025")).toEqual(["2025-01-01", "2025-12-31"]);
  });

  it("understands month names and dates", () => {
    expect(w("im März")).toEqual(["2026-03-01", "2026-03-31"]);
    expect(w("in December")).toEqual(["2025-12-01", "2025-12-31"]);
    expect(w("March 2025")).toEqual(["2025-03-01", "2025-03-31"]);
    expect(w("am 14. März")).toEqual(["2026-03-14", "2026-03-14"]);
    expect(w("on March 14th, 2025")).toEqual(["2025-03-14", "2025-03-14"]);
    expect(w("2026-03-14")).toEqual(["2026-03-14", "2026-03-14"]);
    expect(w("am 14.03.2026")).toEqual(["2026-03-14", "2026-03-14"]);
    expect(w("2026-02")).toEqual(["2026-02-01", "2026-02-28"]);
    expect(parseTimeWindow("2026-02-30", now)).toBeNull();
  });

  it("understands weekdays", () => {
    expect(w("last Monday")).toEqual(["2026-11-23", "2026-11-23"]);
    expect(w("letzten Donnerstag")).toEqual(["2026-11-19", "2026-11-19"]);
    expect(w("am Donnerstag")).toEqual(["2026-11-26", "2026-11-26"]);
    expect(w("on friday")).toEqual(["2026-11-20", "2026-11-20"]);
  });

  it("stretches since and cuts before", () => {
    expect(w("since March")).toEqual(["2026-03-01", "2026-11-26"]);
    expect(w("seit letzter Woche")).toEqual(["2026-11-16", "2026-11-26"]);
    const before = parseTimeWindow("before March 2026", now)!;
    expect(before.from).toBe(0);
    expect(before.to).toBe(day(2026, 3, 1));
  });

  it("treats recently as the last 30 days and never reaches past now", () => {
    const r = parseTimeWindow("what did I say recently about rhizome", now)!;
    expect(r.to).toBe(now + 1);
    expect(r.from).toBe(now - 30 * 86_400_000);
    expect(parseTimeWindow("neulich", now)).not.toBeNull();
    expect(parseTimeWindow("on 2027-01-05", now)).toBeNull();
  });
});
