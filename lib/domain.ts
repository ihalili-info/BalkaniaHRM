export type AttendanceEventType = "clock_in" | "clock_out" | "break_start" | "break_end" | "lunch_start" | "lunch_end";
export type AttendanceState = "not_started" | "working" | "on_break" | "on_lunch" | "complete";
export type AttendanceSource = "pwa" | "kiosk" | "web" | "admin";

export interface AttendanceEventInput {
  eventType: AttendanceEventType;
  idempotencyKey: string;
  source: AttendanceSource;
  workMode?: "office" | "remote" | "manual";
  latitude?: number;
  longitude?: number;
  qrToken?: string;
  employeeId?: string;
}

export interface AttendanceSession {
  employeeId: string;
  workDate: string;
  state: AttendanceState;
  clockedInAt?: string;
  clockedOutAt?: string;
  firstBreakStartedAt?: string;
  firstBreakEndedAt?: string;
  lunchStartedAt?: string;
  lunchEndedAt?: string;
}

export type LeaveType = "annual" | "medical" | "unpaid" | "other";
export type LeaveStatus = "pending" | "approved" | "rejected" | "cancelled";

export interface LeaveRequestInput {
  leaveType: LeaveType;
  startsOn: string;
  endsOn: string;
  note?: string;
  isHalfDay?: boolean;
}

export type EmployeeRole = "employee" | "team_lead" | "manager" | "hr_admin" | "kiosk";

// Roles that supervise other people and therefore get the admin portal. Team
// leads see the same views as managers, scoped by RLS to their own team.
export function isAdminPortalRole(role: EmployeeRole | undefined | null): boolean {
  return role === "team_lead" || role === "manager" || role === "hr_admin";
}

export interface Profile {
  id: string;
  fullName: string;
  employeeCode: string;
  role: EmployeeRole;
  active: boolean;
  selfServiceAttendance: boolean;
  // Clock-in at the kiosk, but clock-out allowed from the app.
  phoneClockOut: boolean;
}

export interface LeaveBalance {
  leaveType: string;
  entitlement: number;
  earned: number;
  used: number;
}

export interface LeaveRequestRecord {
  id: string;
  leaveType: string;
  startsOn: string;
  endsOn: string;
  status: LeaveStatus;
  note: string | null;
  createdAt: string;
  // Sick leave only: the uploaded doctor's certificate, required before approval.
  medicalCertificatePath: string | null;
}

export interface AttendanceEventRecord {
  eventType: AttendanceEventType;
  occurredAt: string;
}

export interface OnLeaveEntry {
  employeeName: string;
  leaveType: string;
}

export interface DisciplinaryNote {
  id: string;
  severity: string;
  reason: string;
  details: string | null;
  occurredOn: string;
}
