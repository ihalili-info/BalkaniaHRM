import type { AttendanceEventInput, AttendanceSession } from "./domain";
import { createSupabaseBrowserClient } from "./supabase";

interface AttendanceSessionRow {
  employee_id: string;
  work_date: string;
  state: AttendanceSession["state"];
  clocked_in_at: string | null;
  clocked_out_at: string | null;
  first_break_started_at: string | null;
  first_break_ended_at: string | null;
  lunch_started_at: string | null;
  lunch_ended_at: string | null;
}

export async function recordAttendance(input: AttendanceEventInput): Promise<AttendanceSession> {
  const supabase = createSupabaseBrowserClient();
  if (!supabase) throw new Error("Supabase is not configured. Add the public project URL and anon key first.");
  const { data, error } = await supabase.rpc("record_attendance_event", {
    p_event_type: input.eventType,
    p_idempotency_key: input.idempotencyKey,
    p_source: input.source,
    p_work_mode: input.workMode ?? null,
    p_location: input.latitude == null ? null : { latitude: input.latitude, longitude: input.longitude },
    p_employee_id: input.employeeId ?? null,
  });
  if (error) throw error;
  const row = data as AttendanceSessionRow;
  return {
    employeeId: row.employee_id,
    workDate: row.work_date,
    state: row.state,
    clockedInAt: row.clocked_in_at ?? undefined,
    clockedOutAt: row.clocked_out_at ?? undefined,
    firstBreakStartedAt: row.first_break_started_at ?? undefined,
    firstBreakEndedAt: row.first_break_ended_at ?? undefined,
    lunchStartedAt: row.lunch_started_at ?? undefined,
    lunchEndedAt: row.lunch_ended_at ?? undefined,
  };
}

// HR or a manager (for their own reports) recording an event at a chosen date
// and time, e.g. a missed clock-in or a forgotten clock-out. The server checks
// the caller's authority, the state machine, and that times stay in order.
export async function recordAttendanceAt(input: {
  employeeId: string;
  eventType: AttendanceEventInput["eventType"];
  workDate: string;
  occurredAt: string;
  idempotencyKey: string;
}): Promise<void> {
  const supabase = createSupabaseBrowserClient();
  if (!supabase) throw new Error("Supabase is not configured. Add the public project URL and anon key first.");
  const { error } = await supabase.rpc("record_attendance_event_at", {
    p_employee_id: input.employeeId,
    p_event_type: input.eventType,
    p_work_date: input.workDate,
    p_occurred_at: input.occurredAt,
    p_idempotency_key: input.idempotencyKey,
  });
  if (error) throw error;
}
