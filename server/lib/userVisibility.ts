export type ViewerLike = { id: string; role?: string | null };

export function isManagerRole(role?: string | null): boolean {
  return role === "admin" || role === "manager";
}

export function sanitizeUserForViewer<T extends Record<string, any>>(
  user: T,
  viewer: ViewerLike,
): T {
  if (isManagerRole(viewer?.role)) return user;
  const { hourlyRateCents: _hr, timesheetEnabled, ...rest } = user as any;
  const out: any = { ...rest };
  if (viewer?.id && viewer.id === user.id) {
    out.timesheetEnabled = timesheetEnabled;
  }
  return out as T;
}

export function sanitizeTimeEntryForViewer<T extends Record<string, any>>(
  entry: T,
  viewer: ViewerLike,
): T {
  if (isManagerRole(viewer?.role)) return entry;
  const { rateCentsSnapshot: _r, ...rest } = entry as any;
  return rest as T;
}
