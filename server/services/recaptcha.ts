const RECAPTCHA_MIN_SCORE = 0.3;

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
      console.log(`[recaptcha] score=${data.score} action=${data.action} passed=false reason=invalid-token`);
      return { valid: false, reason: "invalid_token", score: data.score };
    }

    if (data.action !== expectedAction) {
      console.warn(`[recaptcha] action mismatch — expected ${expectedAction}, got ${data.action}`);
      console.log(`[recaptcha] score=${data.score} action=${data.action} passed=false reason=action-mismatch`);
      return { valid: false, reason: "action_mismatch", score: data.score };
    }

    if ((data.score ?? 0) < RECAPTCHA_MIN_SCORE) {
      console.warn(`[recaptcha] low score: ${data.score} (threshold: ${RECAPTCHA_MIN_SCORE})`);
      console.log(`[recaptcha] score=${data.score} action=${data.action} passed=false reason=low-score`);
      return { valid: false, reason: "low_score", score: data.score };
    }

    console.log(`[recaptcha] verified, score: ${data.score}`);
    console.log(`[recaptcha] score=${data.score} action=${data.action} passed=true reason=ok`);
    return { valid: true, score: data.score };
  } catch (err) {
    console.error("[recaptcha] verification threw:", err);
    return { valid: false, reason: "exception" };
  }
}
