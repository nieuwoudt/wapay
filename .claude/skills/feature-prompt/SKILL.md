---
name: feature-prompt
description: Turn a raw feature idea (voice-note transcript, chat paragraph, bullet dump) into a finished Claude Fable 5.1 build brief using docs/prompting/FEATURE_PROMPT_TEMPLATE.md, saved under docs/prompting/prompts/. Use when the founder says "help me format this prompt", "write the brief for…", or pastes a feature description to build.
---

# /feature-prompt — raw idea → Fable build brief

## When to use
The user hands you a feature in their own words and wants it built well. Run this BEFORE building. The output is a file the build session (or this session) executes.

## Steps

1. **Read context first** (batch these): `CLAUDE.md`, `docs/CAPABILITIES.md`, the newest tracker entry in `…/Desktop/WaPay /WAPAY_BUILD_TRACKER.md`, and `docs/prompting/FEATURE_PROMPT_TEMPLATE.md`. Check the memory index for locked decisions that touch the feature (fees, regulatory, Meta policy, consent gate).
2. **Extract from the raw idea**: the real user, the job to be done, every capability named, every constraint implied ("don't rebuild", "don't break anything", design words like "mirror finish").
3. **Resolve ambiguity yourself** where the repo or memory decides it; list the rest under "Assumptions to state in the summary". Ask the user a question only if two readings would produce materially different work AND nothing in the repo decides it. Ask all such questions at once, never one at a time.
4. **Map to the existing stack**: name the files and patterns the build must reuse (auth pattern, money rail, chart components). Anything that would require a second implementation of an existing capability goes under Hard constraints as "reuse X".
5. **Write the brief** into `docs/prompting/prompts/<YYYY-MM-DD>-<slug>.md` using the template verbatim: Goal, Hard constraints, Scope (In / Out / Assumptions), Acceptance, Working style. Keep it under two screens. Do not repeat a rule the constitution already states except money-safety and "don't break anything".
6. **Pick the effort level** from `docs/prompting/FABLE_5_1_PROMPTING.md` §2 and put it in the header.
7. **Show the user the brief in full** (it is short) and say which assumptions you made. If the user asked you to build it in the same session, start building immediately after showing it.

## Rules
- The founder's words win over yours for scope; keep their phrasing in the "In" bullets.
- Any A-affects-B behaviour (one user causes a message or state change on another) MUST appear under Hard constraints with the consent-gate rule and an adversarial review in Acceptance.
- Fee lines: receiver pays, payer pays the displayed amount, free under R50, free from balance. Never invent a fee.
- No betting or cash-out language in any copy the brief asks for.
