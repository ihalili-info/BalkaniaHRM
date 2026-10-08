import { createSupabaseBrowserClient } from "./supabase";
import { listEmployees } from "./admin-service";

function client() {
  const supabase = createSupabaseBrowserClient();
  if (!supabase) throw new Error("Supabase is not configured.");
  return supabase;
}

export type PayType = "salary" | "hourly";
export type PayrollPeriodStatus = "draft" | "finalized" | "paid";
export type PayslipLineType = "earning" | "deduction";

export interface AdminCompensation {
  employeeId: string;
  employeeName: string;
  employeeCode: string;
  payType: PayType;
  monthlySalary: number | null;
  hourlyRate: number | null;
  currency: string;
}

export async function listEmployeeCompensation(): Promise<AdminCompensation[]> {
  const [employees, { data, error }] = await Promise.all([
    listEmployees(),
    client().from("employee_compensation").select("employee_id,pay_type,monthly_salary,hourly_rate,currency"),
  ]);
  if (error) throw error;

  const byEmployee = new Map((data ?? []).map((row) => [row.employee_id, row]));
  return employees
    .filter((e) => e.active)
    .map((e) => {
      const comp = byEmployee.get(e.id);
      return {
        employeeId: e.id,
        employeeName: e.fullName,
        employeeCode: e.employeeCode,
        payType: (comp?.pay_type as PayType) ?? "salary",
        monthlySalary: comp?.monthly_salary ?? null,
        hourlyRate: comp?.hourly_rate ?? null,
        currency: comp?.currency ?? "EUR",
      };
    })
    .sort((a, b) => a.employeeName.localeCompare(b.employeeName));
}

export interface UpsertCompensationInput {
  employeeId: string;
  payType: PayType;
  monthlySalary?: number | null;
  hourlyRate?: number | null;
  currency?: string;
}

export async function upsertEmployeeCompensation(input: UpsertCompensationInput): Promise<void> {
  const { error } = await client().rpc("upsert_employee_compensation", {
    p_employee_id: input.employeeId,
    p_pay_type: input.payType,
    p_monthly_salary: input.payType === "salary" ? input.monthlySalary ?? null : null,
    p_hourly_rate: input.payType === "hourly" ? input.hourlyRate ?? null : null,
    p_currency: input.currency ?? "EUR",
  });
  if (error) throw error;
}

export interface AdminPayrollPeriod {
  id: string;
  label: string;
  startsOn: string;
  endsOn: string;
  status: PayrollPeriodStatus;
  payslipCount: number;
}

export async function listPayrollPeriods(): Promise<AdminPayrollPeriod[]> {
  const [{ data, error }, counts] = await Promise.all([
    client().from("payroll_periods").select("id,label,starts_on,ends_on,status").order("starts_on", { ascending: false }),
    client().from("payslips").select("payroll_period_id"),
  ]);
  if (error) throw error;
  if (counts.error) throw counts.error;

  const countByPeriod = new Map<string, number>();
  for (const row of counts.data ?? []) {
    countByPeriod.set(row.payroll_period_id, (countByPeriod.get(row.payroll_period_id) ?? 0) + 1);
  }

  return (data ?? []).map((row) => ({
    id: row.id,
    label: row.label,
    startsOn: row.starts_on,
    endsOn: row.ends_on,
    status: row.status,
    payslipCount: countByPeriod.get(row.id) ?? 0,
  }));
}

export interface CreatePayrollPeriodInput {
  label: string;
  startsOn: string;
  endsOn: string;
}

export async function createPayrollPeriod(input: CreatePayrollPeriodInput): Promise<void> {
  const { error } = await client().rpc("create_payroll_period", {
    p_label: input.label.trim(),
    p_starts_on: input.startsOn,
    p_ends_on: input.endsOn,
  });
  if (error) throw error;
}

export interface AdminPayslip {
  id: string;
  payrollPeriodId: string;
  employeeId: string;
  employeeName: string;
  employeeCode: string;
  payType: PayType;
  hoursWorked: number | null;
  grossPay: number;
  totalDeductions: number;
  netPay: number;
  status: PayrollPeriodStatus;
}

export async function listPayslips(periodId: string): Promise<AdminPayslip[]> {
  const [{ data, error }, employees] = await Promise.all([
    client()
      .from("payslips")
      .select("id,payroll_period_id,employee_id,pay_type,hours_worked,gross_pay,total_deductions,net_pay,status")
      .eq("payroll_period_id", periodId),
    listEmployees(),
  ]);
  if (error) throw error;

  const employeeById = new Map(employees.map((e) => [e.id, e]));
  return (data ?? [])
    .map((row) => {
      const employee = employeeById.get(row.employee_id);
      return {
        id: row.id,
        payrollPeriodId: row.payroll_period_id,
        employeeId: row.employee_id,
        employeeName: employee?.fullName ?? "Unknown",
        employeeCode: employee?.employeeCode ?? "",
        payType: row.pay_type,
        hoursWorked: row.hours_worked,
        grossPay: row.gross_pay,
        totalDeductions: row.total_deductions,
        netPay: row.net_pay,
        status: row.status,
      };
    })
    .sort((a, b) => a.employeeName.localeCompare(b.employeeName));
}

export async function generatePayslips(periodId: string): Promise<void> {
  const { error } = await client().rpc("generate_payroll_period_payslips", { p_period_id: periodId });
  if (error) throw error;
}

export interface AdminPayslipLineItem {
  id: string;
  lineType: PayslipLineType;
  label: string;
  amount: number;
  sortOrder: number;
}

export async function listPayslipLineItems(payslipId: string): Promise<AdminPayslipLineItem[]> {
  const { data, error } = await client()
    .from("payslip_line_items")
    .select("id,line_type,label,amount,sort_order")
    .eq("payslip_id", payslipId)
    .order("sort_order");
  if (error) throw error;
  return (data ?? []).map((row) => ({
    id: row.id,
    lineType: row.line_type,
    label: row.label,
    amount: row.amount,
    sortOrder: row.sort_order,
  }));
}

export interface AddPayslipLineItemInput {
  payslipId: string;
  lineType: PayslipLineType;
  label: string;
  amount: number;
}

export async function addPayslipLineItem(input: AddPayslipLineItemInput): Promise<void> {
  const { error } = await client().rpc("add_payslip_line_item", {
    p_payslip_id: input.payslipId,
    p_line_type: input.lineType,
    p_label: input.label.trim(),
    p_amount: input.amount,
  });
  if (error) throw error;
}

export async function deletePayslipLineItem(lineItemId: string): Promise<void> {
  const { error } = await client().rpc("delete_payslip_line_item", { p_line_item_id: lineItemId });
  if (error) throw error;
}

export async function finalizePayrollPeriod(periodId: string): Promise<void> {
  const { error } = await client().rpc("finalize_payroll_period", { p_period_id: periodId });
  if (error) throw error;
}

// Draft periods only -- the RPC refuses finalized/paid ones. Deletes the
// period's payslips and line items with it.
export async function deletePayrollPeriod(periodId: string): Promise<void> {
  const { error } = await client().rpc("delete_payroll_period", { p_period_id: periodId });
  if (error) throw error;
}

export async function markPayrollPeriodPaid(periodId: string): Promise<void> {
  const { error } = await client().rpc("mark_payroll_period_paid", { p_period_id: periodId });
  if (error) throw error;
}
