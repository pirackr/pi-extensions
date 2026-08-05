# Deep Research Tools & Methodologies — Research Notes

Companion research for [`docs/001-deep-research.org`](./001-deep-research.org) ("Build a deep research extension for pi").
Covers: the five referenced systems (Claude Deep Research, ChatGPT deep research, `karpathy/autoresearch`,
`langchain-ai/open_deep_research`, `czhiming-maker/pi-deep-research`), other tools (commercial + open source),
the underlying methodologies (incl. the arXiv survey taxonomy, STORM, RL tuning, evaluation), and the
design space for building our own pi extension.

Primary sources: Anthropic engineering blog (multi-agent research system), arXiv 2506.18096 (survey),
OpenAI deep research announcement, STORM paper (arXiv 2402.14207), LangChain "bitter lesson" blog,
READMEs + source of the three GitHub repos, the pi-deep-research `extension.ts` source.

---

## Part 1 — The five references from `docs/001-deep-research.org`

### 1.1 Claude Deep Research (Anthropic)

**What it is.** The Research capability in Claude. Anthropic published the engineering post
["How we built our multi-agent research system"](https://www.anthropic.com/engineering/multi-agent-research-system),
which is the best public source on the architecture.

**Architecture — orchestrator-worker multi-agent:**

```
user query
  → LeadResearcher (plans, saves plan to Memory, spawns subagents)
      → Subagent 1..N in parallel (search tools, interleaved thinking,
         evaluate results, return compressed findings)
  → LeadResearcher synthesizes, decides: more subagents? refine strategy?
  → when sufficient → CitationAgent (attaches citations to claims)
  → final report
```

Key pieces:

- **Lead agent** (a strong model, e.g. Opus 4): analyzes the query, develops a strategy, spawns 3–5 subagents in parallel, delegates, synthesizes. Uses extended thinking as a controllable scratchpad for planning.
- **Subagents** (e.g. Sonnet 4): run web searches with their **own context windows**, use *interleaved thinking* after tool results to judge quality/gaps, then return compressed findings.
- **Memory persistence**: the plan is saved to Memory so it survives context truncation (>200k tokens) and long-horizon runs.
- **CitationAgent**: a separate pass that maps claims in the final report to source locations.

**Why multi-agent (their numbers):**

- Multi-agent (Opus 4 lead + Sonnet 4 subagents) outperformed single-agent Opus 4 by **90.2%** on their internal research eval — especially on *breadth-first* queries (e.g. "all board members of S&P 500 IT companies") that decompose into independent subtasks.
- On BrowseComp, **token usage alone explains 80% of performance variance**; tool-call count and model choice are the other factors. Multi-agent systems essentially *spend more tokens* on the problem.
- Cost reality: agents use ~**4×** tokens vs. chat; multi-agent ~**15×**. Only worth it for high-value, parallelizable, wide-context tasks.

**Prompt-engineering lessons (directly reusable):**

1. **Teach the orchestrator how to delegate** — each subagent needs an objective, output format, tool guidance, and clear task boundaries. Vague instructions → duplicated/gapped work.
2. **Scale effort to query complexity** — embed rules: simple fact-finding = 1 agent, 3–10 calls; comparison = 2–4 subagents × 10–15 calls; complex = 10+ subagents with divided roles.
3. **Start wide, then narrow** — short broad queries first, then drill down (mirrors expert research; agents default to overly specific queries that return nothing).
4. **Tool design is half the battle** — distinct purpose + clear description per tool; let agents improve their own tool descriptions (a tool-testing agent rewrote descriptions → **40% decrease in task completion time**).
5. **Parallel tool calling** — subagents fire 3+ tools concurrently; this + parallel subagents cut research time **up to 90%**.

**Evaluation methodology (their practice):**

- Start with ~20 representative queries; effect sizes are huge early on (30% → 80% success from a prompt tweak).
- **LLM-as-judge** with a single prompt + rubric (factual accuracy, citation accuracy, completeness, source quality, tool efficiency) scoring 0.0–1.0 + pass/fail — found more consistent than multiple judges.
- **Human eval catches what automation misses** — e.g. agents choosing SEO content farms over authoritative PDFs; fixed with source-quality heuristics in prompts.
- For stateful agents: **end-state evaluation** (did it reach the right final state) rather than turn-by-turn process checks.

**Production engineering:**

- Agents are stateful and errors compound → resume-from-checkpoint instead of restart, retry logic, let the agent adapt when a tool fails.
- **Rainbow deployments** (gradual traffic shift) because running agents are mid-process everywhere.
- Observability of *decision patterns* (not conversation contents) to debug "agent didn't find obvious info".
- **Subagent output to filesystem** to avoid the "game of telephone" — subagents write artifacts, pass lightweight references back to the coordinator.
- Current bottleneck: subagents execute **synchronously**; async execution is the identified future direction.

**Trade-off summary:**

| Dimension | Choice | Trade-off |
| --- | --- | --- |
| Agent topology | Multi-agent orchestrator-worker | Massive breadth/token-scaling wins; 15× token cost; coordination complexity; bad for tightly-coupled tasks |
| Parallelism | Parallel subagents + parallel tool calls | 90% time reduction; synchronous execution still bottlenecks |
| Context | Per-subagent windows + memory persistence | Survives 200k+ token runs; needs handoff discipline |
| Effort control | Prompt-embedded scaling rules | Needs careful prompt engineering; agents over/under-invest otherwise |
| Citations | Dedicated citation pass | Correct attribution; extra pass/context cost |

---

### 1.2 ChatGPT Deep Research (OpenAI)

**What it is.** Agentic capability in ChatGPT, announced Feb 2025. Per OpenAI: conducts "multi-step research on the internet for complex tasks… in tens of minutes what would take a human many hours," finding/analyzing/synthesizing hundreds of online sources into a documented report. Can work with uploaded files, search the public web or specific sites, and use enabled ChatGPT apps/connectors.

**Architecture (as summarized by the arXiv survey §4.1 + public details):**

- **Single-agent architecture** centered on a **reinforcement-learning-fine-tuned o3 reasoning model** (not a multi-agent system).
- **Intent clarification first**: a concise interactive step to pin down the user's objectives before researching.
- Then an autonomous multi-step strategy: multimodal retrieval, web browsing, and computation (data analysis/visualization) via built-in tools; final output is a structured report with precise citations.
- Long-running (5–30 min), parallel searches under the hood, hundreds of sources.

**Trade-offs:**

| Dimension | Choice | Trade-off |
| --- | --- | --- |
| Agent topology | Single agent (o3, RL-tuned) | Coherent, end-to-end RL-optimizable; less raw parallel breadth than Anthropic's multi-agent |
| Planning | Intent-clarification → plan | Aligns with user goals, costs an interaction; some users find the clarification annoying |
| Tools | Browser + code interpreter + multimodal | Can analyze data/visualize, not just copy text; heavier compute |
| Output | Cited report | Citations are a headline feature |
| Limits | Paywalled content inaccessible; can't browse everything | Users must verify critical facts; cited sources can still be mischaracterized |

---

### 1.3 `karpathy/autoresearch`

**What it is.** NOT a web research tool — an **autonomous experiment-running system** for LLM training research. Give an agent a small real LLM training setup and let it iterate overnight: modify code, train 5 minutes, check if `val_bpb` improved, keep or discard, repeat. Included in the task list because it demonstrates the "agent instructions as a file" pattern that maps directly onto pi skills.

**Architecture (3 files):**

- `prepare.py` — fixed constants, one-time data prep, runtime utilities. **Not modified** by the agent.
- `train.py` — the single file the agent edits: full GPT model, optimizer (Muon + AdamW), training loop. Everything is fair game (architecture, hyperparameters, batch size).
- `program.md` — baseline instructions for the agent; **edited by the human**. "Essentially a super lightweight skill."

**Design choices & trade-offs:**

- **Single file to modify** → reviewable diffs, manageable scope.
- **Fixed 5-minute time budget** (wall clock) → experiments directly comparable regardless of what changed (model size, batch size, architecture); ~12 experiments/hour, ~100 overnight. Downside: results **not comparable across compute platforms** (your 5 min ≠ my 5 min).
- **One metric** (`val_bpb`, vocab-size-independent) → fair comparisons across architecture changes.
- **Self-contained**: one GPU, one file, one metric; no distributed training, no complex configs.
- The human iterates on `program.md` — i.e. you "program the research org" by writing better agent instructions. That's the whole game: prompt/instruction engineering as the product.

**Relevance to pi:** `program.md` ≈ a `SKILL.md`. The lesson: **the quality ceiling of a research agent is largely set by the instruction file**, and iterating on it is cheap and fast. A pi deep-research skill is the same shape.

---

### 1.4 `langchain-ai/open_deep_research`

**What it is.** Fully open-source deep research agent on **LangGraph**; model-provider agnostic, Tavily search default, MCP-compatible. Scored top-10 on Deep Research Bench (RACE 0.4344, ranked #6 at the time).

**Current architecture (v2):**

- **Plan** → **parallel search with subagents** → **one-shot final report** written by a dedicated model from the collected context.
- Four configurable LLM roles: `summarization` (default gpt-4.1-mini, summarizes search results), `research` (drives the search agent), `compression` (compresses findings), `final report`.
- Context gathering is separated from writing — subagents collect, then a single call writes the whole report (avoiding disjoint section-by-section output).

**The "bitter lesson" evolution (from [Lance Martin's post](https://rlancemartin.github.io/2025/07/30/bitter_lesson/)) — the most instructive part:**

1. **2024: workflow (plan-and-execute).** Orchestrator LLM call → list of report sections; workers research+write sections in parallel; combine. *Structure added:* no tool calling (unreliable at the time), fixed section decomposition, parallel writing for speed.
2. **Bottlenecks emerged:** no tool calling → couldn't use the growing MCP ecosystem; fixed section decomposition was rigid; parallel-written sections produced disjoint reports.
3. **2025: multi-agent, but kept a bad assumption** — each sub-agent still wrote its own report section → reports remained disjoint (the "multi-agent communication is hard" problem, Walden Yan/Cognition).
4. **Final: moved writing to a single final step** — flexible planning + multi-agent context gathering + one-shot report writing. Result: 43.5 RACE, top 10, comparable to RL-trained or much larger systems.

The lesson (Hyung Won Chung): *add structure needed for the current level of compute/data; remove it later because these shortcuts bottleneck further improvement.* For builders: keep agent abstractions minimal (LangGraph checkpointing is worth it, but stick to low-level nodes/edges).

**Cost/quality data (from their eval table):**

| Config | Research model | Total tokens | Cost | RACE |
| --- | --- | --- | --- | --- |
| GPT-5 | gpt-5 | 204.6M | — | 0.4943 |
| Defaults | gpt-4.1 | 58M | $45.98 | 0.4309 |
| Claude Sonnet 4 | claude-sonnet-4 | 138.9M | $187.09 | 0.4401 |
| Bench submission | gpt-4.1 | 207M | $87.83 | 0.4344 |

(100 research tasks; so per-task costs are ~$0.5–1.9 — a useful sanity check for budget design.)

**Trade-offs:**

| Dimension | Choice | Trade-off |
| --- | --- | --- |
| Topology | Multi-agent gather → one-shot write | Coherent reports; avoids disjoint parallel writing; less "collaborative writing" flexibility |
| Structure | Minimal, configurable | Fast to adapt as models improve; relies on model capability |
| Search | Tavily default, MCP/Anthropic/OpenAI-native | Provider lock-in low; API keys needed |
| Eval | Deep Research Bench (RACE, Gemini LLM-judge) | Standardized comparison; ~$20–100 per 100-task run |

---

### 1.5 `czhiming-maker/pi-deep-research` (closest to what we're building)

**What it is.** A pi skill + extension (`pi install npm:pi-deep-research`). The README is explicit about the goal: LLMs doing "research" usually search once, skim snippets, produce a surface summary — this fixes that with structure, reflection, and code-enforced gates.

**Architecture — 4-phase workflow:**

```
Phase 1: Understand & Plan        → user approves plan (human-in-the-loop)
Phase 2: Search & Gather          → multi-hop reasoning, deep reading (web_extract on substantive sources)
Phase 3: Checkpoint & Reflect     → MANDATORY research_checkpoint tool call (code-enforced)
        🔴 CONTINUE → back to Phase 2
        🟢 PROCEED  → Phase 4
Phase 4: Synthesize & Report      → structured markdown report file
```

**The `research_checkpoint` tool (the key innovation).** After every search round the agent *must* call it; the tool runs **6 hard rules** with thresholds per depth level:

| Rule | Checks |
| --- | --- |
| Min search rounds | Not enough rounds for this depth |
| Min sources | Not enough unique sources |
| Answered ratio | Too many sub-questions unanswered |
| Avg confidence | Below depth threshold |
| Low-confidence questions | Any sub-question < 40% confidence |
| Unresolved contradictions | Sources disagree, unresolved |

Safety valve: past max rounds → force PROCEED + flag remaining gaps. Verdict comes with specific next-action guidance (which questions to attack, what to corroborate).

Depth levels (`/research <depth> <topic>`): quick (1–3 searches, 3–5 sources, 60% conf, ~2min), standard (3–6, 5–10, 75%, ~5min), deep (5–10, 10–15, 85%, ~10min), exhaustive (10–20, 15–30, 95%, ~20min).

**Multi-hop reasoning patterns (prompted, in SKILL.md):** Entity Expansion (product→company→competitors→market), Temporal Progression (current→changes→history), Conceptual Deepening (overview→architecture→trade-offs→edge cases), Causal Chain (observation→cause→root cause→solutions), Source Triangulation (official docs × independent analysis × community).

**Extension tools (from reading the actual `extension.ts`):**

- `web_search` — Tavily API primary, Brave fallback, single or batch (max 5 parallel queries), `search_depth`, domain include/exclude. Returns title/url/snippet/score/date.
- `web_extract` — plain `fetch` + regex HTML strip (title, scripts/nav/footer removal, 8000-word truncation, author/date meta). Note: naive — no Readability, no JS rendering, no anti-bot.
- `research_checkpoint` — the gate described above; all thresholds hardcoded in the extension.

**Design decisions (from README):**

1. **Forceful imperative wording** for reference-file loading — "LLMs skip polite requests."
2. **Exact keyword matching** for depth selection — natural-language ambiguity overrides otherwise.
3. **Human-in-the-loop at plan stage** — API calls are costly; confirm before executing.
4. **Code-enforced checkpoints** — "LLMs self-evaluate optimistically, code doesn't."

Academic foundations cited: **Reflexion** (self-reflective loops + explicit evaluation), **Chain-of-Thought** (structured decomposition), **ReAct** (interleaved reasoning/action), **Multi-hop QA** (cross-document reasoning). Inspired by SuperClaude's DeepResearch architecture.

**Trade-offs / weak spots:**

- **Self-reported confidence**: the checkpoint relies on the LLM honestly reporting its own confidence/source counts — a sophisticated agent could game it (the tool trusts the model's numbers rather than counting real fetched sources). Its real power is *forcing reflection*, not verifying.
- **Search keys required** (Tavily/Brave) — the repo's own web-search extension avoids this via `npx open-websearch` (no API key).
- Naive extraction (regex HTML strip) vs. Readability-based extraction.
- Skill + extension split: methodology lives in SKILL.md/references (LLM-prompted), enforcement lives in the extension (code).

---

## Part 2 — Other tools

### 2.1 Commercial systems (from arXiv 2506.18096 §4)

| System | Base model | Architecture | Signature features |
| --- | --- | --- | --- |
| **Gemini Deep Research** | Gemini 2.0 Flash Thinking (RL-tuned) | Single agent, async task management, 1M-token context + RAG | Interactive plan approval (unified intent-planning); very fast multi-round retrieval |
| **Perplexity Deep Research** | Hybrid, dynamic model selection | Iterative search, decomposes query into subtasks | Prompt-guided model selection per task; deep-sourcing with citations |
| **Grok DeepSearch** | Grok 3 | Segment pipeline + credibility assessment module | Filters low-quality sources up front; sparse attention; sandbox for computational verification; 3D visualizations |
| **Copilot Researcher / Analyst** | OpenAI research models / o3-mini | Enterprise orchestration over M365 data + web | Access to emails/meetings/documents/chats; connectors (Salesforce, ServiceNow, Confluence); Analyst does chain-of-thought data analysis |
| **Qwen Deep Research** | Qwen3-235B-A22B (RL) | Unified agent framework | Interactive plan refinement; parallel retrieval-validation-synthesis |
| **Kimi K2 Deep Research** | Kimi K2 (MoE) | Single agent, tool-aligned post-training | SFT on tool-use trajectories + RL with verifiable + rubric-based rewards |
| **Genspark Super Agent** | Mixture of 9 base LLMs | Research sub-agent → downstream writing/analysis agents | Research agent hands structured notes to writers (not a monolith) |
| **Manus** | Claude 3.5/GPT-4o | Planner-toolcaller multi-agent; sandboxed Chromium per session | Real browser automation: tabs, clicks, scroll, forms, JS, downloads |
| **AutoGLM Rumination** | GLM-Z1-Air (RL) | Plan–execute browser loop + "rumination" cycles | Computer use; can access authenticated resources (CNKI, WeChat) |

### 2.2 Open-source frameworks worth knowing

- **OpenManus / OWL** — open-source planner-toolcaller multi-agent stacks with browser automation, code interpreters, MCP; the "open Manus" wave.
- **DeerFlow** — open-source deep research pipeline (Doubao/DeepSeek/GPT-4o backends).
- **WebThinker** (QwQ-32B, RL/DPO) — interleaves search, navigation, and report drafting in one reasoning loop.
- **Search-o1 / R1-Searcher / Search-R1 / ReSearch / DeepResearcher / WebDancer / WebSailor / WebShaper / MiroRL / Agent-R1** — the RL training line: teach small models *when* to search, *what* to search, how to incorporate evidence (GRPO/PPO/DAPO, rule-based rewards). Shows search behavior can be learned, not just prompted.
- **SimpleDeepSearcher** — minimal search-fetch-summarize loop with PPO + process-based rewards.
- **AgenticSeek** — metasearch front-end + headless stealth browser, budget/anti-bot knobs.
- **AutoAgent / Alita** — self-evolving agents: generate/wrap MCP tools at runtime, vector-DB memory.
- **AgentRxiv** — research agents sharing outputs on a simulated arXiv (non-parametric continual learning).
- **AWorld** — multi-agent runtime with browser automation + tracing + MCP.
- **Cognitive Kernel-Pro** — fully open, low-cost pipeline on the free DuckDuckGo interface (proves you can do DR without paid search APIs).

### 2.3 Hubs, protocols, benchmarks

- **Awesome list**: [`ai-agents-2030/awesome-deep-research-agent`](https://github.com/ai-agents-2030/awesome-deep-research-agent) — continuously updated paper→system table (search API/browser, code interpreter, data analytics, multimodal, tuning method, benchmarks) behind the survey.
- **Protocols**: **MCP** (Anthropic) standardizes tool access; **A2A** (Google) standardizes agent-to-agent collaboration. Complementary: MCP = tools, A2A = agents.
- **Benchmarks**: **Deep Research Bench** (100 PhD-level tasks, 50 EN/50 ZH, RACE score via Gemini LLM-judge vs. expert golden reports), **GAIA** (real-world assistant tasks, L1–L3), **BrowseComp** (browse to find hard-to-find info), **SimpleQA/HotpotQA/2WikiMultiHopQA/NQ/GPQA** (QA), **WebWalkerQA** (web navigation), **Humanity's Last Exam**, **MLE-Bench** (for AI-scientist-type agents).

---

## Part 3 — Methodologies (the survey taxonomy + foundations)

### 3.1 Information acquisition: API vs. browser

| | API-based search | Browser-based |
| --- | --- | --- |
| Speed/cost | Fast, cheap, scalable | Slower, resource-heavy |
| Coverage | Structured results; fails on JS-rendered/auth-gated content | Can click, scroll, fill forms, execute JS, download files |
| Examples | Tavily, SerpApi, Google/arXiv APIs, DuckDuckGo (free) | Manus sandboxed Chromium, AgenticSeek stealth browser |
| Best practice | **Hybrid**: API for breadth/speed, browser for depth/dynamic content | |

### 3.2 Workflow & planning taxonomy (survey Fig. 4)

1. **Static vs. dynamic workflows** — static = hand-defined pipelines (AI Scientist's ideation→experiment→report); easy but poor generalization. Dynamic = LLM plans/replans in loop; generalizes, harder to build/eval.
2. **Planning strategies**:
   - *Planning-only* — plan directly from prompt (Grok, Manus).
   - *Intent-to-planning* — clarify intent first (OpenAI DR).
   - *Unified intent-planning* — draft plan + ask user to confirm/revise (Gemini DR; also pi-deep-research).
3. **Single-agent vs. multi-agent**:
   - Single-agent (ReAct-style loop): end-to-end RL-optimizable, coherent, simple; demands strong base model, less modular.
   - Multi-agent: parallelizable, scalable, specialized roles; coordination complexity, hard to RL-train end-to-end, disjoint outputs if roles overlap (see the bitter-lesson story).

### 3.3 Memory / long-context management

Three strategies, in increasing sophistication:

1. **Expand the context window** (Gemini 1M) — simple but expensive.
2. **Compress intermediate steps** (summarize search results/reflections between phases; "Reason-in-Documents") — cheap, risks losing detail.
3. **External structured storage** — filesystem (Manus/OWL/OpenManus), vector DBs (AutoAgent), knowledge graphs (Agentic Reasoning), shared case banks (AgentRxiv). Best semantic recall, highest design cost. Also the Anthropic "subagents write to filesystem" pattern.

### 3.4 Tuning: beyond prompting

- **Prompt-based**: fast, zero training cost; ceiling = base model.
- **SFT**: teach query formulation/report structure/tool use from curated trajectories (Open-RAG, AUTO-RAG, rejection sampling like CoRAG).
- **RL** (the current frontier): GRPO/PPO/DAPO with rule-based rewards teach *when* to search and how to use evidence (Search-R1, Agent-R1, DeepResearcher, Kimi-Researcher). Trade-off: needs search-tool training environments + reward design; huge compute. **Not viable for a pi extension** — but relevant as the reason frontier models (o3, Gemini 2.x, Kimi K2) do deep research well natively.
- **Non-parametric continual learning**: case-based reasoning over external trajectory banks (AgentK), shared result repositories (AgentRxiv), runtime MCP provisioning (Alita) — agents self-improve without weight updates.

### 3.5 Prompting patterns that survive across all systems

1. **Start wide, narrow down** (Anthropic; also WebDancer/WebSailor's horizontal-then-vertical).
2. **Scale effort to query complexity** (explicit budgets).
3. **Perspective-driven questioning** (STORM): discover diverse perspectives on the topic, then ask questions *from each perspective*, iterating multi-turn conversations grounded on sources. Ablations: removing perspectives or conversation history measurably hurts outline/article quality; the outline stage is necessary.
4. **Interleaved thinking after tool results** (Anthropic subagents) — reflect before the next query.
5. **Checkpoint/reflection gates** (pi-deep-research; Reflexion lineage) — force evidence sufficiency checks; better in code than in prose.
6. **Source triangulation + credibility tiers** — official docs × independent analysis × community; filter SEO farms (Anthropic's human-eval finding).
7. **Citation as a separate final pass** (Anthropic CitationAgent; STORM citation recall ~85%) — claims mapped to sources at the end.
8. **Human-in-the-loop at the plan stage** — cheap insurance against wasted API spend (pi-deep-research, Gemini, OpenAI's clarification).

### 3.6 Evaluation practice

- **Process vs. outcome**: judge end-state/outcome, not prescribed steps (agents take many valid paths).
- **LLM-as-judge with a rubric** (factual accuracy, citation accuracy, completeness, source quality, tool efficiency) — single judge call was most consistent for Anthropic.
- **Small eval sets early** (~20 queries), then scale; human testing for edge cases evals miss.
- Public yardsticks: Deep Research Bench (RACE), GAIA, BrowseComp, SimpleQA.

### 3.7 Stopping criteria — how deep research systems decide when to stop

Six distinct mechanisms, almost always **stacked**:

1. **Model-judged sufficiency** (primary in most production systems) — the LLM reflects after each
   round and decides whether evidence is sufficient. Claude Research: lead agent judges, guided by
   prompt heuristics (effort-scaling rules, "start wide then narrow"). LangChain: a Research
   Supervisor reflects each iteration and asks follow-ups until satisfied (then capped, below).
   Perplexity: iterative rounds adjusted on interim insights.
2. **Code-enforced thresholds** — rules evaluated by code, not the model. pi-deep-research's
   `research_checkpoint`: 6 hard rules (min rounds, min sources, answered ratio, avg confidence,
   low-confidence questions, unresolved contradictions) + max-rounds safety valve. Caveat: the
   model *self-reports* the metrics, so it enforces reflection, not independent verification.
   karpathy/autoresearch: fixed 5-minute wall-clock budget in code — the simplest possible stop.
3. **Fixed structural budgets** (designer-set params) — STORM: N=5 perspectives, M=5 conversation
   rounds, no judgment. LangChain config: `max_researcher_iterations=6`, `max_react_tool_calls=10`,
   `max_concurrent_research_units=5`, `max_content_length=50000` (verified in `configuration.py`).
4. **Learned stopping via RL** (frontier) — OpenAI o3 and Gemini Flash Thinking are RL-finetuned;
   stopping is trained behavior rewarded on outcome correctness. PANGU DeepDiver: Search Intensity
   Scaling (RL learns how much search a task needs). WebThinker (iterative online DPO),
   Search-R1/DeepResearcher/Kimi K2: RL teaches *when* to search vs. when to answer. This is why
   the field moved "how to stop" from prompt engineering to reward design — and why picking a
   strong frontier model inherits this for free in an extension.
5. **User-in-the-loop** — human bounds scope *before* tokens are spent: Gemini interactive plan
   review; OpenAI intent clarification; pi-deep-research plan approval gate; LangChain
   `allow_clarification`.
6. **External budget caps** (tokens/time/cost) — Anthropic's ~15× token multiplier makes this
   existential; profile-based token/time budgets (this repo's draft spec) are the pi-native form.

**The standard stack:** user-approved plan (bounds scope) → model judges sufficiency per round
(with reflection) → code-enforced minimums (anti-early-stop guard) → hard caps (anti-runaway
guard) → learned stopping (inherited from the model).

**Where the primary authority sits — trade-offs:**

| Authority | Pros | Cons | Used by |
| --- | --- | --- | --- |
| LLM judgment | Flexible, adapts to task difficulty | Stops too early (surface summary) or too late (token burn); needs strong model | Claude, Perplexity, Gemini, LangChain |
| Code rules | Deterministic, cheap, safe | Arbitrary thresholds; rigid across task difficulty; gameable self-reports | pi-deep-research, autoresearch |
| Fixed budget | Predictable cost, comparable runs | Wastes effort on easy tasks, under-researches hard ones | STORM, autoresearch |
| RL-learned | Truly adaptive | Requires training infra — inherited by choosing the model, not built | OpenAI, Gemini, Kimi, DeepResearcher |

**Practical recipe for our extension:** model-judged sufficiency as the driver, code-enforced
minimums as the floor, hard caps as the ceiling, and the report's "Uncertainties & Gaps" section
as the escape hatch that makes early stopping visible instead of hidden.

### 3.8 Stopping mechanisms — pros/cons and minimal-but-effective implementations

Per mechanism, in a pi-extension context:

**1. Model-judged sufficiency**
- Pros: zero infrastructure; adapts to task difficulty; the *only* mechanism that judges quality (not just quantity); works "in the model's head"
- Cons: optimistic self-eval → stops early (surface summary); no hard guarantees; varies with model strength; non-deterministic
- Minimal impl: one SKILL.md paragraph + a **written self-score table** ("list N sub-questions; after each round score each 0–100; repeat until all ≥80 or N rounds"). Writing the table makes premature stopping visible, which is what makes the check effective
- Effectiveness: good for easy/medium topics with a strong model; insufficient alone for deep research

**2. Code-enforced thresholds** (highest leverage-per-line-of-code)
- Pros: deterministic floor; immune to model optimism about *stopping*; cheap to run; scales with depth profiles
- Cons: still relies on the model calling the tool (instruction-enforced); self-reported metrics gameable; thresholds arbitrary
- Minimal impl: **ONE tool, 3 checks** — `min_rounds`, `min_sources`, `max_rounds` (safety valve). Skip pi-deep-research's confidence/answered-ratio rules initially — noisy and gameable, add schema complexity
- Effectiveness: highest in the list. Evidence: Anthropic found token usage explains ~80% of performance variance → "don't stop early" *is* the dominant lever; the checkpoint gate forces token spend

**3. Fixed structural budgets**
- Pros: zero runtime cost; predictable cost; comparable runs (autoresearch's 5-min lesson)
- Cons: ignores task difficulty — wastes effort on easy tasks, under-serves hard ones
- Minimal impl: a `max_rounds` constant (inside the checkpoint tool). Depth profiles (quick/standard/deep) are the upgrade, not the minimal form
- Effectiveness: good as a *ceiling* (safety), poor as the primary *floor*

**4. RL-learned stopping** (frontier)
- Pros: truly adaptive; zero runtime cost; the reason o3/Gemini/Kimi feel right about stopping
- Cons: requires data + GPUs + search-tool training environments — **not buildable in a pi extension**
- Minimal impl: none to write — model-selection decision: use a strong reasoning model with a thinking budget (pi's thinking level / extended thinking) to inherit it
- Effectiveness: don't build it; inherit it

**5. User-in-the-loop**
- Pros: kills wrong-scope waste (often the biggest real cost); catches hallucinated sub-questions; builds trust
- Cons: needs a human present; friction; impossible for unattended runs
- Minimal impl: one `ctx.ui.confirm()` in the `/research` command (~5 lines) with a `--yes` flag to skip
- Effectiveness: extremely high for interactive use; zero cost to skip when automated

**6. External budget caps**
- Pros: guarantees termination and bounded cost even if the model misbehaves
- Cons: crude; uncorrelated with quality
- Minimal impl: two constants — max rounds + max tool calls per round
- Effectiveness: necessary backstop; trivial; always include

**Minimal-but-effective recipe (~50 lines SKILL.md + ~40 lines extension):**

```text
Layer 1 (driver):   SKILL.md — sub-questions + self-score table + "MUST call
                    research_checkpoint after every round"
Layer 2 (floor):    research_checkpoint tool — 3 rules: min_rounds, min_sources,
                    max_rounds safety valve
Layer 3 (scope):    /research command — plan → ctx.ui.confirm() (or --yes)
Layer 4 (backstop): max_rounds cap + ctx.ui.setStatus progress
```

```typescript
const DEPTH = {
  quick:    { minRounds: 1, minSources: 3, maxRounds: 3 },
  standard: { minRounds: 2, minSources: 5, maxRounds: 6 },
  deep:     { minRounds: 3, minSources: 10, maxRounds: 10 },
};

pi.registerTool({
  name: "research_checkpoint",
  description: "MANDATORY after each search round. Returns CONTINUE or PROCEED.",
  parameters: Type.Object({
    depth: Type.String(),           // quick | standard | deep
    round: Type.Number(),           // current round
    total_sources: Type.Number(),   // unique sources so far
    contradictions: Type.Optional(Type.Array(Type.String())),
  }),
  async execute(_id, p) {
    const t = DEPTH[p.depth] ?? DEPTH.standard;
    const issues: string[] = [];
    if (p.round < t.minRounds) issues.push(`⛔ min rounds: ${p.round}/${t.minRounds}`);
    if (p.total_sources < t.minSources) issues.push(`⛔ min sources: ${p.total_sources}/${t.minSources}`);
    if (p.round >= t.maxRounds) return { content: [{ type: "text",
      text: `🟢 PROCEED (max rounds reached). Flag ${issues.length} gap(s) in Uncertainties & Gaps.` }] };
    return { content: [{ type: "text", text: issues.length
      ? `🔴 CONTINUE — ${issues.join("; ")}`
      : `🟢 PROCEED — criteria met.` }] };
  },
});
```

Why this shape: the checkpoint floor (Layer 2) does ~70% of the work for ~20% of the code — the
anti-shallow fix backed by the "tokens = performance" finding. Plan approval (Layer 3) is the
cheapest waste-prevention. Everything else (confidence rules, answered-ratio, profiles,
multi-agent) is an upgrade added only on observed failure — the bitter-lesson discipline.

---

## Part 4 — Design space for our pi deep research extension

### 4.1 What already exists in this repo

- **`extensions/web-search/index.ts`** — working `lookup_web` / `fetch_web_content` / `fetch_github_readme` tools shelling out to `npx open-websearch` (no API keys; scrapes exa/duckduckgo/brave/bing/startpage; content fetch with Readability option; ~10–20MB first-run npx download). Includes a hack (`patchExaEngine`) that patches open-websearch's exa engine and loads `EXA_API_KEY` from a `.env`. This is our zero-key search substrate.
- **`skills/deep-research/SKILL.md`** — an existing draft spec (from the initial commit): `/research` command with profiles (fast/default/deep: 2/24/100 nodes, 8K/64K/256K tokens, 2m/10m/30m), a 6-stage pipeline (prefilter → research → synthesis → verification → repair → judge), outputs to `research/<slug>…md` + `.jsonl` + checkpoints, config cascade (`PI_RESEARCH_*` env → `.pi/deep-research.json` → global → profile → defaults), safety rules (workers limited to search/fetch tools only, URL validation, budget caps, crash-recovery checkpoints). This is a spec draft — no extension code yet.
- **`extensions/tmux-subagent/`** + `subagents/{reviewer,scout,tester,worker}.md` — a working multi-agent substrate: dispatch independent Pi agents into tmux windows with profiles (reviewer/scout/tester/worker). **This is the pi-native way to get a multi-agent research topology** (parallel subagents with isolated contexts) without writing a separate orchestration runtime.
- `docs/001-deep-research.org` — the task.

### 4.2 pi primitives available to the extension

- `pi.registerTool({ name, description, parameters: Type.Object(...), execute })` — LLM-callable tools (the pattern pi-deep-research uses).
- `pi.registerCommand("research", { handler })` — `/research` slash command.
- `ctx.ui.{select,confirm,input,notify,setStatus,setWidget}` — human-in-the-loop plan approval, progress widgets, final notifications. `ctx.hasUI` to guard non-TUI modes.
- `resources_discover` event — contribute extra skill/prompt/theme paths (can ship methodology as a skill that the extension registers).
- `tool_call` / `tool_result` events — could gate/audit search usage centrally.
- `ctx.sessionManager`, `ctx.signal`, session persistence — checkpoint/resume hooks.
- Hot reload (`/reload`), jiti TS loading, typebox schemas, `typebox` + `@earendil-works/pi-coding-agent` imports — all already wired in this repo (`package.json`, `tsconfig.json`, `types/`).
- subagent dispatch via tmux-subagent — multi-agent topology option.

### 4.3 The core design decisions (and what the research says)

1. **Single-agent skill vs. code-enforced extension.** Research says LLMs self-evaluate optimistically (pi-deep-research's core insight) — the checkpoint gate belongs in **code**. But the methodology (multi-hop patterns, report template, credibility tiers) belongs in **SKILL.md/references** (LLM-read prose). The repo's existing draft already splits these (skill for methodology, extension for enforcement) — consistent with both pi-deep-research and this repo's extension↔skill pairing convention (AGENTS.md).

2. **Single-agent vs. multi-agent topology.**
   - Single-agent (agent loop: plan → search → reflect → synthesize): simplest, cheapest, coherent; matches the current draft spec and pi-deep-research. Model must be strong (research shows base-model capability is the ceiling).
   - Multi-agent (lead + parallel subagents): Anthropic's 90% breadth win; available pi-natively via tmux-subagent dispatch. Costs ~15× tokens; adds coordination complexity. Good middle ground: lead agent dispatches *scout* subagents for breadth, then synthesizes itself (the open_deep_research pattern: parallel gather → one-shot write).

3. **Search backend.**
   - Option A (reuse repo): `npx open-websearch` — zero API keys, multi-engine, already built + battle-tested in this repo. Cost: first-run 10–20MB npx download per invocation (unless installed as dep — note `open-websearch` is already in this repo's `package.json` deps, so an extension can `execFile` it via local node_modules, avoiding the npx download).
   - Option B (pi-deep-research style): Tavily/Brave API keys — higher-quality snippets (Tavily content is pre-extracted), but requires user API keys and has rate limits.
   - Hybrid: prefer open-websearch (zero setup), optional Tavily for depth.

4. **Content extraction.** Use open-websearch's `fetch-web` with Readability (Mozilla) — far better than pi-deep-research's regex strip. Consider `fetch_github_readme` for repo targets.

5. **Research loop shape.** Adopt the converging consensus:
   - Plan with sub-questions → **user approval** (budget insurance) → iterative rounds (parallel queries, deep reads) → **code-enforced checkpoint** (rounds/sources/confidence/contradictions) → one-shot synthesis → **citation pass** → report file.
   - Include the repo draft's verification→repair→judge stages if quality matters (it's a strong differentiator vs. both pi-deep-research and open_deep_research).

6. **Depth/budget profiles.** The draft's profiles (fast/default/deep: node counts, token budgets, time) are well-tuned; pi-deep-research's (quick/standard/deep/exhaustive) prove the pattern. Keep explicit budgets + caps (Anthropic's effort-scaling rule; draft's safety section).

7. **Safety.** Draft spec is right: workers restricted to search/fetch tools, URL validation (no localhost/private IPs/credentials), query screening, budget caps, checkpoint/resume. All mandatory for an extension that runs in the user's trusted pi session.

8. **Report quality bar.** Include: executive summary, key findings ranked w/ citations, cross-referenced analysis, comparison table + narrative, contradictions & debates, uncertainties & gaps, recommendations, sources table with credibility tiers (from pi-deep-research) — plus the draft's verification/judge pass.

### 4.4 Open questions for the design session (brainstorming)

- Should the extension *drive* the whole loop (own state machine in code) or *gates + tools* (agent drives, code enforces)? The repo draft implies the former; pi-deep-research is the latter. The former is more deterministic; the latter leverages model reasoning.
- Multi-agent: dispatch via tmux-subagent (visible windows, real isolation) vs. in-process workers? Trade-off: visibility/robustness vs. latency/complexity.
- Where do checkpoints/resume state live — `.pi/deep-research/` per project, or `~/.pi/`? (Draft says `research/.runs/`.)
- Output format: markdown report only, or also `.jsonl` audit + HTML (visual-explainer pairing, per pi-deep-research)?
- Do we need an eval harness (Deep Research Bench subset / small curated query set) to iterate on the prompts, per Anthropic's "start with ~20 queries" advice?

### 4.5 Design decision — program.md + /loop vs. complex plan/execution

**Framing:** it's not either/or. program.md = methodology (the 90%); the loop already exists (the
agent's own tool-calling loop; `/loop until: X` is a ~15-line command if wanted); enforcement is
the only real choice. So the question is: *how much code-enforced structure do we need, and can we
prove we need it before writing it?*

Note on `/loop` and `/goal`: these are **Claude Code** features (community plugins, now partially
absorbed into Claude Code's scheduled-tasks docs) — pi has no built-in equivalents (verified
against the built-in slash-command table: /model, /compact, /tree, /fork, /resume, /reload, ...).

| | program.md + /loop (skill-driven) | Complex plan/execution (extension state machine) |
| --- | --- | --- |
| Code to write | ~0–40 lines (checkpoint tool) | 500+ lines (state machine, workers, resume, audit) |
| Time to first useful run | Minutes | Days |
| Quality floor | Model's own discipline — optimistic early stop *will* happen sometimes | Deterministic (code gates) |
| Adapts to model upgrades | Yes — stronger model automatically does better | No — must remove/replace structure (bitter lesson) |
| Cost control | None unless a cap is added | Budgets built in |
| Crash/context safety | Context loss on long runs; no resume | Checkpoints, resume |
| Artifacts (audit, JSONL) | Only what the skill forces into the report | Full pipeline outputs |
| Multi-agent breadth | Not without extra machinery | Possible (tmux-subagent dispatch) |
| Unattended/overnight runs | Risky | Designed for it |

**Evidence for the recommendation:**
- Bitter lesson (LangChain): v1 was exactly the complex plan/execution end (fixed-section workflow, no tool calling). It worked, then *bottlenecked* the moment models got better at tool calling, and had to be torn out. Final version ≈ thin orchestration + let the model drive
- pi-deep-research: "LLMs self-evaluate optimistically, code doesn't" — the one empirically-proven failure mode
- Anthropic: token usage ≈ 80% of performance variance → the anti-early-stop floor is the dominant lever
- karpathy: even his minimal setup has a code-enforced stop condition (the 5-min budget in code); program.md is the soul, the stop condition is the guardrail

**Recommendation: program.md/SKILL.md core + exactly one code primitive, grow on observed failure.**

```text
Layer 1 — program.md / SKILL.md (the 90%): methodology, multi-hop patterns, sub-questions,
          self-score table, report template with Uncertainties & Gaps
Layer 2 — one tool: research_checkpoint (3 rules: min rounds, min sources, max rounds)
Layer 3 — one command: /research = plan → ctx.ui.confirm() → loop → report file
```

~90 lines total. Then grow only on observed failure:

| Symptom you observe | Add |
| --- | --- |
| Shallow report despite checkpoint (gamed confidence) | Count real fetched sources in code instead of trusting self-reports |
| Long runs lose context / crash | Filesystem checkpoint + resume (`research/.runs/`) |
| Disjoint report sections | One-shot synthesis step (open_deep_research's fix) |
| Breadth queries slow serially | Dispatch scout subagents via tmux-subagent |
| Unattended runs go off the rails | `--yes` flag + budget profiles |
| Unsupported claims | Draft's verification→repair→judge stages (as a separate command) |

**Why minimal first even if the complex version is the destination:** the draft SKILL.md specs a
full pipeline (prefilter → research → synthesis → verification → repair → judge) — a lot of
structure to maintain, and structure is expensive to remove once agents depend on it. Starting
with skill + gate means the first version works *today*, teaches which failures are real (not
speculative), and keeps the extension thin enough to rip out or grow as models change. Do **not**
defer the checkpoint tool — it's not complexity, it's the difference between research and a
summary, and it's ~40 lines.

---

## Sources

- Anthropic — *How we built our multi-agent research system*: <https://www.anthropic.com/engineering/multi-agent-research-system>
- OpenAI — *Introducing deep research*: <https://openai.com/index/introducing-deep-research/> (+ help.openai.com deep research FAQ)
- arXiv 2506.18096 — *Deep Research Agents: A Systematic Examination And Roadmap* (Huang et al.): <https://arxiv.org/abs/2506.18096>
- awesome-deep-research-agent (curated table behind the survey): <https://github.com/ai-agents-2030/awesome-deep-research-agent>
- STORM (Shao et al., Stanford) — arXiv 2402.14207: <https://arxiv.org/abs/2402.14207>
- karpathy/autoresearch: <https://github.com/karpathy/autoresearch>
- langchain-ai/open_deep_research: <https://github.com/langchain-ai/open_deep_research>
- LangChain — *Learning the Bitter Lesson* (architecture evolution): <https://rlancemartin.github.io/2025/07/30/bitter_lesson/>
- czhiming-maker/pi-deep-research (README + `extension.ts` source): <https://github.com/czhiming-maker/pi-deep-research>
- This repo: `extensions/web-search/index.ts`, `skills/deep-research/SKILL.md`, `extensions/tmux-subagent/`, pi docs `extensions.md`
