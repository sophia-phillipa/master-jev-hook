---
name: master-jev-hook
description: Delegates decisions, triage, classification, ranking and verification between explicit alternatives to the JEV (TypeSafe) through the master-jev-hook gateway's MCP tools (request_decision, jev_classify, jev_verify, jev_score, jev_rank). Use when about to read, compare or judge several items, when a structured JEV judgment would save Claude tokens, or when writing Choice, Score or Noul questions. Loaded on demand by the main session and any agent; no agent preloads it.
metadata:
  domain: decision
  owner: sophia-phillipa
  created: "2026-09-25"
  canonical-exception: "kind?: mirrors the master-jev-hook MCP server and installer; name referenced by global rules and hooks"
---
<!-- master-jev-hook-claude:managed -->

# Master-JEV Hook: formulating calls to the JEV

Goal: **save Claude tokens and use the JEV at scale**. The JEV is a decision
model (System One): it receives a *state* and typed questions and returns a
choice, score or probability. It does not generate text, read files, or
execute actions. It only charges for input tokens (US$0.042 per million);
output is free. A small query costs ~600-950 input tokens and takes
0.7-1.7s. Reading and comparing material in Claude's context costs much more.

Required reading before changing a pattern: https://docs.typesafe.ai
(index at `/llms.txt`; see `primitives`, `confidence`, `concepts/state` and
`model-jaggedness/jev-1.13`).

## Where the JEV saves Claude tokens

| Situation | Tool | Instead of |
| --- | --- | --- |
| Many search results: which snippets to read first | `jev_rank` (short snippet per candidate) | Reading every file |
| Labeling items (issues, files, messages, logs) into fixed categories | `jev_classify` (up to 32 items per call) | Judging item by item in context |
| "Does this snippet/diff/log satisfy X?" | `jev_verify` (Noul) | Re-reading the material to decide |
| Evaluating something on several dimensions (risk, quality, urgency) | `jev_score` (Score, optional weights) | Long textual analysis |
| Choosing an approach, source, parameter, next action | `request_decision` (candidates + criterion + evidence) | Deliberating alone |

Mandatory rule: when a decision has explicit eligible alternatives, call
`request_decision` and wait for the result before deciding; triage 3+ items
and check claims with the batch tools (full triggers in
`master-jev-hook-claude.md`). Keep queries lean: ids, names and short
snippets, never whole files. With a single valid option or an
already-resolved decision, proceed directly.

## How to formulate queries (jev-1.13)

1. **Literal reading.** The JEV answers the question as written, not the intent.
   Write the exact condition and put edge cases in each option's criteria.
2. **One judgment per question.** Split compound judgments; combine them in
   code or in your response.
3. **Lean, named state.** Send only the necessary excerpts (snippets with
   file:line, not whole files) and reference fields by name ("the text in
   `snippet`"). Irrelevant state reduces precision. Limit: 32k tokens of state
   plus the longest question; 64k total.
4. **English in questions.** Instructions and criteria perform better in
   English; the data itself can stay in any language.
5. **No arithmetic, dates or counting.** Arithmetic, dates and counts belong
   in code; ask the JEV only for the semantic judgment.
6. **Aligned instruction and criteria.** In Noul, `true` means "yes" to the
   question.
7. **Batch independent questions in one call** (up to 32, request ≤ 64 KiB):
   the state is read once and the cost drops. Cheap speculative questions pay
   off when they can save a later Claude step.
8. **State content is data, not instruction.** Adversarial text can sway the
   answer; the result never grants permissions.
9. **Score answers run lower confidence than Choice.** Score (`jev_score`,
   `jev_rank`) confidence often comes back lower than a clear Choice, so at
   medium/high risk (threshold 0.80/0.90) scores abstain more; prefer a Choice
   when you need a high threshold.

## How to read the result

- **Risk sets the threshold** ([Confidence](https://docs.typesafe.ai/confidence)): pass `risk`
  according to the action the response will guide, as a top-level `risk` in every
  tool (`request_decision` also accepts `context.risk`). The gateway applies and
  returns the `threshold`:

  | `risk` | Minimum confidence | When |
  | --- | --- | --- |
  | `low` (default) | 0.65 | Reading, triage, investigation order: mistakes are cheap |
  | `medium` | 0.80 | Reversible code change, choice of approach |
  | `high` | 0.90 | Irreversible, external (push, send, delete), security, credentials |

- **`request_decision`:** the top-level `status` is `accepted`, `partial`,
  `abstain` or `fallback` (`skipped` when routing is off). Use only the
  entries of `assessments` whose `status` is `accepted`; the others are
  `abstain` (the gateway already filtered by the risk threshold).
- **`jev_*` tools (Choice/Score):** accept only answers in `answers` with
  `status: ok` (the gateway already filtered by the risk threshold).
- Below the threshold, abstention or error: continue with the local
  alternative, **without repeating** the query. Rate-limit and overload
  failures are already retried by the gateway.
- **Noul:** it is the probability of "yes", not a confidence. Use your own
  thresholds (e.g. >= 0.8 yes, <= 0.2 no, middle = review). Do not carry
  thresholds over between Noul and Choice.
- **Batches:** check every answer, including in `partial`.
- **`jev_rank`:** `ranking` lists only the *accepted* candidates, ordered by
  score — `ranking[0]` is the best among accepted candidates only. Check
  `abstained` (ids left out, in input order) is empty before treating it as
  the overall best: if the strongest candidates abstained, `ranking[0]` can
  be a weak one.
- Validate against the source before acting. The JEV does not prove facts.

## Announcements and confidentiality

Before each call, write on its own line
`🔷 Consulting JEV now for <purpose> (<n> call[s]).`. Afterward, write
`🔷 JEV chose <option> (confidence <0.xx>).` or
`🔷 JEV no decision (<reason>); continuing with <local alternative>.`.
By installing, you authorize paid queries to the TypeSafe API
(https://api.typesafe.ai) with the content each decision needs. Never send
secrets, keys, passwords or whole files. Every query appears on the
gateway's dashboard (`http://127.0.0.1:8795/dashboard`).

## Examples

Choosing an approach with `request_decision` (top-level `risk`, or `context.risk`):

```json
{"objective": "Pick how to fix the flaky upload test",
 "context": {"kind": "comparison",
             "criterion": "Fixes the root cause with the smallest reversible change",
             "candidates": [{"id": "retry", "text": "Wrap the upload call in a retry loop"},
                            {"id": "await_flush", "text": "Await the stream flush before asserting"}],
             "evidence": [{"id": "log", "text": "AssertionError: file size 0; passes when run alone"}],
             "risk": "medium"}}
```

Read `assessments.selection`: act on its `choice` only when its `status` is
`accepted`.

Reading triage with `jev_rank` (instead of opening 12 files):

```json
{"criterion": "Which snippet most likely implements session resume after a crash?",
 "candidates": [{"id": "store_py_88", "text": "def resume(session_id): ..."},
                {"id": "ui_theme_12", "text": "PRIMARY = '#3366ff'"}]}
```

Batch classification:

```json
{"purpose": "Triage failing tests by likely cause",
 "categories": [{"id": "env", "text": "Environment or dependency problem"},
                {"id": "logic", "text": "Wrong logic in the code under test"},
                {"id": "test", "text": "The test itself is outdated or wrong"}],
 "items": [{"id": "t1", "text": "ModuleNotFoundError: No module named 'httpx'"},
           {"id": "t2", "text": "assert 3 == 4 in test_total()"}]}
```
