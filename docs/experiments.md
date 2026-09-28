# Experiment log

What we tried to make Claude use the JEV better, how we measured it, and what we kept or dropped. Read this
before proposing a change to the reminders, rule text or hooks, so a rejected idea is not tested again without
a new reason. Newest first.

**Budget rule behind every measurement:** JEV (TypeSafe) cost does not matter; Claude tokens do. A change is an
improvement only if it lowers cost-weighted Claude tokens (or keeps them flat) with equal correctness.
Cost-weighted = uncached input ×1 + cache creation ×1.25 + cache read ×0.1 + output ×5.

## 2026-09-28 — v1.2.0 rule text regression (fix)

- **Finding:** model-side JEV calls in real Claude sessions (test fixtures excluded) fell from dozens a day under
  v1.1.0 (09-27: tail-harness 33, keepglide 15, agent-atlas 7, auto-navigate-workflow 4, others) and 9 on 09-28
  morning to **0 across 10 sessions** after v1.2.0 was installed (09-28 ~14:15 UTC). Tools were deferred in both
  periods (most calls were preceded by a ToolSearch), so deferral was not the cause.
- **Cause:** `be235f5` replaced the decision trigger ("decision with explicit alternatives → call
  `request_decision` and wait") with "consult when it replaces your own reading or judging; the goal is fewer
  Claude tokens, not more JEV calls … skip when writing the query costs more". Claude took the exits every time.
  The v1.2.0 A/B measured cost and correctness on a small fixture, not whether Claude still consulted in real use.
- **Change:** the v1.1.0 decision trigger is back as the lead of the rule (reminder, rule file, skill). Kept from
  v1.2.0: the 3+ item triage and `jev_verify` triggers and the lean-query guidance. Dropped: "fewer Claude tokens,
  not more JEV calls" and "skip when writing the query costs more than doing it yourself".
- **Lesson:** any rule-text change is measured on the share of real sessions with a model-side JEV call, not only
  on a fixture's token cost.

## 2026-09-28 — always-loaded MCP tools (fix)

- **Finding:** in a real Claude session (keepglide, ~90 min, 4 subagents) the model made 0 JEV MCP calls;
  only hooks consulted the JEV. A parallel Codex session made 3 spontaneous `request_decision` calls. The main
  cause was the rule text (entry above); deferral is a secondary cost: Claude Code hides MCP tools behind
  ToolSearch, so each consult first costs a search turn, while Codex lists them upfront.
- **Change:** the MCP server marks every tool with `_meta: {"anthropic/alwaysLoad": true}` in `tools/list`
  (documented at code.claude.com/docs/en/mcp, "Scale with MCP tool search"). Per tool, not the server-wide
  `alwaysLoad` config key, so it ships with the server and leaves the user's `~/.claude.json` alone.
- **Check:** headless `claude -p` with only this server: old script → tools `DEFERRED`, new → `LOADED`. Unlike
  the rejected nudges it adds no reminder text; it removes a turn from each consult, in line with the budget rule.
- **Per-tool flag is not enough in the desktop app:** an interactive session (Claude Code 2.1.280 in Claude
  Desktop) still deferred the tools; the transcript shows them arriving in a `deferred_tools_delta` before the
  first prompt had any MCP tool. The same binary headless loaded them. MCP servers connect asynchronously and late
  tools are deferred; the server-level `"alwaysLoad": true` in `~/.claude.json` makes startup wait for the server
  (up to 5 s). The installer now writes it for Claude Code only (Claude Desktop's own config does not get it).
- **Still deferred in the desktop app, known upstream bug:** with both flags set, a new desktop session still
  deferred the tools. anthropics/claude-code#86284 ("Desktop app ignores mcpServers alwaysLoad … identical config
  honored by CLI") was closed as stale without a fix; #88483 (desktop never rebuilds its deferred-tool pool) is
  open. Hooks cannot load tools (their output is text only; #89049 asks for a tool-registry API). Both flags stay:
  they work in the CLI and headless runs, and cost nothing in the desktop app. Retry when #86284/#88483 are fixed.
- **Workaround added:** the SessionStart context asks for one ToolSearch with the 5 JEV tools at the start
  (skipped when they are already loaded) and a confirmation line `🔷 MCP Master-JEV Hook loaded: <n>/5 tools
  ready.` read from what the model actually has. The request sits before the verbatim status block so it is
  never printed as part of it. Cost: one tool turn per session, instead of one before the first consult.
  Measured on Opus 5.5 (1 h cache): 2,796 cache-write + 65,135 cache-read + ~150 output tokens ≈ $0.04 once per
  session, then ~2.8k extra cached tokens per turn ≈ $0.0006. Neutral or cheaper in sessions that consult the JEV
  (the same ToolSearch would come later, on a larger context); pure overhead in sessions that never do.
- **Pending measurement:** over the next days, the share of real Claude sessions with a model-side JEV call. Below
  ~50%, replace the upfront load with a presence check that loads nothing.
- **Impact is small:** in the test session the model loaded the JEV in one ToolSearch together with other tools
  and consulted it (`jev_rank`), so the regression was the rule text, not deferral.
- **Check tools from the transcript, not by asking the model:** the `prompt_snapshot` attachment lists the loaded
  tools; `deferred_tools_delta` lists the deferred ones.
- **Not done:** a `SubagentStart` hook injecting the rule into subagents. It is reminder text, the family of the
  rejected nudge; try it only with an A/B that shows lower Claude tokens.
- **Measure next:** share of real Claude sessions with at least one model-side JEV call, before vs after.

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
- **Superseded:** in real use it stopped model-side JEV calls entirely; see "v1.2.0 rule text regression".

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
