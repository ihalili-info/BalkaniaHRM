// Supabase Edge Function: employee-email
//
// Reads or changes an employee's sign-in email for HR admins (Edit employee).
// The email lives in auth.users, which is only reachable with the service-role
// key — never expose that key to the browser.
//
//   POST { employeeId }          -> { email }   current address
//   POST { employeeId, email }   -> { email }   change it
//
// The change is applied as already confirmed (no confirmation email to the new
// address): HR is correcting the record, e.g. a typo from an import, and the
// employee may never have signed in. Their password and sessions are unchanged;
// from now on they sign in with the new address.
//
// Deploy with: supabase functions deploy employee-email

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

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const authHeader = req.headers.get("Authorization") ?? "";
  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

  // Client scoped to the caller's own JWT, used only to verify who is calling.
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
    return json({ error: "Only HR administrators can view or change employee emails." }, 403);
  }

  let body: { employeeId?: string; email?: string };
  try {
    body = await req.json();
  } catch {
    return json({ error: "Invalid request body." }, 400);
  }

  const employeeId = body.employeeId?.trim();
  if (!employeeId) return json({ error: "Employee is required." }, 400);

  // Only accounts that are real employee profiles -- not arbitrary auth users.
  const { data: profile } = await adminClient.from("profiles").select("id").eq("id", employeeId).maybeSingle();
  if (!profile) return json({ error: "Employee not found." }, 404);

  const { data: target, error: targetError } = await adminClient.auth.admin.getUserById(employeeId);
  if (targetError || !target.user) return json({ error: "Couldn't find that employee's account." }, 404);

  if (body.email === undefined) {
    return json({ email: target.user.email ?? null });
  }

  const email = body.email.trim().toLowerCase();
  if (!EMAIL_PATTERN.test(email)) return json({ error: "Enter a valid email address." }, 400);
  if (email === target.user.email?.toLowerCase()) return json({ email });

  const { data: updated, error: updateError } = await adminClient.auth.admin.updateUserById(employeeId, {
    email,
    email_confirm: true,
  });
  if (updateError) {
    const taken = /already|registered|exists/i.test(updateError.message);
    return json({ error: taken ? "Another account already uses that email address." : updateError.message }, taken ? 409 : 400);
  }

  return json({ email: updated.user?.email ?? email });
});
