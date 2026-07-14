-- S46 GHL lifecycle integration — run against production BEFORE deploying code.
-- (Drizzle columns: users.smsConsentAt, accounts.activatedAt in shared/models/auth.ts)
ALTER TABLE users ADD COLUMN IF NOT EXISTS sms_consent_at TIMESTAMP NULL;
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS activated_at TIMESTAMP NULL;
