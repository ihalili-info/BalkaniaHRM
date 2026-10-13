// Same rule as the profiles_sync_name_parts trigger (20261013_profile_name_parts.sql):
// first word is the name, everything after it is the surname.
export function splitFullName(fullName: string): { firstName: string; lastName: string } {
  const clean = fullName.trim().replace(/\s+/g, " ");
  const space = clean.indexOf(" ");
  return space < 0 ? { firstName: clean, lastName: "" } : { firstName: clean.slice(0, space), lastName: clean.slice(space + 1) };
}

export function joinName(firstName: string, lastName: string): string {
  return [firstName.trim(), lastName.trim()].filter(Boolean).join(" ");
}
