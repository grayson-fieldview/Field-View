// Single source of truth for email normalization: trim + lowercase.
// Null/undefined pass through untouched so callers can keep their own
// missing-value handling. Apply at EVERY user-email lookup, write, and
// comparison site — mixed-case legacy rows plus the case-sensitive
// unique index on users.email is how duplicate accounts happened.
export function normalizeEmail(email: string): string;
export function normalizeEmail(email: null): null;
export function normalizeEmail(email: undefined): undefined;
export function normalizeEmail(email: string | null | undefined): string | null | undefined;
export function normalizeEmail(email: string | null | undefined): string | null | undefined {
  if (email == null) return email;
  return String(email).trim().toLowerCase();
}
