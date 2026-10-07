import { createEmployee } from "./admin-service";

export interface ImportRow {
  rowNumber: number; // 1-based sheet row, header = 1
  fullName: string;
  email: string;
  teamName: string;
  teamId: string | null;
  startDate: string;
  dateOfBirth: string;
  phoneNumber: string;
  address: string;
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

function validDate(y: number, m: number, d: number): string | null {
  const date = new Date(Date.UTC(y, m - 1, d));
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d) return null;
  return `${y}-${pad(m)}-${pad(d)}`;
}

export async function readEmployeeSheet(file: File): Promise<unknown[][]> {
  const { readSheet } = await import("read-excel-file/browser");
  return (await readSheet(file)) as unknown[][];
}

export function parseEmployeeRows(sheet: unknown[][], teams: ImportTeam[], existingNames: string[]): ImportRow[] {
  if (sheet.length < 2) return [];
  const header = sheet[0].map(normalise);
  const col: Record<string, number> = {};
  for (const [key, names] of Object.entries(HEADERS)) col[key] = header.findIndex((h) => names.includes(h));
  if (col.email < 0 || (col.fullName < 0 && col.firstName < 0)) {
    throw new Error('Couldn\'t find the required columns. The first row needs headings like "Name & Surname" (or "Name" and "Surname") and "Email".');
  }

  const cell = (row: unknown[], key: string) => (col[key] >= 0 ? row[col[key]] : undefined);
  const text = (row: unknown[], key: string) => String(cell(row, key) ?? "").trim();
  const teamsByName = new Map(teams.map((t) => [normalise(t.name), t]));
  const existing = new Set(existingNames.map(normalise));
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
    if (!email) errors.push("Missing email");
    else if (!EMAIL_PATTERN.test(email)) errors.push("Invalid email");
    else if (seenEmails.has(email)) errors.push("Email appears earlier in the file");
    if (email) seenEmails.add(email);

    const startDate = toIsoDate(cell(raw, "startDate"));
    if (startDate === null) errors.push("Start date isn't a valid date");
    else if (startDate && +startDate.slice(0, 4) < MIN_START_YEAR) errors.push(`Start date ${startDate} looks wrong`);
    else if (startDate && +startDate.slice(0, 4) > currentYear + 1) errors.push(`Start date ${startDate} is too far in the future`);

    const dateOfBirth = toIsoDate(cell(raw, "dateOfBirth"));
    if (dateOfBirth === null) warnings.push("Date of birth isn't a valid date and was skipped");

    const team = teamName ? teamsByName.get(normalise(teamName)) : undefined;
    if (!teamName) warnings.push("No team");
    else if (!team) warnings.push(`Team "${teamName}" doesn't exist`);

    if (fullName && existing.has(normalise(fullName))) warnings.push("Someone with this name is already in the directory");

    const address = [text(raw, "address"), text(raw, "city")].filter(Boolean).join(", ");

    rows.push({
      rowNumber: index + 2,
      fullName,
      email,
      teamName,
      teamId: team?.id ?? null,
      startDate: startDate ?? "",
      dateOfBirth: dateOfBirth ?? "",
      phoneNumber: text(raw, "phone"),
      address,
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
}

// Runs one create-employee call per row, sequentially so Supabase's auth
// invite email rate limits aren't tripped by a burst and failures stay attributable.
export async function importEmployees(
  rows: ImportRow[],
  onProgress: (done: number, total: number) => void,
): Promise<ImportOutcome[]> {
  const outcomes: ImportOutcome[] = [];
  for (const row of rows) {
    try {
      await createEmployee({
        fullName: row.fullName,
        email: row.email,
        role: "employee",
        teamId: row.teamId,
        startDate: row.startDate || undefined,
        dateOfBirth: row.dateOfBirth || undefined,
        phoneNumber: row.phoneNumber || undefined,
        address: row.address || undefined,
      });
      outcomes.push({ row, ok: true });
    } catch (err) {
      const message = err && typeof err === "object" && "message" in err ? String((err as { message: unknown }).message) : "Unknown error";
      outcomes.push({ row, ok: false, message });
    }
    onProgress(outcomes.length, rows.length);
  }
  return outcomes;
}
