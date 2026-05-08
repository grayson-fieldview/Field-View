import { useState, useRef, useEffect, useCallback } from "react";
import { useLocation } from "wouter";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useAuth } from "@/hooks/use-auth";
import { Loader2, Star } from "lucide-react";
import faviconImg from "@assets/Favicon-01-brand_1778259672.png";

const CODE_LENGTH = 6;
const RESEND_COOLDOWN = 60;

export default function VerifyEmailPage() {
  const [, setLocation] = useLocation();
  const { user, logout } = useAuth();
  const queryClient = useQueryClient();

  const [digits, setDigits] = useState<string[]>(Array(CODE_LENGTH).fill(""));
  const [error, setError] = useState("");
  const [resendMsg, setResendMsg] = useState("");
  const [cooldown, setCooldown] = useState(0);
  const inputRefs = useRef<(HTMLInputElement | null)[]>([]);

  useEffect(() => {
    if (cooldown <= 0) return;
    const t = setInterval(() => setCooldown((p) => (p <= 1 ? 0 : p - 1)), 1000);
    return () => clearInterval(t);
  }, [cooldown]);

  const submitCode = useMutation({
    mutationFn: async (code: string) => {
      const res = await fetch("/api/verify-email-code", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ email: (user as any)?.email, code }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        const err: any = new Error(data.message || "Verification failed");
        err.status = res.status;
        err.error = data.error;
        err.remainingAttempts = data.remaining_attempts;
        throw err;
      }
      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/auth/user"] });
      setLocation("/subscribe");
    },
    onError: (err: any) => {
      setDigits(Array(CODE_LENGTH).fill(""));
      setTimeout(() => inputRefs.current[0]?.focus(), 50);

      if (err.status === 401 && err.error === "invalid_code") {
        const r = err.remainingAttempts;
        setError(`Wrong code. ${r} ${r === 1 ? "attempt" : "attempts"} left.`);
      } else if (err.status === 410) {
        setError("That code expired. Tap Resend below for a new one.");
      } else if (err.status === 429) {
        setError("Too many wrong attempts. Tap Resend below to start over.");
      } else {
        setError("Something went wrong. Try again.");
      }
    },
  });

  const trySubmit = useCallback(
    (newDigits: string[]) => {
      if (newDigits.every((d) => d !== "") && !submitCode.isPending) {
        setError("");
        submitCode.mutate(newDigits.join(""));
      }
    },
    [submitCode],
  );

  const handleChange = (index: number, value: string) => {
    const char = value.replace(/\D/g, "").slice(-1);
    const next = [...digits];
    next[index] = char;
    setDigits(next);
    if (char && index < CODE_LENGTH - 1) {
      inputRefs.current[index + 1]?.focus();
    }
    if (char) trySubmit(next);
  };

  const handleKeyDown = (index: number, e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Backspace") {
      e.preventDefault();
      const next = [...digits];
      if (digits[index]) {
        next[index] = "";
        setDigits(next);
      } else if (index > 0) {
        next[index - 1] = "";
        setDigits(next);
        inputRefs.current[index - 1]?.focus();
      }
    }
  };

  const handlePaste = (e: React.ClipboardEvent) => {
    e.preventDefault();
    const pasted = e.clipboardData.getData("text").replace(/\D/g, "").slice(0, CODE_LENGTH);
    if (!pasted) return;
    const next = [...digits];
    for (let i = 0; i < pasted.length; i++) {
      next[i] = pasted[i];
    }
    setDigits(next);
    const focusIdx = Math.min(pasted.length, CODE_LENGTH - 1);
    inputRefs.current[focusIdx]?.focus();
    trySubmit(next);
  };

  const resendMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch("/api/resend-verification", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ email: (user as any)?.email }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        const err: any = new Error(data.message || "Request failed");
        err.status = res.status;
        err.retryAfterSeconds = data.retry_after_seconds;
        throw err;
      }
      return data;
    },
    onSuccess: () => {
      setCooldown(RESEND_COOLDOWN);
      setError("");
      setResendMsg("Sent! Check your email.");
      setTimeout(() => setResendMsg(""), 3000);
    },
    onError: (err: any) => {
      if (err.status === 429 && typeof err.retryAfterSeconds === "number") {
        setCooldown(err.retryAfterSeconds);
      } else {
        setCooldown(RESEND_COOLDOWN);
      }
    },
  });

  const isSubmitting = submitCode.isPending;

  return (
    <div className="min-h-screen bg-white dark:bg-gray-950 p-3 sm:p-4">
      <div className="grid grid-cols-1 md:grid-cols-[40%_1fr] gap-3 sm:gap-4 min-h-[calc(100vh-1.5rem)] sm:min-h-[calc(100vh-2rem)]">
        <div
          className="bg-[#fceed8] rounded-3xl p-8 sm:p-10 lg:p-14 flex flex-col justify-between min-h-[400px] md:min-h-0"
          data-testid="panel-brand"
        >
          <div className="flex items-center gap-2" data-testid="brand-logo-row">
            <img
              src={faviconImg}
              alt="Field View"
              className="h-10 w-10 rounded-md"
              data-testid="img-brand-logo"
            />
            <span className="text-2xl font-bold tracking-tight text-slate-900">
              Field View
            </span>
          </div>

          <div className="my-12">
            <h1
              className="text-5xl sm:text-6xl lg:text-7xl font-extrabold leading-[0.95] tracking-tight text-slate-900"
              data-testid="text-brand-tagline"
            >
              Almost there.
            </h1>
            <p className="mt-6 text-base lg:text-xl font-medium text-slate-800 max-w-xl leading-relaxed">
              One quick step to verify it's really you.
            </p>
          </div>

          <figure
            className="bg-white rounded-2xl shadow-md p-5 max-w-sm"
            data-testid="card-testimonial"
          >
            <div className="flex items-center gap-0.5 mb-3" data-testid="testimonial-stars">
              {[0, 1, 2, 3, 4].map((i) => (
                <Star key={i} className="w-3.5 h-3.5" style={{ color: "#F09000", fill: "#F09000" }} />
              ))}
            </div>
            <blockquote className="text-slate-800 text-sm leading-relaxed mb-4">
              "FieldView keeps the whole crew organized. It clocks everyone in
              when they hit the job, and the photo logs alone have settled two
              disputes for us this year."
            </blockquote>
            <figcaption className="flex items-center gap-2.5">
              <div className="h-8 w-8 rounded-full bg-[#F09000] flex items-center justify-center text-white text-xs font-bold">
                LO
              </div>
              <div className="flex flex-col">
                <span className="text-xs font-bold text-slate-900">Luke Ousdigian</span>
                <span className="text-[11px] text-slate-600">Owner · Palm Beach Painters</span>
              </div>
            </figcaption>
          </figure>
        </div>

        <div className="flex items-center justify-center px-4 py-8 sm:px-6 lg:px-12">
          <div className="w-full max-w-md">
            <h2
              className="text-2xl sm:text-3xl font-extrabold text-slate-900 dark:text-white tracking-tight mb-2"
              data-testid="text-verify-title"
            >
              Enter your verification code
            </h2>
            <p className="text-slate-600 dark:text-slate-400 text-sm mb-8" data-testid="text-verify-email-hint">
              We sent a 6-digit code to{" "}
              <strong className="text-slate-900 dark:text-white">{(user as any)?.email}</strong>
            </p>

            <div className="flex gap-3 justify-center mb-6" onPaste={handlePaste} data-testid="input-group-code">
              {digits.map((digit, i) => (
                <input
                  key={i}
                  ref={(el) => { inputRefs.current[i] = el; }}
                  type="text"
                  inputMode="numeric"
                  pattern="[0-9]*"
                  maxLength={1}
                  value={digit}
                  onChange={(e) => handleChange(i, e.target.value)}
                  onKeyDown={(e) => handleKeyDown(i, e)}
                  disabled={isSubmitting}
                  className="w-12 h-14 text-2xl text-center font-bold rounded-xl border-2 border-slate-300 focus:border-[#f09004] outline-none bg-white dark:bg-gray-900 dark:text-white dark:border-gray-600 dark:focus:border-[#f09004] disabled:opacity-50 transition-colors"
                  data-testid={`input-code-${i}`}
                  autoFocus={i === 0}
                />
              ))}
            </div>

            {isSubmitting && (
              <div className="flex justify-center mb-4">
                <Loader2 className="h-5 w-5 animate-spin text-[#F09000]" />
              </div>
            )}

            {error && (
              <p className="text-red-600 dark:text-red-400 text-sm text-center mb-4" data-testid="text-verify-error">
                {error}
              </p>
            )}

            {resendMsg && (
              <p className="text-green-600 dark:text-green-400 text-sm text-center mb-4" data-testid="text-resend-success">
                {resendMsg}
              </p>
            )}

            <div className="text-center mb-6">
              <button
                type="button"
                onClick={() => resendMutation.mutate()}
                disabled={cooldown > 0 || resendMutation.isPending}
                className="text-sm font-bold text-[#f09004] hover:underline disabled:text-slate-400 disabled:no-underline disabled:cursor-not-allowed transition-colors"
                data-testid="button-resend-code"
              >
                {resendMutation.isPending
                  ? "Sending..."
                  : cooldown > 0
                    ? `Resend in ${cooldown}s`
                    : "Didn't get it? Resend code"}
              </button>
            </div>

            <div className="text-center">
              <button
                type="button"
                onClick={() => logout()}
                className="text-sm text-slate-500 dark:text-slate-400 hover:underline"
                data-testid="button-logout-verify"
              >
                Wrong account? Sign out
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
