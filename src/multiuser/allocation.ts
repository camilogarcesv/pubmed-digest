// Pure helpers of the multi-user digest: the run's week and the fair split of the scoring budget.

/** ISO-8601 week of a UTC instant, e.g. 2026-W39. Weeks start on Monday; week 1 holds the first Thursday. */
export function isoWeek(date: Date): string {
  const day = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const weekday = day.getUTCDay() || 7;
  day.setUTCDate(day.getUTCDate() + 4 - weekday); // the Thursday of this week decides its year
  const year = day.getUTCFullYear();
  const week = Math.ceil(((day.getTime() - Date.UTC(year, 0, 1)) / 86_400_000 + 1) / 7);
  return `${year}-W${String(week).padStart(2, "0")}`;
}

/**
 * Split a global budget of user-PMID pairs round-robin across users (in the given order), one pair
 * at a time, preserving each user's own candidate order and handing unused shares to the others.
 * A PMID wanted by two users costs two pairs: each is scored against its own profile.
 */
export function allocate<K>(candidates: ReadonlyMap<K, readonly string[]>, budget: number): Map<K, string[]> {
  const out = new Map<K, string[]>([...candidates.keys()].map(k => [k, []]));
  const queues = [...candidates.entries()].map(([k, pmids]) => ({ k, pmids, next: 0 }));
  let left = Math.max(0, Math.floor(budget));
  while (left > 0) {
    let progressed = false;
    for (const q of queues) {
      if (left === 0) break;
      if (q.next >= q.pmids.length) continue;
      out.get(q.k)!.push(q.pmids[q.next++]!);
      left--;
      progressed = true;
    }
    if (!progressed) break;
  }
  return out;
}
