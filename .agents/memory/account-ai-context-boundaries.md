---
name: Account AI context boundaries
description: Safety, scope, and caching decisions for per-account AI customization.
---

Apply curated trade context and account-authored business context only to reports and checklists. Resolve the account values in the request/caller layer and pass them into AI generators; AI modules must not query account settings. Treat free text as reference data, then place immutable rules after it with an explicit precedence statement. Do not add this context to captions or translation.

**Why:** Business context is user-controlled and can contain instructions, while the trade blocks are application-controlled. Putting immutable rules last preserves their authority. Reports have a sufficiently large stable Sonnet prefix for Anthropic caching; short Haiku prompts do not reliably meet the cache threshold.

**How to apply:** Keep context ordering consistent in every report/checklist path, including walkthroughs and retries. Cache only the stable report system prefix; keep notes, transcripts, photo descriptions, and other request-specific input dynamic.