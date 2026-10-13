"use client";

import { useEffect, useState } from "react";
import "./careers.css";
import { Icon } from "../../components/icons";
import { errorMessage } from "../../lib/errors";
import { EMPLOYMENT_TYPE_LABELS } from "../../lib/recruitment-service";
import { CV_ACCEPT, CV_MAX_BYTES, getPublicJob, listPublicJobs, submitApplication, type PublicJob } from "../../lib/careers-service";

// Public careers page: open jobs and an application form, no sign-in.
// The selected job lives in ?job=<id> so a single posting can be linked to.

function jobIdFromUrl(): string | null {
  return new URLSearchParams(window.location.search).get("job");
}

function jobMeta(job: PublicJob): string {
  return [job.teamName, job.location, EMPLOYMENT_TYPE_LABELS[job.employmentType]].filter(Boolean).join(" · ");
}

export default function CareersPage() {
  const [jobId, setJobId] = useState<string | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    setJobId(jobIdFromUrl());
    setReady(true);
    const onPop = () => setJobId(jobIdFromUrl());
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  function openJob(id: string | null) {
    window.history.pushState(null, "", id ? `/careers?job=${encodeURIComponent(id)}` : "/careers");
    setJobId(id);
    window.scrollTo({ top: 0 });
  }

  return (
    <div className="careers">
      <header className="careers-header">
        <div className="careers-shell careers-header-inner">
          <button className="careers-brand" onClick={() => openJob(null)}>
            <img src="/icon-white.png" alt="" />
            <b>Balkania</b>
            <span>Careers</span>
          </button>
        </div>
      </header>
      <main className="careers-shell careers-main">
        {!ready ? null : jobId ? <JobDetail jobId={jobId} onBack={() => openJob(null)} /> : <JobList onOpen={openJob} />}
      </main>
      <footer className="careers-shell careers-footer">© {new Date().getFullYear()} Balkania</footer>
    </div>
  );
}

function JobList({ onOpen }: { onOpen: (id: string) => void }) {
  const [jobs, setJobs] = useState<PublicJob[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    listPublicJobs()
      .then(setJobs)
      .catch((err) => setError(errorMessage(err, "Couldn't load open positions.")));
  }, []);

  return (
    <>
      <section className="careers-hero">
        <h1>Work with us</h1>
        <p>We&apos;re always looking for good people. Have a look at our open positions and apply in a couple of minutes.</p>
      </section>
      {error ? (
        <div className="careers-notice error">{error}</div>
      ) : !jobs ? (
        <div className="careers-notice"><Icon name="spinner" size={18} className="careers-spin" /> Loading open positions…</div>
      ) : jobs.length === 0 ? (
        <div className="careers-empty">
          <Icon name="briefcase" size={28} />
          <h2>No open positions right now</h2>
          <p>Please check back soon.</p>
        </div>
      ) : (
        <>
          <h2 className="careers-count">{jobs.length} open position{jobs.length === 1 ? "" : "s"}</h2>
          <ul className="careers-list">
            {jobs.map((job) => (
              <li key={job.id}>
                <a
                  href={`/careers?job=${encodeURIComponent(job.id)}`}
                  className="careers-job"
                  onClick={(e) => {
                    e.preventDefault();
                    onOpen(job.id);
                  }}
                >
                  <span>
                    <b>{job.title}</b>
                    <em>{jobMeta(job)}</em>
                  </span>
                  <span className="careers-job-cta">
                    View &amp; apply <Icon name="chevronRight" size={16} />
                  </span>
                </a>
              </li>
            ))}
          </ul>
        </>
      )}
    </>
  );
}

function JobDetail({ jobId, onBack }: { jobId: string; onBack: () => void }) {
  // undefined = loading, null = not found / closed.
  const [job, setJob] = useState<PublicJob | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setJob(undefined);
    setError(null);
    getPublicJob(jobId)
      .then(setJob)
      .catch((err) => setError(errorMessage(err, "Couldn't load this position.")));
  }, [jobId]);

  const back = (
    <button className="careers-back" onClick={onBack}>
      <Icon name="arrowLeft" size={16} /> All positions
    </button>
  );

  if (error) return <>{back}<div className="careers-notice error">{error}</div></>;
  if (job === undefined) return <>{back}<div className="careers-notice"><Icon name="spinner" size={18} className="careers-spin" /> Loading…</div></>;
  if (job === null) {
    return (
      <>
        {back}
        <div className="careers-empty">
          <Icon name="briefcase" size={28} />
          <h2>This position is no longer open</h2>
          <p>It may have been filled. Take a look at our other open positions.</p>
        </div>
      </>
    );
  }

  return (
    <>
      {back}
      <div className="careers-detail">
        <article className="careers-panel">
          <h1>{job.title}</h1>
          <p className="careers-meta">{jobMeta(job)}</p>
          {job.description ? <div className="careers-description">{job.description}</div> : <p className="careers-muted">No further details for this position yet — apply and we&apos;ll tell you more.</p>}
        </article>
        <ApplyForm job={job} />
      </div>
    </>
  );
}

function ApplyForm({ job }: { job: PublicJob }) {
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [cv, setCv] = useState<File | null>(null);
  const [consent, setConsent] = useState(false);
  const [website, setWebsite] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (!cv) {
      setError("Please attach your CV.");
      return;
    }
    if (cv.size > CV_MAX_BYTES) {
      setError("Your CV must be 10 MB or smaller.");
      return;
    }
    setError(null);
    setSending(true);
    try {
      await submitApplication({ jobId: job.id, firstName, lastName, email, phone, cv, consent, website });
      setSent(true);
    } catch (err) {
      setError(errorMessage(err, "We couldn't send your application. Please try again."));
    } finally {
      setSending(false);
    }
  }

  if (sent) {
    return (
      <aside className="careers-panel careers-apply careers-sent" role="status">
        <span className="careers-sent-icon"><Icon name="check" size={26} strokeWidth={2.4} /></span>
        <h2>Application sent</h2>
        <p>Thanks, {firstName.trim()}. We&apos;ve received your application for {job.title} and will be in touch by email.</p>
      </aside>
    );
  }

  return (
    <aside className="careers-panel careers-apply">
      <h2>Apply for this position</h2>
      <form onSubmit={handleSubmit}>
        <div className="careers-row">
          <label>
            Name
            <input required autoComplete="given-name" value={firstName} onChange={(e) => setFirstName(e.target.value)} disabled={sending} />
          </label>
          <label>
            Surname
            <input required autoComplete="family-name" value={lastName} onChange={(e) => setLastName(e.target.value)} disabled={sending} />
          </label>
        </div>
        <label>
          Email
          <input required type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} disabled={sending} />
        </label>
        <label>
          Phone <span className="careers-optional">optional</span>
          <input type="tel" autoComplete="tel" value={phone} onChange={(e) => setPhone(e.target.value)} disabled={sending} />
        </label>
        <label>
          CV
          <span className={`careers-file${cv ? " has-file" : ""}`}>
            <Icon name="upload" size={18} />
            <span>{cv ? cv.name : "Choose a PDF or Word file (max 10 MB)"}</span>
            <input required type="file" accept={CV_ACCEPT} onChange={(e) => setCv(e.target.files?.[0] ?? null)} disabled={sending} />
          </span>
        </label>
        {/* Honeypot: hidden from people, filled in by naive bots. */}
        <label className="careers-hp" aria-hidden="true">
          Website
          <input tabIndex={-1} autoComplete="off" value={website} onChange={(e) => setWebsite(e.target.value)} />
        </label>
        <label className="careers-consent">
          <input type="checkbox" required checked={consent} onChange={(e) => setConsent(e.target.checked)} disabled={sending} />
          <span>I agree that Balkania may store my details and CV to consider my application and contact me about it.</span>
        </label>
        {error && <p className="careers-error" role="alert">{error}</p>}
        <button className="careers-submit" type="submit" disabled={sending}>
          {sending ? <><Icon name="spinner" size={16} className="careers-spin" /> Sending…</> : "Send application"}
        </button>
      </form>
    </aside>
  );
}
