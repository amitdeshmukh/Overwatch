import React from "react";
import { Box, Text } from "ink";
import { getChildTasks } from "../db/queries.js";
import type { TaskRow, TaskStatus } from "../shared/types.js";

export function flattenTaskTree(task: TaskRow): string[] {
  const result: string[] = [task.id];
  const children = getChildTasks(task.id);
  for (const child of children) {
    result.push(...flattenTaskTree(child));
  }
  return result;
}

const STATUS_STYLE: Record<TaskStatus, { icon: string; color: string }> = {
  pending: { icon: "[ ]", color: "gray" },
  blocked: { icon: "[~]", color: "yellow" },
  running: { icon: "[*]", color: "blue" },
  done: { icon: "[+]", color: "green" },
  failed: { icon: "[x]", color: "red" },
};

interface TaskNodeProps {
  task: TaskRow;
  depth: number;
  selected: boolean;
  selectedTaskId: string | null;
}

function TaskNode({ task, depth, selected, selectedTaskId }: TaskNodeProps): React.ReactElement {
  const style = STATUS_STYLE[task.status as TaskStatus] ?? STATUS_STYLE.pending;
  const prefix = depth > 0 ? "  ".repeat(depth - 1) + "├─" : "";
  const children = getChildTasks(task.id);

  return React.createElement(
    Box,
    { flexDirection: "column" },
    React.createElement(
      Box,
      null,
      React.createElement(
        Text,
        { color: selected ? "cyan" : undefined, bold: selected },
        `${prefix}${style.icon} `
      ),
      React.createElement(
        Text,
        { color: style.color, bold: task.status === "running" },
        task.title
      ),
      task.agent_model
        ? React.createElement(Text, { color: "gray" }, ` (${task.agent_model})`)
        : null
    ),
    ...children.map((child) =>
      React.createElement(TaskNode, {
        key: child.id,
        task: child,
        depth: depth + 1,
        selected: child.id === selectedTaskId,
        selectedTaskId,
      })
    )
  );
}

interface TreeViewProps {
  rootTask: TaskRow | null;
  selectedTaskId: string | null;
}

export function TreeView({ rootTask, selectedTaskId }: TreeViewProps): React.ReactElement {
  if (!rootTask) {
    return React.createElement(
      Box,
      { padding: 1 },
      React.createElement(Text, { color: "gray" }, "No tasks")
    );
  }

  return React.createElement(
    Box,
    { flexDirection: "column", paddingX: 1 },
    React.createElement(TaskNode, {
      task: rootTask,
      depth: 0,
      selected: rootTask.id === selectedTaskId,
      selectedTaskId,
    })
  );
}
