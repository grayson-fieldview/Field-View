import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { useToast } from "@/hooks/use-toast";
import { Loader2, ArrowLeft, CheckCircle2, AlertCircle } from "lucide-react";
import faviconImg from "@assets/Favicon-01_1772067008525.png";

export default function ResetPasswordPage() {
  const { toast } = useToast();
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");

  const params = new URLSearchParams(window.location.search);
  const token = params.get("token");

  const resetMutation = useMutation({
    mutationFn: async () => {
      if (password !== confirmPassword) {
        throw new Error("Passwords do not match");
      }
      if (password.length < 8) {
        throw new Error("Password must be at least 8 characters");
      }
      const res = await fetch("/api/reset-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, password }),
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.message || "Reset failed");
      }
      return data;
    },
    onError: (error: Error) => {
      toast({
        title: "Error",
        description: error.message,
        variant: "destructive",
      });
    },
  });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    resetMutation.mutate();
  };

  if (!token) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-[#F0EDEA] dark:bg-gray-950 px-4">
        <Card className="w-full max-w-md shadow-lg border-0">
          <CardContent className="pt-8 text-center space-y-4">
            <div className="mx-auto w-12 h-12 rounded-full bg-destructive/10 flex items-center justify-center">
              <AlertCircle className="h-6 w-6 text-destructive" />
            </div>
            <h2 className="text-xl font-semibold" data-testid="text-invalid-link">Invalid reset link</h2>
            <p className="text-sm text-muted-foreground">
              This password reset link is missing or invalid. Please request a new one.
            </p>
            <a
              href="/forgot-password"
              className="inline-flex items-center gap-1 text-sm text-[#F09000] hover:underline font-medium"
              data-testid="link-request-new-reset"
            >
              Request a new reset link
            </a>
          </CardContent>
        </Card>
      </div>
    );
  }

  if (resetMutation.isSuccess) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-[#F0EDEA] dark:bg-gray-950 px-4">
        <Card className="w-full max-w-md shadow-lg border-0">
          <CardContent className="pt-8 text-center space-y-4">
            <div className="mx-auto w-12 h-12 rounded-full bg-[#267D32]/10 flex items-center justify-center">
              <CheckCircle2 className="h-6 w-6 text-[#267D32]" />
            </div>
            <h2 className="text-xl font-semibold" data-testid="text-reset-success">Password reset!</h2>
            <p className="text-sm text-muted-foreground">
              Your password has been updated. You can now sign in with your new password.
            </p>
            <a
              href="/login"
              className="inline-flex items-center gap-1 text-sm text-[#F09000] hover:underline font-medium"
              data-testid="link-go-to-login"
            >
              <ArrowLeft className="h-4 w-4" />
              Go to sign in
            </a>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-[#F0EDEA] dark:bg-gray-950 px-4">
      <Card className="w-full max-w-md shadow-lg border-0">
        <CardHeader className="text-center space-y-4 pb-2">
          <div className="flex items-center justify-center gap-2">
            <img src={faviconImg} alt="Field View" className="h-8 w-8" />
            <span className="text-xl font-bold text-[#1E1E1E] dark:text-white">Field View</span>
          </div>
          <CardTitle className="text-2xl" data-testid="text-reset-title">Set new password</CardTitle>
          <CardDescription>Enter your new password below</CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="password">New password</Label>
              <Input
                id="password"
                type="password"
                placeholder="At least 8 characters"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                minLength={8}
                data-testid="input-new-password"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="confirmPassword">Confirm password</Label>
              <Input
                id="confirmPassword"
                type="password"
                placeholder="Re-enter your password"
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                required
                minLength={8}
                data-testid="input-confirm-password"
              />
            </div>
            <Button
              type="submit"
              className="w-full bg-[#F09000] hover:bg-[#d98000] text-white"
              disabled={resetMutation.isPending}
              data-testid="button-reset-password"
            >
              {resetMutation.isPending ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Resetting...
                </>
              ) : (
                "Reset Password"
              )}
            </Button>
          </form>
          <div className="mt-6 text-center">
            <a
              href="/login"
              className="inline-flex items-center gap-1 text-sm text-[#F09000] hover:underline font-medium"
              data-testid="link-back-to-login"
            >
              <ArrowLeft className="h-4 w-4" />
              Back to sign in
            </a>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
