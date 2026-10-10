import { createSupabaseBrowserClient } from "./supabase";

// Shift rosters: dated shifts (draft -> published), default templates per
// employee/team, rotations and shift swaps. Business rules live in
// supabase/migrations/20261011_shift_rosters.sql; this file is thin wrappers.

function client() {
  const supabase = createSupabaseBrowserClient();
  if (!supabase) throw new Error("Supabase is not configured.");
  return supabase;
}

// ---- date helpers (local calendar dates as "YYYY-MM-DD") ----

function pad(n: number) {
  return String(n).padStart(2, "0");
}

export function toIsoDate(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function addDays(iso: string, days: number): string {
  const [y, m, d] = iso.split("-").map(Number);
  return toIsoDate(new Date(y, m - 1, d + days));
}

// Monday of the week containing `iso`.
export function weekStart(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  const date = new Date(y, m - 1, d);
  const isoDow = date.getDay() === 0 ? 7 : date.getDay();
  return addDays(iso, 1 - isoDow);
}

// Shift times are local wall-clock times; an end at or before the start means
// the shift finishes the next day.
export function shiftBounds(shift: { shiftDate: string; startsAt: string; endsAt: string }): { start: Date; end: Date } {
  const start = new Date(`${shift.shiftDate}T${shift.startsAt.slice(0, 5)}:00`);
  const endDate = shift.endsAt.slice(0, 5) <= shift.startsAt.slice(0, 5) ? addDays(shift.shiftDate, 1) : shift.shiftDate;
  const end = new Date(`${endDate}T${shift.endsAt.slice(0, 5)}:00`);
  return { start, end };
}

// Paid hours: shift length minus the unpaid break.
export function shiftHours(shift: { shiftDate: string; startsAt: string; endsAt: string; unpaidBreakMinutes: number }): number {
  const { start, end } = shiftBounds(shift);
  return Math.max(0, (end.getTime() - start.getTime()) / 3600000 - shift.unpaidBreakMinutes / 60);
}

export function formatShiftTime(shift: { startsAt: string; endsAt: string }): string {
  return `${shift.startsAt.slice(0, 5)}–${shift.endsAt.slice(0, 5)}`;
}

// ---- roster ----

export type ShiftStatus = "draft" | "published";
export type ShiftSource = "manual" | "default" | "rotation" | "swap";

export interface RosterShift {
  id: string;
  employeeId: string;
  shiftDate: string;
  scheduleId: string | null;
  startsAt: string;
  endsAt: string;
  unpaidBreakMinutes: number;
  note: string | null;
  status: ShiftStatus;
  source: ShiftSource;
}

const SHIFT_COLUMNS = "id,employee_id,shift_date,schedule_id,starts_at,ends_at,unpaid_break_minutes,note,status,source";

type ShiftRow = {
  id: string;
  employee_id: string;
  shift_date: string;
  schedule_id: string | null;
  starts_at: string;
  ends_at: string;
  unpaid_break_minutes: number;
  note: string | null;
  status: ShiftStatus;
  source: ShiftSource;
};

function mapShift(row: ShiftRow): RosterShift {
  return {
    id: row.id,
    employeeId: row.employee_id,
    shiftDate: row.shift_date,
    scheduleId: row.schedule_id,
    startsAt: row.starts_at,
    endsAt: row.ends_at,
    unpaidBreakMinutes: row.unpaid_break_minutes,
    note: row.note,
    status: row.status,
    source: row.source,
  };
}

// RLS scopes the rows: HR sees everyone, supervisors their people, employees
// only their own published shifts.
export async function listRosterShifts(from: string, to: string, opts: { publishedOnly?: boolean; employeeId?: string } = {}): Promise<RosterShift[]> {
  let query = client().from("roster_shifts").select(SHIFT_COLUMNS).gte("shift_date", from).lte("shift_date", to);
  if (opts.publishedOnly) query = query.eq("status", "published");
  if (opts.employeeId) query = query.eq("employee_id", opts.employeeId);
  const { data, error } = await query.order("shift_date").order("starts_at");
  if (error) throw error;
  return (data ?? []).map(mapShift);
}

export interface ShiftInput {
  employeeId: string;
  shiftDate: string;
  scheduleId: string | null;
  startsAt: string;
  endsAt: string;
  unpaidBreakMinutes: number;
  note: string;
}

function shiftRow(input: ShiftInput) {
  return {
    employee_id: input.employeeId,
    shift_date: input.shiftDate,
    schedule_id: input.scheduleId,
    starts_at: input.startsAt,
    ends_at: input.endsAt,
    unpaid_break_minutes: input.unpaidBreakMinutes,
    note: input.note.trim() || null,
  };
}

// New shifts start as drafts; editing a published shift keeps it published
// (the employee sees the change straight away).
export async function saveRosterShift(id: string | null, input: ShiftInput): Promise<RosterShift> {
  const query = id
    ? client().from("roster_shifts").update({ ...shiftRow(input), source: "manual", updated_at: new Date().toISOString() }).eq("id", id)
    : client().from("roster_shifts").insert({ ...shiftRow(input), status: "draft", source: "manual" });
  const { data, error } = await query.select(SHIFT_COLUMNS).single();
  if (error) {
    if ((error as { code?: string }).code === "23505") throw new Error("That person already has a shift on this day.");
    throw error;
  }
  return mapShift(data as ShiftRow);
}

export async function deleteRosterShift(id: string): Promise<void> {
  const { error } = await client().from("roster_shifts").delete().eq("id", id);
  if (error) throw error;
}

export async function fillRoster(from: string, to: string, employeeIds: string[] | null): Promise<number> {
  const { data, error } = await client().rpc("fill_roster", { p_from: from, p_to: to, p_employee_ids: employeeIds });
  if (error) throw error;
  return Number(data ?? 0);
}

// Copies last week's shifts (any status) into this week as drafts, skipping
// days that already have a shift. Done here rather than in SQL because RLS
// already limits it to the people the caller manages.
export async function copyPreviousWeek(weekFrom: string, employeeIds: string[]): Promise<number> {
  const prevFrom = addDays(weekFrom, -7);
  const [previous, current] = await Promise.all([
    listRosterShifts(prevFrom, addDays(prevFrom, 6)),
    listRosterShifts(weekFrom, addDays(weekFrom, 6)),
  ]);
  const allowed = new Set(employeeIds);
  const taken = new Set(current.map((s) => `${s.employeeId}|${s.shiftDate}`));
  const rows = previous
    .filter((s) => allowed.has(s.employeeId))
    .map((s) => ({ ...s, shiftDate: addDays(s.shiftDate, 7) }))
    .filter((s) => !taken.has(`${s.employeeId}|${s.shiftDate}`))
    .map((s) => ({
      employee_id: s.employeeId,
      shift_date: s.shiftDate,
      schedule_id: s.scheduleId,
      starts_at: s.startsAt,
      ends_at: s.endsAt,
      unpaid_break_minutes: s.unpaidBreakMinutes,
      note: s.note,
      status: "draft",
      source: "manual",
    }));
  if (rows.length === 0) return 0;
  const { error } = await client().from("roster_shifts").insert(rows);
  if (error) throw error;
  return rows.length;
}

export async function publishRoster(from: string, to: string): Promise<number> {
  const { data, error } = await client()
    .from("roster_shifts")
    .update({ status: "published", updated_at: new Date().toISOString() })
    .eq("status", "draft")
    .gte("shift_date", from)
    .lte("shift_date", to)
    .select("id");
  if (error) throw error;
  return data?.length ?? 0;
}

export async function clearDrafts(from: string, to: string): Promise<number> {
  const { data, error } = await client()
    .from("roster_shifts")
    .delete()
    .eq("status", "draft")
    .gte("shift_date", from)
    .lte("shift_date", to)
    .select("id");
  if (error) throw error;
  return data?.length ?? 0;
}

// ---- default templates ----

export interface ScheduleAssignment {
  employeeId: string;
  scheduleId: string;
}

export async function listScheduleAssignments(): Promise<ScheduleAssignment[]> {
  const { data, error } = await client().from("employee_schedule_assignments").select("employee_id,schedule_id");
  if (error) throw error;
  return (data ?? []).map((r) => ({ employeeId: r.employee_id, scheduleId: r.schedule_id }));
}

export async function setEmployeeSchedule(employeeId: string, scheduleId: string | null): Promise<void> {
  const query = scheduleId
    ? client()
        .from("employee_schedule_assignments")
        .upsert({ employee_id: employeeId, schedule_id: scheduleId, effective_from: "2000-01-01", effective_to: null }, { onConflict: "employee_id" })
    : client().from("employee_schedule_assignments").delete().eq("employee_id", employeeId);
  const { error } = await query;
  if (error) throw error;
}

export async function listTeamDefaults(): Promise<Map<string, string | null>> {
  const { data, error } = await client().from("teams").select("id,default_schedule_id");
  if (error) throw error;
  return new Map((data ?? []).map((t) => [t.id as string, (t.default_schedule_id as string | null) ?? null]));
}

export async function setTeamSchedule(teamId: string, scheduleId: string | null): Promise<void> {
  const { error } = await client().from("teams").update({ default_schedule_id: scheduleId }).eq("id", teamId);
  if (error) throw error;
}

// ---- rotations ----

export interface Rotation {
  id: string;
  name: string;
  cycleDays: number;
  // schedule id per day index; null = day off
  days: Array<string | null>;
}

export async function listRotations(): Promise<Rotation[]> {
  const [{ data: rotations, error }, { data: days, error: daysError }] = await Promise.all([
    client().from("shift_rotations").select("id,name,cycle_days").order("name"),
    client().from("shift_rotation_days").select("rotation_id,day_index,schedule_id"),
  ]);
  if (error) throw error;
  if (daysError) throw daysError;
  return (rotations ?? []).map((r) => {
    const pattern: Array<string | null> = Array.from({ length: r.cycle_days }, () => null);
    for (const d of days ?? []) {
      if (d.rotation_id === r.id && d.day_index < r.cycle_days) pattern[d.day_index] = d.schedule_id;
    }
    return { id: r.id, name: r.name, cycleDays: r.cycle_days, days: pattern };
  });
}

export async function saveRotation(id: string | null, name: string, days: Array<string | null>): Promise<void> {
  const supabase = client();
  let rotationId = id;
  if (rotationId) {
    const { error } = await supabase.from("shift_rotations").update({ name: name.trim(), cycle_days: days.length }).eq("id", rotationId);
    if (error) throw error;
    const { error: clearError } = await supabase.from("shift_rotation_days").delete().eq("rotation_id", rotationId);
    if (clearError) throw clearError;
  } else {
    const { data, error } = await supabase.from("shift_rotations").insert({ name: name.trim(), cycle_days: days.length }).select("id").single();
    if (error) throw error;
    rotationId = data.id as string;
  }
  const rows = days
    .map((scheduleId, index) => (scheduleId ? { rotation_id: rotationId, day_index: index, schedule_id: scheduleId } : null))
    .filter((r): r is { rotation_id: string; day_index: number; schedule_id: string } => r !== null);
  if (rows.length) {
    const { error } = await supabase.from("shift_rotation_days").insert(rows);
    if (error) throw error;
  }
}

export async function deleteRotation(id: string): Promise<void> {
  const { error } = await client().from("shift_rotations").delete().eq("id", id);
  if (error) throw error;
}

export interface RotationAssignment {
  id: string;
  rotationId: string;
  employeeId: string;
  startsOn: string;
  endsOn: string | null;
}

export async function listRotationAssignments(): Promise<RotationAssignment[]> {
  const { data, error } = await client().from("rotation_assignments").select("id,rotation_id,employee_id,starts_on,ends_on").order("starts_on", { ascending: false });
  if (error) throw error;
  return (data ?? []).map((r) => ({ id: r.id, rotationId: r.rotation_id, employeeId: r.employee_id, startsOn: r.starts_on, endsOn: r.ends_on }));
}

export async function assignRotation(rotationId: string, employeeIds: string[], startsOn: string, endsOn: string | null): Promise<void> {
  if (employeeIds.length === 0) return;
  const { error } = await client()
    .from("rotation_assignments")
    .insert(employeeIds.map((employeeId) => ({ rotation_id: rotationId, employee_id: employeeId, starts_on: startsOn, ends_on: endsOn || null })));
  if (error) throw error;
}

export async function endRotationAssignment(id: string, endsOn: string): Promise<void> {
  const { error } = await client().from("rotation_assignments").update({ ends_on: endsOn }).eq("id", id);
  if (error) throw error;
}

export async function deleteRotationAssignment(id: string): Promise<void> {
  const { error } = await client().from("rotation_assignments").delete().eq("id", id);
  if (error) throw error;
}

// Which template a rotation puts on a date for an assignment (null = day off,
// undefined = the assignment doesn't cover that date). Mirrors fill_roster.
export function rotationScheduleOn(rotation: Rotation, assignment: RotationAssignment, date: string): string | null | undefined {
  if (date < assignment.startsOn || (assignment.endsOn && date > assignment.endsOn)) return undefined;
  const [y1, m1, d1] = assignment.startsOn.split("-").map(Number);
  const [y2, m2, d2] = date.split("-").map(Number);
  const diff = Math.round((Date.UTC(y2, m2 - 1, d2) - Date.UTC(y1, m1 - 1, d1)) / 86400000);
  return rotation.days[diff % rotation.cycleDays] ?? null;
}

// ---- swaps ----

export type SwapStatus = "pending_colleague" | "pending_approval" | "approved" | "rejected" | "declined" | "cancelled";

export const SWAP_STATUS_LABELS: Record<SwapStatus, string> = {
  pending_colleague: "Waiting for colleague",
  pending_approval: "Waiting for approval",
  approved: "Approved",
  rejected: "Rejected",
  declined: "Declined by colleague",
  cancelled: "Cancelled",
};

export interface ShiftSwap {
  id: string;
  status: SwapStatus;
  message: string | null;
  decisionNote: string | null;
  createdAt: string;
  decidedAt: string | null;
  requesterId: string;
  requesterName: string;
  requesterShift: { shiftDate: string; startsAt: string; endsAt: string } | null;
  targetEmployeeId: string;
  targetName: string;
  // null = "cover my shift" (nothing given back)
  targetShift: { shiftDate: string; startsAt: string; endsAt: string } | null;
  decidedByName: string | null;
}

export async function listShiftSwaps(): Promise<ShiftSwap[]> {
  const { data, error } = await client().rpc("list_shift_swaps");
  if (error) throw error;
  return ((data ?? []) as Array<Record<string, string | null>>).map((r) => ({
    id: r.id as string,
    status: r.status as SwapStatus,
    message: r.message,
    decisionNote: r.decision_note,
    createdAt: r.created_at as string,
    decidedAt: r.decided_at,
    requesterId: r.requester_id as string,
    requesterName: r.requester_name as string,
    requesterShift: r.requester_shift_date
      ? { shiftDate: r.requester_shift_date, startsAt: r.requester_starts_at as string, endsAt: r.requester_ends_at as string }
      : null,
    targetEmployeeId: r.target_employee_id as string,
    targetName: r.target_name as string,
    targetShift: r.target_shift_date ? { shiftDate: r.target_shift_date, startsAt: r.target_starts_at as string, endsAt: r.target_ends_at as string } : null,
    decidedByName: r.decided_by_name,
  }));
}

export interface SwapOption {
  employeeId: string;
  employeeName: string;
  // null = colleague is free that day and could cover the shift
  shiftId: string | null;
  shiftDate: string;
  startsAt: string | null;
  endsAt: string | null;
}

export async function listSwapOptions(shiftId: string): Promise<SwapOption[]> {
  const { data, error } = await client().rpc("list_swap_options", { p_shift_id: shiftId });
  if (error) throw error;
  return ((data ?? []) as Array<{ employee_id: string; employee_name: string; shift_id: string | null; shift_date: string; starts_at: string | null; ends_at: string | null }>).map(
    (r) => ({
      employeeId: r.employee_id,
      employeeName: r.employee_name,
      shiftId: r.shift_id,
      shiftDate: r.shift_date,
      startsAt: r.starts_at,
      endsAt: r.ends_at,
    }),
  );
}

export async function requestShiftSwap(shiftId: string, targetEmployeeId: string, targetShiftId: string | null, message: string): Promise<void> {
  const { error } = await client().rpc("request_shift_swap", {
    p_shift_id: shiftId,
    p_target_employee_id: targetEmployeeId,
    p_target_shift_id: targetShiftId,
    p_message: message,
  });
  if (error) throw error;
}

export async function respondShiftSwap(requestId: string, accept: boolean): Promise<void> {
  const { error } = await client().rpc("respond_shift_swap", { p_request_id: requestId, p_accept: accept });
  if (error) throw error;
}

export async function cancelShiftSwap(requestId: string): Promise<void> {
  const { error } = await client().rpc("cancel_shift_swap", { p_request_id: requestId });
  if (error) throw error;
}

export async function decideShiftSwap(requestId: string, approve: boolean, note: string): Promise<void> {
  const { error } = await client().rpc("decide_shift_swap", { p_request_id: requestId, p_approve: approve, p_note: note });
  if (error) throw error;
}

// Approved leave overlapping a date range, so the roster can show who's off.
export async function listApprovedLeave(from: string, to: string): Promise<Array<{ employeeId: string; startsOn: string; endsOn: string; leaveType: string }>> {
  const { data, error } = await client()
    .from("leave_requests")
    .select("employee_id,starts_on,ends_on,leave_type")
    .eq("status", "approved")
    .lte("starts_on", to)
    .gte("ends_on", from);
  if (error) throw error;
  return (data ?? []).map((r) => ({ employeeId: r.employee_id, startsOn: r.starts_on, endsOn: r.ends_on, leaveType: r.leave_type }));
}

// ---- attendance vs roster ----

// Minutes after the rostered start before a clock-in counts as late, and
// before a missing clock-in counts as a no-show.
export const LATE_GRACE_MINUTES = 5;
export const NO_SHOW_AFTER_MINUTES = 30;

export type ShiftAttendanceStatus = "upcoming" | "on_time" | "late" | "no_show" | "awaiting";

export interface ShiftAttendance {
  shift: RosterShift;
  status: ShiftAttendanceStatus;
  lateMinutes: number;
  clockedInAt: string | null;
}

// Matches each rostered shift to the employee's clock-in. A session belongs to
// a shift if it started between 4h before the shift start and the shift end --
// by time, not by date, so night shifts that cross midnight still match.
export function matchShiftsToAttendance(
  shifts: RosterShift[],
  sessions: Array<{ employeeId: string; clockedInAt: string | null }>,
  now = new Date(),
): ShiftAttendance[] {
  const byEmployee = new Map<string, number[]>();
  for (const s of sessions) {
    if (!s.clockedInAt) continue;
    const list = byEmployee.get(s.employeeId) ?? [];
    list.push(new Date(s.clockedInAt).getTime());
    byEmployee.set(s.employeeId, list);
  }
  return shifts.map((shift) => {
    const { start, end } = shiftBounds(shift);
    const clockIn = (byEmployee.get(shift.employeeId) ?? [])
      .filter((t) => t >= start.getTime() - 4 * 3600000 && t <= end.getTime())
      .sort((a, b) => a - b)[0];
    if (clockIn !== undefined) {
      const late = Math.floor((clockIn - start.getTime()) / 60000);
      return {
        shift,
        status: late > LATE_GRACE_MINUTES ? "late" : "on_time",
        lateMinutes: Math.max(0, late),
        clockedInAt: new Date(clockIn).toISOString(),
      };
    }
    const minutesSinceStart = (now.getTime() - start.getTime()) / 60000;
    const status: ShiftAttendanceStatus =
      minutesSinceStart < 0 ? "upcoming" : minutesSinceStart > NO_SHOW_AFTER_MINUTES ? "no_show" : "awaiting";
    return { shift, status, lateMinutes: 0, clockedInAt: null };
  });
}

export function formatLate(minutes: number): string {
  return minutes >= 60 ? `${Math.floor(minutes / 60)}h ${minutes % 60}m late` : `${minutes} min late`;
}
