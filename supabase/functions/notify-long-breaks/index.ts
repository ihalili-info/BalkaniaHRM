// Supabase Edge Function: notify-long-breaks
//
// Emails an employee's team lead, manager, and every HR admin when that
// employee has been on their first break longer than the allowed window
// (17 minutes by default). Invoked once a minute by a pg_cron job -- see the
// scheduling block at the bottom of 20260914_break_overrun_alerts.sql.
//
// Not called by a browser, so it authenticates on a shared secret header
// rather than a user JWT, and must be deployed with JWT verification off:
//
//   supabase secrets set BREAK_ALERT_SECRET=... SMTP_HOST=... SMTP_PORT=465 \
//     SMTP_USER=... SMTP_PASS=... SMTP_FROM='HR Balkania <no-reply@balkania.ie>'
//   supabase functions deploy notify-long-breaks --no-verify-jwt
//
// SMTP_* are the same credentials configured under Authentication > Emails >
// SMTP Settings. Auth keeps those internally and does not expose them to
// functions, so they have to be set again here as secrets.

import { createClient } from "jsr:@supabase/supabase-js@2";
import { SMTPClient } from "https://deno.land/x/denomailer@1.6.0/mod.ts";

interface AlertRow {
  session_id: string;
  employee_name: string;
  employee_code: string;
  break_started_at: string;
  minutes_elapsed: number;
  recipient_email: string;
  recipient_name: string;
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function timeOfDay(iso: string) {
  return new Date(iso).toLocaleTimeString("en-IE", {
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "Europe/Dublin",
  });
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const expectedSecret = Deno.env.get("BREAK_ALERT_SECRET");
  if (!expectedSecret) return json({ error: "BREAK_ALERT_SECRET is not configured." }, 500);
  if (req.headers.get("x-alert-secret") !== expectedSecret) {
    return json({ error: "Forbidden" }, 403);
  }

  const thresholdMinutes = Number(Deno.env.get("BREAK_ALERT_MINUTES") ?? 17);

  const adminClient = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    { auth: { autoRefreshToken: false, persistSession: false } },
  );

  const { data, error } = await adminClient.rpc("pending_break_alerts", {
    p_threshold_minutes: thresholdMinutes,
  });
  if (error) return json({ error: error.message }, 500);

  const rows = (data ?? []) as AlertRow[];
  if (rows.length === 0) return json({ alerted: 0, sessions: 0 });

  const smtpHost = Deno.env.get("SMTP_HOST");
  const smtpUser = Deno.env.get("SMTP_USER");
  const smtpPass = Deno.env.get("SMTP_PASS");
  const smtpFrom = Deno.env.get("SMTP_FROM");
  if (!smtpHost || !smtpUser || !smtpPass || !smtpFrom) {
    return json({ error: "SMTP_HOST, SMTP_USER, SMTP_PASS and SMTP_FROM must all be set." }, 500);
  }
  const smtpPort = Number(Deno.env.get("SMTP_PORT") ?? 465);

  const client = new SMTPClient({
    connection: {
      hostname: smtpHost,
      port: smtpPort,
      // 465 is implicit TLS (SMTPS); 587 negotiates STARTTLS instead.
      tls: smtpPort === 465,
      auth: { username: smtpUser, password: smtpPass },
    },
  });

  // A session is marked alerted if at least one recipient was reached. Marking
  // on partial success is deliberate: the alternative is re-sending to
  // everyone who already got it, every minute, until the last address works.
  const deliveredSessions = new Set<string>();
  const failures: string[] = [];

  try {
    for (const row of rows) {
      const subject = `${row.employee_name} has been on break ${row.minutes_elapsed} minutes`;
      const body = [
        `${row.recipient_name},`,
        ``,
        `${row.employee_name} (${row.employee_code}) started their break at ${timeOfDay(row.break_started_at)} and has not clocked back in.`,
        ``,
        `Time on break: ${row.minutes_elapsed} minutes`,
        `Break allowance: ${thresholdMinutes} minutes`,
        ``,
        `This is an automatic notice from Balkania HR. You'll only get one per break.`,
      ].join("\n");

      try {
        await client.send({ from: smtpFrom, to: row.recipient_email, subject, content: body });
        deliveredSessions.add(row.session_id);
      } catch (err) {
        failures.push(`${row.recipient_email}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  } finally {
    await client.close().catch(() => undefined);
  }

  if (deliveredSessions.size > 0) {
    const { error: markError } = await adminClient.rpc("mark_break_alerts_sent", {
      p_session_ids: [...deliveredSessions],
    });
    // Surfaced rather than swallowed: if marking fails the same alerts go out
    // again next minute, which is worth seeing in the function logs.
    if (markError) failures.push(`mark_break_alerts_sent: ${markError.message}`);
  }

  return json({
    sessions: deliveredSessions.size,
    alerted: rows.length - failures.length,
    failures: failures.length ? failures : undefined,
  });
});
