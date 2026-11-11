import { test } from "node:test";
import assert from "node:assert/strict";
import * as Fr from "../js/friends.js";

const at = (y, m, d) => new Date(y, m - 1, d, 12).getTime();

test("chase points: checked photos only, by month", () => {
  const list = [
    { status: "approved", predicted: 68, createdAt: at(2026, 11, 3) },
    { status: "pending", predicted: 90, createdAt: at(2026, 11, 4) },
    { status: "approved", predicted: 40.4, createdAt: at(2026, 10, 28) },
  ];
  assert.equal(Fr.points(list), 108);
  assert.equal(Fr.points(list, "2026-11"), 68);
  assert.equal(Fr.points(list, "2026-10"), 40);
});

test("month streak counts back from this month (or last)", () => {
  const e = (y, m) => ({ t: at(y, m, 10) / 1000 });
  assert.equal(Fr.monthStreak([e(2026, 11), e(2026, 10), e(2026, 9), e(2026, 7)], at(2026, 11, 20)), 3);
  assert.equal(Fr.monthStreak([e(2026, 10), e(2026, 9)], at(2026, 11, 2)), 2);
  assert.equal(Fr.monthStreak([e(2026, 8)], at(2026, 11, 2)), 0);
  assert.equal(Fr.prevMonthKey(at(2026, 1, 5)), "2025-12");
});

test("badges", () => {
  const log = [{ date: "2026-11-01", kind: "sunrise", t: at(2026, 11, 1) / 1000 }, { date: "2026-11-01", kind: "sunset", t: at(2026, 11, 1) / 1000 }];
  const mine = [{ kind: "sunrise", place: "A", predicted: 92 }];
  const got = Fr.earnedBadges(log, mine, at(2026, 11, 2));
  assert.deepEqual([...got].sort(), ["both-ends", "first-photo", "first-sky", "first-sunrise", "ninety"]);
});

test("leaderboard sorts by points for the month", () => {
  const rows = Fr.leaderboard([
    { uid: "a", name: "Ann", list: [{ status: "approved", predicted: 50, createdAt: at(2026, 11, 2) }] },
    { uid: "b", name: "Bob", list: [{ status: "approved", predicted: 70, createdAt: at(2026, 11, 2) }, { status: "approved", predicted: 99, createdAt: at(2026, 10, 2) }] },
  ], "2026-11");
  assert.deepEqual(rows.map(r => [r.name, r.pts, r.photos]), [["Bob", 70, 1], ["Ann", 50, 1]]);
});
