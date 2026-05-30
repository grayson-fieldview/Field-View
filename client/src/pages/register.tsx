import { useState, useEffect } from "react";
import { Link, useLocation, useSearch } from "wouter";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/hooks/use-toast";
import { Eye, EyeOff, Loader2, Users, Star } from "lucide-react";
import { useGoogleReCaptcha } from "react-google-recaptcha-v3";
import faviconImg from "@assets/Favicon-01-brand_1778259672.png";

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
  // Session 3 BUG 1 fix: inline error rendered under the email field
  // when the server returns 409 (email already registered). Kept
  // separate from the toast so a duplicate signup gets a persistent,
  // in-context message + a "Sign in" link instead of a transient toast.
  const [emailInUseError, setEmailInUseError] = useState(false);
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
        const data = await res.json().catch(() => ({}));
        const err: any = new Error(data.message || "Registration failed");
        err.status = res.status;
        throw err;
      }
      return res.json();
    },
    onSuccess: (data) => {
      // PR 3: Meta Pixel CompleteRegistration. Fires for BOTH branches
      // (trial signup + invitee accepting an invite) — any successful 201
      // from /api/register counts as a completed registration. Guarded so
      // SSR/test contexts and pixel-blocked browsers don't throw.
      if (typeof window !== "undefined" && window.fbq) {
        window.fbq("track", "CompleteRegistration");
      }
      // [DIAG] Session 3 BUG 2 instrumentation
      console.log("[register] success", {
        inviteToken: !!inviteToken,
        userId: data?.id,
        email: data?.email,
        profileCompletedAt: data?.profileCompletedAt,
        emailVerified: data?.emailVerified,
        accessLevel: data?.accessLevel,
        subscriptionStatus: data?.subscriptionStatus,
      });
      // Invitee branch: backend returned {message, email} (no auto-login —
      // they were emailed a verification link and must click it before
      // signing in cleanly). Send them to the "Check your email" landing.
      if (inviteToken) {
        console.log("[register] invite branch → /login");
        toast({
          title: "Check your email",
          description: "We sent a 6-digit verification code. Sign in to verify your account.",
        });
        setLocation("/login");
        return;
      }
      // Trial branch: backend auto-logged the user in and returned the full
      // user object. Seed the auth cache so AppContent's gates evaluate
      // immediately without a flash of /login, then route to /welcome (Step 2).
      // Session 3 BUG 2 fix: do NOT invalidateQueries here — the seeded data
      // is already correct. The previous invalidate triggered an immediate
      // background refetch of /api/auth/user that occasionally hit a Vercel
      // serverless instance whose session cookie hadn't propagated yet,
      // returning 401, wiping the user, and dumping the new signup into the
      // unauthenticated CatchAllRedirect (blank/redirect to /signup). The
      // verification email will fire from PATCH /api/auth/me on welcome
      // submit — they haven't filled their profile yet so no verification
      // email (no email exists yet to "check").
      queryClient.setQueryData(["/api/auth/user"], data);
      console.log("[register] trial branch → setQueryData + navigate /welcome");
      setLocation("/welcome");
    },
    onError: (error: any) => {
      // Session 3 BUG 1 fix: 409 = email already registered. On the
      // trial-signup branch, show an inline error under the email input
      // (with a Sign in link) instead of a generic toast — easier to spot,
      // easier to act on. On the invite branch the email field is readOnly
      // (pre-filled from the invite), so the inline UI never renders;
      // fall through to the toast so the user still sees the failure.
      if (error?.status === 409 && !inviteToken) {
        setEmailInUseError(true);
        return;
      }
      toast({
        title: "Registration failed",
        description: error?.message || "Something went wrong",
        variant: "destructive",
      });
    },
  });

  // Clear the inline 409 error as soon as the user edits the email field.
  useEffect(() => {
    if (emailInUseError) setEmailInUseError(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [email]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    registerMutation.mutate();
  };

  const roleLabels: Record<string, string> = {
    admin: "Admin",
    manager: "Manager",
    standard: "Standard",
    restricted: "Restricted",
  };

  // Invitee branch — preserved as-is from the previous design. Only the trial
  // branch (below) gets the CompanyCam-style two-panel redesign.
  if (inviteInfo) {
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
              <h2 className="text-2xl font-bold text-foreground" data-testid="text-register-title">
                Join {inviteInfo.accountName}
              </h2>
              <p className="text-sm text-muted-foreground">
                You've been invited to join as a{" "}
                <Badge variant="secondary" className="text-xs">{roleLabels[inviteInfo.role] || inviteInfo.role}</Badge>
              </p>
            </div>

            <div className="mb-4 p-3 bg-blue-50 dark:bg-blue-900/20 rounded-lg flex items-center gap-3">
              <Users className="h-5 w-5 text-blue-600 dark:text-blue-400 shrink-0" />
              <div className="text-sm">
                <p className="font-medium text-blue-900 dark:text-blue-300">Team Invitation</p>
                <p className="text-blue-700 dark:text-blue-400 text-xs">
                  You're joining <strong>{inviteInfo.accountName}</strong> as {roleLabels[inviteInfo.role] || inviteInfo.role}
                </p>
              </div>
            </div>

            <form onSubmit={handleSubmit} className="space-y-3">
              <div className="space-y-2">
                <Label htmlFor="email">Work email</Label>
                <Input
                  id="email"
                  type="email"
                  placeholder="john@company.com"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  required
                  readOnly
                  className="bg-muted"
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
                    href="https://www.field-view.com/legal/terms-and-conditions"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-[#F09000] underline hover:no-underline"
                    data-testid="link-terms"
                  >
                    Terms of Service
                  </a>{" "}
                  and{" "}
                  <a
                    href="https://www.field-view.com/legal/privacy-policy"
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
                    Joining team...
                  </>
                ) : (
                  "Join Team"
                )}
              </Button>
            </form>

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

  // Trial-signup branch — CompanyCam-style two-panel layout
  return (
    <div className="min-h-screen bg-white dark:bg-gray-950 p-3 sm:p-4">
      <div className="grid grid-cols-1 md:grid-cols-[40%_1fr] gap-3 sm:gap-4 md:min-h-[calc(100vh-2rem)]">
        {/* Left peach panel — full hero on desktop; on mobile the peach
            box treatment, headline, and testimonial are dropped so the page
            goes straight to the form with just the logo at top. */}
        <div
          className="px-2 pt-2 pb-0 flex flex-col md:bg-[#fceed8] md:rounded-3xl md:p-10 lg:p-14 md:justify-between md:min-h-0"
          data-testid="panel-brand"
        >
          {/* Logo */}
          <div className="flex items-center justify-center md:justify-start gap-2" data-testid="brand-logo-row">
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

          {/* Headline — desktop only */}
          <h1
            className="hidden md:block text-5xl sm:text-6xl lg:text-7xl font-extrabold leading-[0.95] tracking-tight text-slate-900 my-12"
            data-testid="text-brand-tagline"
          >
            Join hundreds of contractors who rely on FieldView
          </h1>

          {/* Testimonial card — desktop only */}
          <figure
            className="hidden md:block bg-white rounded-2xl shadow-md p-5 max-w-sm"
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

        {/* Right form panel */}
        <div className="flex md:items-center justify-center px-4 py-8 sm:px-6 lg:px-12">
          <div className="w-full max-w-md">
            <h2
              className="text-xl sm:text-2xl font-bold text-slate-900 dark:text-white text-center mb-6"
              data-testid="text-register-title"
            >
              Welcome! Create an account for your company.
            </h2>

            <form onSubmit={handleSubmit} className="space-y-3">
              <div className="space-y-2">
                <Label htmlFor="companyName">Company Name</Label>
                <Input
                  id="companyName"
                  placeholder="Acme Construction LLC"
                  value={companyName}
                  onChange={(e) => setCompanyName(e.target.value)}
                  required
                  className="bg-white border-2 border-slate-300 focus:border-[#F09000] focus-visible:ring-0 focus-visible:ring-offset-0 shadow-none"
                  data-testid="input-company-name"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="email">Work email</Label>
                <Input
                  id="email"
                  type="email"
                  placeholder="john@company.com"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  required
                  aria-invalid={emailInUseError || undefined}
                  aria-describedby={emailInUseError ? "email-error" : undefined}
                  className={`bg-white border-2 ${emailInUseError ? "border-red-500 focus:border-red-500" : "border-slate-300 focus:border-[#F09000]"} focus-visible:ring-0 focus-visible:ring-offset-0 shadow-none`}
                  data-testid="input-email"
                />
                {emailInUseError && (
                  <p
                    id="email-error"
                    className="text-sm text-red-600 dark:text-red-400"
                    data-testid="text-email-in-use-error"
                  >
                    This email is already registered.{" "}
                    <Link
                      href="/login"
                      className="font-bold text-[#F09000] hover:underline"
                      data-testid="link-sign-in-instead"
                    >
                      Sign in instead
                    </Link>
                  </p>
                )}
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
                    className="pr-10 bg-white border-2 border-slate-300 focus:border-[#F09000] focus-visible:ring-0 focus-visible:ring-offset-0 shadow-none"
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
                    href="https://www.field-view.com/legal/terms-and-conditions"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-[#F09000] underline hover:no-underline"
                    data-testid="link-terms"
                  >
                    Terms of Service
                  </a>{" "}
                  and{" "}
                  <a
                    href="https://www.field-view.com/legal/privacy-policy"
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
                    Creating account...
                  </>
                ) : (
                  "Get Started"
                )}
              </Button>
            </form>

            <div className="mt-4 text-center text-sm text-muted-foreground">
              Already have an account?{" "}
              <a href="/login" className="text-[#F09000] hover:underline font-medium" data-testid="link-login">
                Sign in
              </a>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
