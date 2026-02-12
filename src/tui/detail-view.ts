import React from "react";
import { Box, Text } from "ink";

interface DetailViewProps {
  title: string;
  body: string;
}

export function DetailView({ title, body }: DetailViewProps): React.ReactElement {
  return React.createElement(
    Box,
    { flexDirection: "column", padding: 1 },
    React.createElement(
      Text,
      { bold: true, underline: true },
      title
    ),
    React.createElement(Text, null, ""),
    ...body.split("\n").map((line, i) =>
      React.createElement(Text, { key: i }, line)
    )
  );
}
