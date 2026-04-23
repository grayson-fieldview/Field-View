import { useEffect, useState } from "react";
import { useLocation, useSearch } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { CheckCircle2, Loader2, XCircle } from "lucide-react";
import faviconImg from "@assets/Favicon-01_1772067008525.png";

type Status = "loading" | "success" | "error";

export default function VerifyEmailPage() {
  const [, setLocation] = useLocation();
  const queryClient = useQueryClient();
  const searchString = useSearch();
  const params = new URLSearchParams(searchString);
  const token = params.get("token");

  const [status, setStatus] = useState<Status>("loading");
  const [message, setMessage] = useState<string>("");
  const [textVisible, setTextVisible] = useState(false);

  useEffect(() => {
    if (!token) {
      setStatus("error");
      setMessage("No verification token provided.");
      return;
    }

    let cancelled = false;
    let textTimer: ReturnType<typeof setTimeout> | undefined;
    let redirectTimer: ReturnType<typeof setTimeout> | undefined;

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

        const autoLoggedIn = Boolean(data.user);
        if (autoLoggedIn) {
          queryClient.setQueryData(["/api/auth/user"], data.user);
          queryClient.invalidateQueries({ queryKey: ["/api/auth/user"] });
        }

        textTimer = setTimeout(() => {
          if (!cancelled) setTextVisible(true);
        }, 100);

        redirectTimer = setTimeout(() => {
          if (cancelled) return;
          setLocation(autoLoggedIn ? "/" : "/login");
        }, 2000);
      } catch (err: any) {
        if (cancelled) return;
        setStatus("error");
        setMessage(err.message || "Verification failed");
      }
    })();

    return () => {
      cancelled = true;
      if (textTimer) clearTimeout(textTimer);
      if (redirectTimer) clearTimeout(redirectTimer);
    };
  }, [token, setLocation, queryClient]);

  return (
    <div className="min-h-screen flex items-center justify-center bg-[#F0EDEA] dark:bg-gray-950 px-4">
      <Card className="w-full max-w-md shadow-lg border-0 bg-white dark:bg-gray-900">
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
            <div className="pb-4">
              <div
                className="mx-auto w-16 h-16 rounded-full bg-[#10b981]/10 flex items-center justify-center transition-all duration-300 ease-out"
                style={{ transform: "scale(1)", animation: "verify-pop 300ms ease-out" }}
              >
                <CheckCircle2 className="h-9 w-9 text-[#10b981]" />
              </div>
              <div
                className="transition-opacity duration-300 ease-out mt-4 space-y-2"
                style={{ opacity: textVisible ? 1 : 0 }}
              >
                <h2 className="text-2xl font-semibold" data-testid="text-verify-success">Email verified!</h2>
                <p className="text-sm text-muted-foreground">
                  Welcome to Field View. Taking you to your account...
                </p>
              </div>
              <style>{`
                @keyframes verify-pop {
                  0% { transform: scale(0.8); opacity: 0; }
                  100% { transform: scale(1); opacity: 1; }
                }
              `}</style>
            </div>
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
