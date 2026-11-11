// Every date and time in the product is shown the Irish way -- DD/MM/YYYY,
// "05 Mar", 24-hour clock -- whatever language the viewer's browser is set to.
// Pass this to toLocaleDateString / toLocaleTimeString / Intl.DateTimeFormat
// instead of [] or undefined (which would follow the browser).
export const APP_LOCALE = "en-IE";

// An ISO date ("2026-03-05", or the date part of a timestamp) as DD/MM/YYYY
// for CSV exports. Plain string slicing, so no timezone shift can move the day.
export function formatCsvDate(iso: string): string {
  const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${m[3]}/${m[2]}/${m[1]}` : iso;
}
