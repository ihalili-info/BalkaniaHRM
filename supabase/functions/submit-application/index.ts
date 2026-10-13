// Supabase Edge Function: submit-application
//
// Receives a job application from the public careers page (/careers): the
// applicant isn't signed in, so this runs with the service-role key to create
// the candidate (via create_public_application, which re-checks the job is
// open, rejects duplicates and caps the hourly volume) and upload their CV to
// the private candidate-cvs bucket. If the CV upload fails the candidate row
// is removed again, so HR never sees a half-submitted application.
//
// Then, best-effort, emails HR and the job's hiring team. That reuses the
// SMTP_* secrets from notify-long-breaks; without them applications are still
// saved, just without the email.
//
// Deploy with: supabase functions deploy submit-application
// (JWT verification can stay on: the careers page calls it with the anon key.)

import { createClient } from "jsr:@supabase/supabase-js@2";
import { SMTPClient } from "https://deno.land/x/denomailer@1.6.0/mod.ts";

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

const CV_BUCKET = "candidate-cvs";
const CV_MAX_BYTES = 10 * 1024 * 1024;
const CV_TYPES = [
  "application/pdf",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
];

// Messages from create_public_application meant for the applicant start with
// "APPLY: "; anything else is an internal error and gets a generic message.
function applicantMessage(message: string | undefined): string | null {
  return message?.startsWith("APPLY: ") ? message.slice("APPLY: ".length) : null;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return json({ error: "Invalid request." }, 400);
  }

  const text = (key: string) => String(form.get(key) ?? "").trim();

  // Honeypot: a field hidden from people. Bots that fill every input get a
  // fake success so they don't learn to skip it.
  if (text("website")) return json({ ok: true });

  const jobId = text("jobId");
  const firstName = text("firstName");
  const lastName = text("lastName");
  const email = text("email");
  const phone = text("phone");
  const cv = form.get("cv");

  if (!/^[0-9a-f-]{36}$/i.test(jobId)) return json({ error: "This job couldn't be found." }, 400);
  if (!firstName || !lastName) return json({ error: "Please enter your name and surname." }, 400);
  if (text("consent") !== "true") return json({ error: "Please accept the privacy notice to apply." }, 400);
  if (!(cv instanceof File) || cv.size === 0) return json({ error: "Please attach your CV." }, 400);
  if (!CV_TYPES.includes(cv.type)) return json({ error: "Your CV must be a PDF or Word document." }, 400);
  if (cv.size > CV_MAX_BYTES) return json({ error: "Your CV must be 10 MB or smaller." }, 400);

  const adminClient = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const { data: candidateId, error: createError } = await adminClient.rpc("create_public_application", {
    p_job_id: jobId,
    p_full_name: `${firstName} ${lastName}`,
    p_email: email,
    p_phone: phone,
  });
  if (createError || !candidateId) {
    const message = applicantMessage(createError?.message);
    if (!message) console.error("create_public_application failed", createError);
    return json({ error: message ?? "Something went wrong sending your application. Please try again." }, message ? 400 : 500);
  }

  const safeName = cv.name.replace(/[^\w.\-]+/g, "_").slice(-100);
  const path = `${candidateId}/${Date.now()}-${safeName}`;
  const { error: uploadError } = await adminClient.storage.from(CV_BUCKET).upload(path, cv, { contentType: cv.type });
  const { error: linkError } = uploadError
    ? { error: uploadError }
    : await adminClient.from("candidates").update({ cv_path: path }).eq("id", candidateId);
  if (uploadError || linkError) {
    console.error("CV upload failed", uploadError ?? linkError);
    if (!uploadError) await adminClient.storage.from(CV_BUCKET).remove([path]);
    await adminClient.from("candidates").delete().eq("id", candidateId);
    return json({ error: "We couldn't upload your CV. Please try again." }, 500);
  }

  await notifyHiringTeam(adminClient, jobId, `${firstName} ${lastName}`).catch((err) =>
    console.error("Application email failed", err),
  );

  return json({ ok: true });
});

async function notifyHiringTeam(adminClient: ReturnType<typeof createClient>, jobId: string, applicantName: string) {
  const smtpHost = Deno.env.get("SMTP_HOST");
  const smtpUser = Deno.env.get("SMTP_USER");
  const smtpPass = Deno.env.get("SMTP_PASS");
  const smtpFrom = Deno.env.get("SMTP_FROM");
  if (!smtpHost || !smtpUser || !smtpPass || !smtpFrom) return;
  const smtpPort = Number(Deno.env.get("SMTP_PORT") ?? 465);

  const [{ data: job }, { data: recipients }] = await Promise.all([
    adminClient.from("jobs").select("title").eq("id", jobId).single(),
    adminClient.rpc("application_alert_recipients", { p_job_id: jobId }),
  ]);
  const to = ((recipients ?? []) as Array<{ email: string }>).map((r) => r.email);
  if (to.length === 0) return;

  const client = new SMTPClient({
    connection: { hostname: smtpHost, port: smtpPort, tls: smtpPort === 465, auth: { username: smtpUser, password: smtpPass } },
  });
  try {
    await client.send({
      from: smtpFrom,
      to,
      subject: `New application: ${applicantName} for ${job?.title ?? "a job"}`,
      content: [
        `${applicantName} applied for ${job?.title ?? "a job"} through the careers page.`,
        ``,
        `Their CV and details are under Recruitment in Balkania Admin.`,
      ].join("\n"),
    });
  } finally {
    await client.close().catch(() => undefined);
  }
}
