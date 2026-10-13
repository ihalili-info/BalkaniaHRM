import { createSupabaseBrowserClient } from "./supabase";
import type { EmploymentType } from "./recruitment-service";

// Public careers page (/careers). Visitors aren't signed in: reads go through
// the anon-callable list_public_jobs / get_public_job RPCs and applications
// through the submit-application Edge Function (20261013_public_careers.sql).

function client() {
  const supabase = createSupabaseBrowserClient();
  if (!supabase) throw new Error("Supabase is not configured.");
  return supabase;
}

export interface PublicJob {
  id: string;
  title: string;
  teamName: string | null;
  location: string | null;
  employmentType: EmploymentType;
  description: string | null;
  createdAt: string;
}

function mapJob(row: Record<string, unknown>): PublicJob {
  return {
    id: row.id as string,
    title: row.title as string,
    teamName: (row.team_name as string | null) ?? null,
    location: (row.location as string | null) ?? null,
    employmentType: row.employment_type as EmploymentType,
    description: (row.description as string | null) ?? null,
    createdAt: row.created_at as string,
  };
}

export async function listPublicJobs(): Promise<PublicJob[]> {
  const { data, error } = await client().rpc("list_public_jobs");
  if (error) throw error;
  return ((data ?? []) as Array<Record<string, unknown>>).map(mapJob);
}

// Null when the job doesn't exist or is no longer open.
export async function getPublicJob(jobId: string): Promise<PublicJob | null> {
  const { data, error } = await client().rpc("get_public_job", { p_job_id: jobId });
  if (error) throw error;
  const row = ((data ?? []) as Array<Record<string, unknown>>)[0];
  return row ? mapJob(row) : null;
}

export interface ApplicationInput {
  jobId: string;
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  cv: File;
  consent: boolean;
  // Honeypot; always "" from a person.
  website: string;
}

export const CV_ACCEPT = ".pdf,.doc,.docx,application/pdf,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document";
export const CV_MAX_BYTES = 10 * 1024 * 1024;

export async function submitApplication(input: ApplicationInput): Promise<void> {
  const body = new FormData();
  body.set("jobId", input.jobId);
  body.set("firstName", input.firstName.trim());
  body.set("lastName", input.lastName.trim());
  body.set("email", input.email.trim());
  body.set("phone", input.phone.trim());
  body.set("consent", String(input.consent));
  body.set("website", input.website);
  body.set("cv", input.cv);

  const { data, error } = await client().functions.invoke("submit-application", { body });
  if (error) {
    // Supabase errors aren't Error instances; the function's own message is in the response body.
    const context = (error as { context?: Response }).context;
    const payload = await context?.json?.().catch(() => null);
    throw new Error(payload?.error ?? "We couldn't send your application. Please check your connection and try again.");
  }
  if (data?.error) throw new Error(data.error);
}
