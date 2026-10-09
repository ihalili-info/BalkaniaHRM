import { createEmployee, setOpeningLeaveBalance, updateEmployeeDetailsFields, updateEmployeeProfileFields } from "./admin-service";

// "create" invites new people; "update" fills in data for people already in
// the directory (matched by full name), without sending any email.
export type ImportMode = "create" | "update";

export interface ExistingEmployee {
  id: string;
  fullName: string;
}

export interface ImportRow {
  rowNumber: number; // 1-based sheet row, header = 1
  // Update mode: the existing employee this row was matched to.
  employeeId: string | null;
  fullName: string;
  email: string;
  teamName: string;
  teamId: string | null;
  startDate: string;
  dateOfBirth: string;
  phoneNumber: string;
  address: string;
  // Remaining days as of today, from the spreadsheet; null when the column is
  // missing or the cell is blank (no balance is set up then).
  annualRemaining: number | null;
  sickRemaining: number | null;
  errors: string[];
  warnings: string[];
}

export interface ImportTeam {
  id: string;
  name: string;
}

// Accepts the column headings used in the HR spreadsheet, case/spacing-insensitive.
const HEADERS: Record<string, string[]> = {
  fullName: ["name & surname", "full name", "fullname", "employee"],
  firstName: ["name", "first name", "firstname"],
  lastName: ["surname", "last name", "lastname"],
  email: ["email", "work email", "e-mail"],
  team: ["team", "department"],
  startDate: ["start date", "startdate", "date started", "hire date"],
  dateOfBirth: ["date of birth", "dob", "birth date"],
  phone: ["phone number", "phone", "mobile"],
  address: ["address"],
  city: ["city", "town"],
  annualLeave: ["annual leave", "annual leave remaining", "remaining annual leave", "annual leave days", "holidays remaining"],
  sickLeave: ["sick leave", "sick leave remaining", "remaining sick leave", "sick days", "medical leave"],
};

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MIN_START_YEAR = 1990;

function normalise(value: unknown): string {
  return String(value ?? "").trim().toLowerCase().replace(/\s+/g, " ");
}

function pad(n: number) {
  return String(n).padStart(2, "0");
}

// Cells are either text ("2026-09-28") or real Excel dates (Date objects).
// Returns "" for blank and null when the value isn't a recognisable date.
function toIsoDate(value: unknown): string | null {
  if (value === null || value === undefined || value === "") return "";
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : `${value.getUTCFullYear()}-${pad(value.getUTCMonth() + 1)}-${pad(value.getUTCDate())}`;
  }
  const text = String(value).trim();
  if (!text) return "";
  const iso = text.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (iso) return validDate(+iso[1], +iso[2], +iso[3]);
  const dmy = text.match(/^(\d{1,2})[/.](\d{1,2})[/.](\d{4})$/);
  if (dmy) return validDate(+dmy[3], +dmy[2], +dmy[1]);
  return null;
}

// Accepts 17, "17", "17 days", "4.3 days", "6,5 days". Returns undefined for
// blank, null for something that isn't a non-negative number.
function toDays(value: unknown): number | null | undefined {
  if (value === null || value === undefined) return undefined;
  if (typeof value === "number") return value >= 0 ? Math.round(value * 100) / 100 : null;
  const text = String(value).trim().toLowerCase().replace(/\s*days?$/, "").replace(",", ".");
  if (!text) return undefined;
  const n = Number(text);
  return Number.isFinite(n) && n >= 0 ? Math.round(n * 100) / 100 : null;
}

function validDate(y: number, m: number, d: number): string | null {
  const date = new Date(Date.UTC(y, m - 1, d));
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d) return null;
  return `${y}-${pad(m)}-${pad(d)}`;
}

export async function readEmployeeSheet(file: File): Promise<unknown[][]> {
  const { readSheet } = await import("read-excel-file/browser");
  return (await readSheet(file)) as unknown[][];
}

export function parseEmployeeRows(sheet: unknown[][], teams: ImportTeam[], existingEmployees: ExistingEmployee[], mode: ImportMode = "create"): ImportRow[] {
  if (sheet.length < 2) return [];
  const header = sheet[0].map(normalise);
  const col: Record<string, number> = {};
  for (const [key, names] of Object.entries(HEADERS)) col[key] = header.findIndex((h) => names.includes(h));
  if (col.fullName < 0 && col.firstName < 0) {
    throw new Error('Couldn\'t find a name column. The first row needs a heading like "Name & Surname" (or "Name" and "Surname").');
  }
  if (mode === "create" && col.email < 0) {
    throw new Error('Couldn\'t find an "Email" column, which is needed to invite new employees.');
  }

  const cell = (row: unknown[], key: string) => (col[key] >= 0 ? row[col[key]] : undefined);
  const text = (row: unknown[], key: string) => String(cell(row, key) ?? "").trim();
  const teamsByName = new Map(teams.map((t) => [normalise(t.name), t]));
  const existing = new Set(existingEmployees.map((e) => normalise(e.fullName)));
  const idsByName = new Map<string, string[]>();
  for (const e of existingEmployees) {
    const key = normalise(e.fullName);
    idsByName.set(key, [...(idsByName.get(key) ?? []), e.id]);
  }
  const seenMatches = new Set<string>();
  const seenEmails = new Set<string>();
  const currentYear = new Date().getFullYear();

  const rows: ImportRow[] = [];
  sheet.slice(1).forEach((raw, index) => {
    if (raw.every((v) => v === null || v === undefined || String(v).trim() === "")) return;
    const errors: string[] = [];
    const warnings: string[] = [];

    const fullName = text(raw, "fullName") || [text(raw, "firstName"), text(raw, "lastName")].filter(Boolean).join(" ");
    const email = text(raw, "email").toLowerCase();
    const teamName = text(raw, "team");

    if (!fullName) errors.push("Missing name");
    let employeeId: string | null = null;
    if (mode === "create") {
      if (!email) errors.push("Missing email");
      else if (!EMAIL_PATTERN.test(email)) errors.push("Invalid email");
      else if (seenEmails.has(email)) errors.push("Email appears earlier in the file");
      if (email) seenEmails.add(email);
    } else if (fullName) {
      const matches = idsByName.get(normalise(fullName)) ?? [];
      if (matches.length === 0) errors.push("No employee with this name in the directory");
      else if (matches.length > 1) errors.push("Several employees have this name — update them by hand");
      else if (seenMatches.has(matches[0])) errors.push("This person appears earlier in the file");
      else {
        employeeId = matches[0];
        seenMatches.add(employeeId);
      }
    }

    const startDate = toIsoDate(cell(raw, "startDate"));
    if (startDate === null) errors.push("Start date isn't a valid date");
    else if (startDate && +startDate.slice(0, 4) < MIN_START_YEAR) errors.push(`Start date ${startDate} looks wrong`);
    else if (startDate && +startDate.slice(0, 4) > currentYear + 1) errors.push(`Start date ${startDate} is too far in the future`);

    const dateOfBirth = toIsoDate(cell(raw, "dateOfBirth"));
    if (dateOfBirth === null) warnings.push("Date of birth isn't a valid date and was skipped");

    const team = teamName ? teamsByName.get(normalise(teamName)) : undefined;
    if (!teamName) warnings.push(mode === "create" ? "No team" : "No team in file — team left unchanged");
    else if (!team) warnings.push(`Team "${teamName}" doesn't exist${mode === "update" ? " — team left unchanged" : ""}`);

    if (mode === "create" && fullName && existing.has(normalise(fullName))) warnings.push("Someone with this name is already in the directory");

    const address = [text(raw, "address"), text(raw, "city")].filter(Boolean).join(", ");

    const annualRemaining = toDays(cell(raw, "annualLeave"));
    if (annualRemaining === null) errors.push(`Annual leave "${text(raw, "annualLeave")}" isn't a number of days`);
    const sickRemaining = toDays(cell(raw, "sickLeave"));
    if (sickRemaining === null) errors.push(`Sick leave "${text(raw, "sickLeave")}" isn't a number of days`);

    rows.push({
      rowNumber: index + 2,
      employeeId,
      fullName,
      email,
      teamName,
      teamId: team?.id ?? null,
      startDate: startDate ?? "",
      dateOfBirth: dateOfBirth ?? "",
      phoneNumber: text(raw, "phone"),
      address,
      annualRemaining: annualRemaining ?? null,
      sickRemaining: sickRemaining ?? null,
      errors,
      warnings,
    });
  });
  return rows;
}

export interface ImportOutcome {
  row: ImportRow;
  ok: boolean;
  message?: string;
  // Employee was created but something after it (leave balances) failed.
  warning?: string;
}

export interface LeaveImportOptions {
  // Yearly allowance (days) that keeps accruing monthly on top of the imported
  // remaining days. Applied to every imported row that has a balance.
  annualEntitlement: number;
  sickEntitlement: number;
}

// Runs one create-employee call per row, sequentially so Supabase's auth
// invite email rate limits aren't tripped by a burst and failures stay attributable.
export async function importEmployees(
  rows: ImportRow[],
  leave: LeaveImportOptions,
  onProgress: (done: number, total: number) => void,
): Promise<ImportOutcome[]> {
  const outcomes: ImportOutcome[] = [];
  for (const row of rows) {
    try {
      const employee = await createEmployee({
        fullName: row.fullName,
        email: row.email,
        role: "employee",
        teamId: row.teamId,
        startDate: row.startDate || undefined,
        dateOfBirth: row.dateOfBirth || undefined,
        phoneNumber: row.phoneNumber || undefined,
        address: row.address || undefined,
      });
      // Balances are set after the employee exists; a failure here doesn't undo
      // the (already emailed) invite, it's reported so HR can fix it under Leave.
      const balanceErrors: string[] = [];
      const balances: Array<["annual" | "medical", number | null, number, string]> = [
        ["annual", row.annualRemaining, leave.annualEntitlement, "annual leave"],
        ["medical", row.sickRemaining, leave.sickEntitlement, "sick leave"],
      ];
      for (const [type, remaining, entitlement, label] of balances) {
        if (remaining === null) continue;
        try {
          await setOpeningLeaveBalance(employee.id, type, remaining, entitlement);
        } catch (err) {
          balanceErrors.push(`${label}: ${err && typeof err === "object" && "message" in err ? String((err as { message: unknown }).message) : "unknown error"}`);
        }
      }
      outcomes.push({ row, ok: true, warning: balanceErrors.length ? `Invited, but couldn't set ${balanceErrors.join("; ")}` : undefined });
    } catch (err) {
      const message = err && typeof err === "object" && "message" in err ? String((err as { message: unknown }).message) : "Unknown error";
      outcomes.push({ row, ok: false, message });
    }
    onProgress(outcomes.length, rows.length);
  }
  return outcomes;
}

// What "update" mode will write for a row, for the preview and the confirm text.
// Blank cells are skipped, so they never clear existing data.
export function updateSummary(row: ImportRow): string[] {
  const parts: string[] = [];
  if (row.startDate) parts.push(`start ${row.startDate}`);
  if (row.teamId) parts.push(`team ${row.teamName}`);
  if (row.dateOfBirth) parts.push("date of birth");
  if (row.phoneNumber) parts.push("phone");
  if (row.address) parts.push("address");
  if (row.annualRemaining !== null) parts.push(`${row.annualRemaining} annual`);
  if (row.sickRemaining !== null) parts.push(`${row.sickRemaining} sick`);
  return parts;
}

// Updates people already in the directory from the file. No invites are sent.
// Order matters: the start date is saved before leave balances, because
// accrual (and so the opening-balance adjustment) is calculated from it.
export async function updateEmployeesFromFile(
  rows: ImportRow[],
  leave: LeaveImportOptions,
  onProgress: (done: number, total: number) => void,
): Promise<ImportOutcome[]> {
  const describe = (err: unknown) =>
    err && typeof err === "object" && "message" in err ? String((err as { message: unknown }).message) : "unknown error";
  const outcomes: ImportOutcome[] = [];
  for (const row of rows) {
    if (!row.employeeId) {
      outcomes.push({ row, ok: false, message: "Not matched to an employee" });
      onProgress(outcomes.length, rows.length);
      continue;
    }
    const problems: string[] = [];
    try {
      await updateEmployeeProfileFields(row.employeeId, {
        ...(row.startDate ? { start_date: row.startDate } : {}),
        ...(row.teamId ? { team_id: row.teamId } : {}),
      });
    } catch (err) {
      problems.push(`start date/team: ${describe(err)}`);
    }
    try {
      await updateEmployeeDetailsFields(row.employeeId, {
        ...(row.dateOfBirth ? { date_of_birth: row.dateOfBirth } : {}),
        ...(row.phoneNumber ? { phone_number: row.phoneNumber } : {}),
        ...(row.address ? { address: row.address } : {}),
      });
    } catch (err) {
      problems.push(`personal details: ${describe(err)}`);
    }
    const balances: Array<["annual" | "medical", number | null, number, string]> = [
      ["annual", row.annualRemaining, leave.annualEntitlement, "annual leave"],
      ["medical", row.sickRemaining, leave.sickEntitlement, "sick leave"],
    ];
    for (const [type, remaining, entitlement, label] of balances) {
      if (remaining === null) continue;
      try {
        await setOpeningLeaveBalance(row.employeeId, type, remaining, entitlement);
      } catch (err) {
        problems.push(`${label}: ${describe(err)}`);
      }
    }
    outcomes.push(
      problems.length === 0
        ? { row, ok: true }
        : { row, ok: true, warning: `Partly updated — couldn't set ${problems.join("; ")}` },
    );
    onProgress(outcomes.length, rows.length);
  }
  return outcomes;
}
