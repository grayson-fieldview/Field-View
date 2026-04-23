import { useState, useEffect } from "react";
import { useLocation } from "wouter";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { useToast } from "@/hooks/use-toast";
import { Eye, EyeOff, Loader2, AlertTriangle } from "lucide-react";
import { SiGoogle } from "react-icons/si";
import { Mail } from "lucide-react";
import faviconImg from "@assets/Favicon-01_1772067008525.png";

type Providers = { google: boolean; microsoft: boolean };

export function SocialAuthButtons({ inviteToken }: { inviteToken?: string | null }) {
  const { data: providers } = useQuery<Providers>({
    queryKey: ["/api/auth/providers"],
  });
  if (!providers || (!providers.google && !providers.microsoft)) return null;
  const qs = inviteToken ? `?invite=${encodeURIComponent(inviteToken)}` : "";
  return (
    <div className="space-y-2">
      {providers.google && (
        <Button
          asChild
          variant="outline"
          className="w-full"
          data-testid="button-google-auth"
        >
          <a href={`/api/auth/google${qs}`}>
            <SiGoogle className="mr-2 h-4 w-4" />
            Continue with Google
          </a>
        </Button>
      )}
      {providers.microsoft && (
        <Button
          asChild
          variant="outline"
          className="w-full"
          data-testid="button-microsoft-auth"
        >
          <a href={`/api/auth/microsoft${qs}`}>
            <Mail className="mr-2 h-4 w-4" />
            Continue with Microsoft
          </a>
        </Button>
      )}
      <div className="relative my-2">
        <div className="absolute inset-0 flex items-center">
          <span className="w-full border-t border-border" />
        </div>
        <div className="relative flex justify-center text-xs uppercase">
          <span className="bg-card px-2 text-muted-foreground">or</span>
        </div>
      </div>
    </div>
  );
}

export default function LoginPage() {
  const [, setLocation] = useLocation();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [unverifiedEmail, setUnverifiedEmail] = useState<string | null>(null);

  // Surface OAuth callback errors via toast and clean up the URL
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const err = params.get("error");
    if (err) {
      const map: Record<string, string> = {
        google_not_configured: "Google sign-in isn't set up yet.",
        microsoft_not_configured: "Microsoft sign-in isn't set up yet.",
        session: "We couldn't start your session. Please try again.",
      };
      toast({
        title: "Sign-in failed",
        description: map[err] || decodeURIComponent(err),
        variant: "destructive",
      });
      window.history.replaceState({}, "", window.location.pathname);
    }
  }, [toast]);

  const loginMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch("/api/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ email, password }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        if (res.status === 403 && data.error === "email_not_verified") {
          const err: any = new Error("email_not_verified");
          err.code = "email_not_verified";
          err.email = data.email || email;
          throw err;
        }
        throw new Error(data.message || "Login failed");
      }
      return data;
    },
    onSuccess: (data) => {
      setUnverifiedEmail(null);
      queryClient.setQueryData(["/api/auth/user"], data);
      setLocation("/");
    },
    onError: (error: any) => {
      if (error.code === "email_not_verified") {
        setUnverifiedEmail(error.email);
        return;
      }
      setUnverifiedEmail(null);
      toast({
        title: "Login failed",
        description: error.message,
        variant: "destructive",
      });
    },
  });

  const resendMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch("/api/resend-verification", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: unverifiedEmail }),
      });
      const data = await res.json();
      if (!res.ok) {
        const err: any = new Error(data.error || data.message || "Request failed");
        err.status = res.status;
        throw err;
      }
      return data;
    },
    onSuccess: (data) => {
      toast({
        title: "Verification email sent",
        description: data.message || "Check your inbox for the verification link.",
      });
    },
    onError: (error: any) => {
      toast({
        title: error.status === 429 ? "Too many requests" : "Couldn't resend email",
        description: error.message,
        variant: "destructive",
      });
    },
  });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    loginMutation.mutate();
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-[#F0EDEA] dark:bg-gray-950 px-4">
      <Card className="w-full max-w-md shadow-lg border-0">
        <CardHeader className="text-center space-y-4 pb-2">
          <div className="flex items-center justify-center gap-2">
            <img src={faviconImg} alt="Field View" className="h-8 w-8" />
            <span className="text-xl font-bold text-[#1E1E1E] dark:text-white">Field View</span>
          </div>
          <CardTitle className="text-2xl" data-testid="text-login-title">Welcome back</CardTitle>
          <CardDescription>Sign in to your account to continue</CardDescription>
        </CardHeader>
        <CardContent>
          {unverifiedEmail && (
            <div
              className="mb-4 p-3 rounded-lg border border-amber-300 bg-amber-50 dark:bg-amber-900/20 dark:border-amber-700"
              data-testid="banner-email-not-verified"
            >
              <div className="flex items-start gap-2">
                <AlertTriangle className="h-4 w-4 text-amber-600 dark:text-amber-400 mt-0.5 shrink-0" />
                <div className="text-sm text-amber-900 dark:text-amber-200">
                  <p className="font-medium mb-1">Your email isn't verified yet</p>
                  <p className="text-xs mb-2">
                    Check your inbox for the verification link sent to <strong>{unverifiedEmail}</strong> — or click below to resend.
                  </p>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={() => resendMutation.mutate()}
                    disabled={resendMutation.isPending}
                    data-testid="button-resend-verification"
                  >
                    {resendMutation.isPending ? (
                      <>
                        <Loader2 className="mr-2 h-3 w-3 animate-spin" />
                        Sending...
                      </>
                    ) : (
                      "Resend verification email"
                    )}
                  </Button>
                </div>
              </div>
            </div>
          )}
          <SocialAuthButtons />
          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="email">Email</Label>
              <Input
                id="email"
                type="email"
                placeholder="you@company.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                data-testid="input-email"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="password">Password</Label>
              <div className="relative">
                <Input
                  id="password"
                  type={showPassword ? "text" : "password"}
                  placeholder="Enter your password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
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
            <div className="flex justify-end">
              <a
                href="/forgot-password"
                className="text-sm text-[#F09000] hover:underline"
                data-testid="link-forgot-password"
              >
                Forgot password?
              </a>
            </div>
            <Button
              type="submit"
              className="w-full bg-[#F09000] hover:bg-[#d98000] text-white"
              disabled={loginMutation.isPending}
              data-testid="button-login"
            >
              {loginMutation.isPending ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Signing in...
                </>
              ) : (
                "Sign In"
              )}
            </Button>
          </form>
          <div className="mt-6 text-center text-sm text-muted-foreground">
            Don't have an account?{" "}
            <a href="/signup" className="text-[#F09000] hover:underline font-medium" data-testid="link-register">
              Start your free trial
            </a>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
