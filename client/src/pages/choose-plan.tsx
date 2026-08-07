import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Minus, Plus } from "lucide-react";

// Session-scoped skip flag. sessionStorage on purpose: the paywall is a
// soft nudge — skipping should hold for the rest of this browser session
// (per spec), NOT forever (a user column) and NOT per-navigation (state).
export const CHOOSE_PLAN_SKIP_KEY = "fv_choose_plan_skipped";

// Fail-open in-memory fallback: if sessionStorage is unavailable OR the
// write throws, the skip must still hold for this page lifetime — otherwise
// skip() navigates to "/" and the gate immediately bounces back here.
let skippedInMemory = false;

export function markChoosePlanSkipped(): void {
  skippedInMemory = true;
  try {
    sessionStorage.setItem(CHOOSE_PLAN_SKIP_KEY, "1");
  } catch {
    // in-memory flag already set — skip still honored this session
  }
}

export function hasSkippedChoosePlan(): boolean {
  if (skippedInMemory) return true;
  try {
    return sessionStorage.getItem(CHOOSE_PLAN_SKIP_KEY) === "1";
  } catch {
    // sessionStorage unavailable (privacy mode edge cases) — never trap the
    // user in the paywall.
    return true;
  }
}

export default function ChoosePlanPage() {
  const [, setLocation] = useLocation();
  const { toast } = useToast();
  const [billingCycle, setBillingCycle] = useState<"monthly" | "annual">("monthly");
  const [seats, setSeats] = useState(3);

  // Same amounts as /subscribe (matches Stripe products):
  // - Field View Monthly: $79/month
  // - Field View Annual:  $588/year (≈ $49/month equivalent → "Save 38%")
  // - Additional User Seat: $15/month, $125/year
  const monthlyBase = 79;
  const annualBase = 588;
  const monthlyExtra = 15;
  const annualExtra = 125;

  const isAnnual = billingCycle === "annual";
  const extraSeats = Math.max(0, seats - 3);
  const basePrice = isAnnual ? annualBase : monthlyBase;
  const extraPrice = isAnnual ? annualExtra : monthlyExtra;
  const totalPrice = basePrice + extraSeats * extraPrice;
  const periodSuffix = isAnnual ? "/year" : "/month";
  const periodShort = isAnnual ? "/yr" : "/mo";

  const checkoutMutation = useMutation({
    mutationFn: async () => {
      // Server-authoritative checkout: send plan + seats; the server resolves
      // Stripe price IDs (interval-matched base + seat addon) and preserves
      // the remaining trial via subscription_data.trial_end — card now,
      // charge at trial end. Do NOT change that behavior here.
      const res = await apiRequest("POST", "/api/create-checkout-session", {
        plan: billingCycle,
        seats,
      });
      return res.json();
    },
    onSuccess: (data: any) => {
      if (data?.url) {
        // Stripe Checkout, or billing portal when the server detected an
        // existing live subscription (redirected: "billing_portal").
        window.location.href = data.url;
        return;
      }
      toast({
        title: "Error",
        description: "Checkout could not be started. Please try again.",
        variant: "destructive",
      });
    },
    onError: (error: any) => {
      toast({
        title: "Error",
        description: error?.message || "Checkout could not be started. Please try again.",
        variant: "destructive",
      });
    },
  });

  const skip = async () => {
    // sessionStorage flag first: immediate effect so the redirect below
    // can't race the auth refetch and bounce back here. The server field
    // (accountPaywallSkippedAt) is the durable cross-session source.
    markChoosePlanSkipped();
    try {
      await apiRequest("POST", "/api/account/skip-paywall");
      queryClient.invalidateQueries({ queryKey: ["/api/auth/user"] });
    } catch {
      // Soft nudge — a failed persist must never trap the user here; the
      // session-scoped flag still suppresses the paywall for this session.
    }
    setLocation("/");
  };

  return (
    <div className="min-h-screen bg-background flex items-center justify-center p-4">
      <Card className="w-full max-w-md">
        <CardHeader className="space-y-3 pb-2">
          <div className="space-y-1">
            <h1 className="text-2xl font-bold" data-testid="text-choose-plan-heading">
              Choose your plan
            </h1>
            <p className="text-sm text-muted-foreground" data-testid="text-choose-plan-subhead">
              Add a card now and you won't be charged until your free trial ends — or skip
              this step and keep exploring. Your trial continues either way.
            </p>
          </div>

          <div className="flex items-center justify-center">
            <div className="inline-flex rounded-full border p-1 bg-muted/50">
              <button
                onClick={() => setBillingCycle("monthly")}
                className={`px-4 py-1.5 rounded-full text-sm font-medium transition-colors ${
                  !isAnnual ? "bg-[#F09000] text-white" : "text-muted-foreground"
                }`}
                data-testid="button-cycle-monthly"
              >
                Monthly
              </button>
              <button
                onClick={() => setBillingCycle("annual")}
                className={`px-4 py-1.5 rounded-full text-sm font-medium transition-colors ${
                  isAnnual ? "bg-[#F09000] text-white" : "text-muted-foreground"
                }`}
                data-testid="button-cycle-annual"
              >
                Annual
              </button>
            </div>
          </div>
          {isAnnual && (
            <Badge className="w-fit mx-auto bg-[#267D32] text-white">Save 38%</Badge>
          )}
        </CardHeader>

        <CardContent className="p-6 pt-4 space-y-5">
          <div className="flex items-baseline gap-1">
            <span className="text-4xl font-bold text-foreground" data-testid="text-total-price">
              ${totalPrice}
            </span>
            <span className="text-muted-foreground" data-testid="text-period-suffix">
              {periodSuffix}
            </span>
          </div>

          <div className="bg-muted/50 rounded-lg p-4 space-y-3">
            <div className="flex items-center justify-between">
              <span className="text-sm font-medium">Seats</span>
              <div className="flex items-center gap-3">
                <button
                  onClick={() => setSeats(Math.max(3, seats - 1))}
                  className="w-8 h-8 rounded-full border flex items-center justify-center hover:bg-muted"
                  data-testid="button-decrease-seats"
                >
                  <Minus className="h-4 w-4" />
                </button>
                <span className="w-8 text-center font-medium" data-testid="text-seat-count">
                  {seats}
                </span>
                <button
                  onClick={() => setSeats(seats + 1)}
                  className="w-8 h-8 rounded-full border flex items-center justify-center hover:bg-muted"
                  data-testid="button-increase-seats"
                >
                  <Plus className="h-4 w-4" />
                </button>
              </div>
            </div>
            <div className="text-sm text-muted-foreground space-y-1">
              <div className="flex justify-between">
                <span>Base plan (3 seats included)</span>
                <span data-testid="text-base-price">
                  ${basePrice}
                  {periodShort}
                </span>
              </div>
              {extraSeats > 0 && (
                <div className="flex justify-between">
                  <span>
                    {extraSeats} additional seat{extraSeats !== 1 ? "s" : ""}
                  </span>
                  <span data-testid="text-extra-price">
                    +${extraSeats * extraPrice}
                    {periodShort}
                  </span>
                </div>
              )}
            </div>
          </div>

          <Button
            onClick={() => checkoutMutation.mutate()}
            disabled={checkoutMutation.isPending}
            className="w-full bg-[#F09000] hover:bg-[#d98000] text-white h-12 text-base"
            data-testid="button-continue-checkout"
          >
            {checkoutMutation.isPending ? "Redirecting…" : "Continue"}
          </Button>

          <div className="text-center">
            <button
              onClick={skip}
              className="text-sm text-slate-400 hover:text-slate-500 underline underline-offset-2"
              data-testid="link-skip-choose-plan"
            >
              Skip this step
            </button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
