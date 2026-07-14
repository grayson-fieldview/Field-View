-- S46 GHL lifecycle integration — run against production BEFORE deploying code.
-- (Drizzle columns: users.smsConsentAt, accounts.activatedAt in shared/models/auth.ts)
ALTER TABLE users ADD COLUMN IF NOT EXISTS sms_consent_at TIMESTAMP NULL;
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS activated_at TIMESTAMP NULL;

-- Legacy owner_id backfill: the OAuth self-serve path never stamped
-- accounts.owner_id (only /api/register did), so pre-fix OAuth accounts have
-- owner_id NULL and would be skipped by owner-gated events (and the HubSpot
-- sync). Assumption (verified in dev: 0 mismatches among stamped accounts):
-- the earliest non-deleted user of an account is its self-serve creator —
-- invitees are always created after the creator.
UPDATE accounts a
SET owner_id = e.id
FROM (
  SELECT DISTINCT ON (account_id) account_id, id
  FROM users
  WHERE account_id IS NOT NULL AND deleted_at IS NULL
  ORDER BY account_id, created_at ASC, id ASC
) e
WHERE a.id = e.account_id
  AND a.owner_id IS NULL;
