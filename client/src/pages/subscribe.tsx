import { useState, useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { useAuth } from "@/hooks/use-auth";
import { useToast } from "@/hooks/use-toast";
import {
  CheckCircle2,
  Loader2,
  Crown,
  Minus,
  Plus,
  CreditCard,
} from "lucide-react";
import faviconImg from "@assets/Favicon-01_1772067008525.png";

export default function SubscribePage() {
  const { user, logout } = useAuth();
  const { toast } = useToast();
  const qc = useQueryClient();
  const [billingCycle, setBillingCycle] = useState<"annual" | "monthly">("annual");
  const [teamSize, setTeamSize] = useState(3);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get("checkout") === "success") {
      window.history.replaceState({}, "", "/");
      fetch("/api/confirm-checkout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
      })
        .then((res) => res.json())
        .then(() => {
          qc.invalidateQueries({ queryKey: ["/api/auth/user"] });
        })
        .catch(() => {});
    }
  }, [qc]);

  const { data: prices, isLoading: pricesLoading } = useQuery({
    queryKey: ["/api/stripe/prices"],
  });

  const checkoutMutation = useMutation({
    mutationFn: async (lineItems: { priceId: string; quantity: number }[]) => {
      const res = await fetch("/api/create-checkout-session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ lineItems }),
      });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.message || "Failed to create checkout");
      }
      return res.json();
    },
    onSuccess: (data) => {
      if (data.url) {
        window.location.href = data.url;
      }
    },
    onError: (error: Error) => {
      toast({
        title: "Error",
        description: error.message,
        variant: "destructive",
      });
    },
  });

  const baseUsers = 3;
  const extraUsers = Math.max(0, teamSize - baseUsers);
  const annualBase = 49;
  const monthlyBase = 79;
  const annualExtra = 24;
  const monthlyExtra = 29;

  const basePrice = billingCycle === "annual" ? annualBase : monthlyBase;
  const extraPrice = billingCycle === "annual" ? annualExtra : monthlyExtra;
  const totalPrice = basePrice + extraUsers * extraPrice;

  const features = [
    "Unlimited photo documentation",
    "Project & task management",
    "Team collaboration (up to your plan size)",
    "Interactive map view",
    "Shareable photo galleries",
    "Checklist & report templates",
    "Analytics dashboard",
    "Photo annotations & markup",
    "Daily activity logs",
    "Before/after photo comparison",
    "Priority support",
  ];

  const handleSubscribe = () => {
    const priceList = prices as any[];
    if (!priceList || priceList.length === 0) {
      toast({
        title: "Plans not available",
        description: "Please try again in a moment.",
        variant: "destructive",
      });
      return;
    }

    const interval = billingCycle === "annual" ? "year" : "month";
    const basePlan = priceList.find(
      (p: any) => p.recurring_interval === interval && p.product_name?.toLowerCase().includes("field view")
    ) || priceList.find((p: any) => p.recurring_interval === interval && !p.product_name?.toLowerCase().includes("additional") && !p.product_name?.toLowerCase().includes("seat"));

    if (!basePlan) {
      toast({
        title: "Plan not found",
        description: "Please try again in a moment.",
        variant: "destructive",
      });
      return;
    }

    const items: { priceId: string; quantity: number }[] = [
      { priceId: basePlan.price_id, quantity: 1 },
    ];

    if (extraUsers > 0) {
      const seatPrice = priceList.find(
        (p: any) => p.product_name?.toLowerCase().includes("additional") || p.product_name?.toLowerCase().includes("seat")
      );
      if (seatPrice) {
        items.push({ priceId: seatPrice.price_id, quantity: extraUsers });
      }
    }

    checkoutMutation.mutate(items);
  };

  const status = user?.subscriptionStatus;
  const trialEndsAt = user?.trialEndsAt ? new Date(user.trialEndsAt) : null;
  const trialExpired = trialEndsAt && trialEndsAt < new Date();
  const daysLeft = trialEndsAt
    ? Math.max(0, Math.ceil((trialEndsAt.getTime() - Date.now()) / (1000 * 60 * 60 * 24)))
    : 0;

  return (
    <div className="min-h-screen bg-[#F0EDEA] dark:bg-gray-950">
      <div className="border-b bg-white dark:bg-gray-900 px-6 py-4">
        <div className="max-w-5xl mx-auto flex items-center justify-between">
          <div className="flex items-center gap-2">
            <img src={faviconImg} alt="Field View" className="h-8 w-8" />
            <span className="text-xl font-bold text-[#1E1E1E] dark:text-white">Field View</span>
          </div>
          <div className="flex items-center gap-4">
            <span className="text-sm text-muted-foreground">{user?.email}</span>
            <Button variant="ghost" size="sm" onClick={() => logout()} data-testid="button-logout">
              Log out
            </Button>
          </div>
        </div>
      </div>

      <div className="max-w-3xl mx-auto px-6 py-12">
        {trialExpired ? (
          <div className="text-center mb-8">
            <h1 className="text-3xl font-bold text-foreground mb-2" data-testid="text-subscribe-title">
              Your trial has ended
            </h1>
            <p className="text-muted-foreground text-lg">
              Subscribe to continue using Field View for your team
            </p>
          </div>
        ) : status === "none" || !status ? (
          <div className="text-center mb-8">
            <h1 className="text-3xl font-bold text-foreground mb-2" data-testid="text-subscribe-title">
              Start your 14-day free trial
            </h1>
            <p className="text-muted-foreground text-lg">
              Add a payment method to begin — you won't be charged until the trial ends
            </p>
          </div>
        ) : (
          <div className="text-center mb-8">
            <h1 className="text-3xl font-bold text-foreground mb-2" data-testid="text-subscribe-title">
              Choose your plan
            </h1>
            <p className="text-muted-foreground text-lg">
              {daysLeft > 0
                ? `You have ${daysLeft} day${daysLeft !== 1 ? "s" : ""} left in your free trial`
                : "Start your subscription to unlock all features"}
            </p>
          </div>
        )}

        <Card className="shadow-lg border-0 overflow-hidden">
          <CardHeader className="bg-[#1E1E1E] text-white pb-6">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Crown className="h-5 w-5 text-[#F09000]" />
                <CardTitle className="text-xl">Field View Pro</CardTitle>
              </div>
              <div className="flex items-center gap-2 bg-white/10 rounded-full p-1">
                <button
                  onClick={() => setBillingCycle("annual")}
                  className={`px-4 py-1.5 rounded-full text-sm font-medium transition-colors ${
                    billingCycle === "annual"
                      ? "bg-[#F09000] text-white"
                      : "text-white/70 hover:text-white"
                  }`}
                  data-testid="button-annual"
                >
                  Annual
                </button>
                <button
                  onClick={() => setBillingCycle("monthly")}
                  className={`px-4 py-1.5 rounded-full text-sm font-medium transition-colors ${
                    billingCycle === "monthly"
                      ? "bg-[#F09000] text-white"
                      : "text-white/70 hover:text-white"
                  }`}
                  data-testid="button-monthly"
                >
                  Monthly
                </button>
              </div>
            </div>
            {billingCycle === "annual" && (
              <Badge className="w-fit bg-[#267D32] text-white mt-2">Save 38%</Badge>
            )}
          </CardHeader>

          <CardContent className="p-6 space-y-6">
            <div className="flex items-baseline gap-1">
              <span className="text-4xl font-bold text-foreground">${totalPrice}</span>
              <span className="text-muted-foreground">/month</span>
            </div>

            <div className="bg-muted/50 rounded-lg p-4 space-y-3">
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium">Team size</span>
                <div className="flex items-center gap-3">
                  <button
                    onClick={() => setTeamSize(Math.max(1, teamSize - 1))}
                    className="w-8 h-8 rounded-full border flex items-center justify-center hover:bg-muted"
                    data-testid="button-decrease-team"
                  >
                    <Minus className="h-4 w-4" />
                  </button>
                  <span className="w-8 text-center font-medium" data-testid="text-team-size">
                    {teamSize}
                  </span>
                  <button
                    onClick={() => setTeamSize(teamSize + 1)}
                    className="w-8 h-8 rounded-full border flex items-center justify-center hover:bg-muted"
                    data-testid="button-increase-team"
                  >
                    <Plus className="h-4 w-4" />
                  </button>
                </div>
              </div>
              <div className="text-sm text-muted-foreground space-y-1">
                <div className="flex justify-between">
                  <span>Base ({baseUsers} users)</span>
                  <span>${basePrice}/mo</span>
                </div>
                {extraUsers > 0 && (
                  <div className="flex justify-between">
                    <span>{extraUsers} additional user{extraUsers !== 1 ? "s" : ""}</span>
                    <span>+${extraUsers * extraPrice}/mo</span>
                  </div>
                )}
              </div>
            </div>

            <div className="space-y-2">
              <p className="text-sm font-medium mb-3">Everything included:</p>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                {features.map((feature) => (
                  <div key={feature} className="flex items-center gap-2 text-sm text-muted-foreground">
                    <CheckCircle2 className="h-4 w-4 text-[#267D32] flex-shrink-0" />
                    {feature}
                  </div>
                ))}
              </div>
            </div>

            <Button
              onClick={handleSubscribe}
              className="w-full bg-[#F09000] hover:bg-[#d98000] text-white h-12 text-base"
              disabled={checkoutMutation.isPending || pricesLoading}
              data-testid="button-subscribe"
            >
              {checkoutMutation.isPending ? (
                <>
                  <Loader2 className="mr-2 h-5 w-5 animate-spin" />
                  Redirecting to checkout...
                </>
              ) : status === "none" || !status ? (
                <>
                  <CreditCard className="mr-2 h-5 w-5" />
                  Start Free Trial — ${totalPrice}/mo after trial
                </>
              ) : (
                <>
                  <CreditCard className="mr-2 h-5 w-5" />
                  Subscribe — ${totalPrice}/month
                </>
              )}
            </Button>

            <p className="text-xs text-center text-muted-foreground">
              14-day free trial — your card won't be charged until the trial ends. Cancel anytime.
            </p>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
