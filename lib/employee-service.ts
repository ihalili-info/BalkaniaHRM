import type {
  AttendanceEventRecord,
  AttendanceSession,
  DisciplinaryNote,
  LeaveBalance,
  LeaveRequestInput,
  LeaveRequestRecord,
  OnLeaveEntry,
  Profile,
} from "./domain";
import { createSupabaseBrowserClient } from "./supabase";

function client() {
  const supabase = createSupabaseBrowserClient();
  if (!supabase) throw new Error("Supabase is not configured.");
  return supabase;
}

// RLS lets team leads/managers/HR also read their reports' rows, so every
// "my data" query must filter to the signed-in user explicitly — otherwise
// supervisors see others' rows mixed in (and .maybeSingle() errors).
async function myId(): Promise<string> {
  const { data } = await client().auth.getSession();
  const id = data.session?.user.id;
  if (!id) throw new Error("Authentication required.");
  return id;
}

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

export interface Holiday {
  date: string;
  name: string;
}

export async function listHolidays(): Promise<Holiday[]> {
  const { data, error } = await client().from("holidays").select("holiday_date,name").order("holiday_date");
  if (error) throw error;
  return (data ?? []).map((row) => ({ date: row.holiday_date, name: row.name }));
}

export async function issueQrToken(): Promise<{ token: string; expiresAt: string }> {
  const { data, error } = await client().rpc("issue_qr_token");
  if (error) throw error;
  const row = Array.isArray(data) ? data[0] : data;
  return { token: row.token, expiresAt: row.expires_at };
}

export async function getMyProfile(): Promise<Profile | null> {
  const { data: auth } = await client().auth.getUser();
  if (!auth.user) return null;
  const { data, error } = await client()
    .from("profiles")
    .select("id,full_name,employee_code,role,active,self_service_attendance")
    .eq("id", auth.user.id)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  return {
    id: data.id,
    fullName: data.full_name,
    employeeCode: data.employee_code,
    role: data.role,
    active: data.active,
    selfServiceAttendance: data.self_service_attendance,
  };
}

export async function getTodaySession(): Promise<AttendanceSession | null> {
  const { data, error } = await client()
    .from("attendance_sessions")
    .select("*")
    .eq("employee_id", await myId())
    .eq("work_date", todayIso())
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  return {
    employeeId: data.employee_id,
    workDate: data.work_date,
    state: data.state,
    clockedInAt: data.clocked_in_at ?? undefined,
    clockedOutAt: data.clocked_out_at ?? undefined,
    firstBreakStartedAt: data.first_break_started_at ?? undefined,
    firstBreakEndedAt: data.first_break_ended_at ?? undefined,
    lunchStartedAt: data.lunch_started_at ?? undefined,
    lunchEndedAt: data.lunch_ended_at ?? undefined,
  };
}

export async function getTodayEvents(): Promise<AttendanceEventRecord[]> {
  const { data, error } = await client()
    .from("attendance_events")
    .select("event_type,occurred_at")
    .eq("employee_id", await myId())
    .gte("occurred_at", `${todayIso()}T00:00:00`)
    .order("occurred_at", { ascending: false });
  if (error) throw error;
  return (data ?? []).map((row) => ({ eventType: row.event_type, occurredAt: row.occurred_at }));
}

export async function getLeaveBalances(): Promise<LeaveBalance[]> {
  // leave_balances_current computes "earned" live from monthly accrual and is
  // scoped to the active Apr-Mar leave year — see 20260825_leave_year_accrual.sql.
  const { data, error } = await client()
    .from("leave_balances_current")
    .select("leave_type,entitlement,earned,used")
    .eq("employee_id", await myId());
  if (error) throw error;
  return (data ?? []).map((row) => ({ leaveType: row.leave_type, entitlement: Number(row.entitlement), earned: Number(row.earned), used: Number(row.used) }));
}

export async function getLeaveRequests(): Promise<LeaveRequestRecord[]> {
  const { data, error } = await client()
    .from("leave_requests")
    .select("id,leave_type,starts_on,ends_on,status,note,created_at")
    .eq("employee_id", await myId())
    .order("created_at", { ascending: false });
  if (error) throw error;
  return (data ?? []).map((row) => ({
    id: row.id,
    leaveType: row.leave_type,
    startsOn: row.starts_on,
    endsOn: row.ends_on,
    status: row.status,
    note: row.note,
    createdAt: row.created_at,
  }));
}

export async function getMyDisciplinaryNotes(): Promise<DisciplinaryNote[]> {
  const { data, error } = await client()
    .from("disciplinary_actions")
    .select("id,severity,reason,details,occurred_on")
    .eq("employee_id", await myId())
    .order("occurred_on", { ascending: false });
  if (error) throw error;
  return (data ?? []).map((row) => ({
    id: row.id,
    severity: row.severity,
    reason: row.reason,
    details: row.details,
    occurredOn: row.occurred_on,
  }));
}

export async function getWhoIsOnLeaveToday(): Promise<OnLeaveEntry[]> {
  const { data, error } = await client().rpc("who_is_on_leave_today");
  if (error) throw error;
  return (data ?? []).map((row: { employee_name: string; leave_type: string }) => ({
    employeeName: row.employee_name,
    leaveType: row.leave_type,
  }));
}

export interface MonthSessionSummary {
  workDate: string;
  state: string;
  clockedInAt: string | null;
  clockedOutAt: string | null;
}

export async function getMonthSessions(monthStart: string, monthEnd: string): Promise<MonthSessionSummary[]> {
  const { data, error } = await client()
    .from("attendance_sessions")
    .select("work_date,state,clocked_in_at,clocked_out_at")
    .eq("employee_id", await myId())
    .gte("work_date", monthStart)
    .lte("work_date", monthEnd)
    .order("work_date");
  if (error) throw error;
  return (data ?? []).map((row) => ({ workDate: row.work_date, state: row.state, clockedInAt: row.clocked_in_at, clockedOutAt: row.clocked_out_at }));
}

export async function submitLeaveRequest(input: LeaveRequestInput): Promise<LeaveRequestRecord> {
  const { data: auth } = await client().auth.getUser();
  if (!auth.user) throw new Error("Authentication required.");
  const { data, error } = await client()
    .from("leave_requests")
    .insert({
      employee_id: auth.user.id,
      leave_type: input.leaveType,
      starts_on: input.startsOn,
      ends_on: input.endsOn,
      note: input.note ?? null,
    })
    .select("id,leave_type,starts_on,ends_on,status,note,created_at")
    .single();
  if (error) throw error;
  return {
    id: data.id,
    leaveType: data.leave_type,
    startsOn: data.starts_on,
    endsOn: data.ends_on,
    status: data.status,
    note: data.note,
    createdAt: data.created_at,
  };
}
