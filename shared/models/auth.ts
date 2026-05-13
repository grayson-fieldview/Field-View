import { sql } from "drizzle-orm";
import { boolean, index, integer, jsonb, pgTable, text, timestamp, varchar } from "drizzle-orm/pg-core";
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
  companyLogoUrl: varchar("company_logo_url"),
  companyLegalName: text("company_legal_name"),
  companyAddress: text("company_address"),
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
export type Invitation = typeof invitations.$inferSelect;
export type InsertInvitation = typeof invitations.$inferInsert;
