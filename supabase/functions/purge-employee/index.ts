// Supabase Edge Function: purge-employee
//
// Permanently deletes an employee AND all their historical records
// (attendance, leave, disciplinary) plus clears any team/department they
// manage. This is irreversible and destroys audit history that "Delete"
// deliberately refuses to touch -- use Deactivate for normal offboarding.
// Only for genuine cleanup: test data, or an account created by mistake
// that's since accumulated records. Refused while any attendance or leave
// record is inside its legal retention period (3 years; 4 for sick leave).
//
// Deploy with: supabase functions deploy purge-employee

import { createClient } from "jsr:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const authHeader = req.headers.get("Authorization") ?? "";
  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

  const callerClient = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: authHeader } },
  });
  const {
    data: { user: caller },
  } = await callerClient.auth.getUser();
  if (!caller) return json({ error: "Authentication required." }, 401);

  const adminClient = createClient(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const { data: callerProfile } = await adminClient
    .from("profiles")
    .select("role")
    .eq("id", caller.id)
    .maybeSingle();
  if (!callerProfile || callerProfile.role !== "hr_admin") {
    return json({ error: "Only HR administrators can purge employees." }, 403);
  }

  let body: { employeeId?: string };
  try {
    body = await req.json();
  } catch {
    return json({ error: "Invalid request body." }, 400);
  }

  const employeeId = body.employeeId?.trim();
  if (!employeeId) return json({ error: "employeeId is required." }, 400);
  if (employeeId === caller.id) return json({ error: "You can't purge your own account." }, 400);

  // Irish record-keeping: working time and leave records are kept for 3 years
  // (Organisation of Working Time Act 1997, s.25), statutory sick leave for 4
  // (Sick Leave Act 2022). Refuse up front with a clear reason; the
  // _protect_retained_records triggers (20261116_record_retention_and_audit.sql)
  // enforce the same rule in the database whatever the path.
  const threeYearsAgo = new Date();
  threeYearsAgo.setFullYear(threeYearsAgo.getFullYear() - 3);
  const fourYearsAgo = new Date();
  fourYearsAgo.setFullYear(fourYearsAgo.getFullYear() - 4);
  const day = (d: Date) => d.toISOString().slice(0, 10);
  const retained = await Promise.all([
    adminClient.from("attendance_events").select("id", { count: "exact", head: true }).eq("employee_id", employeeId).gt("occurred_at", threeYearsAgo.toISOString()),
    adminClient.from("leave_requests").select("id", { count: "exact", head: true }).eq("employee_id", employeeId).neq("leave_type", "medical").gt("ends_on", day(threeYearsAgo)),
    adminClient.from("leave_requests").select("id", { count: "exact", head: true }).eq("employee_id", employeeId).eq("leave_type", "medical").gt("ends_on", day(fourYearsAgo)),
  ]);
  const retainedError = retained.find((r) => r.error)?.error;
  if (retainedError) return json({ error: `Couldn't check their records: ${retainedError.message}` }, 400);
  const [attendance, leave, sick] = retained.map((r) => r.count ?? 0);
  if (attendance + leave + sick > 0) {
    const parts = [
      attendance ? `${attendance} attendance record${attendance === 1 ? "" : "s"} from the last 3 years` : "",
      leave ? `${leave} leave record${leave === 1 ? "" : "s"} from the last 3 years` : "",
      sick ? `${sick} sick leave record${sick === 1 ? "" : "s"} from the last 4 years` : "",
    ].filter(Boolean);
    return json(
      {
        error: `This employee can't be purged: they have ${parts.join(", ")}, which Irish law requires you to keep (3 years for working time and leave, 4 years for sick leave). Deactivate them instead -- that signs them out and keeps their history.`,
      },
      400,
    );
  }

  const cleanupSteps: Array<[string, () => Promise<{ error: { message: string } | null }>]> = [
    ["attendance events", () => adminClient.from("attendance_events").delete().eq("employee_id", employeeId)],
    ["attendance sessions", () => adminClient.from("attendance_sessions").delete().eq("employee_id", employeeId)],
    ["leave requests", () => adminClient.from("leave_requests").delete().eq("employee_id", employeeId)],
    ["leave balances", () => adminClient.from("leave_balances").delete().eq("employee_id", employeeId)],
    ["disciplinary records", () => adminClient.from("disciplinary_actions").delete().eq("employee_id", employeeId)],
    ["team management", () => adminClient.from("teams").update({ manager_id: null }).eq("manager_id", employeeId)],
    ["department management", () => adminClient.from("departments").update({ manager_id: null }).eq("manager_id", employeeId)],
  ];

  for (const [label, run] of cleanupSteps) {
    const { error } = await run();
    if (error) return json({ error: `Couldn't clear ${label}: ${error.message}` }, 400);
  }

  const { error } = await adminClient.auth.admin.deleteUser(employeeId);
  if (error) {
    return json(
      { error: `Couldn't fully purge this employee: ${error.message}. They may have issued disciplinary actions to other employees, which must be reassigned first.` },
      400,
    );
  }

  return json({ id: employeeId });
});
