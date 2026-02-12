import { useState, useEffect, useReducer } from "react";

const MONO = "'JetBrains Mono', 'Fira Code', 'SF Mono', monospace";
const SANS = "'DM Sans', 'Segoe UI', system-ui, sans-serif";

// --- Theme ---
const theme = {
  bg: "#0a0e17",
  surface: "#111827",
  surfaceHover: "#1a2236",
  border: "#1e293b",
  borderActive: "#3b82f6",
  text: "#e2e8f0",
  textMuted: "#64748b",
  textDim: "#475569",
  accent: "#3b82f6",
  accentGlow: "rgba(59,130,246,0.15)",
  green: "#22c55e",
  greenDim: "rgba(34,197,94,0.15)",
  amber: "#f59e0b",
  amberDim: "rgba(245,158,11,0.15)",
  red: "#ef4444",
  redDim: "rgba(239,68,68,0.15)",
  purple: "#a855f7",
  purpleDim: "rgba(168,85,247,0.15)",
  cyan: "#06b6d4",
  cyanDim: "rgba(6,182,212,0.15)",
};

const STATUS_MAP = {
  running: { color: theme.green, bg: theme.greenDim, label: "Running", pulse: true },
  idle: { color: theme.amber, bg: theme.amberDim, label: "Idle" },
  completed: { color: theme.accent, bg: theme.accentGlow, label: "Done" },
  error: { color: theme.red, bg: theme.redDim, label: "Error" },
  queued: { color: theme.textMuted, bg: "rgba(100,116,139,0.1)", label: "Queued" },
};

// --- Sample Data ---
const SAMPLE_PIPELINES = [
  {
    id: "pipe-1",
    name: "LinkedIn Lead Pipeline",
    type: "chain",
    schedule: "Every 6 hours",
    lastRun: "14 min ago",
    status: "running",
    agents: [
      { id: "a1", name: "scanner", role: "Scan LinkedIn Sales Nav", status: "completed", tmux: "lead-pipe:0", tokens: 12400, cost: 0.04, duration: "2m 18s", output: "leads.json (23 leads)" },
      { id: "a2", name: "enricher", role: "RocketReach Enrichment", status: "running", tmux: "lead-pipe:1", tokens: 8200, cost: 0.03, duration: "1m 02s", output: "..." },
      { id: "a3", name: "loader", role: "Push to HubSpot", status: "queued", tmux: "lead-pipe:2", tokens: 0, cost: 0, duration: "-", output: "-" },
      { id: "a4", name: "reporter", role: "Generate weekly .pptx", status: "queued", tmux: "lead-pipe:3", tokens: 0, cost: 0, duration: "-", output: "-" },
    ],
  },
  {
    id: "pipe-2",
    name: "Board Deck Production",
    type: "fan-out",
    schedule: "Manual",
    lastRun: "Now",
    status: "running",
    agents: [
      { id: "b1", name: "team-lead", role: "Orchestrator", status: "running", tmux: "deck:0", tokens: 3100, cost: 0.01, duration: "5m 44s", output: "Coordinating..." },
      { id: "b2", name: "revenue-analyst", role: "Revenue data analysis", status: "completed", tmux: "deck:1", tokens: 41200, cost: 0.14, duration: "4m 12s", output: "revenue_analysis.md" },
      { id: "b3", name: "churn-analyst", role: "Churn pattern analysis", status: "running", tmux: "deck:2", tokens: 28700, cost: 0.10, duration: "3m 01s", output: "..." },
      { id: "b4", name: "competitive", role: "Competitive landscape", status: "running", tmux: "deck:3", tokens: 19800, cost: 0.07, duration: "2m 33s", output: "..." },
      { id: "b5", name: "assembler", role: "Synthesize → .pptx", status: "queued", tmux: "deck:4", tokens: 0, cost: 0, duration: "-", output: "-" },
    ],
  },
  {
    id: "pipe-3",
    name: "LinkedIn Content Engine",
    type: "batch",
    schedule: "Sundays 9pm",
    lastRun: "3 days ago",
    status: "completed",
    agents: [
      { id: "c1", name: "content-gen", role: "Generate 14 posts", status: "completed", tmux: "content:0", tokens: 52000, cost: 0.18, duration: "6m 40s", output: "content_queue.json" },
      { id: "c2", name: "poster-am", role: "Post 9am daily", status: "idle", tmux: "content:1", tokens: 1200, cost: 0.004, duration: "12s", output: "Last: Feb 11 9:00am" },
      { id: "c3", name: "poster-pm", role: "Post 4pm daily", status: "idle", tmux: "content:2", tokens: 1100, cost: 0.004, duration: "11s", output: "Last: Feb 10 4:00pm" },
    ],
  },
];

const SAMPLE_LOGS = [
  { ts: "14:23:07", agent: "enricher", pipe: "LinkedIn Lead Pipeline", msg: "Enriching batch 2/3 via RocketReach API..." },
  { ts: "14:22:54", agent: "scanner", pipe: "LinkedIn Lead Pipeline", msg: "✓ Scan complete. 23 new leads found matching ICP criteria." },
  { ts: "14:22:01", agent: "churn-analyst", pipe: "Board Deck Production", msg: "Analyzing Q1 churn cohorts. MRR impact: -$42k identified so far." },
  { ts: "14:21:33", agent: "revenue-analyst", pipe: "Board Deck Production", msg: "✓ Analysis complete. Key finding: 34% YoY growth driven by enterprise segment." },
  { ts: "14:21:10", agent: "competitive", pipe: "Board Deck Production", msg: "Fetching competitor pricing data via web search..." },
  { ts: "14:20:45", agent: "team-lead", pipe: "Board Deck Production", msg: "All analysts spawned. Monitoring task list for completion." },
  { ts: "14:18:02", agent: "poster-am", pipe: "LinkedIn Content Engine", msg: "✓ Posted: '5 things I learned about AI agents this week...'" },
];

// --- Components ---

function Pill({ color, bg, label, pulse }) {
  return (
    <span style={{
      display: "inline-flex", alignItems: "center", gap: 6,
      padding: "3px 10px", borderRadius: 999, fontSize: 11, fontWeight: 600,
      fontFamily: MONO, color, background: bg, letterSpacing: 0.3,
    }}>
      {pulse && (
        <span style={{
          width: 6, height: 6, borderRadius: "50%", background: color,
          animation: "pulse 1.5s ease-in-out infinite",
        }} />
      )}
      {label}
    </span>
  );
}

function AgentRow({ agent, isLast }) {
  const s = STATUS_MAP[agent.status] || STATUS_MAP.queued;
  return (
    <div style={{
      display: "grid",
      gridTemplateColumns: "140px 1fr 90px 80px 70px 70px 140px",
      alignItems: "center",
      padding: "10px 16px",
      borderBottom: isLast ? "none" : `1px solid ${theme.border}`,
      fontSize: 13,
      fontFamily: SANS,
      transition: "background 0.15s",
      cursor: "pointer",
    }}
    onMouseEnter={e => e.currentTarget.style.background = theme.surfaceHover}
    onMouseLeave={e => e.currentTarget.style.background = "transparent"}
    >
      <div style={{ fontFamily: MONO, fontWeight: 600, color: theme.text, fontSize: 12 }}>
        {agent.name}
      </div>
      <div style={{ color: theme.textMuted, fontSize: 12 }}>{agent.role}</div>
      <div><Pill {...s} /></div>
      <div style={{ fontFamily: MONO, fontSize: 11, color: theme.textMuted }}>{agent.duration}</div>
      <div style={{ fontFamily: MONO, fontSize: 11, color: theme.textDim }}>{agent.tokens > 0 ? `${(agent.tokens/1000).toFixed(1)}k` : "-"}</div>
      <div style={{ fontFamily: MONO, fontSize: 11, color: agent.cost > 0 ? theme.amber : theme.textDim }}>{agent.cost > 0 ? `$${agent.cost.toFixed(3)}` : "-"}</div>
      <div style={{ fontFamily: MONO, fontSize: 11, color: theme.textDim, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{agent.output}</div>
    </div>
  );
}

function PipelineCard({ pipeline, expanded, onToggle }) {
  const s = STATUS_MAP[pipeline.status] || STATUS_MAP.queued;
  const totalCost = pipeline.agents.reduce((sum, a) => sum + a.cost, 0);
  const totalTokens = pipeline.agents.reduce((sum, a) => sum + a.tokens, 0);
  const doneCount = pipeline.agents.filter(a => a.status === "completed").length;

  const typeLabel = { chain: "Chain →", "fan-out": "Fan-out ⇉", batch: "Batch ⊞" }[pipeline.type] || pipeline.type;

  return (
    <div style={{
      background: theme.surface,
      border: `1px solid ${expanded ? theme.borderActive : theme.border}`,
      borderRadius: 12,
      overflow: "hidden",
      transition: "border-color 0.2s",
    }}>
      {/* Header */}
      <div
        onClick={onToggle}
        style={{
          display: "flex", alignItems: "center", justifyContent: "space-between",
          padding: "14px 20px", cursor: "pointer",
          borderBottom: expanded ? `1px solid ${theme.border}` : "none",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
          <span style={{ fontSize: 15, fontWeight: 700, color: theme.text, fontFamily: SANS }}>{pipeline.name}</span>
          <Pill {...s} />
          <span style={{
            fontSize: 10, fontFamily: MONO, color: theme.textDim,
            background: "rgba(100,116,139,0.1)", padding: "2px 8px", borderRadius: 4,
          }}>{typeLabel}</span>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 20, fontSize: 12, fontFamily: MONO }}>
          <span style={{ color: theme.textMuted }}>⏱ {pipeline.schedule}</span>
          <span style={{ color: theme.textDim }}>Last: {pipeline.lastRun}</span>
          <span style={{ color: theme.textMuted }}>{doneCount}/{pipeline.agents.length} agents</span>
          <span style={{ color: theme.amber }}>${totalCost.toFixed(3)}</span>
          <span style={{ color: theme.textDim }}>{(totalTokens/1000).toFixed(0)}k tok</span>
          <span style={{
            transform: expanded ? "rotate(180deg)" : "rotate(0deg)",
            transition: "transform 0.2s", display: "inline-block",
            color: theme.textMuted, fontSize: 14,
          }}>▼</span>
        </div>
      </div>

      {/* Agent Grid */}
      {expanded && (
        <div>
          <div style={{
            display: "grid",
            gridTemplateColumns: "140px 1fr 90px 80px 70px 70px 140px",
            padding: "8px 16px",
            fontSize: 10, fontFamily: MONO, color: theme.textDim,
            textTransform: "uppercase", letterSpacing: 1,
            borderBottom: `1px solid ${theme.border}`,
          }}>
            <div>Agent</div><div>Role</div><div>Status</div><div>Time</div><div>Tokens</div><div>Cost</div><div>Output</div>
          </div>
          {pipeline.agents.map((a, i) => (
            <AgentRow key={a.id} agent={a} isLast={i === pipeline.agents.length - 1} />
          ))}
        </div>
      )}
    </div>
  );
}

function LogPanel({ logs }) {
  return (
    <div style={{
      background: theme.surface,
      border: `1px solid ${theme.border}`,
      borderRadius: 12,
      overflow: "hidden",
    }}>
      <div style={{
        padding: "12px 20px",
        borderBottom: `1px solid ${theme.border}`,
        display: "flex", justifyContent: "space-between", alignItems: "center",
      }}>
        <span style={{ fontSize: 13, fontWeight: 700, color: theme.text, fontFamily: SANS }}>Live Activity Log</span>
        <span style={{ fontSize: 10, fontFamily: MONO, color: theme.textDim }}>streaming from tmux sessions</span>
      </div>
      <div style={{ maxHeight: 220, overflowY: "auto", padding: "4px 0" }}>
        {logs.map((log, i) => (
          <div key={i} style={{
            display: "grid", gridTemplateColumns: "70px 110px 1fr",
            padding: "6px 20px", fontSize: 12, fontFamily: MONO,
            borderBottom: `1px solid rgba(30,41,59,0.5)`,
          }}>
            <span style={{ color: theme.textDim }}>{log.ts}</span>
            <span style={{ color: theme.cyan, fontWeight: 600 }}>{log.agent}</span>
            <span style={{ color: log.msg.startsWith("✓") ? theme.green : theme.textMuted }}>{log.msg}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function StatsBar({ pipelines }) {
  const allAgents = pipelines.flatMap(p => p.agents);
  const running = allAgents.filter(a => a.status === "running").length;
  const completed = allAgents.filter(a => a.status === "completed").length;
  const totalCost = allAgents.reduce((s, a) => s + a.cost, 0);
  const totalTokens = allAgents.reduce((s, a) => s + a.tokens, 0);

  const stats = [
    { label: "Pipelines", value: pipelines.length, color: theme.accent },
    { label: "Agents Active", value: running, color: theme.green },
    { label: "Completed", value: completed, color: theme.cyan },
    { label: "Total Tokens", value: `${(totalTokens/1000).toFixed(0)}k`, color: theme.purple },
    { label: "Session Cost", value: `$${totalCost.toFixed(2)}`, color: theme.amber },
  ];

  return (
    <div style={{
      display: "flex", gap: 12, marginBottom: 20,
    }}>
      {stats.map((s, i) => (
        <div key={i} style={{
          flex: 1, background: theme.surface, border: `1px solid ${theme.border}`,
          borderRadius: 10, padding: "14px 18px",
        }}>
          <div style={{ fontSize: 10, fontFamily: MONO, color: theme.textDim, textTransform: "uppercase", letterSpacing: 1, marginBottom: 4 }}>{s.label}</div>
          <div style={{ fontSize: 22, fontWeight: 800, fontFamily: MONO, color: s.color }}>{s.value}</div>
        </div>
      ))}
    </div>
  );
}

function ArchDiagram() {
  return (
    <div style={{
      background: theme.surface, border: `1px solid ${theme.border}`,
      borderRadius: 12, padding: 20, marginBottom: 20,
    }}>
      <div style={{ fontSize: 13, fontWeight: 700, color: theme.text, fontFamily: SANS, marginBottom: 14 }}>Architecture: tmux + Headless Claude Code</div>
      <div style={{ fontFamily: MONO, fontSize: 11, lineHeight: 1.8, color: theme.textMuted, whiteSpace: "pre" }}>
{`┌─────────────────────────────────────────────────────────────────────┐
│  Cloud VM ($5/mo)                                                   │
│                                                                     │
│  ┌──────────────┐    ┌──────────────────────────────────────────┐   │
│  │  Orchestrator │───▶│  tmux sessions (one per agent)           │   │
│  │  (bash/cron)  │    │                                          │   │
│  └──────────────┘    │  lead-pipe:0  │ scanner    │ claude -p    │   │
│        │             │  lead-pipe:1  │ enricher   │ claude -p    │   │
│        │             │  lead-pipe:2  │ loader     │ claude -p    │   │
│        ▼             │  deck:0       │ team-lead  │ claude -p    │   │
│  ┌──────────────┐    │  deck:1       │ analyst-1  │ claude -p    │   │
│  │  Hooks        │    │  deck:2       │ analyst-2  │ claude -p    │   │
│  │  • PreToolUse │    └──────────────────────────────────────────┘   │
│  │  • PostToolUse│                                                   │
│  │  • Stop       │───▶ logs/ ───▶ Dashboard (this UI)               │
│  └──────────────┘                                                   │
│                                                                     │
│  Data flow:  .json files between agents in /work/                   │
│  Final out:  .pptx, .xlsx, .pdf → /output/                         │
└─────────────────────────────────────────────────────────────────────┘`}
      </div>
    </div>
  );
}

// --- Main App ---
export default function OrchestratorDashboard() {
  const [expandedPipes, setExpandedPipes] = useState({ "pipe-1": true, "pipe-2": true });
  const [activeTab, setActiveTab] = useState("dashboard");

  const togglePipe = (id) => {
    setExpandedPipes(prev => ({ ...prev, [id]: !prev[id] }));
  };

  return (
    <div style={{
      minHeight: "100vh",
      background: theme.bg,
      color: theme.text,
      fontFamily: SANS,
      padding: 0,
    }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700;800&family=JetBrains+Mono:wght@400;500;600;700&display=swap');
        @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.3; } }
        * { box-sizing: border-box; margin: 0; padding: 0; }
        ::-webkit-scrollbar { width: 6px; }
        ::-webkit-scrollbar-track { background: ${theme.bg}; }
        ::-webkit-scrollbar-thumb { background: ${theme.border}; border-radius: 3px; }
      `}</style>

      {/* Header */}
      <div style={{
        borderBottom: `1px solid ${theme.border}`,
        padding: "16px 32px",
        display: "flex", justifyContent: "space-between", alignItems: "center",
        background: "rgba(17,24,39,0.8)",
        backdropFilter: "blur(12px)",
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <span style={{ fontSize: 20, fontWeight: 800, letterSpacing: -0.5 }}>⚡ Overwatch</span>
          <span style={{ fontSize: 11, fontFamily: MONO, color: theme.textDim, background: theme.accentGlow, padding: "2px 8px", borderRadius: 4, color: theme.accent }}>Claude Code Orchestrator</span>
        </div>
        <div style={{ display: "flex", gap: 4 }}>
          {["dashboard", "architecture", "config"].map(tab => (
            <button key={tab} onClick={() => setActiveTab(tab)} style={{
              background: activeTab === tab ? theme.accentGlow : "transparent",
              color: activeTab === tab ? theme.accent : theme.textMuted,
              border: "none", borderRadius: 6, padding: "6px 14px",
              fontSize: 12, fontFamily: MONO, fontWeight: 600, cursor: "pointer",
              textTransform: "capitalize",
            }}>{tab}</button>
          ))}
        </div>
      </div>

      <div style={{ padding: "24px 32px", maxWidth: 1200, margin: "0 auto" }}>
        {activeTab === "dashboard" && (
          <>
            <StatsBar pipelines={SAMPLE_PIPELINES} />
            <div style={{ display: "flex", flexDirection: "column", gap: 16, marginBottom: 20 }}>
              {SAMPLE_PIPELINES.map(p => (
                <PipelineCard key={p.id} pipeline={p} expanded={!!expandedPipes[p.id]} onToggle={() => togglePipe(p.id)} />
              ))}
            </div>
            <LogPanel logs={SAMPLE_LOGS} />
          </>
        )}

        {activeTab === "architecture" && (
          <>
            <ArchDiagram />
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
              {/* Pattern Cards */}
              {[
                {
                  title: "Chain → Sequential Pipeline",
                  desc: "Each agent's output feeds the next. Best for: lead enrichment, ETL, content-to-posting pipelines.",
                  code: `# orchestrate.sh
claude -p "Scan LinkedIn..." --output-format json > leads.json
claude -p "Enrich leads.json via RocketReach" --output-format json > enriched.json
claude -p "Push enriched.json to HubSpot" --output-format json > sync_log.json`,
                },
                {
                  title: "Fan-out ⇉ Parallel Analysis",
                  desc: "Multiple agents work in parallel, results synthesized. Best for: research, multi-perspective analysis, board decks.",
                  code: `# Use Agent Teams (experimental)
export CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1
claude "Create a team: revenue-analyst, churn-analyst, 
competitive-analyst. Each writes findings to /work/. 
When all done, synthesize into board_deck.pptx"`,
                },
                {
                  title: "Batch ⊞ Generate + Schedule",
                  desc: "Bulk generate content, then drip-post on schedule. Best for: social media, email sequences, report series.",
                  code: `# Sunday night batch
claude -p "Generate 14 LinkedIn posts as JSON" > queue.json

# Cron: 0 9,16 * * * 
claude -p "Post next item from queue.json to LinkedIn API"`,
                },
                {
                  title: "Agent Teams (Native)",
                  desc: "Claude Code's built-in multi-agent. Agents message each other directly. Best for: complex features, QA swarms.",
                  code: `# Enable experimental feature
export CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1

# Claude spawns & coordinates automatically
claude "Create a team to audit our auth system:
- security-reviewer
- performance-analyst  
- test-coverage-checker
Have them share findings via task list."`,
                },
              ].map((card, i) => (
                <div key={i} style={{
                  background: theme.surface, border: `1px solid ${theme.border}`,
                  borderRadius: 12, padding: 20,
                }}>
                  <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 6 }}>{card.title}</div>
                  <div style={{ fontSize: 12, color: theme.textMuted, marginBottom: 14, lineHeight: 1.5 }}>{card.desc}</div>
                  <pre style={{
                    background: theme.bg, borderRadius: 8, padding: 14,
                    fontSize: 11, fontFamily: MONO, color: theme.cyan,
                    overflow: "auto", lineHeight: 1.6,
                    border: `1px solid ${theme.border}`,
                  }}>{card.code}</pre>
                </div>
              ))}
            </div>

            {/* Key Concepts */}
            <div style={{
              background: theme.surface, border: `1px solid ${theme.border}`,
              borderRadius: 12, padding: 20, marginTop: 16,
            }}>
              <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 14 }}>Key Concepts</div>
              <div style={{
                display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 16,
                fontSize: 12, color: theme.textMuted, lineHeight: 1.7,
              }}>
                <div>
                  <div style={{ color: theme.green, fontWeight: 700, fontFamily: MONO, fontSize: 11, marginBottom: 4 }}>HEADLESS MODE</div>
                  <code style={{ color: theme.cyan }}>claude -p "prompt"</code> runs non-interactively. Use <code style={{ color: theme.cyan }}>--output-format json</code> for structured data between agents. Use <code style={{ color: theme.cyan }}>--resume SESSION_ID</code> for multi-turn chains.
                </div>
                <div>
                  <div style={{ color: theme.amber, fontWeight: 700, fontFamily: MONO, fontSize: 11, marginBottom: 4 }}>HOOKS</div>
                  Register shell commands on lifecycle events: <code style={{ color: theme.cyan }}>PreToolUse</code>, <code style={{ color: theme.cyan }}>PostToolUse</code>, <code style={{ color: theme.cyan }}>Stop</code>, <code style={{ color: theme.cyan }}>Notification</code>. Use for logging, auto-formatting, file protection, and feeding the dashboard.
                </div>
                <div>
                  <div style={{ color: theme.purple, fontWeight: 700, fontFamily: MONO, fontSize: 11, marginBottom: 4 }}>TMUX ISOLATION</div>
                  Each agent runs in its own tmux window. The orchestrator script creates sessions, sends commands, and captures output. Cheap VM + tmux = poor man's Kubernetes for agents.
                </div>
              </div>
            </div>
          </>
        )}

        {activeTab === "config" && (
          <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
            <div style={{
              background: theme.surface, border: `1px solid ${theme.border}`,
              borderRadius: 12, padding: 20,
            }}>
              <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 14 }}>Sample Orchestrator Script</div>
              <pre style={{
                background: theme.bg, borderRadius: 8, padding: 18,
                fontSize: 11, fontFamily: MONO, color: theme.text,
                overflow: "auto", lineHeight: 1.7,
                border: `1px solid ${theme.border}`,
              }}>{`#!/bin/bash
# orchestrate.sh — Run on a $5/mo VM via cron or manually
set -euo pipefail

WORK_DIR="/home/agent/work"
OUTPUT_DIR="/home/agent/output"
LOG_DIR="/home/agent/logs"
TIMESTAMP=$(date +%Y%m%d_%H%M%S)

mkdir -p "$WORK_DIR" "$OUTPUT_DIR" "$LOG_DIR"

# ─── PATTERN 1: Chain (LinkedIn Lead Pipeline) ───────────────
run_lead_pipeline() {
  echo "[$(date)] Starting lead pipeline..." >> "$LOG_DIR/pipeline.log"

  # Step 1: Scan
  tmux new-session -d -s lead-pipe -n scanner
  tmux send-keys -t lead-pipe:scanner \\
    "claude -p 'Search LinkedIn Sales Navigator for CTOs at Series B+ \\
     SaaS companies in US. Output as JSON array with name, title, \\
     company, linkedin_url.' \\
     --output-format json \\
     --allowedTools 'Bash,Read,mcp__linkedin' \\
     --mcp-config /home/agent/mcp-servers.json \\
     > $WORK_DIR/leads.json 2>> $LOG_DIR/scanner.log" Enter

  # Wait for completion
  while tmux has-session -t lead-pipe 2>/dev/null && \\
        ! [ -s "$WORK_DIR/leads.json" ]; do
    sleep 10
  done

  # Step 2: Enrich
  tmux new-window -t lead-pipe -n enricher
  tmux send-keys -t lead-pipe:enricher \\
    "claude -p 'Read $WORK_DIR/leads.json. For each lead, call \\
     RocketReach API to get email and phone. Output enriched.json.' \\
     --output-format json \\
     --allowedTools 'Bash,Read,mcp__rocketreach' \\
     --mcp-config /home/agent/mcp-servers.json \\
     > $WORK_DIR/enriched.json 2>> $LOG_DIR/enricher.log" Enter

  # Step 3: Load into HubSpot
  # ... same pattern with --allowedTools 'Bash,Read,mcp__hubspot'

  # Step 4: Weekly report
  # claude -p "Summarize this week's pipeline results into a .pptx"
}

# ─── PATTERN 2: Fan-out (Board Deck) ─────────────────────────
run_board_deck() {
  tmux new-session -d -s deck

  # Parallel analysts
  for analyst in revenue churn competitive; do
    tmux new-window -t deck -n "$analyst"
    tmux send-keys -t "deck:$analyst" \\
      "claude -p 'Analyze /data/q1_\${analyst}.csv. Write key findings \\
       to $WORK_DIR/\${analyst}_analysis.md. Be specific with numbers.' \\
       --allowedTools 'Bash,Read' \\
       > $LOG_DIR/\${analyst}.log 2>&1" Enter
  done

  # Wait for all analysts
  wait_for_files "$WORK_DIR/revenue_analysis.md" \\
                 "$WORK_DIR/churn_analysis.md" \\
                 "$WORK_DIR/competitive_analysis.md"

  # Synthesize into deck
  tmux new-window -t deck -n assembler
  tmux send-keys -t deck:assembler \\
    "claude -p 'Read all *_analysis.md files in $WORK_DIR. \\
     Create a 15-slide board deck as .pptx with executive summary, \\
     key metrics, analysis sections, and recommendations. \\
     Save to $OUTPUT_DIR/Q1_Board_Deck.pptx' \\
     --allowedTools 'Bash,Read,Write'" Enter
}

# ─── PATTERN 3: Agent Teams (native, for complex work) ───────
run_agent_team() {
  export CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1
  
  tmux new-session -d -s team-lead
  tmux send-keys -t team-lead \\
    "claude 'Create an agent team to build the new payments feature. \\
     Spawn teammates: api-developer for backend routes, \\
     db-architect for schema + migrations, \\
     frontend-dev for React components, \\
     test-writer for integration tests. \\
     Coordinate via shared task list. \\
     Each teammate should read CLAUDE.md for conventions.'" Enter
}

# ─── Helpers ──────────────────────────────────────────────────
wait_for_files() {
  for f in "$@"; do
    while [ ! -s "$f" ]; do sleep 5; done
    echo "[$(date)] Ready: $f" >> "$LOG_DIR/pipeline.log"
  done
}

# ─── Main ─────────────────────────────────────────────────────
case "\${1:-}" in
  leads)      run_lead_pipeline ;;
  deck)       run_board_deck ;;
  team)       run_agent_team ;;
  *)          echo "Usage: $0 {leads|deck|team}" ;;
esac`}</pre>
            </div>

            <div style={{
              background: theme.surface, border: `1px solid ${theme.border}`,
              borderRadius: 12, padding: 20,
            }}>
              <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 14 }}>MCP Server Config</div>
              <pre style={{
                background: theme.bg, borderRadius: 8, padding: 18,
                fontSize: 11, fontFamily: MONO, color: theme.text,
                overflow: "auto", lineHeight: 1.7,
                border: `1px solid ${theme.border}`,
              }}>{`// /home/agent/mcp-servers.json
{
  "mcpServers": {
    "hubspot": {
      "command": "npx",
      "args": ["@hubspot/mcp-server"],
      "env": { "HUBSPOT_API_KEY": "..." }
    },
    "linkedin": {
      "command": "npx",
      "args": ["linkedin-mcp-server"],
      "env": { "LINKEDIN_ACCESS_TOKEN": "..." }
    },
    "rocketreach": {
      "command": "python3",
      "args": ["mcp_rocketreach/server.py"],
      "env": { "ROCKETREACH_API_KEY": "..." }
    },
    "filesystem": {
      "command": "npx",
      "args": ["@anthropic/mcp-filesystem", "/home/agent/work", "/home/agent/output"]
    }
  }
}`}</pre>
            </div>

            <div style={{
              background: theme.surface, border: `1px solid ${theme.border}`,
              borderRadius: 12, padding: 20,
            }}>
              <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 14 }}>Hooks Config (for dashboard logging)</div>
              <pre style={{
                background: theme.bg, borderRadius: 8, padding: 18,
                fontSize: 11, fontFamily: MONO, color: theme.text,
                overflow: "auto", lineHeight: 1.7,
                border: `1px solid ${theme.border}`,
              }}>{`// ~/.claude/settings.json
{
  "hooks": {
    "PostToolUse": [{
      "matcher": "*",
      "hooks": [{
        "type": "command",
        "command": "jq -c '{ts: now|todate, agent: env.CLAUDE_CODE_AGENT_NAME, tool: .tool_name, status: \"complete\"}' >> /home/agent/logs/activity.jsonl"
      }]
    }],
    "Stop": [{
      "matcher": "",
      "hooks": [{
        "type": "command",
        "command": "echo '{\"ts\":\"'$(date -Iseconds)'\",\"event\":\"agent_stopped\",\"agent\":\"'$CLAUDE_CODE_AGENT_NAME'\"}' >> /home/agent/logs/activity.jsonl"
      }]
    }],
    "Notification": [{
      "matcher": "",
      "hooks": [{
        "type": "command",
        "command": "notify-send 'Claude Agent' 'Needs input' 2>/dev/null; curl -s -X POST https://your-webhook.com/notify -d '{\"msg\":\"Agent needs input\"}'"
      }]
    }]
  }
}`}</pre>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
