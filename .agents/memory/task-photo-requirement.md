---
name: Task photo requirement design
description: Invariants of the task photo-requirement feature (422 gate, no recompute, dogfood flag)
---
- Requirement enforced ONLY at status→done transition in the task PATCH (422 `{code:"PHOTOS_REQUIRED",required,attached}`); nothing ever recomputes a done task's status — detaching/deleting photos or raising the requirement must NOT reopen tasks. **Why:** explicit product decision (unlike checklists' `_recomputeItemCompletion`).
- `requiredPhotoCount` from non-admin / non-flagged PATCHes is silently STRIPPED, never rejected — mobile PATCHes whole task objects.
- Dogfood flag: `FEATURE_TASK_PHOTO_REQUIREMENT_ACCOUNTS` (comma-separated account IDs) gates the input UI and server field-writes only; enforcement of an already-set requirement is not flag-gated (default 0 = inert).
- Attach endpoints scope via projects.accountId joins and reject media whose projectId ≠ the task's project. attach is idempotent (`onConflictDoNothing` on unique(taskId,mediaId)) for mobile retries.
- Extra `/api/auth/user` fields ride through `sanitizeUserForViewer` unchanged (it only strips hourlyRateCents/timesheetEnabled) — safe place to expose flags like `taskPhotoRequirementEnabled`.
