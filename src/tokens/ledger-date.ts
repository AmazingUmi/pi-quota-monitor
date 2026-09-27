/** A ledger filename records the writer's local calendar day. The writer may
 * have been in another time zone when the reader later scans the file.
 * Civil-day offsets worldwide range from UTC-12 through UTC+14. */
export function ledgerDateMatches(timestamp: number, day: string): boolean {
  const start = Date.parse(`${day}T00:00:00Z`);
  return Number.isFinite(timestamp) && Number.isFinite(start)
    && new Date(start).toISOString().slice(0, 10) === day
    && timestamp >= start - 14 * 3_600_000
    && timestamp < start + 36 * 3_600_000;
}
