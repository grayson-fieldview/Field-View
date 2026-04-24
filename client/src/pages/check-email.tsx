import { useEffect, useState } from "react";
import { useSearch } from "wouter";
import { useMutation } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { useToast } from "@/hooks/use-toast";
import { Loader2, Mail } from "lucide-react";
import faviconImg from "@assets/Favicon-01_1772067008525.png";

const RESEND_COOLDOWN_SECONDS = 60;

export default function CheckEmailPage() {
  const { toast } = useToast();
  const searchString = useSearch();
  const params = new URLSearchParams(searchString);
  const email = params.get("email") || "";

  const [cooldown, setCooldown] = useState(0);

  useEffect(() => {
    if (cooldown <= 0) return;
    const interval = setInterval(() => {
      setCooldown((prev) => (prev <= 1 ? 0 : prev - 1));
    }, 1000);
    return () => clearInterval(interval);
  }, [cooldown]);

  const resendMutation = useMutation({
    mutationFn: async () => {
      let res: Response;
      try {
        res = await fetch("/api/resend-verification", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email }),
        });
      } catch (networkErr) {
        const err: any = new Error("Network error — check your connection and try again.");
        err.kind = "network";
        throw err;
      }

      let data: any = {};
      try {
        data = await res.json();
      } catch {
        data = {};
      }

      if (!res.ok) {
        const err: any = new Error(data.message || data.error || "Request failed");
        err.status = res.status;
        err.retryAfterSeconds = typeof data.retryAfterSeconds === "number" ? data.retryAfterSeconds : null;
        throw err;
      }

      return data;
    },
    onSuccess: () => {
      setCooldown(RESEND_COOLDOWN_SECONDS);
      toast({
        title: "Email sent",
        description: "Verification email sent again. Check your inbox in a minute.",
      });
    },
    onError: (error: any) => {
      setCooldown(RESEND_COOLDOWN_SECONDS);

      if (error?.kind === "network") {
        toast({
          title: "Couldn't reach the server",
          description: error.message,
          variant: "destructive",
        });
        return;
      }

      if (error?.status === 429) {
        const retry = error.retryAfterSeconds;
        const isShortThrottle = typeof retry === "number" && retry < 120;
        toast({
          title: "Too many requests",
          description: isShortThrottle
            ? "You just requested an email a moment ago. Please wait about a minute before requesting another."
            : "You've requested too many emails. Please wait an hour and try again.",
          variant: "destructive",
        });
        return;
      }

      toast({
        title: "Couldn't resend email",
        description: error?.message || "Something went wrong. Please try again in a minute.",
        variant: "destructive",
      });
    },
  });

  const handleResend = () => {
    if (!email || cooldown > 0 || resendMutation.isPending) return;
    resendMutation.mutate();
  };

  const buttonDisabled = !email || cooldown > 0 || resendMutation.isPending;
  const buttonLabel = resendMutation.isPending
    ? "Sending..."
    : cooldown > 0
    ? `Resend (available in ${cooldown}s)`
    : "Resend email";

  return (
    <div className="min-h-screen flex items-center justify-center bg-[#F0EDEA] dark:bg-gray-950 px-4">
      <Card className="w-full max-w-md shadow-lg border-0">
        <CardContent className="pt-8 pb-8 text-center space-y-4">
          <div className="flex items-center justify-center gap-2">
            <img src={faviconImg} alt="Field View" className="h-8 w-8" />
            <span className="text-xl font-bold text-[#1E1E1E] dark:text-white">Field View</span>
          </div>

          <div className="mx-auto w-12 h-12 rounded-full bg-[#267D32]/10 flex items-center justify-center">
            <Mail className="h-6 w-6 text-[#267D32]" />
          </div>

          <h2 className="text-xl font-semibold" data-testid="text-check-email-title">
            Check your email
          </h2>

          <p className="text-sm text-muted-foreground">
            We sent a verification link to{" "}
            <strong className="text-foreground" data-testid="text-check-email-address">
              {email || "your email"}
            </strong>
          </p>

          <p className="text-sm text-muted-foreground">
            The link should arrive within a minute. Be sure to check your spam or promotions folder if you don't see it.
          </p>

          <p className="text-xs text-muted-foreground">
            On AT&amp;T, Bellsouth, Yahoo, or AOL? Delivery may take up to 5 minutes.
          </p>

          <Button
            onClick={handleResend}
            disabled={buttonDisabled}
            className="w-full bg-[#F09000] hover:bg-[#d98000] text-white"
            data-testid="button-resend-verification"
          >
            {resendMutation.isPending ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                Sending...
              </>
            ) : (
              buttonLabel
            )}
          </Button>

          <p className="text-xs text-muted-foreground pt-2">
            Wrong email?{" "}
            <a
              href="/register"
              className="text-[#F09000] hover:underline font-medium"
              data-testid="link-start-over"
            >
              Start over
            </a>
          </p>

          <p className="text-xs text-muted-foreground">
            <a
              href="/login"
              className="text-muted-foreground hover:underline"
              data-testid="link-back-to-login"
            >
              Back to sign in
            </a>
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
