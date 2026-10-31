export const CRON_FIELD_COUNT = 5;

export class CronError extends Error {}

const FIELD_SPECS = [
  { name: "minute", min: 0, max: 59 },
  { name: "hour", min: 0, max: 23 },
  { name: "day of month", min: 1, max: 31 },
  { name: "month", min: 1, max: 12 },
  { name: "day of week", min: 0, max: 7 },
];

function parseInteger(raw, field) {
  if (!/^\d{1,2}$/.test(raw)) {
    throw new CronError(`field "${field.name}" has the invalid value "${raw}"`);
  }
  const value = Number(raw);
  if (value < field.min || value > field.max) {
    throw new CronError(
      `field "${field.name}" accepts values from ${field.min} to ${field.max}, got "${raw}"`,
    );
  }
  return value;
}

function parseField(raw, field) {
  const values = new Set();
  let restricted = false;

  for (const part of raw.split(",")) {
    const trimmed = part.trim();
    if (trimmed.length === 0) {
      throw new CronError(`field "${field.name}" has an empty list item`);
    }

    const [rangePart, stepPart, ...extra] = trimmed.split("/");
    if (extra.length > 0 || rangePart === undefined) {
      throw new CronError(`field "${field.name}" has the invalid value "${trimmed}"`);
    }

    let step = 1;
    if (stepPart !== undefined) {
      if (!/^\d{1,2}$/.test(stepPart) || Number(stepPart) === 0) {
        throw new CronError(`field "${field.name}" has the invalid step "${stepPart}"`);
      }
      step = Number(stepPart);
    }

    let start;
    let end;

    if (rangePart === "*") {
      start = field.min;
      end = field.max;
    } else if (rangePart.includes("-")) {
      const [from, to, ...rest] = rangePart.split("-");
      if (rest.length > 0 || from === undefined || to === undefined) {
        throw new CronError(`field "${field.name}" has the invalid range "${rangePart}"`);
      }
      start = parseInteger(from, field);
      end = parseInteger(to, field);
      if (end < start) {
        throw new CronError(`field "${field.name}" has an inverted range "${rangePart}"`);
      }
      restricted = true;
    } else {
      start = parseInteger(rangePart, field);
      end = stepPart === undefined ? start : field.max;
      restricted = true;
    }

    for (let value = start; value <= end; value += step) values.add(value);
  }

  if (values.size === 0) {
    throw new CronError(`field "${field.name}" resolves to no value`);
  }

  return { values: [...values].sort((a, b) => a - b), restricted };
}

export function parseCron(expression) {
  if (typeof expression !== "string") {
    throw new CronError("the cron expression must be a string");
  }

  const fields = expression.trim().split(/\s+/).filter(Boolean);
  if (fields.length !== CRON_FIELD_COUNT) {
    throw new CronError(
      `the cron expression needs ${CRON_FIELD_COUNT} fields, got ${fields.length}`,
    );
  }

  const minute = parseField(fields[0], FIELD_SPECS[0]);
  const hour = parseField(fields[1], FIELD_SPECS[1]);
  const dayOfMonth = parseField(fields[2], FIELD_SPECS[2]);
  const month = parseField(fields[3], FIELD_SPECS[3]);
  const dayOfWeek = parseField(fields[4], FIELD_SPECS[4]);

  const normalizedWeekDays = [...new Set(dayOfWeek.values.map((value) => (value === 7 ? 0 : value)))];

  return {
    minutes: minute.values,
    hours: hour.values,
    daysOfMonth: dayOfMonth.values,
    months: month.values,
    daysOfWeek: normalizedWeekDays.sort((a, b) => a - b),
    dayOfMonthRestricted: dayOfMonth.restricted,
    dayOfWeekRestricted: dayOfWeek.restricted,
  };
}

function smallestGap(values, cycle, wraps) {
  if (values.length < 2) return cycle;

  let smallest = Number.POSITIVE_INFINITY;
  for (let index = 1; index < values.length; index += 1) {
    smallest = Math.min(smallest, values[index] - values[index - 1]);
  }

  if (wraps) {
    smallest = Math.min(smallest, cycle - values[values.length - 1] + values[0]);
  }

  return smallest;
}

export function minimumIntervalMinutes(parsed) {
  if (parsed.minutes.length > 1) {
    return smallestGap(parsed.minutes, 60, parsed.hours.length > 1);
  }
  if (parsed.hours.length > 1) {
    return smallestGap(parsed.hours, 24, true) * 60;
  }
  return 24 * 60;
}
