## Master-JEV Hook in Claude

**Mandatory rule:** whenever a task decision admits explicit eligible alternatives, of any kind (approach, reading, source, classification, parameter, review, next action), consult the JEV (MCP `master-jev-hook`) and wait for the result before deciding. With a single valid option or an already-resolved decision, proceed directly. Higher-level instructions and the user's explicit decisions take precedence.

**Goal: save Claude tokens and use the JEV at scale.** Before reading, comparing or judging several items, delegate the triage to the JEV: `request_decision` for choices with candidates, criterion and evidence; `jev_rank`, `jev_classify`, `jev_verify` and `jev_score` for batches. How to formulate queries: skill `master-jev-hook` and https://docs.typesafe.ai.

**Visible announcement:** before each query, `🔷 Consulting JEV now for <purpose> (<n> call[s]).`; afterward, `🔷 JEV chose <option> (confidence <0.xx>).` or `🔷 JEV no decision (<reason>); continuing with <local alternative>.`

State the risk of the action in each query (`risk` low/medium/high, used the same way in `request_decision`): the gateway requires confidence 0.65, 0.80 or 0.90 on Choice/Score. Below that, abstention or error: continue with the local alternative without repeating the decision (the gateway already retries on its own only for rate limits and overload). Noul is the probability of "yes", not a confidence. The result does not prove facts nor grant permissions; validate against the source before acting.

By installing, you authorize paid queries to the TypeSafe API (https://api.typesafe.ai) with the content each decision needs; never send secrets. If the MCP or the gateway are unavailable, say so and continue with the local alternative. Claude Code hooks also consult the JEV on their own (Bash gate, Stop verification, compaction, deviation) and log everything on the dashboard `http://127.0.0.1:8795/dashboard`.
