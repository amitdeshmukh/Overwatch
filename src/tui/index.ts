import React, { useState, useEffect, useCallback } from "react";
import { render, Box, Text, useApp, useInput } from "ink";
import { getDb, closeDb } from "../db/index.js";
import {
  listDaemons,
  getRootTask,
  getTasksByDaemon,
  getTask,
  getRecentEvents,
} from "../db/queries.js";
import { TreeView, flattenTaskTree } from "./tree-view.js";
import { LogView } from "./log-view.js";
import { DetailView } from "./detail-view.js";
import type { DaemonRow, TaskRow, EventRow } from "../shared/types.js";

type FocusPanel = "daemons" | "tasks" | "events";

interface DetailContent {
  title: string;
  body: string;
}

interface AppProps {
  initialDaemon?: string;
}

function App({ initialDaemon }: AppProps): React.ReactElement {
  const { exit } = useApp();
  const [daemons, setDaemons] = useState<DaemonRow[]>([]);
  const [selectedDaemon, setSelectedDaemon] = useState<string | null>(
    initialDaemon ?? null
  );
  const [rootTask, setRootTask] = useState<TaskRow | null>(null);
  const [taskCount, setTaskCount] = useState({ done: 0, total: 0 });
  const [tick, setTick] = useState(0);

  // New state for navigation
  const [focusPanel, setFocusPanel] = useState<FocusPanel>("daemons");
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [selectedEventIdx, setSelectedEventIdx] = useState<number>(0);
  const [detailContent, setDetailContent] = useState<DetailContent | null>(null);
  const [eventCount, setEventCount] = useState(0);

  // Flat list of task IDs for navigation
  const [flatTaskIds, setFlatTaskIds] = useState<string[]>([]);

  // Refresh data
  const refresh = () => {
    const ds = listDaemons();
    setDaemons(ds);

    if (!selectedDaemon && ds.length > 0) {
      setSelectedDaemon(ds[0].name);
    }

    const daemon = ds.find((d) => d.name === selectedDaemon);
    if (daemon) {
      const root = getRootTask(daemon.id);
      setRootTask(root ?? null);
      const tasks = getTasksByDaemon(daemon.id);
      setTaskCount({
        done: tasks.filter((t) => t.status === "done").length,
        total: tasks.length,
      });
      // Build flat task list for navigation
      if (root) {
        setFlatTaskIds(flattenTaskTree(root));
      } else {
        setFlatTaskIds([]);
      }
    } else {
      setRootTask(null);
      setTaskCount({ done: 0, total: 0 });
      setFlatTaskIds([]);
      if (ds.length > 0) {
        setSelectedDaemon(ds[0].name);
      } else {
        setSelectedDaemon(null);
      }
    }
  };

  useEffect(() => {
    refresh();
    const timer = setInterval(() => setTick((t) => t + 1), 2000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    refresh();
  }, [selectedDaemon, tick]);

  const handleEventCount = useCallback((count: number) => {
    setEventCount(count);
  }, []);

  // Build task detail content
  const buildTaskDetail = (taskId: string): DetailContent | null => {
    const task = getTask(taskId);
    if (!task) return null;
    const lines = [
      `Status: ${task.status}  Model: ${task.agent_model ?? "—"}`,
      "",
      "Prompt:",
      task.prompt,
      "",
      "Result:",
      task.result ?? "(no result yet)",
    ];
    return { title: task.title, body: lines.join("\n") };
  };

  // Build event detail content
  const buildEventDetail = (eventId: number): DetailContent | null => {
    const daemon = daemons.find((d) => d.name === selectedDaemon);
    if (!daemon) return null;
    const events = getRecentEvents(daemon.id, 50);
    const event = events.find((e) => e.id === eventId);
    if (!event) return null;
    let payloadStr: string;
    try {
      payloadStr = JSON.stringify(JSON.parse(event.payload), null, 2);
    } catch {
      payloadStr = event.payload;
    }
    const lines = [
      `Time: ${event.created_at}`,
      `Task: ${event.task_id ?? "—"}`,
      "",
      "Payload:",
      payloadStr,
    ];
    return { title: `Event: ${event.type}`, body: lines.join("\n") };
  };

  // Get ordered event IDs for navigation (reversed to match display order: oldest first)
  const getEventIds = (): number[] => {
    const daemon = daemons.find((d) => d.name === selectedDaemon);
    if (!daemon) return [];
    const events = getRecentEvents(daemon.id, 30);
    return [...events].reverse().map((e) => e.id);
  };

  // Keyboard input
  useInput((input, key) => {
    if (input === "q") {
      exit();
      return;
    }
    if (input === "r") {
      refresh();
      return;
    }

    // Esc clears detail view
    if (key.escape) {
      if (detailContent) {
        setDetailContent(null);
        return;
      }
    }

    // Tab cycles focus
    if (key.tab) {
      setFocusPanel((prev) => {
        if (prev === "daemons") return "tasks";
        if (prev === "tasks") return "events";
        return "daemons";
      });
      return;
    }

    // Navigation within focused panel
    if (input === "j" || key.downArrow) {
      if (focusPanel === "daemons") {
        const idx = daemons.findIndex((d) => d.name === selectedDaemon);
        if (idx < daemons.length - 1) {
          setSelectedDaemon(daemons[idx + 1].name);
        }
      } else if (focusPanel === "tasks") {
        if (flatTaskIds.length === 0) return;
        const idx = selectedTaskId ? flatTaskIds.indexOf(selectedTaskId) : -1;
        if (idx < flatTaskIds.length - 1) {
          setSelectedTaskId(flatTaskIds[idx + 1]);
        }
      } else if (focusPanel === "events") {
        const eventIds = getEventIds();
        if (eventIds.length === 0) return;
        if (selectedEventIdx < eventIds.length - 1) {
          setSelectedEventIdx(selectedEventIdx + 1);
        }
      }
      return;
    }

    if (input === "k" || key.upArrow) {
      if (focusPanel === "daemons") {
        const idx = daemons.findIndex((d) => d.name === selectedDaemon);
        if (idx > 0) {
          setSelectedDaemon(daemons[idx - 1].name);
        }
      } else if (focusPanel === "tasks") {
        if (flatTaskIds.length === 0) return;
        const idx = selectedTaskId ? flatTaskIds.indexOf(selectedTaskId) : 0;
        if (idx > 0) {
          setSelectedTaskId(flatTaskIds[idx - 1]);
        }
      } else if (focusPanel === "events") {
        if (selectedEventIdx > 0) {
          setSelectedEventIdx(selectedEventIdx - 1);
        }
      }
      return;
    }

    // Enter shows detail
    if (key.return) {
      if (focusPanel === "tasks" && selectedTaskId) {
        const detail = buildTaskDetail(selectedTaskId);
        if (detail) setDetailContent(detail);
      } else if (focusPanel === "events") {
        const eventIds = getEventIds();
        if (eventIds.length > 0 && selectedEventIdx < eventIds.length) {
          const detail = buildEventDetail(eventIds[selectedEventIdx]);
          if (detail) setDetailContent(detail);
        }
      }
      return;
    }
  });

  const daemon = daemons.find((d) => d.name === selectedDaemon);

  // Get selected event ID for highlighting
  const eventIds = getEventIds();
  const selectedEventId = focusPanel === "events" && eventIds.length > 0
    ? eventIds[selectedEventIdx] ?? null
    : null;

  // Footer text based on focus and detail state
  let footerText: string;
  if (detailContent) {
    footerText = "[esc] back  [q]uit";
  } else if (focusPanel === "daemons") {
    footerText = "[tab] switch panel  [j/k] select daemon  [r]efresh  [q]uit";
  } else if (focusPanel === "tasks") {
    footerText = "[tab] switch panel  [j/k] navigate  [enter] view detail  [r]efresh  [q]uit";
  } else {
    footerText = "[tab] switch panel  [j/k] navigate  [enter] view detail  [r]efresh  [q]uit";
  }

  // Focus indicator for panel headers
  const daemonFocus = focusPanel === "daemons" ? " *" : "";
  const taskFocus = focusPanel === "tasks" ? " *" : "";

  return React.createElement(
    Box,
    { flexDirection: "column", width: "100%" },
    // Header
    React.createElement(
      Box,
      { borderStyle: "single", paddingX: 1 },
      React.createElement(Text, { bold: true }, "ORCHESTRATOR OVERWATCH"),
      React.createElement(
        Text,
        { color: "gray" },
        `  ${daemons.length} daemon(s)`
      )
    ),
    // Main content
    React.createElement(
      Box,
      { flexDirection: "row", flexGrow: 1 },
      // Left panel: daemon list + task tree
      React.createElement(
        Box,
        {
          flexDirection: "column",
          width: "50%",
          borderStyle: "single",
        },
        // Daemon list
        React.createElement(
          Box,
          { flexDirection: "column", paddingX: 1 },
          React.createElement(
            Text,
            { bold: true, underline: true },
            `Daemons${daemonFocus}`
          ),
          ...daemons.map((d) => {
            const icon =
              d.status === "running"
                ? "*"
                : d.status === "idle"
                  ? "o"
                  : "!";
            const isSelected = d.name === selectedDaemon;
            const cost =
              d.total_cost_usd > 0
                ? ` $${d.total_cost_usd.toFixed(2)}`
                : "";
            const pid = d.pid ? ` [${d.pid}]` : "";
            const pointer = focusPanel === "daemons" && isSelected ? ">" : " ";
            return React.createElement(
              Text,
              {
                key: d.id,
                color: isSelected ? "cyan" : undefined,
                bold: isSelected,
              },
              `${pointer} ${icon} ${d.name} (${d.status})${pid}${cost}`
            );
          })
        ),
        // Task tree
        React.createElement(
          Box,
          { flexDirection: "column" },
          React.createElement(
            Box,
            { paddingX: 1 },
            React.createElement(
              Text,
              { bold: true, underline: true },
              `Task Tree${taskFocus}`
            )
          ),
          React.createElement(TreeView, {
            rootTask,
            selectedTaskId: focusPanel === "tasks" ? selectedTaskId : null,
          })
        )
      ),
      // Right panel: detail view or logs
      React.createElement(
        Box,
        {
          flexDirection: "column",
          width: "50%",
          borderStyle: "single",
        },
        detailContent
          ? React.createElement(DetailView, {
              title: detailContent.title,
              body: detailContent.body,
            })
          : daemon
            ? React.createElement(LogView, {
                daemonId: daemon.id,
                maxLines: 30,
                selectedEventId: focusPanel === "events" ? selectedEventId : null,
                onEventCount: handleEventCount,
              })
            : React.createElement(
                Box,
                { padding: 1 },
                React.createElement(
                  Text,
                  { color: "gray" },
                  "Select a daemon"
                )
              )
      )
    ),
    // Footer
    React.createElement(
      Box,
      { paddingX: 1 },
      React.createElement(
        Text,
        { color: "gray" },
        footerText
      ),
      taskCount.total > 0
        ? React.createElement(
            Text,
            { color: "gray" },
            `  Tasks: ${taskCount.done}/${taskCount.total}`
          )
        : null
    )
  );
}

function main(): void {
  getDb();

  const args = process.argv.slice(2);
  const initialDaemon = args[0];

  const { unmount } = render(
    React.createElement(App, { initialDaemon })
  );

  process.on("SIGINT", () => {
    unmount();
    closeDb();
    process.exit(0);
  });
}

main();
