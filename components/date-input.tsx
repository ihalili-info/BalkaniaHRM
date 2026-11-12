"use client";

import { useEffect, useRef, useState } from "react";
import { Icon } from "./icons";
import { APP_LOCALE } from "../lib/locale";

// A date field that accepts pasted or typed dates in any common format
// ("2023-08-30", "30/08/2023", "30.08.23", "30 Aug 2023", "August 30, 2023",
// "20230830", ...) and normalises them to the browser's own date format, the
// same one a native <input type="date"> shows. The value in and out is always
// ISO "YYYY-MM-DD" (or "" when empty), exactly like a native date input, so it
// drops in wherever one was used. The calendar button opens the native picker.

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

function pad(n: number) {
  return String(n).padStart(2, "0");
}

function isoFrom(year: number, month: number, day: number): string | null {
  if (year < 1900 || year > 2100) return null;
  const d = new Date(Date.UTC(year, month - 1, day));
  if (d.getUTCFullYear() !== year || d.getUTCMonth() !== month - 1 || d.getUTCDate() !== day) return null;
  return `${year}-${pad(month)}-${pad(day)}`;
}

function fullYear(y: number, digits: number): number {
  if (digits === 4) return y;
  // Two-digit years: 00-49 -> 2000s, 50-99 -> 1900s (dates of birth vs. recent start dates).
  return y < 50 ? 2000 + y : 1900 + y;
}

// Day/month order of the field's locale, used only when a numeric date is
// ambiguous (e.g. 05/06/2024). Matches what the field displays, so what you see
// is how it's read.
function localeOrder(locale?: string): "dmy" | "mdy" | "ymd" {
  try {
    const parts = new Intl.DateTimeFormat(locale, { year: "numeric", month: "2-digit", day: "2-digit" })
      .formatToParts(new Date(2000, 10, 22))
      .filter((p) => p.type === "day" || p.type === "month" || p.type === "year")
      .map((p) => p.type[0])
      .join("");
    if (parts === "mdy" || parts === "ymd") return parts;
  } catch {
    // fall through
  }
  return "dmy";
}

export function parseDateInput(raw: string, locale?: string): string | null {
  const text = raw.trim().toLowerCase().replace(/(\d)(st|nd|rd|th)\b/g, "$1").replace(/,/g, " ").replace(/\s+/g, " ");
  if (!text) return null;

  // ISO-like, optionally with a time part: 2023-08-30, 2023/8/30, 2023.08.30T10:00
  let m = text.match(/^(\d{4})[-/. ](\d{1,2})[-/. ](\d{1,2})(?:[t ].*)?$/);
  if (m) return isoFrom(+m[1], +m[2], +m[3]);

  // Compact 8 digits: 20230830 or 30082023
  m = text.match(/^(\d{8})$/);
  if (m) {
    const s = m[1];
    return isoFrom(+s.slice(0, 4), +s.slice(4, 6), +s.slice(6, 8)) ?? isoFrom(+s.slice(4, 8), +s.slice(2, 4), +s.slice(0, 2));
  }

  // Numeric with separators: 30/08/2023, 8-30-23, 30.08.2023, 30 08 2023
  m = text.match(/^(\d{1,2})[-/. ](\d{1,2})[-/. ](\d{2}|\d{4})$/);
  if (m) {
    const a = +m[1];
    const b = +m[2];
    const year = fullYear(+m[3], m[3].length);
    if (a > 12) return isoFrom(year, b, a);
    if (b > 12) return isoFrom(year, a, b);
    return localeOrder(locale) === "mdy" ? isoFrom(year, a, b) : isoFrom(year, b, a);
  }

  // Month names, optional weekday: "30 aug 2023", "wed 30 august 2023", "aug 30 2023", "august 30, 2023"
  const words = text.replace(/^(mon|tue|wed|thu|fri|sat|sun)[a-z]*\.? /, "").split(/[ \-/.]+/);
  if (words.length === 3) {
    const monthIndex = (w: string) => (/^[a-z]{3,}$/.test(w) ? MONTHS.indexOf(w.slice(0, 3)) : -1);
    const [w1, w2, w3] = words;
    if (/^\d{2}(\d{2})?$/.test(w3)) {
      const year = fullYear(+w3, w3.length);
      if (monthIndex(w2) >= 0 && /^\d{1,2}$/.test(w1)) return isoFrom(year, monthIndex(w2) + 1, +w1);
      if (monthIndex(w1) >= 0 && /^\d{1,2}$/.test(w2)) return isoFrom(year, monthIndex(w1) + 1, +w2);
    }
    // "2023 aug 30"
    if (/^\d{4}$/.test(w1) && monthIndex(w2) >= 0 && /^\d{1,2}$/.test(w3)) return isoFrom(+w1, monthIndex(w2) + 1, +w3);
  }

  return null;
}

function formatForDisplay(iso: string, locale?: string): string {
  const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return iso;
  try {
    return new Intl.DateTimeFormat(locale, { year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(+m[1], +m[2] - 1, +m[3]));
  } catch {
    return iso;
  }
}

export function DateInput({
  value,
  onChange,
  required,
  disabled,
  min,
  max,
  id,
  "aria-label": ariaLabel,
  locale = APP_LOCALE,
}: {
  value: string;
  onChange: (iso: string) => void;
  required?: boolean;
  disabled?: boolean;
  min?: string;
  max?: string;
  id?: string;
  "aria-label"?: string;
  // BCP 47 tag for how the date is shown and how ambiguous typed dates are
  // read. Defaults to APP_LOCALE (Irish, DD/MM/YYYY).
  locale?: string;
}) {
  const [text, setText] = useState(() => (value ? formatForDisplay(value, locale) : ""));
  const [invalid, setInvalid] = useState(false);
  const focused = useRef(false);
  const textRef = useRef<HTMLInputElement>(null);
  const nativeRef = useRef<HTMLInputElement>(null);

  // Follow outside changes (picker, form reset, data loading) unless the user is mid-edit.
  useEffect(() => {
    if (!focused.current) {
      setText(value ? formatForDisplay(value, locale) : "");
      setInvalid(false);
    }
  }, [value, locale]);

  // Feed the browser's own form validation so an unreadable or out-of-range
  // date blocks submit with a message, like a native date input would.
  useEffect(() => {
    const el = textRef.current;
    if (!el) return;
    let message = "";
    if (invalid) message = "Enter a valid date, e.g. 30/08/2023 or 30 Aug 2023.";
    else if (value && min && value < min) message = `Date must be on or after ${formatForDisplay(min, locale)}.`;
    else if (value && max && value > max) message = `Date must be on or before ${formatForDisplay(max, locale)}.`;
    el.setCustomValidity(message);
  }, [invalid, value, min, max, locale]);

  function commit(raw: string) {
    if (!raw.trim()) {
      setInvalid(false);
      setText("");
      if (value !== "") onChange("");
      return;
    }
    const iso = parseDateInput(raw, locale);
    if (!iso) {
      setInvalid(true);
      return;
    }
    setInvalid(false);
    setText(formatForDisplay(iso, locale));
    if (iso !== value) onChange(iso);
  }

  // The invisible native date input sits right over the calendar icon, so a
  // tap lands on it directly: phones (iOS Safari especially) only open their
  // date picker for a real tap on a date input, not for showPicker()/click()
  // on a hidden one. Desktop browsers don't open the popup when the field's
  // body is clicked, so ask for it explicitly there too.
  function openPicker(e: React.MouseEvent<HTMLInputElement>) {
    try {
      e.currentTarget.showPicker();
    } catch {
      // Already open, or not supported -- the tap itself opens it on phones.
    }
  }

  return (
    <span className={`date-input${invalid ? " is-invalid" : ""}`}>
      <input
        ref={textRef}
        id={id}
        className="date-input-text"
        type="text"
        inputMode="numeric"
        autoComplete="off"
        placeholder={formatForDisplay("2026-12-31", locale).replace("31", "DD").replace("12", "MM").replace("2026", "YYYY")}
        aria-label={ariaLabel}
        aria-invalid={invalid || undefined}
        required={required}
        disabled={disabled}
        value={text}
        onFocus={() => {
          focused.current = true;
        }}
        onBlur={(e) => {
          focused.current = false;
          commit(e.target.value);
        }}
        onChange={(e) => {
          setText(e.target.value);
          if (invalid) setInvalid(false);
        }}
        onPaste={(e) => {
          // Normalise straight away rather than waiting for blur.
          const pasted = e.clipboardData.getData("text");
          if (parseDateInput(pasted, locale)) {
            e.preventDefault();
            commit(pasted);
          }
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") commit(e.currentTarget.value);
        }}
      />
      <span className="date-input-button" aria-hidden="true">
        <Icon name="calendar" size={16} />
      </span>
      <input
        ref={nativeRef}
        className="date-input-native"
        type="date"
        tabIndex={-1}
        aria-label="Open calendar"
        title="Open calendar"
        onClick={openPicker}
        value={value}
        min={min}
        max={max}
        disabled={disabled}
        onChange={(e) => {
          setInvalid(false);
          setText(e.target.value ? formatForDisplay(e.target.value, locale) : "");
          onChange(e.target.value);
        }}
      />
    </span>
  );
}
