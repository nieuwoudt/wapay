# Prompting Claude Fable 5.1 on WaPay

*How we brief Claude (Fable 5.1 / Mythos 5.1 class) to build features in this repo. Written 2026-09-04 from Anthropic's "Prompting Claude Fable 5.1" guide, mapped section by section onto what is actually enforced here. Update it when the guide or our tooling changes. The short version lives in `CLAUDE.md` ("Working with Claude"); this is the long version with the why.*

Companion files:

- `FEATURE_PROMPT_TEMPLATE.md` — the fill-in template every feature brief uses.
- `prompts/` — the briefs we actually ran, one file per feature, newest first.
- `.claude/skills/feature-prompt/` — turns a raw idea into a finished brief.
- `.claude/skills/handover/` — writes the tracker/CHANGELOG handover in the compaction-safe shape.
- `.claude/skills/fable-review/` — read-only adversarial review with background subagents.

## 0. The one-paragraph model

Fable finishes long tasks on its own when the goal is clear, so the brief's job is to make the goal, the boundaries and the proof unmistakable, and then get out of the way. It under-narrates by default, so we ask for progress lines. It sometimes widens scope, so we say what to leave out. It sometimes describes the next step instead of doing it, so we tell it the user is not watching. Everything else in the Anthropic guide is either an API-harness concern (documented below so we know it exists) or a style preference we encode once.

## 1. Section-by-section: what the guide says, what we do

| Guide section | What it means for Fable | Where it is implemented on WaPay |
|---|---|---|
| Consider all effort levels | `high` is the default; step down to `medium`/`low` when evals hold, up to `xhigh`/`max` only where a measured gain exists. Names do not map across models. | §2 below. Effort is set per session in the Claude Code app (model picker / `/config` in a terminal). Briefs name the recommended level. |
| Ask for user-facing progress updates | Fable writes fewer notes between tool calls. Remove any "hold findings for the end" language; add one line asking for a preamble, brief updates, and a standalone recap. | `CLAUDE.md` → Working with Claude. Also the template's "Working style" block. |
| Batch independent tool calls | In coding loops Fable may issue one call per turn. Nudge: "list what you need, then request everything independent in one response." | `CLAUDE.md` line; the template repeats it at the end of every brief. |
| Keep the conversation history append-only | API harness rule: never edit earlier turns, use turn-scoped system messages, let server-side compaction trim. | Not our code (Claude Code handles it). Recorded in §3 for the day the WaPay brain moves to the Claude API. |
| Writing density | Fable's prose can run dense. Define "mannered prose" and ban it. | `CLAUDE.md` line + template "Writing" block. |
| Formatting in chat | Fable uses less bold/headers; remove anti-formatting rules; say when lists are appropriate. | `CLAUDE.md` line. |
| Quoting retrieved sources | When summarising documents, mark quotes. Give one worked example. | Applies to research briefs; the example lives in §4 and the research variant of the template. |
| Finish the whole task | Two blocks: "you are operating autonomously" + "Delivering work". The first sentence carries most of the effect. | `CLAUDE.md` (short form); the template's "Autonomy" block (full form). |
| Compaction summaries | Tell the model the six things a summary must keep. | `/handover` skill writes tracker handovers in exactly that shape; §5 has the text for `/compact`. |
| Keep changes and tests to what the task asks | Unrequested fixes and extra test files drop with one instruction. | `CLAUDE.md` line + template "Scope" block. Repo already sizes tests "like the neighbouring files". |
| Search triggering at low effort | At `low`, Fable answers from memory. Raise effort for lookups or add the "verify names you recognise" line. | §2; the template's research variant. |
| Reduce safeguard false positives | Ask "are there any bugs" not "does this compile"; give context for rare languages; keep base64 out of tool output. | §6. |
| Prefer targeted edits | Fable rewrites whole files more than Fable 5 did. One line fixes it. | `CLAUDE.md` line. |
| Leave room for long outputs at xhigh/max | Long deliverables at high effort get drafted twice. Run at `high`, or append the token-budget note. | §2 and the template's "Long deliverable" note. |
| Let the lead agent keep working while subagents run | Subagents return immediately; results arrive later; lead continues. | Claude Code already does this (background agents). `/fable-review` uses it. The read-only rule from memory `review-agents-read-only` is mandatory. |
| Give vision work tools to crop and zoom | Dense screenshots/charts: crop and enlarge before answering. | §7: the browser `zoom` action, `Read` on images, PIL in the scratchpad. |

## 2. Effort: which level for which WaPay work

| Work | Recommended effort | Why |
|---|---|---|
| Money-path changes (ledger, ITN, holds, processor flows) | `high` (default) or `xhigh` for the adversarial review pass | Correctness beats latency. Review passes benefit from more thinking. |
| New surfaces (admin/business pages, API routes) | `high` | Long multi-file builds; Fable's long-horizon behaviour is strongest here. |
| Copy edits, docs, tracker updates, tests for known behaviour | `medium` | Matches Fable 5 quality at lower cost. |
| Lookups where the answer is in the repo | `low`, but only with the "verify the name" line, or the model answers from memory | Search triggering drops at low effort. |
| Long single deliverables (a 300-line doc, a whole page) at `xhigh`/`max` | Prefer `high`; if higher, append the token-budget note from §2.1 | Avoids drafting the deliverable twice. |

Re-sweep these when the model changes: effort names are not comparable across models.

### 2.1 Token-budget note (append to the user message when running long deliverables at xhigh/max)

> Everything produced in one reply, including any reasoning or drafting done before the reply, counts toward a single limit of about [max_tokens] tokens. If that limit is reached before the reply is finished, the person receives a cut-off response and has to start over. Composing an entire output or deliverable in full as reasoning and then again as a reply would double the length of the turn without improving the result, so don't do that. Instead, when the person has asked for a long or effort-intensive deliverable, spend extra effort on understanding the request, checking the inputs the answer depends on, settling the structure and other difficult decisions, and otherwise use the reasoning space to reason and the output space to write an output.

## 3. API-harness rules (for when the WaPay brain runs on the Claude API)

The conversational brain is on OpenAI today (`@wapay/ai`). When it moves, these are non-negotiable:

1. **Append-only history.** Store each assistant turn exactly as returned, thinking blocks included. Never rewrite earlier turns or the system prompt mid-session; new accounts get a 400 (`bound to a different conversation`) when a replayed thinking block's prefix changed.
2. **Per-turn reminders go in turn-scoped system messages** (`role: "system"`, `clear_at: "next_user_message"`, beta header `mid-conversation-system-clear-at-2026-08-21`). Append a fresh copy each turn; leave the old ones in place byte-for-byte.
3. **Batching nudge** as such a message after every tool-result turn: *"First privately list what you need next; then request every item that doesn't depend on another's result in this one response."*
4. **Progress updates** arrive as `thinking` blocks; request `thinking.display: "updates"` (beta `thinking-display-updates-2026-08-18`) or they are empty.
5. **Compaction**: prefer server-side. Client-side: replace the whole history with one summary plus the new user turn; use the six-item instruction in §5.
6. **Refusals**: `stop_reason: "refusal"` is possible on benign code; see §6 and keep a fallback.
7. **Quoting**: when the brain summarises supplier documents, include the one-example rationale block (§4) in the system prompt.

## 4. Quoting example (research briefs and any summarising prompt)

```text
<example>
<user>look up how the Riverton Ledger and the Coast Dispatch each covered the Harbor Bridge closure and compare their reporting</user>
<response>
[web_search: Harbor Bridge closure Riverton Ledger]
[web_search: Harbor Bridge closure Coast Dispatch]
Both outlets agree on the basics: the bridge closed on March 3 after inspectors found cracked welds, and the state expects repairs to take about eight months. Where they differ is emphasis. The Ledger treats it as a local-economy story. The Dispatch frames it as a funding failure; its editorial calls the closure "entirely foreseeable." Read together, the Ledger explains who is affected now and the Dispatch explains how it came to this. Neither account alone gives the whole picture.
</response>
<rationale>CORRECT: organised around where the sources agree and differ, each conveyed in the assistant's own words, one short marked phrase from one source, everything else reworded, still specific and complete.</rationale>
</example>
```

Replace `[web_search: …]` with the real tool name so the model reads it as templated tool output.

## 5. Compaction / handover summary instruction

Use verbatim with `/compact <instruction>` or when writing a tracker HANDOVER by hand (the `/handover` skill does this):

> Summarize the transcript inside <summary></summary> tags. Include relevant information in the summary such that this conversation will be continued by a new context window without needing to redo work or be reprovided with relevant constraints or context. Be sure to preserve: (1) any difficulties or problems that came up, and how they were handled or resolved; (2) any possibilities, options, or approaches that were raised, tried, or set aside, and why; (3) anything that was asked for, decided, agreed, ruled out, or established as a preference, constraint, or boundary — stated exactly; (4) exactly where things stand now — what has been covered, settled, or completed so far; (5) anything still open, unresolved, promised, or expected to happen next; (6) specific details that would be hard to reconstruct — names, numbers, dates, exact wording, links or references — kept exactly. Be complete on these even at the cost of length; keep everything else concise. Weight the two voices differently: keep what the user said, asked for, shared, or established carefully and close to their own words; your own explanations and reasoning can be condensed much further, to what they concluded or produced — as long as nothing in the six items above is dropped.

## 6. Avoiding safeguard false positives

- Ask **"Are there any bugs in this program?"** rather than "Does this compile without errors?".
- For unusual languages or DSLs (Prisma schema, PayFast ITN signing rules), paste the relevant docs into the brief.
- Keep **base64 blobs out of tool output** (image payloads, signed tokens). Save them to a file and pass the path.
- Security work on WaPay is authorised defensive work (our own code, our own webhooks); say so in the brief when the task is a review of signing, auth or webhook handling.

## 7. Vision work

- Screenshots from the founder: `Read` the file, then use the browser `zoom` action or crop with PIL in the scratchpad before concluding anything about small UI text.
- Dense charts: crop the region, enlarge, then read numbers. Never read a KPI off a full-page thumbnail.

## 8. Subagents on WaPay

- Every review/verify agent prompt carries: **"READ-ONLY. Do not Edit/Write any repo file. Report findings; propose mutations, never apply them."** (memory `review-agents-read-only`, BUGLOG #24/#25).
- Run them in the background and keep working; collect results when they arrive.
- Any feature where user A causes a message or state change on user B gets the adversarial review BEFORE shipping (memory `cross-user-actions-need-consent-gate`).

## 9. The brief itself

Use `FEATURE_PROMPT_TEMPLATE.md`. Keep it under two screens. The order matters: goal, hard constraints, scope in/out, acceptance proof, working style. Fable reads the whole thing; it does not need the same rule twice.
