// Supabase Edge Function: send-password-reset
//
// Sends an employee a password-reset email on their behalf, triggered by HR,
// their manager, or their team lead from the staff directory. Must run
// server-side: the employee's email address lives in auth.users, which is only
// reachable with the service-role key — never expose that key to the browser.
//
// The reset link lands on /welcome, the same page invites use. A Supabase
// recovery link establishes a session exactly like an invite link does, so
// that page's "set your password" flow already handles it unchanged.
//
// Deploy with: supabase functions deploy send-password-reset

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

  // Scoped to the caller's own JWT, used to verify who is calling and to run
  // the can_supervise check as them (it reads auth.uid() internally).
  const callerClient = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: authHeader } },
  });
  const {
    data: { user: caller },
  } = await callerClient.auth.getUser();
  if (!caller) return json({ error: "Authentication required." }, 401);

  let body: { employeeId?: string; redirectTo?: string };
  try {
    body = await req.json();
  } catch {
    return json({ error: "Invalid request body." }, 400);
  }

  const employeeId = body.employeeId?.trim();
  if (!employeeId) return json({ error: "Employee is required." }, 400);

  const adminClient = createClient(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const { data: callerProfile } = await adminClient
    .from("profiles")
    .select("role")
    .eq("id", caller.id)
    .maybeSingle();
  if (!callerProfile) return json({ error: "Your account has no employee profile." }, 403);

  // HR admins can reset anyone. Managers and team leads only people in their
  // own scope, which can_supervise() already defines for every other feature —
  // reusing it keeps this consistent rather than re-deriving the hierarchy.
  if (callerProfile.role !== "hr_admin") {
    if (callerProfile.role !== "manager" && callerProfile.role !== "team_lead") {
      return json({ error: "You aren't allowed to send password resets." }, 403);
    }
    const { data: supervises, error: supervisesError } = await callerClient.rpc("can_supervise", {
      p_employee_id: employeeId,
    });
    if (supervisesError) return json({ error: supervisesError.message }, 400);
    if (!supervises) {
      return json({ error: "You can only reset passwords for people you supervise." }, 403);
    }
  }

  // Resetting your own password goes through the normal "change password"
  // screen, which verifies the current one first.
  if (employeeId === caller.id) {
    return json({ error: "Use the change-password screen for your own account." }, 400);
  }

  const { data: target, error: targetError } = await adminClient.auth.admin.getUserById(employeeId);
  if (targetError || !target.user?.email) {
    return json({ error: "Couldn't find an email address for that employee." }, 404);
  }

  const { error: resetError } = await adminClient.auth.resetPasswordForEmail(target.user.email, {
    redirectTo: body.redirectTo || undefined,
  });
  if (resetError) {
    // Supabase's built-in email service is rate limited to a handful of
    // messages per hour; surface that clearly rather than as a raw 429.
    const rateLimited = resetError.status === 429 || /rate limit/i.test(resetError.message);
    return json(
      {
        error: rateLimited
          ? "Supabase's email rate limit was hit. Wait a few minutes, or configure custom SMTP to lift the limit."
          : resetError.message,
      },
      rateLimited ? 429 : 400,
    );
  }

  return json({ email: target.user.email });
});
