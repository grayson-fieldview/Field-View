import { useState, useEffect } from "react";
import { useLocation, useSearch } from "wouter";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/hooks/use-toast";
import { Eye, EyeOff, Loader2, CheckCircle2, Users } from "lucide-react";
import { useGoogleReCaptcha } from "react-google-recaptcha-v3";
import faviconImg from "@assets/Favicon-01_1772067008525.png";

export default function RegisterPage() {
  const [, setLocation] = useLocation();
  const searchString = useSearch();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [companyName, setCompanyName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [termsAccepted, setTermsAccepted] = useState(false);
  const { executeRecaptcha } = useGoogleReCaptcha();

  const params = new URLSearchParams(searchString);
  const inviteToken = params.get("token");

  const { data: inviteInfo } = useQuery<{ email: string; role: string; accountName: string; firstName: string | null; lastName: string | null }>({
    queryKey: ["/api/invitations/validate", inviteToken],
    queryFn: async () => {
      const res = await fetch(`/api/invitations/validate/${inviteToken}`);
      if (!res.ok) throw new Error("Invalid invitation");
      return res.json();
    },
    enabled: !!inviteToken,
    retry: false,
  });

  useEffect(() => {
    if (inviteInfo?.email) {
      setEmail(inviteInfo.email);
    }
  }, [inviteInfo]);

  const registerMutation = useMutation({
    mutationFn: async () => {
      if (!termsAccepted) {
        throw new Error("You must agree to the Terms of Service and Privacy Policy to create an account.");
      }
      if (!inviteInfo && !companyName.trim()) {
        throw new Error("Company name is required");
      }
      if (password.length < 8) {
        throw new Error("Password must be at least 8 characters");
      }

      const hasRecaptcha = Boolean(import.meta.env.VITE_RECAPTCHA_SITE_KEY);
      let recaptchaToken: string | undefined;
      if (hasRecaptcha) {
        if (!executeRecaptcha) {
          throw new Error("Security check unavailable. Please refresh and try again.");
        }
        recaptchaToken = await executeRecaptcha("signup");
      }

      const res = await fetch("/api/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          email,
          password,
          companyName: companyName.trim(),
          ...(inviteToken ? { inviteToken } : {}),
          ...(recaptchaToken ? { recaptchaToken } : {}),
          termsAccepted: true,
        }),
      });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.message || "Registration failed");
      }
      return res.json();
    },
    onSuccess: (data) => {
      setLocation(`/check-email?email=${encodeURIComponent(data.email || email)}`);
    },
    onError: (error: Error) => {
      toast({
        title: "Registration failed",
        description: error.message,
        variant: "destructive",
      });
    },
  });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    registerMutation.mutate();
  };

  const trialFeatures = [
    "Unlimited photo documentation",
    "Automatic GPS Time Tracking",
    "Project & task management",
    "Team collaboration tools",
    "Shareable photo galleries",
    "Analytics dashboard",
  ];

  const roleLabels: Record<string, string> = {
    admin: "Admin",
    manager: "Manager",
    standard: "Standard",
    restricted: "Restricted",
  };

  return (
    <div className="min-h-screen flex bg-white dark:bg-gray-950">
      {/* Left brand panel — desktop only */}
      <div
        className="hidden lg:flex lg:w-2/5 flex-col p-12 bg-[#F09000]/50"
        data-testid="panel-brand"
      >
        <div className="flex items-center gap-2" data-testid="brand-logo-row">
          <img
            src={faviconImg}
            alt="Field View"
            className="h-10 w-10 rounded-md"
            data-testid="img-brand-logo"
          />
          <span className="text-2xl font-bold tracking-tight text-gray-900">
            Field View
          </span>
        </div>

        <div className="mt-12 flex flex-col gap-10">
          <h1
            className="text-4xl lg:text-5xl font-bold leading-tight text-gray-900"
            data-testid="text-brand-tagline"
          >
            Trusted by hundreds of contractors across the country.
          </h1>

          <figure
            className="bg-zinc-900 text-white rounded-2xl shadow-2xl shadow-black/40 p-8"
            data-testid="card-testimonial"
          >
            <blockquote className="text-lg leading-relaxed">
              "FieldView has helped our team stay organized across multiple
              projects, automatically clocks in all of our employees when they
              get to the job, and has been a big help with the growth of our
              company."
            </blockquote>
            <figcaption className="mt-4 text-base font-medium text-white/80">
              — Luke Ousdigian, Palm Beach Painters
            </figcaption>
          </figure>
        </div>
      </div>

      {/* Right form panel */}
      <div className="flex flex-col flex-1 lg:w-3/5 items-center justify-center px-4 py-8 sm:px-6 lg:px-12">
        <div className="w-full max-w-md">
          <div className="text-center space-y-2 mb-5">
            <div className="flex items-center justify-center gap-2 lg:hidden">
              <img src={faviconImg} alt="Field View" className="h-8 w-8" />
              <span className="text-xl font-bold text-[#1E1E1E] dark:text-white">Field View</span>
            </div>
            {inviteInfo ? (
              <>
                <h2 className="text-2xl font-bold text-foreground" data-testid="text-register-title">
                  Join {inviteInfo.accountName}
                </h2>
                <p className="text-sm text-muted-foreground">
                  You've been invited to join as a{" "}
                  <Badge variant="secondary" className="text-xs">{roleLabels[inviteInfo.role] || inviteInfo.role}</Badge>
                </p>
              </>
            ) : (
              <>
                <h2 className="text-2xl font-bold text-foreground" data-testid="text-register-title">
                  Welcome! Create an account for your company.
                </h2>
              </>
            )}
          </div>

          {inviteInfo && (
            <div className="mb-4 p-3 bg-blue-50 dark:bg-blue-900/20 rounded-lg flex items-center gap-3">
              <Users className="h-5 w-5 text-blue-600 dark:text-blue-400 shrink-0" />
              <div className="text-sm">
                <p className="font-medium text-blue-900 dark:text-blue-300">Team Invitation</p>
                <p className="text-blue-700 dark:text-blue-400 text-xs">
                  You're joining <strong>{inviteInfo.accountName}</strong> as {roleLabels[inviteInfo.role] || inviteInfo.role}
                </p>
              </div>
            </div>
          )}

          <form onSubmit={handleSubmit} className="space-y-3">
            {!inviteInfo && (
              <div className="space-y-2">
                <Label htmlFor="companyName">Company Name</Label>
                <Input
                  id="companyName"
                  placeholder="Acme Construction LLC"
                  value={companyName}
                  onChange={(e) => setCompanyName(e.target.value)}
                  required
                  data-testid="input-company-name"
                />
              </div>
            )}
            <div className="space-y-2">
              <Label htmlFor="email">Work email</Label>
              <Input
                id="email"
                type="email"
                placeholder="john@company.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                readOnly={!!inviteInfo}
                className={inviteInfo ? "bg-muted" : ""}
                data-testid="input-email"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="password">Password</Label>
              <div className="relative">
                <Input
                  id="password"
                  type={showPassword ? "text" : "password"}
                  placeholder="Min. 8 characters"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                  minLength={8}
                  className="pr-10"
                  data-testid="input-password"
                />
                <button
                  type="button"
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                  onClick={() => setShowPassword(!showPassword)}
                  data-testid="button-toggle-password"
                >
                  {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </button>
              </div>
            </div>
            <label className="flex items-start gap-2 text-sm text-muted-foreground">
              <input
                type="checkbox"
                checked={termsAccepted}
                onChange={(e) => setTermsAccepted(e.target.checked)}
                required
                className="mt-1 h-4 w-4 rounded border-input accent-[#F09000]"
                data-testid="checkbox-terms"
              />
              <span>
                I agree to the{" "}
                <a
                  href="https://field-view.com/terms"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-[#F09000] underline hover:no-underline"
                  data-testid="link-terms"
                >
                  Terms of Service
                </a>{" "}
                and{" "}
                <a
                  href="https://field-view.com/privacy"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-[#F09000] underline hover:no-underline"
                  data-testid="link-privacy"
                >
                  Privacy Policy
                </a>
              </span>
            </label>
            <Button
              type="submit"
              className="w-full bg-[#F09000] hover:bg-[#d98000] text-white"
              disabled={registerMutation.isPending || !termsAccepted}
              data-testid="button-register"
            >
              {registerMutation.isPending ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  {inviteInfo ? "Joining team..." : "Creating account..."}
                </>
              ) : (
                inviteInfo ? "Join Team" : "Get Started"
              )}
            </Button>
          </form>

          {!inviteInfo && (
            <div className="mt-4 p-4 bg-[#F0EDEA] dark:bg-gray-900 rounded-lg">
              <p className="text-sm font-medium mb-2 text-foreground">Your trial includes:</p>
              <ul className="grid grid-cols-2 gap-x-4 gap-y-1">
                {trialFeatures.map((feature) => (
                  <li key={feature} className="flex items-center gap-2 text-sm text-muted-foreground">
                    <CheckCircle2 className="h-3.5 w-3.5 text-[#267D32] flex-shrink-0" />
                    {feature}
                  </li>
                ))}
              </ul>
            </div>
          )}

          <div className="mt-4 text-center text-sm text-muted-foreground">
            Already have an account?{" "}
            <a href="/login" className="text-[#F09000] hover:underline font-medium" data-testid="link-login">
              Sign in
            </a>
          </div>
        </div>
      </div>
    </div>
  );
}
