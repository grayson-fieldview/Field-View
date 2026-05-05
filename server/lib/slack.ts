// Slack webhook notifier. Fire-and-forget, fail-closed.
// Set SLACK_WEBHOOK_URL on Vercel + Replit (https://api.slack.com/messaging/webhooks).
// Failures NEVER throw — Slack outages must not break signup or webhook processing.

const COMP_ACCOUNT_EMAIL = "grayson@field-view.com";

export function isCompAccount(email?: string | null): boolean {
  return !!email && email.toLowerCase() === COMP_ACCOUNT_EMAIL;
}

export async function sendSlackNotification(
  text: string,
  blocks?: any[],
): Promise<void> {
  const webhookUrl = process.env.SLACK_WEBHOOK_URL;
  if (!webhookUrl) return; // no-op silently when unconfigured

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 3000);
  try {
    const res = await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(blocks ? { text, blocks } : { text }),
      signal: controller.signal,
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      console.error(`[slack] webhook ${res.status}: ${body.slice(0, 200)}`);
    }
  } catch (err: any) {
    if (err?.name === "AbortError") {
      console.error("[slack] webhook timed out after 3s");
    } else {
      console.error("[slack] notification failed:", err?.message ?? err);
    }
  } finally {
    clearTimeout(timer);
  }
}
