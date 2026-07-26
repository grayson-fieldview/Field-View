---
name: Task photo requirement design
description: Invariants of the task photo-requirement feature (422 gate, no recompute, admin-only)
---
- Requirement enforced ONLY at status→done transition in the task PATCH (422 `{code:"PHOTOS_REQUIRED",required,attached}`); nothing ever recomputes a done task's status — detaching/deleting photos or raising the requirement must NOT reopen tasks. **Why:** explicit product decision (unlike checklists' `_recomputeItemCompletion`).
- `requiredPhotoCount` from non-admin PATCHes is silently STRIPPED, never rejected — mobile PATCHes whole task objects.
- The dogfood feature flag was fully removed July 2026: setting the requirement is admin-only and enforcement is always on for everyone (default 0 = inert, so no behavior change for accounts that never set it).
- Attach endpoints scope via projects.accountId joins and reject media whose projectId ≠ the task's project. attach is idempotent (`onConflictDoNothing` on unique(taskId,mediaId)) for mobile retries.
- Extra `/api/auth/user` fields ride through `sanitizeUserForViewer` unchanged (it only strips hourlyRateCents/timesheetEnabled) — safe place to expose per-account flags.
