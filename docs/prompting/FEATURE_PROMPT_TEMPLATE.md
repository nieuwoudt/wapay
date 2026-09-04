# Feature brief template (Claude Fable 5.1)

*Copy this into `docs/prompting/prompts/<date>-<slug>.md`, fill every bracket, delete the guidance lines in italics. Paste the result as the first message of the build session. The `/feature-prompt` skill produces this from a raw idea.*

---

# Build: [feature name]

**Effort:** [high | medium | xhigh] · **Session type:** [autonomous build | pair] · **Repo:** WaPay (`~/Projects/wapay` fast copy; canonical iCloud `…/Desktop/WaPay /WaPay V1.01`)

## Goal (one paragraph)

[Who it is for, what they can do when it ships, why it matters. Name the real user if there is one, e.g. "the founder's local laundry".]

## Hard constraints (never violate)

- Follow `CLAUDE.md` money-safety and policy invariants; all money through `postEntry`, integer cents, deterministic idemKeys.
- Build on the existing stack (Next.js pages router, Prisma, `lib/*`, `pages/api/*`, hand-rolled SVG charts). No new frameworks, no rewrites of existing surfaces.
- Do not break anything: `node --test tests/*.test.mjs` 100% green, `pnpm build` green, existing pages unchanged unless listed under Scope.
- [Feature-specific constraints: regulatory, Meta policy, fee direction, PII rules.]

## Scope

**In:**
- [Bullet per capability, in the user's words where possible.]

**Out (report as follow-ups, do not build):**
- [What is explicitly deferred.]

**Assumptions to state in the summary (decide, do not ask):**
- [Ambiguities with the reading you want taken.]

## Acceptance (how we know it is done)

- [ ] [Observable behaviour 1 with the exact route/command/screen.]
- [ ] Tests added alongside neighbours (one focused test per stated behaviour), no extra test files beyond the pattern.
- [ ] Docs updated: `docs/CAPABILITIES.md`, `docs/CHANGELOG.md`, tracker delta, BUGLOG only for bugs found.
- [ ] Activation instructions written (env names, Vercel redeploy reminder).

## Working style (Fable 5.1)

You are operating autonomously. The user is not watching in real time and cannot answer questions mid-task, so asking "Want me to…?" or "Shall I…?" will block the work. For reversible actions that follow from this brief, proceed without asking. Stop only for destructive actions or genuine scope changes. Before ending your turn, check your last paragraph: if it is a plan, a question or a promise, do that work now.

Before you start, say in a line what you're about to do; brief updates while you work help the user follow along. Close with a short recap that stands on its own.

If you find a pre-existing bug or behaviour the task doesn't mention, don't fix or extend it unless the requested behaviour cannot work without it; report it as a follow-up. Where the task is ambiguous, implement the reading its wording and the surrounding code most directly support, state that assumption, and don't build for the other readings as well.

Surgically edit files rather than rewriting them when the result is the same. Remove all mannered prose. Use lists only when the content is multifaceted.

Every review or verify subagent you spawn is READ-ONLY: it must not Edit or Write any repo file; it reports findings and proposes mutations.

First privately list what you need next; then request every item that doesn't depend on another's result in this one response.

---

*Optional blocks:*

*Research variant, add under Working style:* When a query centres on a name you do not confidently recognise, or from a fast-moving area, the name itself is the thing to verify: search before answering, and include the name as the user wrote it in at least one query. Mark any reproduced wording as a quotation; summarise in your own words otherwise.

*Long deliverable at xhigh/max, append to the end:* the token-budget note from `FABLE_5_1_PROMPTING.md` §2.1.
