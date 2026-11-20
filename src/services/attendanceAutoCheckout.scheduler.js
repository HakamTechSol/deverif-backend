import { pool } from "../config/db.js";
import {
  attendanceDurationForShift,
  attendanceMetrics,
  buildAttendanceRange,
  karachiDate,
  karachiDateTime,
} from "./attendance.service.js";

export async function autoCheckoutOpenAttendance() {
  const today = karachiDate();
  const now = karachiDateTime();
  const [rows] = await pool.query(
    `SELECT ar.id, DATE_FORMAT(ar.check_in_at, '%Y-%m-%d %H:%i:%s') AS check_in_at,
            ar.break_duration_minutes, DATE_FORMAT(ar.date, '%Y-%m-%d') AS date,
            ps.shift_start_time, ps.shift_end_time
       FROM attendance_records ar
       JOIN organization_payroll_settings ps ON ps.organization_id=ar.organization_id
      WHERE ar.date <= ?
        AND ar.check_in_at IS NOT NULL
        AND ar.check_out_at IS NULL
        AND ar.status='checked_in'
      ORDER BY ar.date ASC, ar.id ASC`,
    [today],
  );

  let affectedRows = 0;
  for (const row of rows) {
    const date = String(row.date).slice(0, 10);
    const checkInAt = String(row.check_in_at).replace("T", " ").slice(0, 19);
    const startTime = String(row.shift_start_time).slice(0, 5);
    const endTime = String(row.shift_end_time).slice(0, 5);
    const shift = buildAttendanceRange(date, startTime, endTime);
    if (!shift.checkOutAt || shift.checkOutAt > now || checkInAt >= shift.checkOutAt) continue;

    const metrics = attendanceMetrics({
      checkInAt,
      checkOutAt: shift.checkOutAt,
      breakDurationMinutes: row.break_duration_minutes ?? 0,
      shiftDurationMinutes: attendanceDurationForShift(startTime, endTime),
    });
    const [result] = await pool.query(
      `UPDATE attendance_records
          SET check_out_at=?, status='checked_out', checkout_source='auto',
              worked_minutes=?, overtime_minutes=?
        WHERE id=? AND check_out_at IS NULL AND status='checked_in'`,
      [shift.checkOutAt, metrics.worked_minutes, metrics.overtime_minutes, row.id],
    );
    affectedRows += Number(result.affectedRows) || 0;
  }
  return affectedRows;
}
