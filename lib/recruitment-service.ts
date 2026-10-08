import { createSupabaseBrowserClient } from "./supabase";

function client() {
  const supabase = createSupabaseBrowserClient();
  if (!supabase) throw new Error("Supabase is not configured.");
  return supabase;
}

const CV_BUCKET = "candidate-cvs";

export type JobStatus = "draft" | "open" | "on_hold" | "closed";
export type EmploymentType = "full_time" | "part_time" | "contract" | "temporary" | "internship";
export type CandidateStage = "applied" | "screening" | "interview" | "offer" | "hired" | "rejected";

export const JOB_STATUS_LABELS: Record<JobStatus, string> = {
  draft: "Draft",
  open: "Open",
  on_hold: "On hold",
  closed: "Closed",
};

export const EMPLOYMENT_TYPE_LABELS: Record<EmploymentType, string> = {
  full_time: "Full-time",
  part_time: "Part-time",
  contract: "Contract",
  temporary: "Temporary",
  internship: "Internship",
};

// Pipeline order; also the column order on the job board.
export const CANDIDATE_STAGES: CandidateStage[] = ["applied", "screening", "interview", "offer", "hired", "rejected"];

export const CANDIDATE_STAGE_LABELS: Record<CandidateStage, string> = {
  applied: "Applied",
  screening: "Screening",
  interview: "Interview",
  offer: "Offer",
  hired: "Hired",
  rejected: "Rejected",
};

export interface HiringTeamMember {
  id: string;
  name: string;
}

export interface Job {
  id: string;
  title: string;
  teamId: string | null;
  teamName: string | null;
  location: string | null;
  employmentType: EmploymentType;
  openings: number;
  status: JobStatus;
  description: string | null;
  archived: boolean;
  createdAt: string;
  applicationCount: number;
  hiringTeam: HiringTeamMember[];
}

export async function listJobs(): Promise<Job[]> {
  const { data, error } = await client().rpc("list_jobs");
  if (error) throw error;
  return ((data ?? []) as Array<Record<string, unknown>>).map((row) => ({
    id: row.id as string,
    title: row.title as string,
    teamId: (row.team_id as string | null) ?? null,
    teamName: (row.team_name as string | null) ?? null,
    location: (row.location as string | null) ?? null,
    employmentType: row.employment_type as EmploymentType,
    openings: row.openings as number,
    status: row.status as JobStatus,
    description: (row.description as string | null) ?? null,
    archived: row.archived as boolean,
    createdAt: row.created_at as string,
    applicationCount: Number(row.application_count ?? 0),
    hiringTeam: (row.hiring_team as HiringTeamMember[] | null) ?? [],
  }));
}

export interface JobInput {
  title: string;
  teamId: string | null;
  location: string;
  employmentType: EmploymentType;
  openings: number;
  status: JobStatus;
  description: string;
  hiringTeamIds: string[];
}

function jobRow(input: JobInput) {
  return {
    title: input.title.trim(),
    team_id: input.teamId || null,
    location: input.location.trim() || null,
    employment_type: input.employmentType,
    openings: input.openings,
    status: input.status,
    description: input.description.trim() || null,
  };
}

async function setHiringTeam(jobId: string, profileIds: string[]) {
  const { error } = await client().rpc("set_job_hiring_team", { p_job_id: jobId, p_profile_ids: profileIds });
  if (error) throw error;
}

export async function createJob(input: JobInput): Promise<string> {
  const { data, error } = await client().from("jobs").insert(jobRow(input)).select("id").single();
  if (error) throw error;
  await setHiringTeam(data.id, input.hiringTeamIds);
  return data.id;
}

export async function updateJob(jobId: string, input: JobInput): Promise<void> {
  const { error } = await client()
    .from("jobs")
    .update({ ...jobRow(input), updated_at: new Date().toISOString() })
    .eq("id", jobId);
  if (error) throw error;
  await setHiringTeam(jobId, input.hiringTeamIds);
}

export async function setJobArchived(jobId: string, archived: boolean): Promise<void> {
  const { error } = await client().from("jobs").update({ archived, updated_at: new Date().toISOString() }).eq("id", jobId);
  if (error) throw error;
}

export interface Candidate {
  id: string;
  jobId: string;
  fullName: string;
  email: string | null;
  phone: string | null;
  source: string | null;
  stage: CandidateStage;
  interviewAt: string | null;
  cvPath: string | null;
  hiredEmployeeId: string | null;
  createdAt: string;
}

const CANDIDATE_COLUMNS = "id,job_id,full_name,email,phone,source,stage,interview_at,cv_path,hired_employee_id,created_at";

function mapCandidate(row: {
  id: string;
  job_id: string;
  full_name: string;
  email: string | null;
  phone: string | null;
  source: string | null;
  stage: CandidateStage;
  interview_at: string | null;
  cv_path: string | null;
  hired_employee_id: string | null;
  created_at: string;
}): Candidate {
  return {
    id: row.id,
    jobId: row.job_id,
    fullName: row.full_name,
    email: row.email,
    phone: row.phone,
    source: row.source,
    stage: row.stage,
    interviewAt: row.interview_at,
    cvPath: row.cv_path,
    hiredEmployeeId: row.hired_employee_id,
    createdAt: row.created_at,
  };
}

export async function listCandidates(jobId: string): Promise<Candidate[]> {
  const { data, error } = await client().from("candidates").select(CANDIDATE_COLUMNS).eq("job_id", jobId).order("created_at", { ascending: false });
  if (error) throw error;
  return (data ?? []).map(mapCandidate);
}

export interface CandidateInput {
  fullName: string;
  email: string;
  phone: string;
  source: string;
}

function candidateRow(input: CandidateInput) {
  return {
    full_name: input.fullName.trim(),
    email: input.email.trim().toLowerCase() || null,
    phone: input.phone.trim() || null,
    source: input.source.trim() || null,
  };
}

export async function createCandidate(jobId: string, input: CandidateInput): Promise<Candidate> {
  const { data, error } = await client()
    .from("candidates")
    .insert({ job_id: jobId, ...candidateRow(input) })
    .select(CANDIDATE_COLUMNS)
    .single();
  if (error) throw error;
  return mapCandidate(data);
}

export async function updateCandidate(candidateId: string, input: CandidateInput): Promise<Candidate> {
  const { data, error } = await client()
    .from("candidates")
    .update({ ...candidateRow(input), updated_at: new Date().toISOString() })
    .eq("id", candidateId)
    .select(CANDIDATE_COLUMNS)
    .single();
  if (error) throw error;
  return mapCandidate(data);
}

export async function deleteCandidate(candidate: Candidate): Promise<void> {
  // Remove the CV first: deleting the row would otherwise orphan the file,
  // and nobody could reach it afterwards (access is keyed on the candidate).
  if (candidate.cvPath) {
    const { error: storageError } = await client().storage.from(CV_BUCKET).remove([candidate.cvPath]);
    if (storageError) throw storageError;
  }
  const { error } = await client().from("candidates").delete().eq("id", candidate.id);
  if (error) throw error;
}

export async function setCandidateStage(candidateId: string, stage: CandidateStage, interviewAt: string | null): Promise<Candidate> {
  const { data, error } = await client().rpc("set_candidate_stage", {
    p_candidate_id: candidateId,
    p_stage: stage,
    p_interview_at: interviewAt,
  });
  if (error) throw error;
  return mapCandidate(data);
}

export async function linkHiredEmployee(candidateId: string, employeeId: string): Promise<void> {
  const { error } = await client()
    .from("candidates")
    .update({ hired_employee_id: employeeId, updated_at: new Date().toISOString() })
    .eq("id", candidateId);
  if (error) throw error;
}

const CV_TYPES = [
  "application/pdf",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
];
const CV_MAX_BYTES = 10 * 1024 * 1024;

export async function uploadCandidateCv(candidate: Candidate, file: File): Promise<Candidate> {
  if (!CV_TYPES.includes(file.type)) throw new Error("CVs must be a PDF or Word document.");
  if (file.size > CV_MAX_BYTES) throw new Error("CVs must be 10 MB or smaller.");
  const safeName = file.name.replace(/[^\w.\-]+/g, "_").slice(-100);
  const path = `${candidate.id}/${Date.now()}-${safeName}`;
  const storage = client().storage.from(CV_BUCKET);
  const { error: uploadError } = await storage.upload(path, file, { contentType: file.type });
  if (uploadError) throw uploadError;

  const { data, error } = await client()
    .from("candidates")
    .update({ cv_path: path, updated_at: new Date().toISOString() })
    .eq("id", candidate.id)
    .select(CANDIDATE_COLUMNS)
    .single();
  if (error) {
    await storage.remove([path]);
    throw error;
  }
  if (candidate.cvPath) await storage.remove([candidate.cvPath]);
  return mapCandidate(data);
}

// Short-lived link so a CV URL pasted elsewhere stops working quickly.
export async function getCandidateCvUrl(cvPath: string): Promise<string> {
  const { data, error } = await client().storage.from(CV_BUCKET).createSignedUrl(cvPath, 60);
  if (error) throw error;
  return data.signedUrl;
}

export interface CandidateNote {
  id: string;
  authorId: string;
  authorName: string | null;
  body: string;
  createdAt: string;
}

export async function listCandidateNotes(candidateId: string): Promise<CandidateNote[]> {
  const { data, error } = await client().rpc("list_candidate_notes", { p_candidate_id: candidateId });
  if (error) throw error;
  return ((data ?? []) as Array<{ id: string; author_id: string; author_name: string | null; body: string; created_at: string }>).map((row) => ({
    id: row.id,
    authorId: row.author_id,
    authorName: row.author_name,
    body: row.body,
    createdAt: row.created_at,
  }));
}

export async function addCandidateNote(candidateId: string, body: string): Promise<void> {
  const { error } = await client().rpc("add_candidate_note", { p_candidate_id: candidateId, p_body: body });
  if (error) throw error;
}

export async function deleteCandidateNote(noteId: string): Promise<void> {
  const { error } = await client().from("candidate_notes").delete().eq("id", noteId);
  if (error) throw error;
}
