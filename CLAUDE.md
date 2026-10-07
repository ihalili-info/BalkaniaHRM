# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Balkania HRM ("balkania-checkin") — a single-tenant HR/attendance product. Employee-facing PWA (clock in/out, breaks, leave, tracking) plus an HR admin portal, backed entirely by Supabase (Postgres + Auth + RLS + Edge Functions). `AVEHR_DEVELOPMENT_GUIDE.md` is the long-term product spec (mobile app, full HR modules, payroll, recruitment); the current repo implements a subset of it as a Next.js web app — treat the guide as direction, not a description of what exists today.

## Commands

```
npm run dev      # start dev server
npm run build    # production build
npm run start    # run production build
npm run lint     # next lint
```

There is no test suite configured in this repo.

Supabase is managed via the Supabase CLI/dashboard, not via npm scripts — migrations live in `supabase/migrations/` (applied in filename/date order) and Edge Functions in `supabase/functions/*/index.ts` (deployed individually with `supabase functions deploy <name>`).

## Architecture

**Three routes, one backend.** `app/page.tsx` (~1.4k lines) is the employee PWA: sign-in, clock in/out, breaks/lunch, leave requests, tracking, holidays, QR code display — one big client component with local screen-state (`Screen` union), not a router-per-page setup. `app/admin/page.tsx` (~4k lines) is the HR/manager portal, same single-big-client-component pattern, gated by `isAdminPortalRole()` (`lib/domain.ts`). `app/kiosk/page.tsx` is the shared-tablet attendance kiosk: pairs with a PIN (`register_attendance_device` / `pair_attendance_device` RPCs), scans employee QR codes, and calls kiosk-scoped RPCs — it never gets employee auth sessions or a service-role key.

**All state changes go through Postgres RPCs, not table writes from the client.** The `lib/*-service.ts` files are thin wrappers around `supabase.rpc(...)` and `supabase.from(...).select(...)` — business rules (valid attendance transitions, leave balance checks, role checks) live in `security definer` Postgres functions in `supabase/migrations/`, not in TypeScript. `lib/attendance.ts` has a client-side mirror of the attendance state machine (`canRecordAttendanceEvent` / `transitionAttendanceState`) used only for UI enable/disable — the server (`record_attendance_event` and friends) is the actual source of truth and re-validates independently.

**Row/role scoping is done in SQL, not in application code.** Migrations define `current_role_is(...)`-style helpers and RLS policies per table; `EmployeeRole` (`lib/domain.ts`) is `employee | team_lead | manager | hr_admin | kiosk`. When adding a feature, the question "who can see/do this" is answered by writing or extending a policy/function in a migration, not by filtering in the frontend.

**Edge Functions are only for operations the anon/authenticated key can't safely do**, primarily anything touching `auth.users` via the service-role key: `create-employee` (invites + provisions `profiles`), `delete-employee`, `purge-employee`, `set-employee-active`, `send-password-reset`. Each verifies the caller's role via a `profiles` lookup using the caller's own JWT before using the admin client — see `supabase/functions/create-employee/index.ts` for the pattern to follow (verify caller → do privileged work → roll back the invited auth user on any downstream failure so it doesn't leave an orphan). `notify-long-breaks` is a scheduled function (no caller to authorize) that emails alerts for prolonged breaks. `supabase/functions/record-attendance/` is an empty leftover directory — attendance recording is done via the `record_attendance_event` RPC directly, not an Edge Function.

**Errors from Supabase are plain objects, not `Error` instances.** postgrest-js/functions-js only produce a real `Error` when `.throwOnError()` is used, which this codebase doesn't. Never write `err instanceof Error` against a Supabase error — duck-type on `.message` instead, matching `errorMessage()` in `lib/errors.ts` (and the same pattern reimplemented in `lib/kiosk-service.ts` for kiosk-specific error prefixes like `KIOSK_SESSION_INVALID:`).

**Supabase client:** `lib/supabase.ts` lazily creates and caches a single browser client from `NEXT_PUBLIC_SUPABASE_URL` / `NEXT_PUBLIC_SUPABASE_ANON_KEY`; every `lib/*-service.ts` calls `createSupabaseBrowserClient()` and throws "Supabase is not configured" if the env vars are missing, rather than crashing.

## Writing Postgres functions/migrations

Two rules learned from production incidents (see `supabase/migrations/20260912_fix_attendance_core_overload.sql` and `20260913_lock_down_internal_helpers.sql`):

1. **`revoke ... from public` does not lock a function down here.** Supabase's default privileges grant EXECUTE to `anon`, `authenticated`, and `service_role` explicitly on every new function, on top of PUBLIC. An internal helper (especially a `security definer` one with no authorization of its own, meant to be called only by a wrapper RPC) needs `revoke all on function public.foo(argtypes) from public, anon, authenticated;` explicitly.
2. **`create or replace function` only replaces a matching argument list** — changing the parameter count creates a silent overload instead of replacing the function. If new params have defaults, existing call sites can become ambiguous and fail at runtime with `function ... is not unique`. When a signature must change, `drop function` the old signature explicitly in the same migration.

Naming convention: migrations are dated `YYYYMMDD_description.sql` and applied in order; several later migrations exist specifically to patch access-control gaps in earlier ones (`..._role_access.sql`, `..._hr_write_access.sql`, `..._lock_down_internal_helpers.sql`) — grants and RLS are treated as append-only fixes, not rewritten in place.

## Supabase access

I don't currently have Supabase credentials configured, so I can't run migrations, query the live database, or deploy Edge Functions myself. If you want me to inspect current schema/data, verify a migration actually applied, or deploy a function, either:
- give me a Supabase access token / project ref (and I can use the Supabase CLI if it's installed), or
- run the command yourself and share the output.

Everything I can do today comes from reading the migration files and code in this repo.
