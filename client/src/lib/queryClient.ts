import { QueryClient, QueryFunction } from "@tanstack/react-query";

// Session 2 trial-flow rework: when the server returns 402
// {error:"trial_expired"}, surface a single global toast (debounced)
// directing the user to add a card. Per spec: at most one trial-expired
// toast per 30 seconds to avoid spam from repeated mutation attempts.
const TRIAL_EXPIRED_TOAST_DEBOUNCE_MS = 30_000;
let lastTrialExpiredToastAt = 0;
type TrialExpiredHandler = (message: string) => void;
let trialExpiredHandler: TrialExpiredHandler | null = null;

export function registerTrialExpiredHandler(handler: TrialExpiredHandler | null) {
  trialExpiredHandler = handler;
}

async function maybeNotifyTrialExpired(res: Response): Promise<Response> {
  if (res.status !== 402) return res;
  const cloned = res.clone();
  try {
    const body = await cloned.json();
    if (body?.error === "trial_expired") {
      const now = Date.now();
      if (now - lastTrialExpiredToastAt >= TRIAL_EXPIRED_TOAST_DEBOUNCE_MS) {
        lastTrialExpiredToastAt = now;
        trialExpiredHandler?.(
          body.message || "Your trial has ended. Add a card to continue."
        );
      }
    }
  } catch {
    // Non-JSON 402 — ignore, let the original error path handle it.
  }
  return res;
}

async function throwIfResNotOk(res: Response) {
  if (!res.ok) {
    await maybeNotifyTrialExpired(res);
    const text = (await res.text()) || res.statusText;
    throw new Error(`${res.status}: ${text}`);
  }
}

export async function apiRequest(
  method: string,
  url: string,
  data?: unknown | undefined,
): Promise<Response> {
  const res = await fetch(url, {
    method,
    headers: data ? { "Content-Type": "application/json" } : {},
    body: data ? JSON.stringify(data) : undefined,
    credentials: "include",
  });

  await throwIfResNotOk(res);
  return res;
}

type UnauthorizedBehavior = "returnNull" | "throw";
export const getQueryFn: <T>(options: {
  on401: UnauthorizedBehavior;
}) => QueryFunction<T> =
  ({ on401: unauthorizedBehavior }) =>
  async ({ queryKey }) => {
    const res = await fetch(queryKey.join("/") as string, {
      credentials: "include",
    });

    if (unauthorizedBehavior === "returnNull" && res.status === 401) {
      return null;
    }

    await throwIfResNotOk(res);
    return await res.json();
  };

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      queryFn: getQueryFn({ on401: "throw" }),
      refetchInterval: false,
      refetchOnWindowFocus: false,
      staleTime: Infinity,
      retry: false,
    },
    mutations: {
      retry: false,
    },
  },
});

// [DIAG] Session 3 BUG 2 instrumentation — log every query lifecycle event
// (fetch start, success, error). Cache-level subscription so it covers
// queries fired by any component, not just useAuth.
const queryStartTimes = new Map<string, number>();
queryClient.getQueryCache().subscribe((event) => {
  if (!event) return;
  const key = JSON.stringify(event.query.queryKey);
  if (event.type === "updated") {
    const action: any = (event as any).action;
    if (action?.type === "fetch") {
      queryStartTimes.set(key, performance.now());
      console.log("[query] fetch start", { key });
    } else if (action?.type === "success") {
      const t = queryStartTimes.get(key);
      const dt = t ? Math.round(performance.now() - t) : null;
      queryStartTimes.delete(key);
      console.log("[query] success", { key, ms: dt });
    } else if (action?.type === "error") {
      const t = queryStartTimes.get(key);
      const dt = t ? Math.round(performance.now() - t) : null;
      queryStartTimes.delete(key);
      console.log("[query] error", { key, ms: dt, error: String(action.error?.message ?? action.error) });
    }
  }
});
