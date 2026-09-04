---
name: fable-review
description: Read-only adversarial review of a WaPay change using background subagents (money, security, conversation, cross-user, admin/ops lenses) while the lead keeps working; findings are verified before they are reported and never applied by the reviewers. Use before shipping any money-path change or any feature where one user can trigger a message or state change on another.
---

# /fable-review — read-only adversarial review, lead keeps working

## Standing rules (from memory `review-agents-read-only` and `cross-user-actions-need-consent-gate`)
- Every reviewer prompt starts with: **"READ-ONLY. Do not Edit, Write or run mutation tests against any repo file. Report findings with file:line and a concrete failure scenario; propose the mutation that would expose it, never apply it."**
- Reviewers run in the background (default). The lead continues building, testing or documenting and collects results as they arrive. Do not idle.
- Any A-affects-B feature gets this review BEFORE ship, never after.

## Steps

1. **Define the diff**: list the changed files (fast copy vs iCloud `rsync -rcn`, or the commit range). Paste that list into every reviewer prompt so they review the same thing.
2. **Spawn lens reviewers in ONE message** (Explore or general-purpose agents, `run_in_background: true`), one per lens that applies:
   - **Money**: integer cents, idemKeys deterministic and epoch-free, every hold released on every crash path, quotes binding, exactly-once across rails, no direct wallet mutation.
   - **Security**: auth gates before DB access, fail-closed on missing env, constant-time compares, no secrets/PINs/OTPs in logs or payloads, cookie flags, host gating, injection via `$queryRawUnsafe` or string-built SQL, IDOR on ids.
   - **Cross-user / phishing**: relationship gate, informational-only, attacker-controlled labels sanitised, membership-neutral responses, rate limits.
   - **Conversation** (if the processor changed): new matchers never hijack ordinary sentences; states never trap; escapes work.
   - **Policy/copy**: no betting or cash-out language; fee direction receiver-pays; no card-surcharge framing.
   - **UI/ops**: every computed block is returned AND rendered; failures render as unknown, never as R0; dark mode tokens defined.
3. **Verify each finding** with a second read-only agent or yourself: reproduce the scenario against the code, classify CONFIRMED / REFUTED, severity CRITICAL/HIGH/MEDIUM/LOW.
4. **Fix confirmed findings yourself** (the lead is the only writer), add a regression guard per fix, re-run `node --test tests/*.test.mjs`.
5. **Record**: `docs/testing/adversarial-review-<date>.md` (counts, load-bearing catches table, accepted risks, refuted-for-the-record), BUGLOG entries for real bugs.

## Prompt skeleton for a reviewer
```
READ-ONLY. Do not Edit, Write or run mutation tests against any repo file. Report findings; propose mutations, never apply them.
Repo: ~/Projects/wapay. Changed files: <list>. Lens: <lens>.
For each finding: file:line, the concrete input/state → wrong outcome, severity, the smallest test that would catch it.
Ignore style. Ignore anything outside the changed files unless a changed file calls into it.
```
