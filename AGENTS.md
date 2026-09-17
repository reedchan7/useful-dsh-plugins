# AGENTS.md

Behavioral guidelines to reduce common LLM coding mistakes. Merge with project-specific instructions as needed.

**Tradeoff:** These guidelines bias toward caution over speed. For trivial tasks, use judgment.

## 1. Think Before Coding

**Don't assume. Don't hide confusion. Surface tradeoffs.**

Before implementing:

- State your assumptions explicitly. If uncertain, ask.
- If multiple interpretations exist, present them - don't pick silently.
- If a simpler approach exists, say so. Push back when warranted.
- If something is unclear, stop. Name what's confusing. Ask.

## 2. Simplicity First

**Minimum code that solves the problem. Nothing speculative.**

- No features beyond what was asked.
- No abstractions for single-use code.
- No "flexibility" or "configurability" that wasn't requested.
- No error handling for impossible scenarios.
- If you write 200 lines and it could be 50, rewrite it.

Ask yourself: "Would a senior engineer say this is overcomplicated?" If yes, simplify.

## 3. Surgical Changes

**Touch only what you must. Clean up only your own mess.**

When editing existing code:

- Don't "improve" adjacent code, comments, or formatting.
- Don't refactor things that aren't broken.
- Match existing style, even if you'd do it differently.
- If you notice unrelated dead code, mention it - don't delete it.

When your changes create orphans:

- Remove imports/variables/functions that YOUR changes made unused.
- Don't remove pre-existing dead code unless asked.

The test: Every changed line should trace directly to the user's request.

## 4. Goal-Driven Execution

**Define success criteria. Loop until verified.**

Transform tasks into verifiable goals:

- "Add validation" → "Write tests for invalid inputs, then make them pass"
- "Fix the bug" → "Write a test that reproduces it, then make it pass"
- "Refactor X" → "Ensure tests pass before and after"

For multi-step tasks, state a brief plan:

```
1. [Step] → verify: [check]
2. [Step] → verify: [check]
3. [Step] → verify: [check]
```

Strong success criteria let you loop independently. Weak criteria ("make it work") require constant clarification.

## Rule 5 — Use the model only for judgment calls

Use me for: classification, drafting, summarization, extraction.
Do NOT use me for: routing, retries, deterministic transforms.
If code can answer, code answers.

## Rule 6 — Token budgets are not advisory

Per-task: 4,000 tokens. Per-session: 30,000 tokens.
If approaching budget, summarize and start fresh.
Surface the breach. Do not silently overrun.

## Rule 7 — Surface conflicts, don't average them

If two patterns contradict, pick one (more recent / more tested).
Explain why. Flag the other for cleanup.
Don't blend conflicting patterns.

## Rule 8 — Read before you write

Before adding code, read exports, immediate callers, shared utilities.
"Looks orthogonal" is dangerous. If unsure why code is structured a way, ask.

## Rule 9 — Tests verify intent, not just behavior

Tests must encode WHY behavior matters, not just WHAT it does.
A test that can't fail when business logic changes is wrong.

## Rule 10 — Checkpoint after every significant step

Summarize what was done, what's verified, what's left.
Don't continue from a state you can't describe back.
If you lose track, stop and restate.

## Rule 11 — Match the codebase's conventions, even if you disagree

Conformance > taste inside the codebase.
If you genuinely think a convention is harmful, surface it. Don't fork silently.

## Rule 12 — Fail loud

"Completed" is wrong if anything was skipped silently.
"Tests pass" is wrong if any were skipped.
Default to surfacing uncertainty, not hiding it.

---

# Repository conventions (useful-dsh-plugins)

Project-specific rules for this workspace. They win over the general guidance above where the two
touch the same ground.

## Layout

- One plugin per package under `plugins/<name>/`, named `@reedchan7/dsh-<name>` (lowercase, hyphenated,
  ASCII). A plugin ships its own semver. No changelog files: commit subjects carry the history, and a
  changelog maintained by hand goes stale beside them.
- Shared logic lives in `lib/<name>/` and is imported by **source path**. It is inlined into plugin
  builds and is never a published or runtime dependency.
- Repository tooling lives in `tools/<name>/`; build orchestration in `scripts/`.

## The two constraints that shape everything

1. **A plugin package has zero runtime dependencies.** DSH installs plugins into a profile with
   `dsh plugin`, which forwards to pnpm; neither pnpm nor Bun installs a linked package's transitive
   dependencies (verified). Anything a plugin needs at runtime must be inlined into its `lib/` by
   `scripts/build-plugins.ts`. Do not add `dependencies` to a plugin manifest — the contract test
   asserts their absence.
2. **The browser half is a `window.__ModuleLoader__.load({ id, factory })` CommonJS bundle**, not an
   ES module. `bun build --format=cjs` with the banner/footer in `scripts/build-plugins.ts` produces
   it; platform modules (react, react-dom, `@deepseek-ai/dsh-client-*`) stay external and arrive
   through the injected `require`. The browser cannot resolve bare specifiers, so anything not
   declared in `dsh.client.inject` must be inlined.

## Language

- Code, comments, JSDoc, commit messages, CLI output and hook prompts are **English**.
- Each `README.md` has a `README_CN.md` counterpart with the same heading structure, a language
  switcher at the top of both, and no other documentation language. `make docs-check` enforces it.
- User-facing plugin strings live in `lib/i18n` and are registered with DSH's locale service, so they
  follow the GUI language instead of carrying their own switch.

## Quality gates

- `make check` is the gate: `oxfmt --check`, `oxlint` (zero warnings), `tsc --noEmit`,
  `make docs-check`, `bun test`, `make build`. Nothing merges red.
- Tests encode intent. A cost-related figure must be asserted against a hand-computed expectation —
  the tests in `lib/cost-core/tests/pricing.test.ts` are the model to copy.
- No rule is silenced to make a gate pass. If a lint rule is wrong for the repository, add an
  `overrides` entry in `.oxlintrc.json` with a comment saying which class of code it excludes; do not
  sprinkle inline disables except where a single call site genuinely contradicts the rule, in which
  case name the reason.

## Data and money

- Every figure a user sees is an **estimate** derived from provider-reported token usage, and the UI
  says so.
- A model missing from the price book is reported as unpriced. Never bill it at zero.
- Currency comes from the account balance's own currency; CNY and USD are separate published price
  lists and are never converted into each other.
- Time is explicit: the billed schedule stays in the provider's timezone, the reader's calendar stays
  in theirs, and both are labelled.
