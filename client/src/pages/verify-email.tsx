import { useEffect, useState } from "react";
import { useLocation, useSearch } from "wouter";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { CheckCircle2, Loader2, XCircle } from "lucide-react";
import faviconImg from "@assets/Favicon-01_1772067008525.png";

type Status = "loading" | "success" | "error";

export default function VerifyEmailPage() {
  const [, setLocation] = useLocation();
  const searchString = useSearch();
  const params = new URLSearchParams(searchString);
  const token = params.get("token");

  const [status, setStatus] = useState<Status>("loading");
  const [message, setMessage] = useState<string>("");

  useEffect(() => {
    if (!token) {
      setStatus("error");
      setMessage("No verification token provided.");
      return;
    }

    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/verify-email?token=${encodeURIComponent(token)}`);
        const data = await res.json();
        if (cancelled) return;
        if (!res.ok) {
          setStatus("error");
          setMessage(data.error || "Verification failed");
          return;
        }
        setStatus("success");
        setMessage(data.message || "Email verified!");
        setTimeout(() => {
          if (!cancelled) setLocation("/login");
        }, 2000);
      } catch (err: any) {
        if (cancelled) return;
        setStatus("error");
        setMessage(err.message || "Verification failed");
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [token, setLocation]);

  return (
    <div className="min-h-screen flex items-center justify-center bg-[#F0EDEA] dark:bg-gray-950 px-4">
      <Card className="w-full max-w-md shadow-lg border-0">
        <CardContent className="pt-8 text-center space-y-4">
          <div className="flex items-center justify-center gap-2">
            <img src={faviconImg} alt="Field View" className="h-8 w-8" />
            <span className="text-xl font-bold text-[#1E1E1E] dark:text-white">Field View</span>
          </div>

          {status === "loading" && (
            <>
              <div className="mx-auto w-12 h-12 rounded-full bg-muted flex items-center justify-center">
                <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
              </div>
              <h2 className="text-xl font-semibold" data-testid="text-verify-loading">Verifying your email...</h2>
              <p className="text-sm text-muted-foreground">Hang tight while we confirm your account.</p>
            </>
          )}

          {status === "success" && (
            <>
              <div className="mx-auto w-12 h-12 rounded-full bg-[#267D32]/10 flex items-center justify-center">
                <CheckCircle2 className="h-6 w-6 text-[#267D32]" />
              </div>
              <h2 className="text-xl font-semibold" data-testid="text-verify-success">Email verified!</h2>
              <p className="text-sm text-muted-foreground">Redirecting you to sign in...</p>
            </>
          )}

          {status === "error" && (
            <>
              <div className="mx-auto w-12 h-12 rounded-full bg-red-100 dark:bg-red-900/20 flex items-center justify-center">
                <XCircle className="h-6 w-6 text-red-600 dark:text-red-400" />
              </div>
              <h2 className="text-xl font-semibold" data-testid="text-verify-error">Verification failed</h2>
              <p className="text-sm text-muted-foreground" data-testid="text-verify-error-message">{message}</p>
              <Button
                onClick={() => setLocation("/check-email")}
                className="w-full bg-[#F09000] hover:bg-[#d98000] text-white"
                data-testid="button-request-new-verification"
              >
                Request a new verification email
              </Button>
              <a
                href="/login"
                className="inline-block text-sm text-[#F09000] hover:underline font-medium"
                data-testid="link-back-to-login"
              >
                Back to sign in
              </a>
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
