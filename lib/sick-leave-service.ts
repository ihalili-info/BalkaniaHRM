// Statutory sick leave (Sick Leave Act 2022): qualification status, medical
// certificates and sick pay. The rules themselves live in Postgres -- see
// supabase/migrations/20261021_statutory_sick_leave.sql. Used by both the
// employee app and the admin portal.
import { createSupabaseBrowserClient } from "./supabase";

function client() {
  const supabase = createSupabaseBrowserClient();
  if (!supabase) throw new Error("Supabase is not configured.");
  return supabase;
}

const CERTIFICATE_BUCKET = "medical-certificates";
const CERTIFICATE_TYPES = ["application/pdf", "image/jpeg", "image/png", "image/webp", "image/heic"];
const CERTIFICATE_MAX_BYTES = 10 * 1024 * 1024;
export const CERTIFICATE_ACCEPT = ".pdf,.jpg,.jpeg,.png,.webp,.heic";

// Mirrors statutory_sick_days_per_year() for wording only; the server decides.
export const STATUTORY_SICK_DAYS = 5;

export interface SickLeaveStatus {
  startDate: string;
  // First day paid sick leave applies (start date + 13 weeks).
  qualifiesOn: string;
  weeksOfService: number;
  qualified: boolean;
  // 1 January of the year the status is for.
  yearStart: string;
  entitlement: number;
  used: number;
  remaining: number;
}

// Where someone stands for paid sick leave on `on` (YYYY-MM-DD). Employees
// can ask about themselves; HR and supervisors about the people they cover.
export async function getSickLeaveStatus(employeeId: string, on: string): Promise<SickLeaveStatus> {
  const { data, error } = await client().rpc("sick_leave_status", { p_employee_id: employeeId, p_on: on });
  if (error) throw error;
  const row = Array.isArray(data) ? data[0] : data;
  if (!row) throw new Error("Couldn't load sick leave status.");
  return {
    startDate: row.start_date,
    qualifiesOn: row.qualifies_on,
    weeksOfService: Number(row.weeks_of_service),
    qualified: Boolean(row.qualified),
    yearStart: row.year_start,
    entitlement: Number(row.entitlement),
    used: Number(row.used),
    remaining: Number(row.remaining),
  };
}

// Uploads a doctor's certificate for a sick leave request and attaches it.
// Storage policies only allow it for the employee themself, HR, or their
// supervisor, and not on a cancelled request.
export async function uploadMedicalCertificate(employeeId: string, requestId: string, file: File): Promise<void> {
  if (!CERTIFICATE_TYPES.includes(file.type)) throw new Error("Medical certificates must be a PDF or a photo (JPG, PNG, WebP or HEIC).");
  if (file.size > CERTIFICATE_MAX_BYTES) throw new Error("Medical certificates must be 10 MB or smaller.");
  const safeName = file.name.replace(/[^\w.\-]+/g, "_").slice(-100);
  const path = `${employeeId}/${requestId}/${Date.now()}-${safeName}`;
  const { error: uploadError } = await client().storage.from(CERTIFICATE_BUCKET).upload(path, file, { contentType: file.type });
  if (uploadError) throw uploadError;
  const { error } = await client().rpc("attach_medical_certificate", { p_request_id: requestId, p_path: path });
  if (error) throw error;
}

// Short-lived link so a certificate URL pasted elsewhere stops working quickly.
export async function getMedicalCertificateUrl(path: string): Promise<string> {
  const { data, error } = await client().storage.from(CERTIFICATE_BUCKET).createSignedUrl(path, 60);
  if (error) throw error;
  return data.signedUrl;
}

export interface StatutorySickPay {
  employeeId: string;
  sspDays: number;
  sspAmount: number;
  // Today's daily SSP rate; null when no compensation is set up.
  dailyRate: number | null;
}

// HR only: statutory sick pay per employee for a calendar year.
export async function getStatutorySickPaySummary(year: number): Promise<StatutorySickPay[]> {
  const { data, error } = await client().rpc("statutory_sick_pay_summary", { p_year: year });
  if (error) throw error;
  return (data ?? []).map((row: { employee_id: string; ssp_days: number; ssp_amount: number; daily_rate: number | null }) => ({
    employeeId: row.employee_id,
    sspDays: Number(row.ssp_days),
    sspAmount: Number(row.ssp_amount),
    dailyRate: row.daily_rate === null ? null : Number(row.daily_rate),
  }));
}
