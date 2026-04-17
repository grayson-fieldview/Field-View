import { useState, useEffect } from "react";
import { useLocation, useSearch } from "wouter";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/hooks/use-toast";
import { Eye, EyeOff, Loader2, CheckCircle2, Users } from "lucide-react";
import { SocialAuthButtons } from "./login";
import faviconImg from "@assets/Favicon-01_1772067008525.png";

export default function RegisterPage() {
  const [, setLocation] = useLocation();
  const searchString = useSearch();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);

  const params = new URLSearchParams(searchString);
  const inviteToken = params.get("token");

  const { data: inviteInfo } = useQuery<{ email: string; role: string; accountName: string }>({
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
      if (password !== confirmPassword) {
        throw new Error("Passwords do not match");
      }
      if (password.length < 8) {
        throw new Error("Password must be at least 8 characters");
      }
      const res = await fetch("/api/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          email,
          password,
          firstName,
          lastName,
          ...(inviteToken ? { inviteToken } : {}),
        }),
      });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.message || "Registration failed");
      }
      return res.json();
    },
    onSuccess: (data) => {
      queryClient.setQueryData(["/api/auth/user"], data);
      setLocation("/");
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
    <div className="min-h-screen flex items-center justify-center bg-[#F0EDEA] dark:bg-gray-950 px-4 py-8">
      <Card className="w-full max-w-md shadow-lg border-0">
        <CardHeader className="text-center space-y-4 pb-2">
          <div className="flex items-center justify-center gap-2">
            <img src={faviconImg} alt="Field View" className="h-8 w-8" />
            <span className="text-xl font-bold text-[#1E1E1E] dark:text-white">Field View</span>
          </div>
          {inviteInfo ? (
            <>
              <CardTitle className="text-2xl" data-testid="text-register-title">Join {inviteInfo.accountName}</CardTitle>
              <CardDescription>
                You've been invited to join as a{" "}
                <Badge variant="secondary" className="text-xs">{roleLabels[inviteInfo.role] || inviteInfo.role}</Badge>
              </CardDescription>
            </>
          ) : (
            <>
              <CardTitle className="text-2xl" data-testid="text-register-title">Start your free trial</CardTitle>
              <CardDescription>14 days free — add a payment method to get started</CardDescription>
            </>
          )}
        </CardHeader>
        <CardContent>
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
          <SocialAuthButtons inviteToken={inviteToken} />
          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-2">
                <Label htmlFor="firstName">First name</Label>
                <Input
                  id="firstName"
                  placeholder="John"
                  value={firstName}
                  onChange={(e) => setFirstName(e.target.value)}
                  data-testid="input-first-name"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="lastName">Last name</Label>
                <Input
                  id="lastName"
                  placeholder="Smith"
                  value={lastName}
                  onChange={(e) => setLastName(e.target.value)}
                  data-testid="input-last-name"
                />
              </div>
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
            <div className="space-y-2">
              <Label htmlFor="confirmPassword">Confirm password</Label>
              <Input
                id="confirmPassword"
                type={showPassword ? "text" : "password"}
                placeholder="Confirm your password"
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                required
                data-testid="input-confirm-password"
              />
            </div>
            <Button
              type="submit"
              className="w-full bg-[#F09000] hover:bg-[#d98000] text-white"
              disabled={registerMutation.isPending}
              data-testid="button-register"
            >
              {registerMutation.isPending ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  {inviteInfo ? "Joining team..." : "Creating account..."}
                </>
              ) : (
                inviteInfo ? "Join Team" : "Create Account & Start Trial"
              )}
            </Button>
          </form>
          {!inviteInfo && (
            <div className="mt-5 p-4 bg-[#F0EDEA] dark:bg-gray-900 rounded-lg">
              <p className="text-sm font-medium mb-2 text-foreground">Your trial includes:</p>
              <ul className="space-y-1.5">
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
        </CardContent>
      </Card>
    </div>
  );
}
