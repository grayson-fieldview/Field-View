import { sql } from "drizzle-orm";
import { boolean, index, integer, jsonb, pgEnum, pgTable, text, timestamp, varchar } from "drizzle-orm/pg-core";
import { z } from "zod";

export const sessions = pgTable(
  "sessions",
  {
    sid: varchar("sid").primaryKey(),
    sess: jsonb("sess").notNull(),
    expire: timestamp("expire").notNull(),
  },
  (table) => [index("IDX_session_expire").on(table.expire)]
);

// S46: account-level default aspect ratio for the in-app camera.
// Underscore labels (4_3 etc.) are the DB-level enum format; the wire format
// (HTTP JSON) uses colons (4:3 etc.). Translation happens in the storage layer
// so route/UI code only ever sees the colon form.
export const photoAspectRatioEnum = pgEnum("photo_aspect_ratio", ["4_3", "1_1", "16_9"]);

export const accounts = pgTable("accounts", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  name: text("name").notNull(),
  ownerId: varchar("owner_id"),
  stripeCustomerId: varchar("stripe_customer_id"),
  stripeSubscriptionId: varchar("stripe_subscription_id"),
  subscriptionStatus: varchar("subscription_status"),
  trialEndsAt: timestamp("trial_ends_at"),
  seatCount: integer("seat_count").default(3),
  billingCycle: varchar("billing_cycle"),
  subscriptionLapsedAt: timestamp("subscription_lapsed_at"),
  industry: varchar("industry"),
  companySize: varchar("company_size"),
  // S46 GHL: idempotency guard for the activation_milestone lifecycle event
  // (≥1 project AND ≥5 photos). Set exactly once via an atomic conditional
  // UPDATE ... WHERE activated_at IS NULL.
  activatedAt: timestamp("activated_at"),
  companyLogoUrl: varchar("company_logo_url"),
  companyLegalName: text("company_legal_name"),
  companyAddress: text("company_address"),
  defaultPhotoAspectRatio: photoAspectRatioEnum("default_photo_aspect_ratio").notNull().default("4_3"),
  deletedAt: timestamp("deleted_at"),
  createdAt: timestamp("created_at").defaultNow(),
}, (table) => [
  index("idx_accounts_deleted_at").on(table.deletedAt),
]);

export const users = pgTable("users", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  email: varchar("email").unique(),
  password: varchar("password"),
  emailVerified: boolean("email_verified").notNull().default(false),
  firstName: varchar("first_name"),
  lastName: varchar("last_name"),
  profileImageUrl: varchar("profile_image_url"),
  authProvider: varchar("auth_provider").default("local"),
  googleId: varchar("google_id").unique(),
  microsoftId: varchar("microsoft_id").unique(),
  role: varchar("role").default("standard"),
  accountId: varchar("account_id").references(() => accounts.id),
  stripeCustomerId: varchar("stripe_customer_id"),
  stripeSubscriptionId: varchar("stripe_subscription_id"),
  subscriptionStatus: varchar("subscription_status").default("none"),
  trialEndsAt: timestamp("trial_ends_at"),
  termsAcceptedAt: timestamp("terms_accepted_at"),
  termsVersion: text("terms_version"),
  timesheetEnabled: boolean("timesheet_enabled").notNull().default(false),
  autoTrackingEnabled: boolean("auto_tracking_enabled").notNull().default(true),
  hourlyRateCents: integer("hourly_rate_cents"),
  phone: varchar("phone"),
  profileCompletedAt: timestamp("profile_completed_at"),
  // S46 GHL: A2P/TCPA SMS consent timestamp. Set when the user checks the
  // consent box on the Complete Setup page (tcpaAccepted in PATCH
  // /api/auth/me). Previously the checkbox was client-side only.
  smsConsentAt: timestamp("sms_consent_at"),
  verificationCode: varchar("verification_code", { length: 6 }),
  verificationCodeExpiresAt: timestamp("verification_code_expires_at"),
  verificationCodeAttempts: integer("verification_code_attempts").notNull().default(0),
  verificationCodeSentAt: timestamp("verification_code_sent_at"),
  expoPushToken: varchar("expo_push_token", { length: 255 }),
  // S43 Rewardful: cached affiliate id + referral URL so we don't have to
  // round-trip Rewardful's API on every modal open. Both populated lazily
  // on first GET /api/me/referral; created in Rewardful campaign
  // "Friends of Field View".
  rewardfulAffiliateId: varchar("rewardful_affiliate_id", { length: 64 }),
  rewardfulReferralUrl: varchar("rewardful_referral_url", { length: 255 }),
  // S45 Customer.io signup attribution — captured from query params /
  // document.referrer at /api/register (frontend capture lands in Phase 3).
  signupReferrer: varchar("signup_referrer"),
  signupUtmSource: varchar("signup_utm_source"),
  signupUtmMedium: varchar("signup_utm_medium"),
  signupUtmCampaign: varchar("signup_utm_campaign"),
  // S46 Meta Pixel + Conversions API attribution — captured by
  // server/middleware/attribution.ts (first-touch UTM/fbclid via
  // req.session.attribution; fbp/fbc from cookies) and persisted at /api/register.
  signupUtmContent: varchar("signup_utm_content"),
  signupUtmTerm: varchar("signup_utm_term"),
  signupFbclid: varchar("signup_fbclid"),
  signupFbp: varchar("signup_fbp"),
  signupFbc: varchar("signup_fbc"),
  // S45 last_active_at — touched by touch-last-active middleware on every
  // authenticated request, throttled to 1 write/user/60s.
  lastActiveAt: timestamp("last_active_at"),
  deletedAt: timestamp("deleted_at"),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
}, (table) => [
  index("users_account_id_idx").on(table.accountId),
  index("idx_users_deleted_at").on(table.deletedAt),
]);

export const passwordResetTokens = pgTable("password_reset_tokens", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  userId: varchar("user_id").references(() => users.id, { onDelete: "cascade" }).notNull(),
  token: varchar("token").notNull().unique(),
  expiresAt: timestamp("expires_at").notNull(),
  usedAt: timestamp("used_at"),
  createdAt: timestamp("created_at").defaultNow(),
}, (table) => [
  index("idx_password_reset_tokens_user_id").on(table.userId),
]);

export const emailVerificationTokens = pgTable("email_verification_tokens", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  userId: varchar("user_id").references(() => users.id, { onDelete: "cascade" }).notNull(),
  token: varchar("token").notNull().unique(),
  expiresAt: timestamp("expires_at").notNull(),
  usedAt: timestamp("used_at"),
  createdAt: timestamp("created_at").defaultNow(),
}, (table) => [
  index("idx_email_verification_tokens_user_id").on(table.userId),
]);

export const invitations = pgTable("invitations", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  accountId: varchar("account_id").references(() => accounts.id).notNull(),
  email: varchar("email").notNull(),
  firstName: text("first_name"),
  lastName: text("last_name"),
  role: varchar("role").default("standard").notNull(),
  token: varchar("token").notNull().unique(),
  status: varchar("status").default("pending").notNull(),
  invitedById: varchar("invited_by_id").references(() => users.id),
  expiresAt: timestamp("expires_at").notNull(),
  // S41: Project IDs to auto-assign to the invitee at acceptance time. Only
  // meaningful for role="restricted" (validated at POST /api/invitations).
  // Empty array means no auto-assignment (post-acceptance assignment via
  // POST /api/projects/:id/assignments still works).
  assignedProjectIds: jsonb("assigned_project_ids").$type<number[]>().notNull().default(sql`'[]'::jsonb`),
  createdAt: timestamp("created_at").defaultNow(),
}, (table) => [
  index("invitations_account_id_idx").on(table.accountId),
]);

export const assignedProjectIdsSchema = z.array(z.number().int().positive()).default([]);

export type UpsertUser = typeof users.$inferInsert;
export type User = typeof users.$inferSelect;
export type Account = typeof accounts.$inferSelect;
export type Invitation = typeof invitations.$inferSelect;
export type InsertInvitation = typeof invitations.$inferInsert;
