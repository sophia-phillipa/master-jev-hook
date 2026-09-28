# Experiment log

What we tried to make Claude use the JEV better, how we measured it, and what we kept or dropped. Read this
before proposing a change to the reminders, rule text or hooks, so a rejected idea is not tested again without
a new reason. Newest first.

**Budget rule behind every measurement:** JEV (TypeSafe) cost does not matter; Claude tokens do. A change is an
improvement only if it lowers cost-weighted Claude tokens (or keeps them flat) with equal correctness.
Cost-weighted = uncached input ×1 + cache creation ×1.25 + cache read ×0.1 + output ×5.

## 2026-09-28 — v1.2.0 cycle

Method: unit and integration suites; a sandboxed installer suite; a live headless A/B (`claude -p`, fresh session
per run) on a fixture of 11–12 small Python modules with an answer key. Arms: v1.1.0 (`3309921`) vs candidates.
Two lean rounds, 1 run per task per arm (N=1: direction, not proof). Round 2 blocked Bash so reads went through
Read/Grep/Glob, and gated every session on a live JEV self-test plus a dashboard check for failed evaluations.

### Rejected: PreToolUse "nudge" before reads, searches and delegation

- **Idea:** a local PreToolUse hook injects a short reminder to triage with the JEV. WebSearch and
  AskUserQuestion every call; Read, Grep, Glob, WebFetch, `mcp__graphify__*` and Chrome page reads every
  third call without a JEV call; Agent/Task every call (first version only).
- **Result:** 0 of 5 nudges turned into a JEV call. Triage cost more in both rounds (+58%, then +15.5%): after
  the nudges Claude made 3 more reads and 3 more turns. Delegation with the Agent nudge cost +89% Claude tokens
  with the same result, because each JEV query costs Claude a written query and an extra turn.
- **Decision:** dropped. Commit `2e9f037` is kept only on branch `archive/nudge-hooks-rejected`.
- **Mechanics that did work there (reuse if this returns):** Claude Code does not anchor hook matchers (a
  `Read` matcher also fired on `ReadMcpResourceTool`), so anchor with `^(...)$`; an append-only counter
  (`O_APPEND` + `lseek`) counts parallel calls without locks, where a JSON read-modify-write lost 14 of 20.
- **Retry only if:** tasks are large enough that a keyword search cannot do the triage (dozens of candidate
  files or pages), and a pilot shows nudges turning into JEV calls that cut reads.

### Rejected: "consult the JEV by default" / "as many JEV calls as possible"

- **Idea:** more JEV calls means more savings.
- **Result:** false for calls Claude makes itself. Each one costs output tokens for the query plus a turn that
  re-reads the context. Verification cost +68% with no accuracy gain in round 1.
- **Decision:** replaced by the cost-aware wording below. The goal is fewer Claude tokens, not more JEV calls.
- **Not affected:** hook-side calls (Bash gate, Stop check, drift, compaction, session self-test). Python builds
  their context from the transcript on disk, so they cost only the JEV. Sending the last user messages as
  context there was kept: it lowers abstentions at no Claude cost.

### Kept: trigger-based, Claude-cost-aware rule text (`be235f5`)

- Same concrete triggers in the per-message reminder, the guide and the skill (choice → `request_decision`;
  3+ items → `jev_rank`/`jev_classify`/`jev_score`, then read only what it keeps; claim or done check →
  `jev_verify`). Consult only when it replaces Claude's own reading or judging; lean queries (ids, names, short
  snippets, never whole files); skip when writing the query costs more than doing it. Agent/model choice stays
  with Claude.
- **Result:** no regression. Control task +0.5% to +3% (noise), verification 3–10% cheaper, same correctness.

### Kept: guide as a Claude Code rule file (`d183ee3`)

- The guide moved from a managed block in `~/.claude/CLAUDE.md` to `~/.claude/rules/master-jev-hook.md`.
- **Result:** it loads in new sessions and after `/compact`; migration removes only the legacy block
  (byte-exact); no measurable cost change. The gain is a cleaner install, not behavior: a rule loads exactly
  like CLAUDE.md, so it does not make Claude call the JEV more.

### Observed, not caused by this cycle

- JEV answer rate in real use rose from 42% (09-26) to 82% (09-28 after install), abstentions from 58% to 14%.
  Most of the rise came before this cycle (drift and self-test context fixes), so it is not credited to v1.2.0.
- The TypeSafe upstream failed between ~10:38 and ~10:51 on 09-28 (`workflow_evaluation_failed`, 8 s, 0 tokens)
  while the local gateway stayed up. Gate live tests on a JEV self-test, not only on `/health`.
- Open idea (not tested): every session prints the self-test block, costing Claude output tokens; printing it
  only on failure would save them.
