const RATE_REGEX = /^\d+(\.\d{1,2})?$/;

export function centsToDisplay(cents: number | null | undefined): string {
  if (cents == null) return "—";
  const dollars = cents / 100;
  return `$${dollars.toFixed(2)}`;
}

export function centsToDisplayPerHour(cents: number | null | undefined): string {
  if (cents == null) return "Not set";
  const dollars = cents / 100;
  return `$${dollars.toFixed(2)}/hr`;
}

export function dollarsToCents(input: string): number | null {
  const trimmed = input.trim();
  if (!RATE_REGEX.test(trimmed)) return null;
  const value = parseFloat(trimmed);
  if (!Number.isFinite(value) || value < 0) return null;
  return Math.round(value * 100);
}
