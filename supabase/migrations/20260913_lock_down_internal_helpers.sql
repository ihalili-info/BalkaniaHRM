-- Follow-up to 20260912. Applies the same lockdown to the remaining internal
-- helpers -- functions that exist only to be called by another function, never
-- by a client.
--
-- Supabase's default privileges grant EXECUTE on every new function in the
-- public schema to anon, authenticated and service_role, so a helper is
-- client-callable unless a migration explicitly says otherwise. Wrapper RPCs
-- are meant to be reachable and do their own authorization; these are not.
--
-- Neither of these is a serious exposure -- see the notes on each -- but both
-- are the same class of oversight that made _record_attendance_event_core
-- callable by anon, and cost nothing to close.

-- SECURITY DEFINER with no authorization of its own, and 20260908 gave it
-- neither a grant nor a revoke. Limited blast radius: it recomputes a
-- payslip's totals from that payslip's own line items and accepts no amounts,
-- so a direct caller can only re-derive figures that already match. It also
-- has no draft-status guard, unlike add_payslip_line_item -- harmless while
-- totals and line items agree, but not something to leave reachable.
revoke all on function public.recompute_payslip_totals(uuid) from public, anon, authenticated;

-- Not SECURITY DEFINER and touches no tables -- it maps an attendance state to
-- the event types allowed next, all from its argument. It leaks nothing, and
-- 20260827 already revoked PUBLIC; this just completes that intent now that we
-- know PUBLIC alone leaves the anon/authenticated grants in place.
revoke all on function public._valid_next_event_types(text) from public, anon, authenticated;
