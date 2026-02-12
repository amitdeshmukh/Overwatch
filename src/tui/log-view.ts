import React, { useState, useEffect } from "react";
import { Box, Text } from "ink";
import { getRecentEvents } from "../db/queries.js";
import type { EventRow } from "../shared/types.js";

interface LogViewProps {
  daemonId: string;
  maxLines: number;
  selectedEventId?: number | null;
  onEventCount?: (count: number) => void;
}

export function LogView({ daemonId, maxLines, selectedEventId, onEventCount }: LogViewProps): React.ReactElement {
  const [events, setEvents] = useState<EventRow[]>([]);

  useEffect(() => {
    const refresh = () => {
      const fetched = getRecentEvents(daemonId, maxLines);
      setEvents(fetched);
      if (onEventCount) {
        onEventCount(fetched.length);
      }
    };
    refresh();
    const timer = setInterval(refresh, 2000);
    return () => clearInterval(timer);
  }, [daemonId, maxLines]);

  const colorForType = (type: string): string => {
    switch (type) {
      case "task_done": return "green";
      case "task_failed": return "red";
      case "task_started": return "blue";
      case "needs_input": return "yellow";
      default: return "gray";
    }
  };

  // Events come in DESC order from query; reverse to show oldest first
  const displayEvents = [...events].reverse();

  return React.createElement(
    Box,
    { flexDirection: "column", padding: 1 },
    React.createElement(
      Text,
      { bold: true, underline: true },
      "Events"
    ),
    ...displayEvents.map((event) => {
      const isSelected = selectedEventId === event.id;
      return React.createElement(
        Box,
        { key: event.id },
        React.createElement(
          Text,
          { color: isSelected ? "cyan" : "gray", bold: isSelected },
          `${isSelected ? ">" : " "} ${event.created_at.slice(11, 19)} `
        ),
        React.createElement(
          Text,
          { color: isSelected ? "cyan" : colorForType(event.type), bold: isSelected },
          `[${event.type}] `
        ),
        React.createElement(
          Text,
          { color: isSelected ? "cyan" : undefined, bold: isSelected },
          event.task_id?.slice(0, 8) ?? ""
        )
      );
    })
  );
}
