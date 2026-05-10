import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import type { User } from "@shared/models/auth";

// [DIAG] Session 3 BUG 2 instrumentation — see Commit "diagnostic only".
async function fetchUser(): Promise<User | null> {
  const t0 = performance.now();
  console.log("[auth] fetchUser → GET /api/auth/user");
  const response = await fetch("/api/auth/user", {
    credentials: "include",
  });
  const dt = Math.round(performance.now() - t0);

  if (response.status === 401) {
    console.log(`[auth] fetchUser ← 401 in ${dt}ms (returning null)`);
    return null;
  }

  if (!response.ok) {
    console.log(`[auth] fetchUser ← ${response.status} in ${dt}ms (throwing)`);
    throw new Error(`${response.status}: ${response.statusText}`);
  }

  const json = await response.json();
  console.log(`[auth] fetchUser ← 200 in ${dt}ms`, {
    id: json?.id,
    email: json?.email,
    accessLevel: json?.accessLevel,
    profileCompletedAt: json?.profileCompletedAt,
    emailVerified: json?.emailVerified,
    subscriptionStatus: json?.subscriptionStatus,
  });
  return json;
}

async function logoutFn(): Promise<void> {
  await fetch("/api/logout", {
    method: "POST",
    credentials: "include",
  });
}

export function useAuth() {
  const queryClient = useQueryClient();
  const query = useQuery<User | null>({
    queryKey: ["/api/auth/user"],
    queryFn: fetchUser,
    // Session 3 BUG 2 defense: a single transient 401 (e.g., Vercel
    // serverless cold-start cookie race right after /api/register) used
    // to wipe the seeded user object and bounce the freshly-signed-up
    // user out to the unauthenticated <Switch>. One retry recovers
    // before that happens; fetchUser already returns null (not throws)
    // on a real 401, so retries only fire on transport errors.
    retry: 1,
    staleTime: 1000 * 60 * 5,
  });
  const { data: user, isLoading } = query;
  // [DIAG] Log every state transition. prevRef avoids double-logging on
  // strict-mode rerenders that don't actually change state.
  const prevRef = useRef<string>("");
  useEffect(() => {
    const sig = JSON.stringify({
      status: query.status,
      fetchStatus: query.fetchStatus,
      isLoading,
      hasUser: !!user,
      userId: user?.id,
      errored: !!query.error,
    });
    if (sig !== prevRef.current) {
      prevRef.current = sig;
      console.log("[auth] state →", {
        status: query.status,
        fetchStatus: query.fetchStatus,
        isLoading,
        hasUser: !!user,
        userId: user?.id ?? null,
        error: query.error ? String((query.error as Error).message) : null,
      });
    }
  }, [query.status, query.fetchStatus, isLoading, user, query.error]);

  const logoutMutation = useMutation({
    mutationFn: logoutFn,
    onSuccess: () => {
      queryClient.setQueryData(["/api/auth/user"], null);
      window.location.href = "/";
    },
  });

  return {
    user,
    isLoading,
    isAuthenticated: !!user,
    logout: logoutMutation.mutate,
    isLoggingOut: logoutMutation.isPending,
  };
}
