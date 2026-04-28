import { Resend } from "resend";
import { render } from "@react-email/render";
import WelcomeEmail from "../emails/welcome";

const API_KEY = process.env.RESEND_API_KEY;
const FROM = process.env.EMAIL_FROM || "Field View <support@field-view.com>";
const REPLY_TO = process.env.EMAIL_REPLY_TO || "support@field-view.com";
const WELCOME_FROM = "Grayson at Field View <grayson@field-view.com>";
const WELCOME_REPLY_TO = "grayson@field-view.com";
const PUBLIC_APP_URL = process.env.PUBLIC_APP_URL || "https://app.field-view.com";

if (!API_KEY) {
  console.warn("[email] RESEND_API_KEY not set — emails will not send");
}

const resend = API_KEY ? new Resend(API_KEY) : null;

export async function sendPasswordResetEmail(to: string, resetToken: string): Promise<void> {
  if (!resend) {
    console.warn("[email] Skipping send — Resend not configured");
    return;
  }

  const resetUrl = `${PUBLIC_APP_URL}/reset-password?token=${resetToken}`;

  const { data, error } = await resend.emails.send({
    from: FROM,
    replyTo: REPLY_TO,
    to,
    subject: "Reset your Field View password",
    html: `
      <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 560px; margin: 0 auto; padding: 40px 20px; color: #111;">
        <h1 style="font-size: 24px; margin-bottom: 16px;">Reset your password</h1>
        <p style="font-size: 16px; line-height: 1.5; margin-bottom: 24px;">
          Someone requested a password reset for your Field View account. If this was you, click the button below to set a new password.
        </p>
        <p style="margin-bottom: 24px;">
          <a href="${resetUrl}" style="background: #f97316; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; display: inline-block; font-weight: 600;">
            Reset password
          </a>
        </p>
        <p style="font-size: 14px; color: #666; line-height: 1.5; margin-bottom: 8px;">
          Or copy this link into your browser:
        </p>
        <p style="font-size: 13px; color: #666; word-break: break-all; margin-bottom: 24px;">
          ${resetUrl}
        </p>
        <p style="font-size: 14px; color: #666; line-height: 1.5;">
          This link will expire in 1 hour. If you didn't request a password reset, you can safely ignore this email — your password will not change.
        </p>
        <hr style="border: none; border-top: 1px solid #eee; margin: 32px 0;">
        <p style="font-size: 12px; color: #999;">
          Field View &middot; <a href="https://field-view.com" style="color: #999;">field-view.com</a>
        </p>
      </div>
    `,
    text: `Reset your Field View password\n\nSomeone requested a password reset for your Field View account. If this was you, click the link below to set a new password:\n\n${resetUrl}\n\nThis link will expire in 1 hour. If you didn't request a password reset, you can safely ignore this email.\n\n— Field View`,
  });

  if (error) {
    console.error("[email] Failed to send password reset:", error);
    throw new Error(`Email send failed: ${error.message}`);
  }

  console.log("[email] Password reset email sent:", data?.id);
}

export async function sendEmailVerificationEmail(to: string, verificationToken: string, firstName?: string | null): Promise<void> {
  if (!resend) {
    console.warn("[email] Skipping send — Resend not configured");
    return;
  }

  const verifyUrl = `${PUBLIC_APP_URL}/verify-email?token=${verificationToken}`;
  const greeting = firstName ? `Hi ${firstName},` : "Welcome to Field View!";

  const { data, error } = await resend.emails.send({
    from: FROM,
    replyTo: REPLY_TO,
    to,
    subject: "Verify your email for Field View",
    html: `
      <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 560px; margin: 0 auto; padding: 40px 20px; color: #111;">
        <h1 style="font-size: 24px; margin-bottom: 16px;">Verify your email</h1>
        <p style="font-size: 16px; line-height: 1.5; margin-bottom: 24px;">
          ${greeting} Please confirm your email address to finish setting up your Field View account.
        </p>
        <p style="margin-bottom: 24px;">
          <a href="${verifyUrl}" style="background: #f97316; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; display: inline-block; font-weight: 600;">
            Verify email
          </a>
        </p>
        <p style="font-size: 14px; color: #666; line-height: 1.5; margin-bottom: 8px;">
          Or copy this link into your browser:
        </p>
        <p style="font-size: 13px; color: #666; word-break: break-all; margin-bottom: 24px;">
          ${verifyUrl}
        </p>
        <p style="font-size: 14px; color: #666; line-height: 1.5;">
          This link will expire in 1 hour. If you didn't sign up for Field View, you can safely ignore this email.
        </p>
        <hr style="border: none; border-top: 1px solid #eee; margin: 32px 0;">
        <p style="font-size: 12px; color: #999;">
          Field View &middot; <a href="https://field-view.com" style="color: #999;">field-view.com</a>
        </p>
      </div>
    `,
    text: `Verify your email for Field View\n\n${greeting} Please confirm your email address to finish setting up your Field View account:\n\n${verifyUrl}\n\nThis link will expire in 1 hour. If you didn't sign up, you can safely ignore this email.\n\n— Field View`,
  });

  if (error) {
    console.error("[email] Failed to send verification email:", error);
    throw new Error(`Email send failed: ${error.message}`);
  }

  console.log("[email] Verification email sent:", data?.id);
}

const INVITATION_ROLE_LABELS: Record<string, string> = {
  admin: "Admin",
  manager: "Manager",
  standard: "Standard User",
  restricted: "Restricted User",
};

export async function sendInvitationEmail(params: {
  to: string;
  inviterName: string | null;
  inviterEmail: string;
  accountName: string;
  role: string;
  inviteUrl: string;
  expiresAt: Date;
  recipientFirstName: string | null;
}): Promise<{ success: boolean; error?: string }> {
  const { to, inviterName, inviterEmail, accountName, role, inviteUrl, expiresAt, recipientFirstName } = params;
  const inviterDisplay = inviterName?.trim() || inviterEmail;
  const greetingName = recipientFirstName?.trim() || "there";
  const roleLabel = INVITATION_ROLE_LABELS[role] || "User";
  const expiresFormatted = expiresAt.toLocaleDateString("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
  });

  if (!resend) {
    console.warn("[email] Skipping invitation send — Resend not configured");
    return { success: false, error: "RESEND_API_KEY not set" };
  }

  const subject = `${inviterDisplay} invited you to join ${accountName} on Field View`;

  try {
    const { data, error } = await resend.emails.send({
      from: FROM,
      replyTo: REPLY_TO,
      to,
      subject,
      html: `
      <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 560px; margin: 0 auto; padding: 40px 20px; color: #111;">
        <h1 style="font-size: 24px; margin-bottom: 16px;">You're invited to Field View</h1>
        <p style="font-size: 16px; line-height: 1.5; margin-bottom: 16px;">Hi ${greetingName},</p>
        <p style="font-size: 16px; line-height: 1.5; margin-bottom: 16px;">
          <strong>${inviterDisplay}</strong> invited you to join <strong>${accountName}</strong> on Field View as a ${roleLabel}.
        </p>
        <p style="font-size: 16px; line-height: 1.5; margin-bottom: 24px;">
          Field View is the field intelligence platform for documenting jobsites, tracking project progress, and collaborating with your team.
        </p>
        <p style="margin-bottom: 24px;">
          <a href="${inviteUrl}" style="background: #F09000; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; display: inline-block; font-weight: 600;">
            Accept invitation
          </a>
        </p>
        <p style="font-size: 14px; color: #666; line-height: 1.5; margin-bottom: 8px;">
          Or paste this link into your browser:
        </p>
        <p style="font-size: 13px; color: #666; word-break: break-all; margin-bottom: 24px;">
          ${inviteUrl}
        </p>
        <p style="font-size: 14px; color: #666; line-height: 1.5;">
          This invitation expires on ${expiresFormatted}.
        </p>
        <hr style="border: none; border-top: 1px solid #eee; margin: 32px 0;">
        <p style="font-size: 12px; color: #999;">
          Field View &middot; <a href="https://field-view.com" style="color: #999;">field-view.com</a>
        </p>
      </div>
    `,
      text: `You're invited to Field View\n\nHi ${greetingName},\n\n${inviterDisplay} invited you to join ${accountName} on Field View as a ${roleLabel}.\n\nField View is the field intelligence platform for documenting jobsites, tracking project progress, and collaborating with your team.\n\nAccept your invitation: ${inviteUrl}\n\nOr paste this link into your browser: ${inviteUrl}\n\nThis invitation expires on ${expiresFormatted}.\n\n— Field View`,
    });

    if (error) {
      console.error("[email] Failed to send invitation:", error);
      return { success: false, error: error.message };
    }

    console.log("[email] Invitation email sent:", data?.id);
    return { success: true };
  } catch (err: any) {
    console.error("[email] Failed to send invitation:", err);
    return { success: false, error: err?.message || "unknown error" };
  }
}

export async function sendWelcomeEmail(to: string, firstName?: string | null): Promise<void> {
  if (!resend) {
    console.warn("[email] Skipping welcome send — Resend not configured");
    return;
  }

  const name = firstName && firstName.trim().length > 0 ? firstName.trim() : "there";
  const html = await render(WelcomeEmail({ firstName: name }));
  const text = await render(WelcomeEmail({ firstName: name }), { plainText: true });

  const { data, error } = await resend.emails.send({
    from: WELCOME_FROM,
    replyTo: WELCOME_REPLY_TO,
    to,
    subject: "Welcome to Field View — here's how to get the most out of it",
    html,
    text,
  });

  if (error) {
    console.error("[email] Failed to send welcome email:", error);
    throw new Error(`Welcome email send failed: ${error.message}`);
  }

  console.log("[email] Welcome email sent:", data?.id);
}

export async function sendAccountDeletionEmail(
  to: string,
  opts: {
    firstName?: string | null;
    accountName: string;
    ownerName: string;
    permanentDeletionDate: string;
  },
): Promise<void> {
  if (!resend) {
    console.warn("[email] Skipping account-deletion send — Resend not configured");
    return;
  }

  const greeting = opts.firstName ? `Hi ${opts.firstName},` : "Hi,";
  const signInUrl = `${PUBLIC_APP_URL}/login`;

  const { data, error } = await resend.emails.send({
    from: FROM,
    replyTo: REPLY_TO,
    to,
    subject: "Your Field View account has been scheduled for deletion",
    html: `
      <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 560px; margin: 0 auto; padding: 40px 20px; color: #111;">
        <h1 style="font-size: 24px; margin-bottom: 16px;">Account scheduled for deletion</h1>
        <p style="font-size: 16px; line-height: 1.5; margin-bottom: 16px;">${greeting}</p>
        <p style="font-size: 16px; line-height: 1.5; margin-bottom: 16px;">
          The Field View account <strong>${opts.accountName}</strong> has been deleted by <strong>${opts.ownerName}</strong>.
        </p>
        <p style="font-size: 16px; line-height: 1.5; margin-bottom: 24px;">
          All data will be permanently removed on <strong>${opts.permanentDeletionDate}</strong>. To restore the account before then, sign in with your existing credentials.
        </p>
        <p style="margin-bottom: 24px;">
          <a href="${signInUrl}" style="background: #f97316; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; display: inline-block; font-weight: 600;">
            Sign in to restore
          </a>
        </p>
        <p style="font-size: 14px; color: #666; line-height: 1.5;">
          After ${opts.permanentDeletionDate}, data will be permanently destroyed and cannot be recovered.
        </p>
        <hr style="border: none; border-top: 1px solid #eee; margin: 32px 0;">
        <p style="font-size: 12px; color: #999;">
          The Field View Team &middot; <a href="https://field-view.com" style="color: #999;">field-view.com</a>
        </p>
      </div>
    `,
    text: `Account scheduled for deletion\n\n${greeting}\n\nThe Field View account ${opts.accountName} has been deleted by ${opts.ownerName}. All data will be permanently removed on ${opts.permanentDeletionDate}. To restore the account before then, sign in at ${signInUrl} with your existing credentials.\n\nAfter ${opts.permanentDeletionDate}, data will be permanently destroyed and cannot be recovered.\n\n— The Field View Team`,
  });

  if (error) {
    console.error("[email] Failed to send account-deletion email:", error);
    throw new Error(`Email send failed: ${error.message}`);
  }

  console.log("[email] Account-deletion email sent:", data?.id);
}

export async function sendAccountRestoredEmail(
  to: string,
  opts: { firstName?: string | null; accountName: string },
): Promise<void> {
  if (!resend) {
    console.warn("[email] Skipping account-restored send — Resend not configured");
    return;
  }

  const greeting = opts.firstName ? `Hi ${opts.firstName},` : "Hi,";

  const { data, error } = await resend.emails.send({
    from: FROM,
    replyTo: REPLY_TO,
    to,
    subject: "Your Field View account has been restored",
    html: `
      <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 560px; margin: 0 auto; padding: 40px 20px; color: #111;">
        <h1 style="font-size: 24px; margin-bottom: 16px;">Account restored</h1>
        <p style="font-size: 16px; line-height: 1.5; margin-bottom: 16px;">${greeting}</p>
        <p style="font-size: 16px; line-height: 1.5; margin-bottom: 24px;">
          Welcome back. The Field View account <strong>${opts.accountName}</strong> has been restored and your data is intact.
        </p>
        <p style="font-size: 14px; color: #666; line-height: 1.5;">
          Note: If your subscription was canceled during the deletion grace period, you may need to re-subscribe from Settings &rarr; Billing to regain full access.
        </p>
        <hr style="border: none; border-top: 1px solid #eee; margin: 32px 0;">
        <p style="font-size: 12px; color: #999;">
          The Field View Team &middot; <a href="https://field-view.com" style="color: #999;">field-view.com</a>
        </p>
      </div>
    `,
    text: `Account restored\n\n${greeting}\n\nWelcome back. The Field View account ${opts.accountName} has been restored and your data is intact.\n\nNote: If your subscription was canceled during the deletion grace period, you may need to re-subscribe from Settings → Billing to regain full access.\n\n— The Field View Team`,
  });

  if (error) {
    console.error("[email] Failed to send account-restored email:", error);
    throw new Error(`Email send failed: ${error.message}`);
  }

  console.log("[email] Account-restored email sent:", data?.id);
}
