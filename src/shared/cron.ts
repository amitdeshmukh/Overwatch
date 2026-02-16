type CronField = {
  any: boolean;
  values: Set<number>;
};

type CronSpec = {
  minute: CronField;
  hour: CronField;
  dayOfMonth: CronField;
  month: CronField;
  dayOfWeek: CronField;
};

function parseField(
  raw: string,
  min: number,
  max: number
): CronField | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  if (trimmed === "*") {
    return { any: true, values: new Set() };
  }

  const values = new Set<number>();
  for (const token of trimmed.split(",")) {
    const part = token.trim();
    if (!part) return null;

    if (part.startsWith("*/")) {
      const step = Number.parseInt(part.slice(2), 10);
      if (!Number.isFinite(step) || step <= 0) return null;
      for (let v = min; v <= max; v += step) values.add(v);
      continue;
    }

    const value = Number.parseInt(part, 10);
    if (!Number.isFinite(value) || value < min || value > max) {
      return null;
    }
    values.add(value);
  }

  return { any: false, values };
}

export function parseCronExpr(expr: string): CronSpec | null {
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5) return null;

  const minute = parseField(fields[0], 0, 59);
  const hour = parseField(fields[1], 0, 23);
  const dayOfMonth = parseField(fields[2], 1, 31);
  const month = parseField(fields[3], 1, 12);
  const dayOfWeek = parseField(fields[4], 0, 6);

  if (!minute || !hour || !dayOfMonth || !month || !dayOfWeek) {
    return null;
  }

  return { minute, hour, dayOfMonth, month, dayOfWeek };
}

function matchesField(field: CronField, value: number): boolean {
  return field.any || field.values.has(value);
}

function matchesCron(spec: CronSpec, date: Date): boolean {
  const minute = date.getUTCMinutes();
  const hour = date.getUTCHours();
  const dayOfMonth = date.getUTCDate();
  const month = date.getUTCMonth() + 1;
  const dayOfWeek = date.getUTCDay();

  if (!matchesField(spec.minute, minute)) return false;
  if (!matchesField(spec.hour, hour)) return false;
  if (!matchesField(spec.month, month)) return false;

  const domMatch = matchesField(spec.dayOfMonth, dayOfMonth);
  const dowMatch = matchesField(spec.dayOfWeek, dayOfWeek);

  // Cron semantics: if both DOM and DOW are restricted, either can match.
  if (!spec.dayOfMonth.any && !spec.dayOfWeek.any) {
    return domMatch || dowMatch;
  }
  return domMatch && dowMatch;
}

/**
 * Compute the next UTC minute matching a 5-field cron expression.
 * Supports wildcard, step, numeric, and comma-list tokens.
 */
export function nextCronRun(expr: string, from: Date): Date | null {
  const spec = parseCronExpr(expr);
  if (!spec) return null;

  const cursor = new Date(from.getTime());
  cursor.setUTCSeconds(0, 0);
  cursor.setUTCMinutes(cursor.getUTCMinutes() + 1);

  const maxLookaheadMinutes = 60 * 24 * 366; // 1 year
  for (let i = 0; i < maxLookaheadMinutes; i++) {
    if (matchesCron(spec, cursor)) {
      return new Date(cursor.getTime());
    }
    cursor.setUTCMinutes(cursor.getUTCMinutes() + 1);
  }

  return null;
}
