interface RecaptchaVerifyResult {
  success: boolean;
  score?: number;
  action?: string;
  hostname?: string;
  "error-codes"?: string[];
}

export async function verifyRecaptchaToken(
  token: string | undefined,
  expectedAction: string,
): Promise<{ valid: boolean; reason?: string; score?: number }> {
  if (process.env.NODE_ENV === "development") {
    console.log("[recaptcha] dev mode — bypassing verification");
    return { valid: true, score: 1.0 };
  }

  const secret = process.env.RECAPTCHA_SECRET_KEY;
  if (!secret) {
    console.error("[recaptcha] RECAPTCHA_SECRET_KEY not set — failing closed");
    return { valid: false, reason: "misconfigured" };
  }

  if (!token) {
    return { valid: false, reason: "missing_token" };
  }

  try {
    const response = await fetch("https://www.google.com/recaptcha/api/siteverify", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ secret, response: token }).toString(),
    });

    if (!response.ok) {
      console.error("[recaptcha] verify API HTTP error:", response.status);
      return { valid: false, reason: "api_error" };
    }

    const data = (await response.json()) as RecaptchaVerifyResult;

    if (!data.success) {
      console.warn("[recaptcha] verification failed:", data["error-codes"]);
      return { valid: false, reason: "invalid_token", score: data.score };
    }

    if (data.action !== expectedAction) {
      console.warn(`[recaptcha] action mismatch — expected ${expectedAction}, got ${data.action}`);
      return { valid: false, reason: "action_mismatch", score: data.score };
    }

    const SCORE_THRESHOLD = 0.5;
    if ((data.score ?? 0) < SCORE_THRESHOLD) {
      console.warn(`[recaptcha] low score: ${data.score} (threshold: ${SCORE_THRESHOLD})`);
      return { valid: false, reason: "low_score", score: data.score };
    }

    console.log(`[recaptcha] verified, score: ${data.score}`);
    return { valid: true, score: data.score };
  } catch (err) {
    console.error("[recaptcha] verification threw:", err);
    return { valid: false, reason: "exception" };
  }
}
