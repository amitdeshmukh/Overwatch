export function getPageHtml(): string {
  return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Overwatch Dashboard</title>
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
  <link href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700;800&family=JetBrains+Mono:wght@400;500;600;700&display=swap" rel="stylesheet" />
  <style>
    :root {
      --bg: #0a0e17;
      --surface: #111827;
      --surface-hover: #1a2236;
      --border: #1e293b;
      --border-active: #3b82f6;
      --text: #e2e8f0;
      --text-muted: #64748b;
      --text-dim: #475569;
      --accent: #3b82f6;
      --accent-glow: rgba(59,130,246,0.15);
      --green: #22c55e;
      --green-dim: rgba(34,197,94,0.15);
      --amber: #f59e0b;
      --amber-dim: rgba(245,158,11,0.15);
      --red: #ef4444;
      --red-dim: rgba(239,68,68,0.15);
      --purple: #a855f7;
      --purple-dim: rgba(168,85,247,0.15);
      --cyan: #06b6d4;
      --cyan-dim: rgba(6,182,212,0.15);
      --mono: 'JetBrains Mono', 'Fira Code', 'SF Mono', monospace;
      --sans: 'DM Sans', 'Segoe UI', system-ui, sans-serif;
    }
    @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.3; } }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { background: var(--bg); color: var(--text); font-family: var(--sans); }
    ::-webkit-scrollbar { width: 6px; }
    ::-webkit-scrollbar-track { background: var(--bg); }
    ::-webkit-scrollbar-thumb { background: var(--border); border-radius: 3px; }
  </style>
</head>
<body>
  <div id="root"></div>
  <script type="importmap">
  {
    "imports": {
      "react": "https://esm.sh/react@18.3.1",
      "react-dom/client": "https://esm.sh/react-dom@18.3.1/client"
    }
  }
  </script>
  <script type="module">
import React from "react";
import { createRoot } from "react-dom/client";

const { createElement: h, useState, useEffect, useRef, Fragment } = React;

// --- Status maps ---
const STATUS_MAP = {
  running: { color: "var(--green)", bg: "var(--green-dim)", label: "Running", pulse: true },
  idle:    { color: "var(--amber)", bg: "var(--amber-dim)", label: "Idle" },
  done:    { color: "var(--accent)", bg: "var(--accent-glow)", label: "Done" },
  completed: { color: "var(--accent)", bg: "var(--accent-glow)", label: "Done" },
  pending: { color: "var(--text-muted)", bg: "rgba(100,116,139,0.1)", label: "Pending" },
  blocked: { color: "var(--purple)", bg: "var(--purple-dim)", label: "Blocked" },
  failed:  { color: "var(--red)", bg: "var(--red-dim)", label: "Failed" },
  error:   { color: "var(--red)", bg: "var(--red-dim)", label: "Error" },
};

const EVENT_COLORS = {
  task_started: "var(--green)",
  task_done: "var(--accent)",
  task_failed: "var(--red)",
  needs_input: "var(--amber)",
  agent_stop: "var(--text-muted)",
  file_changed: "var(--cyan)",
};

// --- Components ---

function Pill({ color, bg, label, pulse }) {
  return h("span", {
    style: {
      display: "inline-flex", alignItems: "center", gap: 6,
      padding: "3px 10px", borderRadius: 999, fontSize: 11, fontWeight: 600,
      fontFamily: "var(--mono)", color, background: bg, letterSpacing: 0.3,
    }
  },
    pulse && h("span", { style: {
      width: 6, height: 6, borderRadius: "50%", background: color,
      animation: "pulse 1.5s ease-in-out infinite",
    }}),
    label
  );
}

function AgentRow({ agent, daemonId, events, traces, isLast, depth, isExpanded, onToggle }) {
  const s = STATUS_MAP[agent.status] || STATUS_MAP.pending;
  const indent = (depth || 0) * 20;
  const traceEvents = (traces || [])
    .filter((ev) => ev.daemonId === daemonId && ev.taskId === agent.id)
    .slice(0, 8)
    .reverse();
  return h("div", null,
    h("div", {
      onClick: onToggle,
      style: {
        display: "grid",
        gridTemplateColumns: "1.5fr 1fr 90px 1fr 80px 1.5fr",
        alignItems: "center",
        padding: "10px 16px",
        paddingLeft: 16 + indent,
        borderBottom: isExpanded ? "none" : (isLast ? "none" : "1px solid var(--border)"),
        fontSize: 13, fontFamily: "var(--sans)",
        transition: "background 0.15s", cursor: "pointer",
        background: isExpanded ? "var(--surface-hover)" : "transparent",
      },
      onMouseEnter: (e) => { if (!isExpanded) e.currentTarget.style.background = "var(--surface-hover)"; },
      onMouseLeave: (e) => { if (!isExpanded) e.currentTarget.style.background = "transparent"; },
    },
      h("div", { style: { fontFamily: "var(--mono)", fontWeight: 600, color: "var(--text)", fontSize: 12, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } },
        depth > 0 ? "└ " : "", agent.title
      ),
      h("div", { style: { fontFamily: "var(--mono)", fontSize: 11, color: "var(--cyan)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } },
        agent.skills && agent.skills.length > 0 ? agent.skills.join(", ") : "—"
      ),
      h("div", null, h(Pill, { ...s })),
      h("div", { style: { fontFamily: "var(--mono)", fontSize: 11, color: "var(--text-dim)" } }, agent.agentModel || "—"),
      h("div", { style: { fontFamily: "var(--mono)", fontSize: 11, color: "var(--text-dim)" } }, agent.id.slice(0, 8)),
      h("div", { style: { fontFamily: "var(--mono)", fontSize: 11, color: "var(--text-dim)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", display: "flex", alignItems: "center", gap: 6 } },
        h("span", { style: { flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } },
          agent.result ? (agent.result.length > 60 ? agent.result.slice(0, 60) + "…" : agent.result) : "—"
        ),
        agent.result && h("span", { style: { color: "var(--text-dim)", fontSize: 10, flexShrink: 0, transform: isExpanded ? "rotate(180deg)" : "rotate(0deg)", transition: "transform 0.2s" } }, "▼")
      )
    ),
    isExpanded && h("div", {
      style: {
        padding: "10px 20px 12px 20px",
        paddingLeft: 20 + indent,
        background: "var(--bg)",
        borderBottom: isLast ? "none" : "1px solid var(--border)",
        fontSize: 12, fontFamily: "var(--mono)", color: "var(--text)",
        whiteSpace: "pre-wrap", wordBreak: "break-word",
        lineHeight: 1.6, maxHeight: 300, overflowY: "auto",
      }
    },
      h("div", null, agent.result || "(no result yet)"),
      h("div", { style: { marginTop: 10, paddingTop: 10, borderTop: "1px dashed var(--border)", whiteSpace: "normal" } },
        h("div", { style: { fontSize: 10, textTransform: "uppercase", letterSpacing: 1, color: "var(--text-dim)", marginBottom: 8 } }, "Internal Trace"),
        traceEvents.length === 0
          ? h("div", { style: { color: "var(--text-dim)", fontSize: 11, fontFamily: "var(--sans)" } }, "No task events yet.")
          : traceEvents.map((ev) =>
              h("details", {
                key: ev.id,
                style: {
                  marginBottom: 6,
                  border: "1px solid var(--border)",
                  borderRadius: 6,
                  background: "var(--surface)",
                  overflow: "hidden",
                }
              },
                h("summary", {
                  style: {
                    cursor: "pointer",
                    listStyle: "none",
                    padding: "6px 8px",
                    display: "flex",
                    gap: 8,
                    alignItems: "center",
                    fontSize: 11,
                  }
                },
                  h("span", { style: { color: "var(--text-dim)" } }, toLocalTime(ev.createdAt)),
                  h("span", { style: { color: "var(--cyan)", fontWeight: 700 } }, ev.eventType),
                  h("span", { style: { color: "var(--amber)" } }, traceModel(ev.payload)),
                  h("span", { style: { color: "var(--text-muted)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } }, tryParsePayload(ev.payload))
                ),
                h("pre", {
                  style: {
                    margin: 0,
                    padding: "8px",
                    borderTop: "1px solid var(--border)",
                    color: "var(--text)",
                    background: "var(--bg)",
                    fontSize: 11,
                    whiteSpace: "pre-wrap",
                    wordBreak: "break-word",
                  }
                }, formatPayload(ev.payload))
              )
            )
      )
    )
  );
}

function DaemonCard({ daemon, events, traces, cronTriggers, expanded, onToggle }) {
  const s = daemon.isReaped
    ? { color: "var(--text-muted)", bg: "rgba(100,116,139,0.1)", label: "Reaped" }
    : (STATUS_MAP[daemon.status] || STATUS_MAP.idle);
  const activeCount = daemon.agents.filter(a => a.status === "running").length;
  const doneCount = daemon.agents.filter(a => a.status === "done" || a.status === "completed").length;
  const daemonCron = (cronTriggers || []).filter((t) => t.daemonName === daemon.name);
  const decomp = daemon.latestDecomposition;
  const [expandedAgentId, setExpandedAgentId] = useState(null);

  // Build depth map from parentId
  const depthMap = {};
  const idSet = new Set(daemon.agents.map(a => a.id));
  for (const a of daemon.agents) {
    depthMap[a.id] = (a.parentId && idSet.has(a.parentId)) ? 1 : 0;
  }

  return h("div", {
    style: {
      background: "var(--surface)",
      border: "1px solid " + (expanded ? "var(--border-active)" : "var(--border)"),
      borderRadius: 12, overflow: "hidden", transition: "border-color 0.2s",
    }
  },
    // Header
    h("div", {
      onClick: onToggle,
      style: {
        display: "flex", alignItems: "center", justifyContent: "space-between",
        padding: "14px 20px", cursor: "pointer",
        borderBottom: expanded ? "1px solid var(--border)" : "none",
      }
    },
      h("div", { style: { display: "flex", alignItems: "center", gap: 14 } },
        h("span", { style: { fontSize: 15, fontWeight: 700, color: "var(--text)", fontFamily: "var(--sans)" } }, daemon.name),
        h(Pill, { ...s }),
        daemon.pid && h("span", { style: { fontSize: 10, fontFamily: "var(--mono)", color: "var(--text-dim)", background: "rgba(100,116,139,0.1)", padding: "2px 8px", borderRadius: 4 } }, "PID " + daemon.pid)
      ),
      h("div", { style: { display: "flex", alignItems: "center", gap: 20, fontSize: 12, fontFamily: "var(--mono)" } },
        h("span", { style: { color: "var(--text-muted)" } }, activeCount + " active"),
        h("span", { style: { color: "var(--text-dim)" } }, doneCount + "/" + daemon.agents.length + " agents"),
        h("span", { style: { color: "var(--cyan)" } }, daemonCron.length + " schedules"),
        h("span", { style: { color: decomp ? (decomp.status === "failed" ? "var(--red)" : decomp.fallbackUsed ? "var(--amber)" : "var(--green)") : "var(--text-dim)" } },
          decomp ? formatDecompositionSummary(decomp) : "plan: —"
        ),
        h("span", { style: { color: "var(--amber)" } }, "$" + daemon.totalCost.toFixed(3)),
        h("span", {
          style: {
            transform: expanded ? "rotate(180deg)" : "rotate(0deg)",
            transition: "transform 0.2s", display: "inline-block",
            color: "var(--text-muted)", fontSize: 14,
          }
        }, "▼")
      )
    ),
    // Agent grid
    expanded && h("div", null,
      h("div", {
        style: {
          display: "grid",
          gridTemplateColumns: "1.5fr 1fr 90px 1fr 80px 1.5fr",
          padding: "8px 16px", fontSize: 10, fontFamily: "var(--mono)",
          color: "var(--text-dim)", textTransform: "uppercase", letterSpacing: 1,
          borderBottom: "1px solid var(--border)",
        }
      },
        h("div", null, "Agent"),
        h("div", null, "Skills"),
        h("div", null, "Status"),
        h("div", null, "Model"),
        h("div", null, "ID"),
        h("div", null, "Content")
      ),
      daemon.agents.length === 0
        ? h("div", { style: { padding: "20px 16px", fontSize: 12, color: "var(--text-dim)", textAlign: "center" } }, "No agents")
        : daemon.agents.map((a, i) =>
            h(AgentRow, {
              key: a.id, agent: a, isLast: i === daemon.agents.length - 1, depth: depthMap[a.id] || 0,
              daemonId: daemon.id,
              events,
              traces,
              isExpanded: expandedAgentId === a.id,
              onToggle: () => setExpandedAgentId(expandedAgentId === a.id ? null : a.id),
            })
          ),
      h("div", {
        style: {
          borderTop: "1px solid var(--border)",
          padding: "10px 16px 12px 16px",
          background: "rgba(10,14,23,0.5)",
        }
      },
        h("div", { style: { fontSize: 10, fontFamily: "var(--mono)", color: "var(--text-dim)", textTransform: "uppercase", letterSpacing: 1, marginBottom: 8 } }, "Cron Triggers"),
        daemonCron.length === 0
          ? h("div", { style: { fontSize: 12, color: "var(--text-dim)" } }, "No cron triggers for this daemon.")
          : daemonCron.map((t) =>
              h("div", {
                key: t.id,
                style: {
                  display: "grid",
                  gridTemplateColumns: "60px 110px 1fr 1fr",
                  gap: 10,
                  fontSize: 11,
                  fontFamily: "var(--mono)",
                  color: "var(--text-muted)",
                  padding: "4px 0",
                  borderBottom: "1px dashed rgba(30,41,59,0.5)",
                }
              },
                h("span", { style: { color: t.enabled ? "var(--green)" : "var(--red)" } }, t.enabled ? "ACTIVE" : "PAUSED"),
                h("span", { style: { color: "var(--cyan)" } }, t.cronExpr),
                h("span", { style: { color: "var(--text)" } }, t.title),
                h("span", null, "next " + toLocalDateTime(t.nextRunAt))
              )
            )
      )
    )
  );
}

function LogPanel({ events }) {
  const [expandedId, setExpandedId] = useState(null);

  return h("div", {
    style: {
      background: "var(--surface)",
      border: "1px solid var(--border)",
      borderRadius: 12, overflow: "hidden",
    }
  },
    h("div", {
      style: {
        padding: "12px 20px", borderBottom: "1px solid var(--border)",
        display: "flex", justifyContent: "space-between", alignItems: "center",
      }
    },
      h("span", { style: { fontSize: 13, fontWeight: 700, color: "var(--text)", fontFamily: "var(--sans)" } }, "Live Activity Log"),
      h("span", { style: { fontSize: 10, fontFamily: "var(--mono)", color: "var(--text-dim)" } }, "polling every 2s")
    ),
    h("div", { style: { maxHeight: 360, overflowY: "auto", padding: "4px 0" } },
      events.length === 0
        ? h("div", { style: { padding: "20px", fontSize: 12, color: "var(--text-dim)", textAlign: "center" } }, "No events yet")
        : events.map((ev) => {
            const isExpanded = expandedId === ev.id;
            const parsed = tryParsePayload(ev.payload);
            return h("div", { key: ev.id },
              h("div", {
                onClick: () => setExpandedId(isExpanded ? null : ev.id),
                style: {
                  display: "grid", gridTemplateColumns: "140px 100px 90px 1fr",
                  padding: "6px 20px", fontSize: 12, fontFamily: "var(--mono)",
                  borderBottom: isExpanded ? "none" : "1px solid rgba(30,41,59,0.5)",
                  cursor: "pointer",
                  background: isExpanded ? "var(--surface-hover)" : "transparent",
                  transition: "background 0.15s",
                },
                onMouseEnter: (e) => { if (!isExpanded) e.currentTarget.style.background = "var(--surface-hover)"; },
                onMouseLeave: (e) => { if (!isExpanded) e.currentTarget.style.background = "transparent"; },
              },
                h("span", { style: { color: "var(--text-dim)" } }, toLocalTime(ev.createdAt)),
                h("span", { style: { color: EVENT_COLORS[ev.type] || "var(--text-muted)", fontWeight: 600 } }, ev.type),
                h("span", { style: { color: "var(--cyan)" } }, ev.taskId ? ev.taskId.slice(0, 8) : "—"),
                h("span", { style: { color: "var(--text-muted)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", display: "flex", alignItems: "center", gap: 6 } },
                  h("span", { style: { flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } }, parsed),
                  h("span", { style: { color: "var(--text-dim)", fontSize: 10, flexShrink: 0, transform: isExpanded ? "rotate(180deg)" : "rotate(0deg)", transition: "transform 0.2s" } }, "▼")
                )
              ),
              isExpanded && h("div", {
                style: {
                  padding: "10px 20px 12px 20px",
                  background: "var(--bg)",
                  borderBottom: "1px solid rgba(30,41,59,0.5)",
                  fontSize: 12, fontFamily: "var(--mono)", color: "var(--text)",
                  whiteSpace: "pre-wrap", wordBreak: "break-word",
                  lineHeight: 1.6, maxHeight: 300, overflowY: "auto",
                }
              }, formatPayload(ev.payload))
            );
          })
    )
  );
}

function CronPanel({ cronTriggers }) {
  return h("div", {
    style: {
      background: "var(--surface)",
      border: "1px solid var(--border)",
      borderRadius: 12,
      overflow: "hidden",
      marginBottom: 20,
    }
  },
    h("div", {
      style: {
        padding: "12px 20px",
        borderBottom: "1px solid var(--border)",
        display: "flex",
        justifyContent: "space-between",
        alignItems: "center",
      }
    },
      h("span", { style: { fontSize: 13, fontWeight: 700, color: "var(--text)", fontFamily: "var(--sans)" } }, "Cron Schedules"),
      h("span", { style: { fontSize: 10, fontFamily: "var(--mono)", color: "var(--text-dim)" } }, cronTriggers.length + " total")
    ),
    h("div", { style: { maxHeight: 260, overflowY: "auto", padding: "6px 0" } },
      cronTriggers.length === 0
        ? h("div", { style: { padding: "20px", fontSize: 12, color: "var(--text-dim)", textAlign: "center" } }, "No cron triggers yet")
        : cronTriggers.map((t) =>
            h("div", {
              key: t.id,
              style: {
                display: "grid",
                gridTemplateColumns: "90px 130px 140px 1fr 220px",
                gap: 10,
                padding: "6px 20px",
                fontSize: 11,
                fontFamily: "var(--mono)",
                borderBottom: "1px solid rgba(30,41,59,0.5)",
              }
            },
              h("span", { style: { color: t.enabled ? "var(--green)" : "var(--red)" } }, t.enabled ? "ACTIVE" : "PAUSED"),
              h("span", { style: { color: "var(--cyan)" } }, t.daemonName),
              h("span", { style: { color: "var(--text-muted)" } }, t.cronExpr),
              h("span", { style: { color: "var(--text)" } }, t.title),
              h("span", { style: { color: "var(--text-muted)" } }, "next " + toLocalDateTime(t.nextRunAt))
            )
          )
    )
  );
}

function toLocalTime(utcStr) {
  try {
    const d = new Date(utcStr + "Z");
    return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  } catch { return utcStr; }
}

function toLocalDateTime(utcStr) {
  try {
    const d = new Date(utcStr + "Z");
    return d.toLocaleString([], { month: "short", day: "2-digit", hour: "2-digit", minute: "2-digit" });
  } catch { return utcStr; }
}

function tryParsePayload(raw) {
  try {
    const obj = JSON.parse(raw);
    const candidate = obj.message ?? obj.error ?? obj.title ?? obj;
    if (typeof candidate === "string") return candidate;
    if (candidate && typeof candidate === "object") {
      const keys = Object.keys(candidate);
      return keys.length > 0
        ? ("{" + keys.slice(0, 6).join(", ") + (keys.length > 6 ? ", ..." : "") + "}")
        : "(object)";
    }
    return String(candidate);
  } catch {
    if (typeof raw === "string") return raw;
    try {
      return JSON.stringify(raw);
    } catch {
      return String(raw);
    }
  }
}

function traceModel(raw) {
  try {
    const obj = JSON.parse(raw);
    if (typeof obj.model === "string" && obj.model.length > 0) return obj.model;
  } catch {
    // ignore
  }
  return "model:—";
}

function formatPayload(raw) {
  try {
    const obj = JSON.parse(raw);
    return JSON.stringify(obj, null, 2);
  } catch {
    if (typeof raw === "string") return raw;
    try {
      return JSON.stringify(raw, null, 2);
    } catch {
      return String(raw);
    }
  }
}

function formatDecompositionSummary(run) {
  const elapsed = typeof run.elapsedMs === "number" ? (Math.round(run.elapsedMs / 1000) + "s") : "—";
  const status = run.status === "failed"
    ? ("failed:" + (run.errorCode || "error"))
    : run.fallbackUsed
      ? "ok:fallback"
      : "ok";
  return "plan " + status + " " + elapsed + " p" + run.parseAttempts;
}

function StatsBar({ daemons, cronTriggers }) {
  const allAgents = daemons.flatMap(d => d.agents);
  const active = allAgents.filter(a => a.status === "running").length;
  const completed = allAgents.filter(a => a.status === "done" || a.status === "completed").length;
  const failed = allAgents.filter(a => a.status === "failed").length;
  const totalCost = daemons.reduce((s, d) => s + d.totalCost, 0);
  const activeSchedules = (cronTriggers || []).filter((t) => t.enabled).length;

  const stats = [
    { label: "Daemons", value: daemons.length, color: "var(--accent)" },
    { label: "Agents Active", value: active, color: "var(--green)" },
    { label: "Completed", value: completed, color: "var(--cyan)" },
    { label: "Failed", value: failed, color: "var(--red)" },
    { label: "Schedules", value: activeSchedules, color: "var(--purple)" },
    { label: "Session Cost", value: "$" + totalCost.toFixed(2), color: "var(--amber)" },
  ];

  return h("div", { style: { display: "flex", gap: 12, marginBottom: 20 } },
    stats.map((s, i) =>
      h("div", {
        key: i,
        style: {
          flex: 1, background: "var(--surface)", border: "1px solid var(--border)",
          borderRadius: 10, padding: "14px 18px",
        }
      },
        h("div", { style: { fontSize: 10, fontFamily: "var(--mono)", color: "var(--text-dim)", textTransform: "uppercase", letterSpacing: 1, marginBottom: 4 } }, s.label),
        h("div", { style: { fontSize: 22, fontWeight: 800, fontFamily: "var(--mono)", color: s.color } }, s.value)
      )
    )
  );
}

function ArchDiagram() {
  return h("div", {
    style: {
      background: "var(--surface)", border: "1px solid var(--border)",
      borderRadius: 12, padding: 20, marginBottom: 20,
    }
  },
    h("div", { style: { fontSize: 13, fontWeight: 700, color: "var(--text)", fontFamily: "var(--sans)", marginBottom: 14 } },
      "Architecture: Overwatch Orchestrator"
    ),
    h("pre", { style: { fontFamily: "var(--mono)", fontSize: 11, lineHeight: 1.8, color: "var(--text-muted)", whiteSpace: "pre", overflow: "auto" } },
\`┌─────────────────────────────────────────────────────────────────────────┐
│  launch.ts  (parent process)                                            │
│                                                                         │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐  ┌────────────┐  │
│  │  manager/     │  │  telegram/   │  │  web/         │  │  tui/      │  │
│  │  index.ts     │  │  index.ts    │  │  index.ts     │  │  index.ts  │  │
│  │  (scheduler)  │  │  (Grammy bot)│  │  (HTTP :7777) │  │  (Ink)     │  │
│  └──────┬───────┘  └──────────────┘  └───────┬───────┘  └────────────┘  │
│         │                                     │                          │
│         ▼                                     ▼                          │
│  ┌──────────────┐               ┌──────────────────────┐                │
│  │  daemon/      │               │  SQLite (WAL mode)    │                │
│  │  index.ts     │──── reads ───▶│  daemons │ tasks      │                │
│  │  (per-daemon) │     writes    │  events  │ commands   │                │
│  │               │               │  mcp_configs │ skills │                │
│  └──────┬───────┘               └──────────────────────┘                │
│         │                                                                │
│         ▼                                                                │
│  ┌──────────────────────────────────────────────┐                       │
│  │  Claude Agent SDK                             │                       │
│  │  Agents: haiku / sonnet / opus                │                       │
│  │  Roles: lead, backend-dev, frontend-dev, ...  │                       │
│  │  Isolated sessions per task                   │                       │
│  └──────────────────────────────────────────────┘                       │
└─────────────────────────────────────────────────────────────────────────┘\`
    )
  );
}

function ArchTab() {
  const patterns = [
    {
      title: "Hierarchical Task Decomposition",
      desc: "A lead agent breaks down complex goals into sub-tasks with dependencies. Child tasks run in parallel when their deps are met.",
      code: \`// tasks table has parent_id + deps (JSON array)
// Manager picks pending tasks with resolved deps
// Each task runs in its own Claude Agent SDK session
daemon.submitTask({
  title: "Build payment feature",
  exec_mode: "auto",
  agent_role: "lead"  // lead decomposes into subtasks
});\`
    },
    {
      title: "Multi-Agent Roles",
      desc: "Each agent has a role (lead, backend-dev, frontend-dev, reviewer, researcher, db-admin, tester) that determines its system prompt and MCP tools.",
      code: \`// Agent roles from src/shared/types.ts
type AgentRole =
  | "lead"         // coordinates subtasks
  | "backend-dev"  // API / server code
  | "frontend-dev" // UI code
  | "reviewer"     // code review
  | "researcher"   // information gathering
  | "db-admin"     // database operations
  | "tester";      // test writing\`
    },
    {
      title: "Event-Driven Coordination",
      desc: "All state changes emit events. The manager polls for work, Telegram notifies users, and this dashboard reads the event stream.",
      code: \`// Event types
type EventType =
  | "task_started"  | "task_done"
  | "task_failed"   | "needs_input"
  | "agent_stop"    | "file_changed";

// Events flow: daemon → SQLite → telegram/tui/web\`
    },
    {
      title: "Budget & Cost Tracking",
      desc: "Each daemon tracks cumulative API cost. Configurable per-daemon budget caps prevent runaway spend.",
      code: \`// Config
OW_BUDGET_CAP_USD=10   # per-daemon cap (0=unlimited)
OW_MAX_AGENTS=5        # concurrent agents per daemon
OW_AGENT_TIMEOUT_MS=600000  # 10 min timeout\`
    },
  ];

  const concepts = [
    { title: "DAEMONS", color: "var(--green)", text: "Long-running processes that own a workspace and a set of agents. Each daemon has its own SQLite row tracking PID, status, and cumulative cost. Controlled via Telegram or CLI." },
    { title: "AGENTS", color: "var(--amber)", text: "Individual Claude sessions that execute a single task. Agents have roles, models (haiku/sonnet/opus), and run in auto or hybrid exec mode. Results are stored in the tasks table." },
    { title: "MANAGER", color: "var(--purple)", text: "Central scheduler that polls the database for pending tasks and idle daemons. Assigns work, monitors timeouts, and handles the task lifecycle (pending → running → done/failed)." },
  ];

  return h(Fragment, null,
    h(ArchDiagram, null),
    h("div", { style: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16, marginBottom: 20 } },
      patterns.map((card, i) =>
        h("div", { key: i, style: { background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 12, padding: 20 } },
          h("div", { style: { fontSize: 14, fontWeight: 700, marginBottom: 6 } }, card.title),
          h("div", { style: { fontSize: 12, color: "var(--text-muted)", marginBottom: 14, lineHeight: 1.5 } }, card.desc),
          h("pre", { style: { background: "var(--bg)", borderRadius: 8, padding: 14, fontSize: 11, fontFamily: "var(--mono)", color: "var(--cyan)", overflow: "auto", lineHeight: 1.6, border: "1px solid var(--border)" } }, card.code)
        )
      )
    ),
    h("div", { style: { background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 12, padding: 20 } },
      h("div", { style: { fontSize: 14, fontWeight: 700, marginBottom: 14 } }, "Key Concepts"),
      h("div", { style: { display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 16, fontSize: 12, color: "var(--text-muted)", lineHeight: 1.7 } },
        concepts.map((c, i) =>
          h("div", { key: i },
            h("div", { style: { color: c.color, fontWeight: 700, fontFamily: "var(--mono)", fontSize: 11, marginBottom: 4 } }, c.title),
            c.text
          )
        )
      )
    )
  );
}

function AboutTab() {
  const card = (title, children) =>
    h("div", { style: { background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 12, padding: "28px 32px" } },
      title && h("div", { style: { fontSize: 16, fontWeight: 700, marginBottom: 14 } }, title),
      children
    );

  const p = (text) =>
    h("p", { style: { fontSize: 14, color: "var(--text-muted)", lineHeight: 1.8, marginBottom: 12 } }, text);

  return h("div", { style: { display: "flex", flexDirection: "column", gap: 20, maxWidth: 800 } },

    card(null,
      h(Fragment, null,
        h("div", { style: { fontSize: 28, fontWeight: 800, marginBottom: 4 } }, "⚡ Overwatch"),
        h("div", { style: { fontSize: 14, color: "var(--accent)", fontFamily: "var(--mono)", marginBottom: 20 } }, "AI agent system"),
        p("Overwatch is a system that runs multiple AI agents in the background, coordinates their work, and lets you monitor everything from Telegram, a terminal, or this dashboard."),
        p("Think of it like a project manager for AI. You give it a goal — like \\"build a payment feature\\" or \\"research our competitors\\" — and it breaks that goal into tasks, assigns each task to a specialized agent (a backend dev, a researcher, a reviewer), and runs them all in parallel. You watch the progress and step in when needed."),
      )
    ),

    card("Why it exists",
      h(Fragment, null,
        p("Running one AI agent is easy. Running five at once on a real codebase — keeping them coordinated, on budget, and not stepping on each other — is hard. Overwatch handles the hard parts:"),
        h("ul", { style: { fontSize: 14, color: "var(--text-muted)", lineHeight: 2, paddingLeft: 20, marginBottom: 8 } },
          h("li", null, "Breaks big goals into smaller tasks automatically"),
          h("li", null, "Assigns the right agent role and model to each task"),
          h("li", null, "Tracks costs so you don't blow your API budget"),
          h("li", null, "Notifies you on Telegram when something needs your attention"),
          h("li", null, "Keeps a full event log of everything every agent does"),
        ),
        p("It runs on a single machine — no Kubernetes, no cloud services, just Node.js and SQLite. The whole thing is one npm install away."),
      )
    ),

    card("How it works",
      h(Fragment, null,
        p("Overwatch has a few moving parts, all started from a single launch command:"),
        h("div", { style: { display: "grid", gridTemplateColumns: "100px 1fr", gap: "8px 16px", fontSize: 13, marginTop: 8, marginBottom: 12 } },
          h("span", { style: { fontFamily: "var(--mono)", color: "var(--green)", fontWeight: 600 } }, "Manager"),
          h("span", { style: { color: "var(--text-muted)" } }, "The scheduler. Polls the database for pending tasks and assigns them to idle daemons."),
          h("span", { style: { fontFamily: "var(--mono)", color: "var(--amber)", fontWeight: 600 } }, "Daemons"),
          h("span", { style: { color: "var(--text-muted)" } }, "Worker processes. Each daemon owns a workspace and runs agents (Claude sessions) to complete tasks."),
          h("span", { style: { fontFamily: "var(--mono)", color: "var(--cyan)", fontWeight: 600 } }, "Telegram"),
          h("span", { style: { color: "var(--text-muted)" } }, "Bot interface. Create daemons, submit work, get notified — all from your phone."),
          h("span", { style: { fontFamily: "var(--mono)", color: "var(--purple)", fontWeight: 600 } }, "Dashboard"),
          h("span", { style: { color: "var(--text-muted)" } }, "This page. A live view of all daemons, agents, and events, refreshed every 2 seconds."),
          h("span", { style: { fontFamily: "var(--mono)", color: "var(--text)", fontWeight: 600 } }, "TUI"),
          h("span", { style: { color: "var(--text-muted)" } }, "Terminal UI for when you'd rather stay in the shell."),
        ),
        p("Everything shares a single SQLite database. No message queues, no Redis, no microservices. Just files on disk."),
      )
    ),

    card("Built by",
      h(Fragment, null,
        h("p", { style: { fontSize: 14, color: "var(--text-muted)", lineHeight: 1.8, marginBottom: 12 } },
          "Overwatch is built by ",
          h("a", { href: "https://www.linkedin.com/in/amitdeshmukh/", target: "_blank", style: { color: "var(--accent)", textDecoration: "none" } }, "Amit Deshmukh"),
          " (",
          h("a", { href: "https://x.com/amitdeshmukh", target: "_blank", style: { color: "var(--accent)", textDecoration: "none" } }, "@amitdeshmukh"),
          ") and Claude — yes, the AI. The whole project, including this dashboard, was pair-programmed with Claude Code."
        ),
        p("The agents it coordinates are powered by Anthropic's Claude, via the Claude Agent SDK."),
      )
    ),
  );
}

function ConfigTab() {
  return h("div", { style: { display: "flex", flexDirection: "column", gap: 16 } },
    // Telegram setup
    h("div", { style: { background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 12, padding: 20 } },
      h("div", { style: { fontSize: 14, fontWeight: 700, marginBottom: 14 } }, "Setting up Telegram"),
      h("div", { style: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: 20 } },
        h("div", null,
          h("div", { style: { fontSize: 12, fontWeight: 600, color: "var(--accent)", marginBottom: 8 } }, "Getting your bot token"),
          h("ol", { style: { fontSize: 12, color: "var(--text-muted)", lineHeight: 2, paddingLeft: 18 } },
            h("li", null, "Open Telegram and search for @BotFather"),
            h("li", null, "Send /newbot to create a new bot"),
            h("li", null, "Follow the prompts to set a name and username"),
            h("li", null, h("span", null, "Copy the token (looks like ", h("code", { style: { fontFamily: "var(--mono)", color: "var(--cyan)", fontSize: 11 } }, "123456:ABC-DEF..."), ") into ", h("code", { style: { fontFamily: "var(--mono)", color: "var(--cyan)", fontSize: 11 } }, "OW_TELEGRAM_TOKEN")))
          )
        ),
        h("div", null,
          h("div", { style: { fontSize: 12, fontWeight: 600, color: "var(--accent)", marginBottom: 8 } }, "Setting allowed users"),
          h("ol", { style: { fontSize: 12, color: "var(--text-muted)", lineHeight: 2, paddingLeft: 18 } },
            h("li", null, "Your Telegram username is the @handle in your profile"),
            h("li", null, h("span", null, "Add it to ", h("code", { style: { fontFamily: "var(--mono)", color: "var(--cyan)", fontSize: 11 } }, "OW_ALLOWED_USERS"), " without the @")),
            h("li", null, "Comma-separate multiple usernames (e.g. alice,bob)"),
            h("li", null, "Leave empty to reject all messages (safe default)")
          )
        )
      )
    ),
    // Environment variables
    h("div", { style: { background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 12, padding: 20 } },
      h("div", { style: { fontSize: 14, fontWeight: 700, marginBottom: 14 } }, "Environment Variables"),
      h("pre", { style: { background: "var(--bg)", borderRadius: 8, padding: 18, fontSize: 11, fontFamily: "var(--mono)", color: "var(--text)", overflow: "auto", lineHeight: 1.7, border: "1px solid var(--border)" } },
\`# .env — Overwatch configuration
ANTHROPIC_API_KEY=sk-ant-...        # Required: Claude API key
OW_TELEGRAM_TOKEN=...              # Required: Telegram bot token
OW_DB_PATH=~/.overwatch/overwatch.db # SQLite database location
OW_WORKSPACES_DIR=~/.overwatch/workspaces
OW_LOG_DIR=~/.overwatch/logs
OW_PID_DIR=~/.overwatch/pids

# Agent configuration
OW_MODEL=sonnet                    # Default model: haiku | sonnet | opus
OW_MAX_AGENTS=5                    # Max concurrent agents per daemon
OW_AGENT_TIMEOUT_MS=600000         # Agent timeout (10 min default)
OW_POLL_INTERVAL_MS=2000           # Daemon poll interval

# Access control
OW_ALLOWED_USERS=alice,bob         # Telegram usernames without @ (empty = reject all)
OW_BUDGET_CAP_USD=0                # Per-daemon budget cap (0 = unlimited)

# Web dashboard
OW_WEB_PORT=7777                   # Dashboard HTTP port\`)
    ),
    // Database schema
    h("div", { style: { background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 12, padding: 20 } },
      h("div", { style: { fontSize: 14, fontWeight: 700, marginBottom: 14 } }, "Database Schema (SQLite, WAL mode)"),
      h("pre", { style: { background: "var(--bg)", borderRadius: 8, padding: 18, fontSize: 11, fontFamily: "var(--mono)", color: "var(--text)", overflow: "auto", lineHeight: 1.7, border: "1px solid var(--border)" } },
\`-- Core tables (schema v3)

daemons (
  id TEXT PK,    name TEXT UNIQUE,   pid INTEGER,
  status TEXT,   chat_id TEXT,       total_cost_usd REAL,
  tmux_session TEXT,  created_at TEXT,  updated_at TEXT
)

tasks (
  id TEXT PK,        daemon_id TEXT FK,  parent_id TEXT FK,
  title TEXT,        prompt TEXT,        status TEXT,
  exec_mode TEXT,    agent_role TEXT,    agent_model TEXT,
  agent_session_id TEXT,  deps TEXT,     result TEXT,
  created_at TEXT,   updated_at TEXT
)

events (
  id INTEGER PK,  daemon_id TEXT FK,  task_id TEXT FK,
  type TEXT,       payload TEXT,       notified INTEGER,
  created_at TEXT
)

commands (
  id INTEGER PK,  daemon_id TEXT FK,  type TEXT,
  payload TEXT,    handled INTEGER,    created_at TEXT
)\`)
    ),
    // Launch
    h("div", { style: { background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 12, padding: 20 } },
      h("div", { style: { fontSize: 14, fontWeight: 700, marginBottom: 14 } }, "Launch"),
      h("pre", { style: { background: "var(--bg)", borderRadius: 8, padding: 18, fontSize: 11, fontFamily: "var(--mono)", color: "var(--text)", overflow: "auto", lineHeight: 1.7, border: "1px solid var(--border)" } },
\`npm run build && npm start    # build and start all components\`)
    )
  );
}

// --- Main App ---

function App() {
  const [state, setState] = useState({ daemons: [], events: [], cronTriggers: [], traces: [] });
  const [expanded, setExpanded] = useState({});
  const [activeTab, setActiveTab] = useState("dashboard");
  const [error, setError] = useState(null);
  const [lastUpdate, setLastUpdate] = useState(null);

  useEffect(() => {
    let active = true;
    async function poll() {
      try {
        const res = await fetch("/api/state");
        if (!res.ok) throw new Error("HTTP " + res.status);
        const data = await res.json();
        if (active) {
          setState(data);
          setError(null);
          setLastUpdate(new Date().toLocaleTimeString());
        }
      } catch (e) {
        if (active) setError(e.message);
      }
    }
    poll();
    const id = setInterval(poll, 2000);
    return () => { active = false; clearInterval(id); };
  }, []);

  // Auto-expand first two daemons on initial load
  useEffect(() => {
    if (state.daemons.length > 0 && Object.keys(expanded).length === 0) {
      const init = {};
      state.daemons.slice(0, 2).forEach(d => { init[d.id] = true; });
      setExpanded(init);
    }
  }, [state.daemons.length]);

  const toggleDaemon = (id) => {
    setExpanded(prev => ({ ...prev, [id]: !prev[id] }));
  };

  const tabs = ["dashboard", "architecture", "config", "about"];

  return h("div", { style: { minHeight: "100vh", background: "var(--bg)", color: "var(--text)", fontFamily: "var(--sans)" } },
    // Header
    h("div", {
      style: {
        borderBottom: "1px solid var(--border)", padding: "16px 32px",
        display: "flex", justifyContent: "space-between", alignItems: "center",
        background: "rgba(17,24,39,0.8)", backdropFilter: "blur(12px)",
        position: "sticky", top: 0, zIndex: 10,
      }
    },
      h("div", { style: { display: "flex", alignItems: "center", gap: 12 } },
        h("span", { style: { fontSize: 20, fontWeight: 800, letterSpacing: -0.5 } }, "⚡ Overwatch"),

        error && h("span", { style: { fontSize: 11, fontFamily: "var(--mono)", color: "var(--red)", marginLeft: 12 } }, "⚠ " + error),
        lastUpdate && !error && h("span", { style: { fontSize: 10, fontFamily: "var(--mono)", color: "var(--text-dim)", marginLeft: 12 } }, "Updated " + lastUpdate)
      ),
      h("div", { style: { display: "flex", gap: 4 } },
        tabs.map(tab =>
          h("button", {
            key: tab,
            onClick: () => setActiveTab(tab),
            style: {
              background: activeTab === tab ? "var(--accent-glow)" : "transparent",
              color: activeTab === tab ? "var(--accent)" : "var(--text-muted)",
              border: "none", borderRadius: 6, padding: "6px 14px",
              fontSize: 12, fontFamily: "var(--mono)", fontWeight: 600, cursor: "pointer",
              textTransform: "capitalize",
            }
          }, tab)
        )
      )
    ),

    // Content
    h("div", { style: { padding: "24px 32px", maxWidth: 1200, margin: "0 auto" } },
      activeTab === "dashboard" && h(Fragment, null,
        h(StatsBar, { daemons: state.daemons, cronTriggers: state.cronTriggers }),
        h(CronPanel, { cronTriggers: state.cronTriggers }),
        h("div", { style: { display: "flex", flexDirection: "column", gap: 16, marginBottom: 20 } },
          state.daemons.length === 0
            ? h("div", { style: { background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 12, padding: "40px 20px", textAlign: "center", color: "var(--text-dim)", fontSize: 13 } }, "No daemons found. Start a daemon to see it here.")
            : state.daemons.map(d =>
                h(DaemonCard, { key: d.id, daemon: d, events: state.events, traces: state.traces, cronTriggers: state.cronTriggers, expanded: !!expanded[d.id], onToggle: () => toggleDaemon(d.id) })
              )
        ),
        h(LogPanel, { events: state.events })
      ),
      activeTab === "architecture" && h(ArchTab, null),
      activeTab === "config" && h(ConfigTab, null),
      activeTab === "about" && h(AboutTab, null)
    )
  );
}

createRoot(document.getElementById("root")).render(h(App));
  </script>
</body>
</html>`;
}
