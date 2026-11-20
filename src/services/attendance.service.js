const KARACHI_TIME_ZONE = "Asia/Karachi";
const KARACHI_OFFSET_MINUTES = 5 * 60;

function karachiParts(value = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: KARACHI_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(value);
  return Object.fromEntries(parts.map(({ type, value: part }) => [type, part]));
}

export function karachiDate(value = new Date()) {
  const parts = karachiParts(value);
  return `${parts.year}-${parts.month}-${parts.day}`;
}

export function karachiDateTime(value = new Date()) {
  const parts = karachiParts(value);
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second}`;
}

export function validAttendanceDate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

export function validAttendanceTime(value) {
  return typeof value === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(value);
}

export function buildAttendanceRange(date, checkInTime, checkOutTime = null) {
  if (!validAttendanceDate(date)) throw new TypeError("date must be a valid YYYY-MM-DD value");
  if (!validAttendanceTime(checkInTime)) throw new TypeError("check-in time must use HH:MM (24h)");
  if (checkOutTime !== null && !validAttendanceTime(checkOutTime)) {
    throw new TypeError("check-out time must use HH:MM (24h)");
  }
  const checkInAt = `${date} ${checkInTime}:00`;
  if (!checkOutTime) return { checkInAt, checkOutAt: null };
  if (checkOutTime === checkInTime) {
    throw new TypeError("check-out time must be after check-in and within 24 hours");
  }
  const checkOutDate = checkOutTime < checkInTime ? addDays(date, 1) : date;
  return { checkInAt, checkOutAt: `${checkOutDate} ${checkOutTime}:00` };
}

function addDays(date, days) {
  const [year, month, day] = date.split("-").map(Number);
  const result = new Date(Date.UTC(year, month - 1, day + days));
  return `${result.getUTCFullYear()}-${String(result.getUTCMonth() + 1).padStart(2, "0")}-${String(result.getUTCDate()).padStart(2, "0")}`;
}

function wallClockEpoch(value) {
  if (value instanceof Date) {
    const parts = karachiParts(value);
    value = `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second}`;
  }
  const match = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec(String(value ?? ""));
  if (!match) return NaN;
  const [, year, month, day, hour, minute, second] = match.map(Number);
  return Date.UTC(year, month - 1, day, hour, minute, second) - KARACHI_OFFSET_MINUTES * 60_000;
}

export function attendanceMetrics({
  checkInAt,
  checkOutAt,
  breakDurationMinutes = 0,
  shiftDurationMinutes = null,
}) {
  if (!checkInAt || !checkOutAt) {
    return { elapsed_minutes: null, worked_minutes: null, regular_minutes: null, overtime_minutes: null };
  }
  const elapsedMilliseconds = wallClockEpoch(checkOutAt) - wallClockEpoch(checkInAt);
  const breakMinutes = Number(breakDurationMinutes);
  if (!Number.isFinite(elapsedMilliseconds) || elapsedMilliseconds <= 0) {
    throw new TypeError("check-out must be later than check-in");
  }
  if (!Number.isInteger(breakMinutes) || breakMinutes < 0 || breakMinutes > 1440) {
    throw new TypeError("break duration must be a whole number between 0 and 1440 minutes");
  }
  const elapsedMinutes = Math.floor(elapsedMilliseconds / 60_000);
  if (breakMinutes > elapsedMinutes) {
    throw new TypeError("break duration cannot exceed elapsed attendance time");
  }
  const workedMinutes = elapsedMinutes - breakMinutes;
  const shiftMinutes = shiftDurationMinutes === null ? null : Number(shiftDurationMinutes);
  if (shiftMinutes !== null && (!Number.isInteger(shiftMinutes) || shiftMinutes <= 0)) {
    throw new TypeError("configured shift duration must be a positive whole number of minutes");
  }
  return {
    elapsed_minutes: elapsedMinutes,
    worked_minutes: workedMinutes,
    regular_minutes: shiftMinutes === null ? null : Math.min(workedMinutes, shiftMinutes),
    overtime_minutes: shiftMinutes === null ? null : Math.max(0, workedMinutes - shiftMinutes),
  };
}

export function attendanceDurationForShift(startTime, endTime) {
  const timePattern = /^([01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?$/;
  if (!timePattern.test(String(startTime ?? "")) || !timePattern.test(String(endTime ?? ""))) return null;
  const minutes = (value) => {
    const [hour, minute] = value.split(":").map(Number);
    return hour * 60 + minute;
  };
  const start = minutes(startTime);
  const end = minutes(endTime);
  const duration = (end - start + 1440) % 1440;
  return duration > 0 ? duration : null;
}
