/** Formats a duration in milliseconds for log lines, e.g. 3_723_000 -> "1h 2m 3s". */
export function formatDuration(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return [hours ? `${hours}h` : "", minutes ? `${minutes}m` : "", `${seconds}s`]
    .filter(Boolean)
    .join(" ");
}

/** Formats a USD amount for review footers: 4 decimals below one cent, 2 otherwise. */
export function formatUsd(amount: number): string {
  return amount < 0.01 ? `$${amount.toFixed(4)}` : `$${amount.toFixed(2)}`;
}
