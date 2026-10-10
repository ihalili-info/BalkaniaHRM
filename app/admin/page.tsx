"use client";

import { useEffect, useMemo, useState } from "react";
import "./admin.css";
import { Icon } from "../../components/icons";
import { DateInput } from "../../components/date-input";
import { getCurrentSession, onAuthStateChange, signInWithPassword, signOut, supabaseConfigured } from "../../lib/auth-service";
import { getLeaveBalances, getLeaveRequests, getMyProfile, submitLeaveRequest } from "../../lib/employee-service";
import type { LeaveBalance, LeaveRequestInput, LeaveRequestRecord } from "../../lib/domain";
import { errorMessage } from "../../lib/errors";
import { recordAttendance } from "../../lib/attendance-service";
import { downloadCsv } from "../../lib/csv";
import {
  CANDIDATE_STAGE_LABELS,
  CANDIDATE_STAGES,
  EMPLOYMENT_TYPE_LABELS,
  JOB_STATUS_LABELS,
  addCandidateNote,
  createCandidate,
  createJob,
  deleteCandidate,
  deleteCandidateNote,
  getCandidateCvUrl,
  linkHiredEmployee,
  listCandidateNotes,
  listCandidates,
  listJobs,
  setCandidateStage,
  setJobArchived,
  updateCandidate,
  updateJob,
  uploadCandidateCv,
  type Candidate,
  type CandidateNote,
  type CandidateStage,
  type EmploymentType,
  type Job,
  type JobStatus,
} from "../../lib/recruitment-service";
import {
  importEmployees,
  parseEmployeeRows,
  readEmployeeSheet,
  updateEmployeesFromFile,
  updateSummary,
  type ImportMode,
  type ImportOutcome,
  type ImportRow,
  type ImportTeam,
} from "../../lib/employee-import";
import type { AttendanceEventType, Profile } from "../../lib/domain";
import {
  addHoliday,
  assignAsset,
  cancelLeaveRequest,
  createAsset,
  createAttendanceLocation,
  createEmployee,
  createTeam,
  createWorkSchedule,
  deleteAsset,
  deleteAttendanceDevice,
  deleteEmployee,
  deleteDisciplinaryAction,
  deleteHoliday,
  deleteWorkSchedule,
  getDashboardStats,
  getEmployeeDetails,
  getEmployeeEmail,
  issueDisciplinaryAction,
  listAdminHolidays,
  listAssetHistory,
  listAssets,
  listAttendanceDevices,
  listAttendanceLocations,
  listAttendanceSessions,
  listDisciplinaryActions,
  listEmployees,
  listLeaveBalances,
  listSickLeave,
  currentLeaveYearStart,
  listManagers,
  listPendingLeaveRequests,
  listReviewedLeaveRequests,
  listTeamLeadCandidates,
  listTeams,
  listTimesheet,
  listUpcomingLeave,
  listWorkSchedules,
  purgeEmployee,
  regenerateDevicePin,
  registerDevice,
  returnAsset,
  reviewLeaveRequest,
  seedBankHolidays,
  sendPasswordReset,
  setAssetRetired,
  setDeviceActive,
  setEmployeeActive,
  setLeaveBalance,
  setLeaveEntitlement,
  setOpeningLeaveBalance,
  updateAttendanceLocation,
  updateEmployee,
  updateEmployeeEmail,
  updateTeam,
  upsertEmployeeDetails,
  type AdminAsset,
  type AdminAttendanceLocation,
  type AdminAttendanceSession,
  type AdminDevice,
  type AssetAssignmentRecord,
  type AssetCategory,
  type AssetStatus,
  type AdminDisciplinaryAction,
  type AdminEmployee,
  type AdminHoliday,
  type AdminLeaveBalance,
  type AdminLeaveRequest,
  type AdminManagerOption,
  type AdminTeam,
  type AdminTimesheetRow,
  type AdminWorkSchedule,
  type DashboardStats,
  type DisciplinarySeverity,
  type RegisteredDevice,
} from "../../lib/admin-service";
import {
  addPayslipLineItem,
  createPayrollPeriod,
  deletePayslipLineItem,
  deletePayrollPeriod,
  finalizePayrollPeriod,
  generatePayslips,
  listEmployeeCompensation,
  listPayrollPeriods,
  listPayslipLineItems,
  listPayslips,
  markPayrollPeriodPaid,
  upsertEmployeeCompensation,
  type AdminCompensation,
  type AdminPayrollPeriod,
  type AdminPayslip,
  type AdminPayslipLineItem,
  type PayrollPeriodStatus,
  type PayType,
  type PayslipLineType,
} from "../../lib/payroll-service";

type Module =
  | "dashboard"
  | "organization"
  | "employees"
  | "teams"
  | "documents"
  | "training"
  | "recruitment"
  | "leaves"
  | "holidays"
  | "disciplinary"
  | "performance"
  | "payroll"
  | "attendance"
  | "timesheets"
  | "schedules"
  | "devices"
  | "locations"
  | "assets"
  | "settings"
  | "integrations";
type AuthStatus = "loading" | "signedOut" | "forbidden" | "deactivated" | "signedIn";

type ModuleEntry = [Module, string, Parameters<typeof Icon>[0]["name"]];

const moduleGroups: Array<{ label: string; items: ModuleEntry[] }> = [
  { label: "MAIN", items: [["dashboard", "Dashboard", "layout"]] },
  {
    label: "COMPANY",
    items: [
      ["organization", "Organization", "building"],
      ["employees", "Staff Directory", "user"],
      ["teams", "Teams", "users"],
      ["documents", "Documents", "archive"],
      ["training", "Training & Certifications", "graduationCap"],
    ],
  },
  {
    label: "EMPLOYEES",
    items: [
      ["recruitment", "Recruitment", "userPlus"],
      ["leaves", "Leave management", "calendar"],
      ["holidays", "Bank holidays", "calendar"],
      ["disciplinary", "Disciplinary", "warning"],
      ["performance", "Performance Review", "chart"],
      ["payroll", "Payroll", "creditCard"],
    ],
  },
  {
    label: "OPERATIONS",
    items: [
      ["attendance", "Attendance", "clock"],
      ["timesheets", "Timesheets", "chart"],
      ["schedules", "Work schedules", "swap"],
      ["devices", "Kiosk devices", "device"],
      ["locations", "Attendance locations", "building"],
      ["assets", "Asset Management", "briefcase"],
    ],
  },
  {
    label: "ACCOUNT",
    items: [
      ["settings", "Settings", "settings"],
      ["integrations", "Integrations", "swap"],
    ],
  },
];

const modules: ModuleEntry[] = moduleGroups.flatMap((group) => group.items);

export default function AdminPage() {
  const [status, setStatus] = useState<AuthStatus>("loading");
  const [profile, setProfile] = useState<Profile | null>(null);
  const configured = supabaseConfigured();

  useEffect(() => {
    if (!configured) {
      setStatus("signedOut");
      return;
    }
    let active = true;

    async function evaluate(hasSession: boolean) {
      if (!hasSession) {
        setProfile(null);
        setStatus("signedOut");
        return;
      }
      try {
        const p = await getMyProfile();
        if (!active) return;
        if (p && !p.active) {
          setStatus("deactivated");
        } else if (p && (p.role === "manager" || p.role === "team_lead" || p.role === "hr_admin")) {
          setProfile(p);
          setStatus("signedIn");
        } else {
          setStatus("forbidden");
        }
      } catch {
        if (active) setStatus("forbidden");
      }
    }

    getCurrentSession().then((session) => {
      if (active) void evaluate(!!session);
    });
    const unsubscribe = onAuthStateChange((session) => void evaluate(!!session));
    return () => {
      active = false;
      unsubscribe();
    };
  }, [configured]);

  if (status === "loading") {
    return (
      <main className="admin-auth-screen">
        <Icon name="spinner" size={24} className="spin" />
      </main>
    );
  }

  if (status === "forbidden") {
    return (
      <main className="admin-auth-screen">
        <Icon name="warning" size={36} className="warn-icon" />
        <h1>Access restricted</h1>
        <p className="muted">This portal is limited to managers and HR administrators.</p>
        <button className="outline-button" onClick={() => signOut()}>Sign out</button>
      </main>
    );
  }

  if (status === "deactivated") {
    return (
      <main className="admin-auth-screen">
        <Icon name="warning" size={36} className="warn-icon" />
        <h1>Account deactivated</h1>
        <p className="muted">Your account has been deactivated. Contact another HR administrator if you believe this is a mistake.</p>
        <button className="outline-button" onClick={() => signOut()}>Sign out</button>
      </main>
    );
  }

  if (status !== "signedIn" || !profile) {
    return <AdminLogin configured={configured} />;
  }

  return <AdminShell profile={profile} />;
}

function AdminLogin({ configured }: { configured: boolean }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    setLoading(true);
    try {
      await signInWithPassword(email, password);
    } catch (err) {
      setError(errorMessage(err, "Sign-in failed."));
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="admin-auth-screen">
      <div className="admin-brand"><img src="/icon.png" alt="" /><b>Balkania</b></div>
      <h1>Admin sign-in</h1>
      <p className="muted">Restricted to managers and HR administrators.</p>
      {!configured && (
        <p className="admin-notice warn">
          <Icon name="warning" size={15} /> Supabase environment variables are not set for this deployment.
        </p>
      )}
      <form className="admin-login-form" onSubmit={handleSubmit}>
        <label>
          Work email
          <input type="email" required autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} disabled={!configured} />
        </label>
        <label>
          Password
          <input type="password" required autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} disabled={!configured} />
        </label>
        {error && <p className="form-error"><Icon name="warning" size={14} />{error}</p>}
        <button className="primary-admin" type="submit" disabled={loading || !configured}>{loading ? "Signing in…" : "Sign in"}</button>
      </form>
    </main>
  );
}

// "employees" is included so supervisors can reach the staff directory to send
// password resets. RLS scopes the profiles they can read to their own people,
// and every HR-only action inside the module is gated on isHrAdmin.
// "recruitment" shows supervisors only the jobs HR put them on the hiring team for (RLS).
const MANAGER_MODULES: Module[] = ["attendance", "timesheets", "leaves", "disciplinary", "employees", "recruitment"];

// Modules that only render a "coming in a later release" placeholder. They're
// kept out of the sidebar so the menu only offers things that work; drop an
// entry from this list once its module ships.
const UNBUILT_MODULES: Module[] = ["organization", "documents", "training", "performance", "integrations"];

function AdminShell({ profile }: { profile: Profile }) {
  // Team leads get the same portal view as managers, scoped by RLS to their
  // own team. What differs is authority, not navigation: only a manager can
  // reverse a decided leave request or withdraw a disciplinary action.
  const isManager = profile.role === "manager";
  const isTeamLead = profile.role === "team_lead";
  const isSupervisor = isManager || isTeamLead;
  const visibleGroups = moduleGroups
    .map((group) => ({
      label: group.label,
      items: group.items.filter(([id]) => !UNBUILT_MODULES.includes(id) && (!isSupervisor || MANAGER_MODULES.includes(id))),
    }))
    .filter((group) => group.items.length > 0);
  const [module, setModuleState] = useState<Module>(visibleGroups[0].items[0][0]);
  const [notice, setNotice] = useState("");
  // Below 800px the sidebar becomes an off-canvas drawer opened from the top bar.
  const [navOpen, setNavOpen] = useState(false);
  const currentGroup = moduleGroups.find((group) => group.items.some(([id]) => id === module));

  function setModule(next: Module) {
    setModuleState(next);
    setNavOpen(false);
  }

  useEffect(() => {
    if (!navOpen) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setNavOpen(false);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [navOpen]);

  useEffect(() => {
    if (!notice) return;
    const id = setTimeout(() => setNotice(""), 4500);
    return () => clearTimeout(id);
  }, [notice]);

  return (
    <main className={`admin-shell${navOpen ? " nav-open" : ""}`}>
      <div className="admin-topbar">
        <button className="admin-menu-button" onClick={() => setNavOpen(true)} aria-label="Open menu" aria-expanded={navOpen}>
          <Icon name="menu" size={20} />
        </button>
        <div className="admin-brand"><img src="/icon-white.png" alt="" /><b>Balkania</b></div>
      </div>
      {navOpen && <div className="admin-nav-scrim" onClick={() => setNavOpen(false)} />}
      <aside className="admin-sidebar">
        <div className="admin-sidebar-head">
          <div className="admin-brand"><img src="/icon-white.png" alt="" /><b>Balkania</b></div>
          <button className="admin-menu-button admin-menu-close" onClick={() => setNavOpen(false)} aria-label="Close menu">
            <Icon name="x" size={18} />
          </button>
        </div>
        {visibleGroups.map((group) => (
          <div className="sidebar-group" key={group.label}>
            <p>{group.label}</p>
            {group.items.map(([id, label, icon]) => (
              <button key={id} className={module === id ? "active" : ""} aria-current={module === id ? "page" : undefined} onClick={() => setModule(id)}>
                <Icon name={icon} size={17} />
                {label}
              </button>
            ))}
          </div>
        ))}
        <div className="sidebar-footer">
          <span>Signed in as {profile.fullName}</span>
          <a className="sidebar-signout" href="/?view=employee">
            <Icon name="qr" size={15} /> Check-in view
          </a>
          <button className="sidebar-signout" onClick={() => signOut()}>
            <Icon name="logout" size={15} /> Sign out
          </button>
        </div>
      </aside>
      <section className="admin-main">
        <header className="admin-header">
          <div>
            {currentGroup && currentGroup.label !== "MAIN" && <p className="eyebrow">{currentGroup.label}</p>}
            <h1>{modules.find(([id]) => id === module)?.[1]}</h1>
          </div>
          <div className="admin-actions">
            <span className="avatar" title={`Signed in as ${profile.fullName}`}>{initials(profile.fullName)}</span>
          </div>
        </header>
        {notice && <p className="admin-notice">{notice}</p>}
        {module === "dashboard" && <Dashboard onNavigate={setModule} />}
        {module === "organization" && (
          <EmptyPanel icon="building" title="Organization" note="Company structure, branches, and departments will live here." />
        )}
        {module === "employees" && (
          <Employees setNotice={setNotice} isHrAdmin={profile.role === "hr_admin"} />
        )}
        {module === "teams" && <Teams setNotice={setNotice} />}
        {module === "documents" && (
          <EmptyPanel icon="archive" title="Documents" note="Employee and company document storage is coming in a later release." />
        )}
        {module === "training" && (
          <EmptyPanel icon="graduationCap" title="Training & Certifications" note="Course tracking and certification renewals are coming in a later release." />
        )}
        {module === "recruitment" && (
          <Recruitment setNotice={setNotice} isHrAdmin={profile.role === "hr_admin"} currentUserId={profile.id} />
        )}
        {module === "attendance" && <Attendance setNotice={setNotice} isHrAdmin={profile.role === "hr_admin"} />}
        {module === "timesheets" && <Timesheets setNotice={setNotice} />}
        {module === "leaves" && (
          <Leaves
            setNotice={setNotice}
            isHrAdmin={profile.role === "hr_admin"}
            isManager={isManager}
            isTeamLead={isTeamLead}
            currentUserId={profile.id}
          />
        )}
        {module === "holidays" && <Holidays setNotice={setNotice} />}
        {module === "disciplinary" && (
          <Disciplinary setNotice={setNotice} canWithdraw={profile.role === "hr_admin" || isManager} />
        )}
        {module === "performance" && (
          <EmptyPanel icon="chart" title="Performance Review" note="Goals, reviews, and feedback cycles are coming in a later release." />
        )}
        {module === "payroll" && <Payroll setNotice={setNotice} isHrAdmin={profile.role === "hr_admin"} />}
        {module === "schedules" && <Schedules setNotice={setNotice} />}
        {module === "devices" && <Devices setNotice={setNotice} />}
        {module === "locations" && <AttendanceLocations setNotice={setNotice} />}
        {module === "assets" && <Assets setNotice={setNotice} />}
        {module === "settings" && <Settings setNotice={setNotice} />}
        {module === "integrations" && (
          <EmptyPanel icon="swap" title="Integrations" note="Connect third-party tools once this module is built." />
        )}
      </section>
    </main>
  );
}

type NoticeProps = { setNotice: (value: string) => void };

const ATTENDANCE_GROUPS: Array<{ key: string; label: string; states: string[]; tone: string }> = [
  { key: "working", label: "Working", states: ["working"], tone: "success" },
  { key: "break", label: "On break / lunch", states: ["on_break", "on_lunch"], tone: "pending" },
  { key: "done", label: "Finished", states: ["complete"], tone: "" },
];

function TodayAttendance({ stats }: { stats: DashboardStats }) {
  const timeOf = (iso: string | null) => (iso ? new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "—");
  const grouped = ATTENDANCE_GROUPS.map((g) => ({ ...g, rows: stats.sessions.filter((s) => g.states.includes(s.state)) }));

  return (
    <div className="today-attendance">
      <div className="attendance-chips">
        {grouped.map((g) => (
          <span key={g.key} className={`pill ${g.tone}`}>{g.label}: {g.rows.length}</span>
        ))}
        <span className="pill danger">Not in yet: {stats.notInYet.length}</span>
        <span className="pill">On leave: {stats.onLeave.length}</span>
      </div>

      {stats.sessions.length === 0 ? (
        <p className="muted small">Nobody has clocked in yet today.</p>
      ) : (
        <ul className="attendance-list">
          {grouped.flatMap((g) =>
            g.rows.map((row) => (
              <li key={row.id}>
                <span className="person-cell">
                  <i className="person-dot">{row.employeeName[0]}</i>
                  <span className="person-name">{row.employeeName}</span>
                </span>
                <span className={`pill ${g.tone}`}>{stateLabel(row.state)}</span>
                <span className="muted small">
                  In {timeOf(row.clockedInAt)}{row.clockedOutAt ? ` · Out ${timeOf(row.clockedOutAt)}` : ""}
                </span>
              </li>
            )),
          )}
        </ul>
      )}

      {stats.notInYet.length > 0 && (
        <details className="attendance-missing">
          <summary>Not clocked in yet ({stats.notInYet.length})</summary>
          <p className="muted small">{stats.notInYet.map((e) => e.fullName).join(", ")}</p>
        </details>
      )}
      {stats.onLeave.length > 0 && (
        <p className="muted small">On leave today: {stats.onLeave.map((l) => l.employeeName).join(", ")}</p>
      )}
    </div>
  );
}

function Dashboard({ onNavigate }: { onNavigate: (module: Module) => void }) {
  const [stats, setStats] = useState<DashboardStats | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    getDashboardStats()
      .then((s) => active && setStats(s))
      .catch((err) => active && setError(errorMessage(err, "Couldn't load dashboard data.")));
    return () => {
      active = false;
    };
  }, []);

  if (error) return <ErrorState message={error} />;
  if (!stats) return <LoadingPanel />;

  return (
    <>
      <div className="admin-stats">
        <Stat label="Active employees" value={String(stats.totalEmployees)} note="Excluding kiosk accounts" />
        <Stat label="Working now" value={String(stats.workingNow)} note="Clocked in, incl. breaks" />
        <Stat label="Leave requests" value={String(stats.pendingLeave)} note="Awaiting review" />
        <Stat label="Attendance rate" value={`${stats.attendanceRate}%`} note="Clocked in today, excl. on leave" />
      </div>
      <div className="admin-grid">
        <section className="panel wide">
          <div className="panel-title">
            <h2>Today&apos;s attendance</h2>
            <button onClick={() => onNavigate("attendance")}>View report <Icon name="chevronRight" size={14} /></button>
          </div>
          <TodayAttendance stats={stats} />
        </section>
        <section className="panel">
          <div className="panel-title"><h2>Quick actions</h2></div>
          <button className="quick" onClick={() => onNavigate("employees")}><Icon name="plus" size={15} /> Add employee</button>
          <button className="quick" onClick={() => onNavigate("leaves")}><Icon name="check" size={15} /> Review leave</button>
          <button className="quick" onClick={() => onNavigate("devices")}><Icon name="device" size={15} /> Manage kiosk</button>
        </section>
        <section className="panel">
          <div className="panel-title"><h2>Expiring items</h2></div>
          <p className="muted">No contracts or documents require attention.</p>
        </section>
      </div>
    </>
  );
}

function Employees({ setNotice, isHrAdmin }: NoticeProps & { isHrAdmin: boolean }) {
  const [rows, setRows] = useState<AdminEmployee[] | null>(null);
  const [teams, setTeams] = useState<AdminTeam[]>([]);
  const [tab, setTab] = useState<"active" | "former">("active");
  const [error, setError] = useState<string | null>(null);
  const [showAddModal, setShowAddModal] = useState(false);
  const [showImportModal, setShowImportModal] = useState(false);
  const [search, setSearch] = useState("");
  const [editingEmployee, setEditingEmployee] = useState<AdminEmployee | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);

  function load() {
    listEmployees()
      .then((data) => setRows(data))
      .catch((err) => setError(errorMessage(err, "Couldn't load employees.")));
    // Teams are only used to show every team a manager oversees, so a failure
    // here just falls back to the single team on the profile.
    listTeams()
      .then(setTeams)
      .catch(() => setTeams([]));
  }

  useEffect(() => {
    load();
  }, []);

  // A manager can manage several teams (teams.manager_id), while profiles.team_id
  // holds only the one team they sit on. Show all of them, own team first.
  function teamLabel(row: AdminEmployee): string {
    if (row.role !== "manager") return row.teamName ?? "—";
    const names = teams.filter((t) => t.managerId === row.id).map((t) => t.name);
    if (row.teamName && !names.includes(row.teamName)) names.unshift(row.teamName);
    return names.length > 0 ? names.join(", ") : "—";
  }

  const visibleRows =
    rows?.filter(
      (row) => (tab === "active" ? row.active : !row.active) && matchesSearch(search, row.fullName, row.employeeCode, row.role.replace("_", " "), teamLabel(row)),
    ) ?? null;

  function handleExport() {
    if (!rows || rows.length === 0) {
      setNotice("No employees to export yet.");
      return;
    }
    setExporting(true);
    try {
      downloadCsv(
        `employees-${new Date().toISOString().slice(0, 10)}.csv`,
        ["Full name", "Employee code", "Role", "Team", "Status"],
        rows.map((row) => [row.fullName, row.employeeCode, row.role, teamLabel(row) === "—" ? "" : teamLabel(row), row.active ? "Active" : "Former"]),
      );
    } finally {
      setExporting(false);
    }
  }

  async function handleSendReset(row: AdminEmployee) {
    if (!window.confirm(`Email ${row.fullName} a password reset link? Their current password keeps working until they use it.`)) return;
    setBusyId(row.id);
    try {
      const email = await sendPasswordReset(row.id);
      setNotice(`Password reset sent to ${email}.`);
    } catch (err) {
      setNotice(errorMessage(err, "Couldn't send the reset email."));
    } finally {
      setBusyId(null);
    }
  }

  async function handleToggleActive(row: AdminEmployee) {
    if (row.active && !window.confirm(`Deactivate ${row.fullName}? They'll be signed out immediately, any open attendance session will be automatically clocked out, and they won't be able to sign back in until reactivated.`)) return;
    setBusyId(row.id);
    try {
      await setEmployeeActive(row.id, !row.active);
      setNotice(row.active ? `${row.fullName} was deactivated.` : `${row.fullName} was reactivated.`);
      load();
    } catch (err) {
      setNotice(errorMessage(err, "Couldn't update the employee's status."));
    } finally {
      setBusyId(null);
    }
  }

  async function handleDelete(row: AdminEmployee) {
    if (!window.confirm(`Permanently delete ${row.fullName}? This cannot be undone and is blocked if they have any attendance, leave, or disciplinary history — use Deactivate for former employees instead.`)) return;
    setBusyId(row.id);
    try {
      await deleteEmployee(row.id);
      setNotice(`${row.fullName} was deleted.`);
      load();
    } catch (err) {
      setNotice(errorMessage(err, "Couldn't delete the employee."));
    } finally {
      setBusyId(null);
    }
  }

  async function handlePurge(row: AdminEmployee) {
    if (
      !window.confirm(
        `Permanently purge ${row.fullName}? This deletes their account AND all attendance, leave, and disciplinary records — unlike Delete, this is not blocked by history. This cannot be undone. Only do this for genuine cleanup (e.g. test data), not for normal offboarding — use Deactivate for that.`,
      )
    )
      return;
    setBusyId(row.id);
    try {
      await purgeEmployee(row.id);
      setNotice(`${row.fullName} and all their records were purged.`);
      load();
    } catch (err) {
      setNotice(errorMessage(err, "Couldn't purge the employee."));
    } finally {
      setBusyId(null);
    }
  }

  return (
    <>
      <Toolbar
        action={isHrAdmin ? "Add employee" : undefined}
        onAction={isHrAdmin ? () => setShowAddModal(true) : undefined}
        onExport={handleExport}
        exporting={exporting}
        onImport={isHrAdmin ? () => setShowImportModal(true) : undefined}
        search={search}
        onSearch={setSearch}
        searchPlaceholder="Search name, code, role or team"
      />
      {showImportModal && (
        <ImportEmployeesModal
          existingEmployees={rows?.map((r) => ({ id: r.id, fullName: r.fullName })) ?? []}
          onClose={() => setShowImportModal(false)}
          onDone={() => load()}
        />
      )}
      {isHrAdmin && (
        <div className="module-tabs">
          <button className={tab === "active" ? "active" : ""} onClick={() => setTab("active")}>Active</button>
          <button className={tab === "former" ? "active" : ""} onClick={() => setTab("former")}>Former</button>
        </div>
      )}
      {showAddModal && (
        <AddEmployeeModal
          onClose={() => setShowAddModal(false)}
          onCreated={(employee) => {
            setShowAddModal(false);
            load();
            setNotice(`Invited ${employee.fullName}. They'll receive an email to set their password.`);
          }}
        />
      )}
      {editingEmployee && (
        <EditEmployeeModal
          employee={editingEmployee}
          onClose={() => setEditingEmployee(null)}
          onSaved={(employee) => {
            setEditingEmployee(null);
            load();
            setNotice(`${employee.fullName} was updated.`);
          }}
        />
      )}
      {error ? (
        <ErrorState message={error} />
      ) : !visibleRows ? (
        <LoadingPanel />
      ) : visibleRows.length === 0 ? (
        search.trim() ? (
          <EmptyPanel icon="search" title="No matches" note={`No employees match "${search.trim()}".`} />
        ) : (
          <EmptyPanel
            icon="users"
            title={tab === "active" ? "No employees yet" : "No former employees"}
            note={tab === "active" ? "Add or import employees to see them here." : "Deactivated employees will appear here."}
          />
        )
      ) : (
        <section className="panel">
          <div className="table-head cols-5"><b>Employee</b><b>Code</b><b>Role</b><b>Team</b><b className="actions-head">Actions</b></div>
          {visibleRows.map((row) => (
            <div className="table-row cols-5" key={row.id}>
              <span className="person-cell">
                <i className="person-dot">{row.fullName[0]}</i>
                <span className="person-name">{row.fullName}</span>
                {!row.active && <span className="pill">Inactive</span>}
                {isHrAdmin && !row.active && (
                  <button className="purge-link" disabled={busyId === row.id} onClick={() => handlePurge(row)}>
                    Purge all data
                  </button>
                )}
              </span>
              <span>{row.employeeCode}</span>
              <span className="capitalize">{row.role.replace("_", " ")}</span>
              <span className="team-cell">{teamLabel(row)}</span>
              <span className="row-actions">
                <button
                  className="icon-action"
                  disabled={busyId === row.id || !row.active}
                  onClick={() => handleSendReset(row)}
                  aria-label={`Send ${row.fullName} a password reset`}
                  title={row.active ? "Send password reset" : "Inactive employees can't sign in"}
                >
                  <Icon name="mail" size={15} />
                </button>
                {isHrAdmin && (
                  <>
                    <button className="icon-action" disabled={busyId === row.id} onClick={() => setEditingEmployee(row)} aria-label={`Edit ${row.fullName}`}>
                      <Icon name="edit" size={15} />
                    </button>
                    <button
                      className="icon-action"
                      disabled={busyId === row.id}
                      onClick={() => handleToggleActive(row)}
                      aria-label={row.active ? `Deactivate ${row.fullName}` : `Reactivate ${row.fullName}`}
                    >
                      <Icon name={row.active ? "logout" : "check"} size={15} />
                    </button>
                    <button className="icon-action reject" disabled={busyId === row.id} onClick={() => handleDelete(row)} aria-label={`Delete ${row.fullName}`}>
                      <Icon name="trash" size={15} />
                    </button>
                  </>
                )}
              </span>
            </div>
          ))}
        </section>
      )}
    </>
  );
}

function ImportEmployeesModal({
  existingEmployees,
  onClose,
  onDone,
}: {
  existingEmployees: Array<{ id: string; fullName: string }>;
  onClose: () => void;
  onDone: () => void;
}) {
  const [mode, setMode] = useState<ImportMode>("create");
  // Kept so switching mode re-reads the same file without picking it again.
  const [source, setSource] = useState<{ sheet: unknown[][]; teams: ImportTeam[] } | null>(null);
  const [rows, setRows] = useState<ImportRow[] | null>(null);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [fileError, setFileError] = useState<string | null>(null);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [outcomes, setOutcomes] = useState<ImportOutcome[] | null>(null);
  // Yearly allowances that keep accruing on top of the imported remaining days.
  // Defaults are the Irish statutory minimums for full-time staff (4 working
  // weeks annual leave; 5 days statutory sick leave).
  const [annualEntitlement, setAnnualEntitlement] = useState("20");
  const [sickEntitlement, setSickEntitlement] = useState("5");

  function applyParse(next: { sheet: unknown[][]; teams: ImportTeam[] }, nextMode: ImportMode) {
    setFileError(null);
    try {
      const parsed = parseEmployeeRows(next.sheet, next.teams, existingEmployees, nextMode);
      if (parsed.length === 0) throw new Error("No employee rows found in the file.");
      setRows(parsed);
      // In create mode, rows that may duplicate an existing person start unticked
      // so including them is a conscious choice.
      setSelected(
        new Set(
          parsed
            .filter((r) => r.errors.length === 0 && (nextMode === "update" || !r.warnings.some((w) => w.includes("already in the directory"))))
            .map((r) => r.rowNumber),
        ),
      );
    } catch (err) {
      setRows(null);
      setFileError(errorMessage(err, "Couldn't read that file. Use an .xlsx file."));
    }
  }

  async function handleFile(file: File) {
    setFileError(null);
    setRows(null);
    try {
      const [sheet, teams] = await Promise.all([readEmployeeSheet(file), listTeams()]);
      const next = { sheet, teams };
      setSource(next);
      applyParse(next, mode);
    } catch (err) {
      setFileError(errorMessage(err, "Couldn't read that file. Use an .xlsx file."));
    }
  }

  function switchMode(next: ImportMode) {
    setMode(next);
    if (source) applyParse(source, next);
  }

  function toggle(rowNumber: number) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(rowNumber)) next.delete(rowNumber);
      else next.add(rowNumber);
      return next;
    });
  }

  async function handleImport() {
    if (!rows) return;
    const chosen = rows.filter((r) => selected.has(r.rowNumber) && r.errors.length === 0);
    if (chosen.length === 0) return;
    const annual = Number(annualEntitlement);
    const sick = Number(sickEntitlement);
    if (hasLeaveColumns && (!Number.isFinite(annual) || annual < 0 || !Number.isFinite(sick) || sick < 0)) {
      setFileError("Yearly allowances must be zero or more.");
      return;
    }
    const confirmText =
      mode === "create"
        ? `Create ${chosen.length} employee${chosen.length === 1 ? "" : "s"} and email each of them an invite to set their password? Emails are sent immediately and can't be recalled.`
        : `Update ${chosen.length} existing employee${chosen.length === 1 ? "" : "s"} from the file? Filled-in cells overwrite what's saved now (start date, team, personal details, leave balances); blank cells are left alone. No emails are sent.`;
    if (!window.confirm(confirmText)) return;
    setProgress({ done: 0, total: chosen.length });
    const leave = { annualEntitlement: annual, sickEntitlement: sick };
    const onProgress = (done: number, total: number) => setProgress({ done, total });
    const results = mode === "create" ? await importEmployees(chosen, leave, onProgress) : await updateEmployeesFromFile(chosen, leave, onProgress);
    setOutcomes(results);
    setProgress(null);
    onDone();
  }

  const importing = progress !== null;
  const selectedCount = rows?.filter((r) => selected.has(r.rowNumber) && r.errors.length === 0).length ?? 0;
  const failed = outcomes?.filter((o) => !o.ok) ?? [];
  const warned = outcomes?.filter((o) => o.ok && o.warning) ?? [];
  const hasLeaveColumns = rows?.some((r) => r.annualRemaining !== null || r.sickRemaining !== null) ?? false;

  return (
    <div className="admin-modal-overlay" onClick={importing ? undefined : onClose}>
      <div className="admin-modal wide" onClick={(e) => e.stopPropagation()}>
        <div className="admin-modal-header">
          <h2>Import employees</h2>
          <button className="icon-action" onClick={onClose} disabled={importing} aria-label="Close"><Icon name="x" size={16} /></button>
        </div>

        {outcomes ? (
          <>
            <p>
              <b>{outcomes.length - failed.length}</b> {mode === "create" ? "invited" : "updated"}
              {failed.length > 0 && <>, <b>{failed.length}</b> failed</>}.
            </p>
            {failed.length > 0 && (
              <ul className="import-list">
                {failed.map((o) => (
                  <li key={o.row.rowNumber}>Row {o.row.rowNumber} — {o.row.fullName} ({o.row.email}): {o.message}</li>
                ))}
              </ul>
            )}
            {warned.length > 0 && (
              <>
                <p className="muted small">
                  {mode === "create" ? "Invited" : "Updated"}, but some data needs fixing by hand (Staff Directory or Leave management):
                </p>
                <ul className="import-list">
                  {warned.map((o) => (
                    <li key={o.row.rowNumber}>Row {o.row.rowNumber} — {o.row.fullName}: {o.warning}</li>
                  ))}
                </ul>
              </>
            )}
            <div className="admin-modal-actions">
              <button className="primary-admin" onClick={onClose}>Done</button>
            </div>
          </>
        ) : (
          <>
            <div className="module-tabs import-mode-tabs">
              <button className={mode === "create" ? "active" : ""} onClick={() => switchMode("create")} disabled={importing}>
                Add new employees
              </button>
              <button className={mode === "update" ? "active" : ""} onClick={() => switchMode("update")} disabled={importing}>
                Update existing employees
              </button>
            </div>
            {mode === "update" && (
              <p className="admin-notice warn">
                <Icon name="warning" size={15} />
                Matches rows to people already in the directory by full name and fills in start date, team, date of birth, phone, address
                and leave balances. Blank cells are left unchanged. No invites are sent.
              </p>
            )}
            <p className="muted small">
              Upload an .xlsx file with a heading row. Used columns: Name &amp; Surname (or Name + Surname), Email, Team, Start Date, Date of Birth, Phone Number, Address, City,
              Annual Leave and Sick Leave (days remaining today). Everyone is added as an Employee; other columns (gender, age) are ignored.
            </p>
            <input
              type="file"
              accept=".xlsx"
              disabled={importing}
              onChange={(e) => e.target.files?.[0] && handleFile(e.target.files[0])}
            />
            {fileError && <p className="form-error"><Icon name="warning" size={14} />{fileError}</p>}

            {rows && (
              <>
                <p className="muted small">
                  {rows.length} rows read · {rows.filter((r) => r.errors.length > 0).length} with errors (can&apos;t be imported) · {selectedCount} selected
                </p>
                {hasLeaveColumns && (
                  <div className="admin-login-form import-leave-options">
                    <label>
                      Annual leave allowance <span className="field-optional">days per year</span>
                      <input type="number" min={0} step={0.5} value={annualEntitlement} onChange={(e) => setAnnualEntitlement(e.target.value)} disabled={importing} />
                    </label>
                    <label>
                      Sick leave allowance <span className="field-optional">days per year</span>
                      <input type="number" min={0} step={0.5} value={sickEntitlement} onChange={(e) => setSickEntitlement(e.target.value)} disabled={importing} />
                    </label>
                    <p className="muted small">
                      Each person&apos;s balance today is set to the days in the file. From next month the allowance above keeps adding 1/12 per month,
                      until the leave year resets on 1 April. Blank cells mean no balance is set for that leave type.
                    </p>
                  </div>
                )}
                <div className="import-table">
                  {rows.map((r) => (
                    <label key={r.rowNumber} className={`import-row${r.errors.length ? " has-error" : ""}`}>
                      <input
                        type="checkbox"
                        checked={selected.has(r.rowNumber) && r.errors.length === 0}
                        disabled={r.errors.length > 0 || importing}
                        onChange={() => toggle(r.rowNumber)}
                      />
                      <span>
                        {mode === "create" ? (
                          <>
                            <b>{r.fullName || "(no name)"}</b> · {r.email || "(no email)"} · {r.teamName || "no team"}
                            {r.annualRemaining !== null && <> · {r.annualRemaining} annual</>}
                            {r.sickRemaining !== null && <> · {r.sickRemaining} sick</>}
                          </>
                        ) : (
                          <>
                            <b>{r.fullName || "(no name)"}</b>
                            {r.employeeId && <> → {updateSummary(r).join(", ") || "nothing to update"}</>}
                          </>
                        )}
                        {r.errors.map((m) => <em key={m} className="import-error"> {m}.</em>)}
                        {r.warnings.map((m) => <em key={m} className="import-warning"> {m}.</em>)}
                      </span>
                    </label>
                  ))}
                </div>
              </>
            )}

            <div className="admin-modal-actions">
              <button type="button" className="outline-button" onClick={onClose} disabled={importing}>Cancel</button>
              <button className="primary-admin" onClick={handleImport} disabled={importing || selectedCount === 0}>
                {importing
                  ? `${mode === "create" ? "Inviting" : "Updating"} ${progress!.done}/${progress!.total}…`
                  : mode === "create"
                    ? `Import ${selectedCount || ""} & send invites`
                    : `Update ${selectedCount || ""} employees`}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function AddEmployeeModal({
  onClose,
  onCreated,
  initial,
}: {
  onClose: () => void;
  onCreated: (employee: AdminEmployee) => void;
  // Pre-fill, e.g. when hiring a candidate from Recruitment.
  initial?: { fullName?: string; email?: string; teamId?: string | null; phoneNumber?: string };
}) {
  const [fullName, setFullName] = useState(initial?.fullName ?? "");
  const [email, setEmail] = useState(initial?.email ?? "");
  const [role, setRole] = useState("employee");
  const [teamId, setTeamId] = useState(initial?.teamId ?? "");
  const [teams, setTeams] = useState<AdminTeam[]>([]);
  const [attendanceLocationId, setAttendanceLocationId] = useState("");
  const [attendanceLocations, setAttendanceLocations] = useState<AdminAttendanceLocation[]>([]);
  const [selfServiceAttendance, setSelfServiceAttendance] = useState(false);
  const [startDate, setStartDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [ppsNumber, setPpsNumber] = useState("");
  const [dateOfBirth, setDateOfBirth] = useState("");
  const [phoneNumber, setPhoneNumber] = useState(initial?.phoneNumber ?? "");
  const [address, setAddress] = useState("");
  const [placeOfBirth, setPlaceOfBirth] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    listTeams()
      .then(setTeams)
      .catch(() => setTeams([]));
    listAttendanceLocations()
      .then(setAttendanceLocations)
      .catch(() => setAttendanceLocations([]));
  }, []);

  const teamRequired = role !== "kiosk";

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (teamRequired && !teamId) {
      setError("Choose a team.");
      return;
    }
    setError(null);
    setSaving(true);
    try {
      const employee = await createEmployee({
        fullName,
        email,
        role,
        teamId: teamId || null,
        attendanceLocationId: attendanceLocationId || null,
        selfServiceAttendance,
        startDate,
        ppsNumber,
        dateOfBirth,
        phoneNumber,
        address,
        placeOfBirth,
      });
      onCreated(employee);
    } catch (err) {
      setError(errorMessage(err, "Couldn't create the employee."));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="admin-modal-overlay" onClick={onClose}>
      <div className="admin-modal wide" onClick={(e) => e.stopPropagation()}>
        <div className="admin-modal-header">
          <h2>Add employee</h2>
          <button className="icon-action" onClick={onClose} aria-label="Close"><Icon name="x" size={16} /></button>
        </div>
        <p className="muted small">Creates a profile and emails an invite so they can set their password. Employee code is generated automatically.</p>
        <form className="admin-login-form" onSubmit={handleSubmit}>
          <h3 className="form-section">Employment</h3>
          <label>
            Full name
            <input required value={fullName} onChange={(e) => setFullName(e.target.value)} disabled={saving} />
          </label>
          <label>
            Work email
            <input type="email" required autoComplete="off" value={email} onChange={(e) => setEmail(e.target.value)} disabled={saving} />
          </label>
          <label>
            Role
            <select value={role} onChange={(e) => setRole(e.target.value)} disabled={saving}>
              <option value="employee">Employee</option>
              <option value="team_lead">Team lead</option>
              <option value="manager">Manager</option>
              <option value="hr_admin">HR admin</option>
              <option value="kiosk">Kiosk</option>
            </select>
          </label>
          {teamRequired && (
            <label>
              Team
              <select required value={teamId} onChange={(e) => setTeamId(e.target.value)} disabled={saving}>
                <option value="">Select a team</option>
                {teams.map((t) => (
                  <option key={t.id} value={t.id}>{t.name}</option>
                ))}
              </select>
            </label>
          )}
          <label>
            Start date
            <DateInput required value={startDate} onChange={setStartDate} disabled={saving} />
            <small className="field-hint">Leave accrues from this date — use their actual first day.</small>
          </label>
          <label>
            Attendance location <span className="field-optional">optional</span>
            <select value={attendanceLocationId} onChange={(e) => setAttendanceLocationId(e.target.value)} disabled={saving}>
              <option value="">Unassigned</option>
              {attendanceLocations.map((l) => (
                <option key={l.id} value={l.id}>{l.name}</option>
              ))}
            </select>
            <small className="field-hint">Needed for &quot;office&quot; clock-in from the app, to confirm they&apos;re nearby.</small>
          </label>
          <label className="checkbox-row">
            <input type="checkbox" checked={selfServiceAttendance} onChange={(e) => setSelfServiceAttendance(e.target.checked)} disabled={saving} />
            <span>
              Allow self-service clock-in (skip the kiosk)
              <small className="field-hint">Off by default — everyone else clocks in at the shared kiosk. Turn on for remote or trusted staff.</small>
            </span>
          </label>
          <h3 className="form-section">Personal details <span className="field-optional">optional — can be completed later</span></h3>
          <label>
            PPS number
            <input value={ppsNumber} onChange={(e) => setPpsNumber(e.target.value)} disabled={saving} placeholder="1234567A" />
          </label>
          <label>
            Date of birth
            <DateInput value={dateOfBirth} onChange={setDateOfBirth} disabled={saving} />
          </label>
          <label>
            Phone number
            <input type="tel" value={phoneNumber} onChange={(e) => setPhoneNumber(e.target.value)} disabled={saving} placeholder="+353 1 234 5678" />
          </label>
          <label>
            Place of birth
            <input value={placeOfBirth} onChange={(e) => setPlaceOfBirth(e.target.value)} disabled={saving} />
          </label>
          <label>
            Address
            <textarea value={address} onChange={(e) => setAddress(e.target.value)} disabled={saving} rows={2} />
          </label>
          {error && <p className="form-error"><Icon name="warning" size={14} />{error}</p>}
          <div className="admin-modal-actions">
            <button type="button" className="outline-button" onClick={onClose} disabled={saving}>Cancel</button>
            <button className="primary-admin" type="submit" disabled={saving}>{saving ? "Sending invite…" : "Send invite"}</button>
          </div>
        </form>
      </div>
    </div>
  );
}

function EditEmployeeModal({
  employee,
  onClose,
  onSaved,
}: {
  employee: AdminEmployee;
  onClose: () => void;
  onSaved: (employee: AdminEmployee) => void;
}) {
  const [fullName, setFullName] = useState(employee.fullName);
  const [employeeCode, setEmployeeCode] = useState(employee.employeeCode);
  const [role, setRole] = useState(employee.role);
  const [teamId, setTeamId] = useState(employee.teamId ?? "");
  const [teams, setTeams] = useState<AdminTeam[]>([]);
  const [attendanceLocationId, setAttendanceLocationId] = useState(employee.attendanceLocationId ?? "");
  const [attendanceLocations, setAttendanceLocations] = useState<AdminAttendanceLocation[]>([]);
  const [selfServiceAttendance, setSelfServiceAttendance] = useState(employee.selfServiceAttendance);
  const [startDate, setStartDate] = useState(employee.startDate ?? "");
  const [ppsNumber, setPpsNumber] = useState("");
  const [dateOfBirth, setDateOfBirth] = useState("");
  const [phoneNumber, setPhoneNumber] = useState("");
  const [address, setAddress] = useState("");
  const [placeOfBirth, setPlaceOfBirth] = useState("");
  // Sign-in email from auth.users: null while loading, "" if it couldn't be read.
  const [originalEmail, setOriginalEmail] = useState<string | null>(null);
  const [email, setEmail] = useState("");
  const [emailLoadError, setEmailLoadError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    listTeams()
      .then(setTeams)
      .catch(() => setTeams([]));
    listAttendanceLocations()
      .then(setAttendanceLocations)
      .catch(() => setAttendanceLocations([]));
    getEmployeeEmail(employee.id)
      .then((current) => {
        setOriginalEmail(current ?? "");
        setEmail(current ?? "");
      })
      .catch((err) => {
        setOriginalEmail("");
        setEmailLoadError(errorMessage(err, "Couldn't load the current email."));
      });
    getEmployeeDetails(employee.id)
      .then((details) => {
        setPpsNumber(details.ppsNumber ?? "");
        setDateOfBirth(details.dateOfBirth ?? "");
        setPhoneNumber(details.phoneNumber ?? "");
        setAddress(details.address ?? "");
        setPlaceOfBirth(details.placeOfBirth ?? "");
      })
      .catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [employee.id]);

  const emailChanged = originalEmail !== null && !emailLoadError && email.trim().toLowerCase() !== originalEmail.toLowerCase();

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    if (
      emailChanged &&
      !window.confirm(`Change ${employee.fullName}'s sign-in email to ${email.trim()}? They'll sign in with the new address from now on; their password stays the same.`)
    ) {
      return;
    }
    setSaving(true);
    try {
      if (emailChanged) {
        const saved = await updateEmployeeEmail(employee.id, email);
        setOriginalEmail(saved);
        setEmail(saved);
      }
      const updated = await updateEmployee({
        id: employee.id,
        fullName,
        employeeCode,
        role,
        teamId: teamId || null,
        attendanceLocationId: attendanceLocationId || null,
        selfServiceAttendance,
        startDate: startDate || undefined,
      });
      await upsertEmployeeDetails(employee.id, { ppsNumber, dateOfBirth, phoneNumber, address, placeOfBirth });
      onSaved(updated);
    } catch (err) {
      setError(errorMessage(err, "Couldn't save changes."));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="admin-modal-overlay" onClick={onClose}>
      <div className="admin-modal wide" onClick={(e) => e.stopPropagation()}>
        <div className="admin-modal-header">
          <h2>Edit employee</h2>
          <button className="icon-action" onClick={onClose} aria-label="Close"><Icon name="x" size={16} /></button>
        </div>
        <form className="admin-login-form" onSubmit={handleSubmit}>
          <h3 className="form-section">Employment</h3>
          <label>
            Full name
            <input required value={fullName} onChange={(e) => setFullName(e.target.value)} disabled={saving} />
          </label>
          <label>
            Work email
            <input
              type="email"
              required={!emailLoadError}
              autoComplete="off"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              disabled={saving || originalEmail === null || !!emailLoadError}
              placeholder={originalEmail === null ? "Loading…" : undefined}
            />
            {emailLoadError ? (
              <small className="field-hint">{emailLoadError}</small>
            ) : (
              emailChanged && <small className="field-hint">They&apos;ll sign in with this address once you save.</small>
            )}
          </label>
          <label>
            Employee code
            <input required value={employeeCode} onChange={(e) => setEmployeeCode(e.target.value)} disabled={saving} />
          </label>
          <label>
            Role
            <select value={role} onChange={(e) => setRole(e.target.value)} disabled={saving}>
              <option value="employee">Employee</option>
              <option value="team_lead">Team lead</option>
              <option value="manager">Manager</option>
              <option value="hr_admin">HR admin</option>
              <option value="kiosk">Kiosk</option>
            </select>
          </label>
          <label>
            Team
            <select value={teamId} onChange={(e) => setTeamId(e.target.value)} disabled={saving}>
              <option value="">No team</option>
              {teams.map((t) => (
                <option key={t.id} value={t.id}>{t.name}</option>
              ))}
            </select>
          </label>
          <label>
            Start date
            <DateInput required value={startDate} onChange={setStartDate} disabled={saving} />
            <small className="field-hint">Leave accrues from this date.</small>
          </label>
          <label>
            Attendance location <span className="field-optional">optional</span>
            <select value={attendanceLocationId} onChange={(e) => setAttendanceLocationId(e.target.value)} disabled={saving}>
              <option value="">Unassigned</option>
              {attendanceLocations.map((l) => (
                <option key={l.id} value={l.id}>{l.name}</option>
              ))}
            </select>
            <small className="field-hint">Needed for &quot;office&quot; clock-in from the app.</small>
          </label>
          <label className="checkbox-row">
            <input type="checkbox" checked={selfServiceAttendance} onChange={(e) => setSelfServiceAttendance(e.target.checked)} disabled={saving} />
            <span>
              Allow self-service clock-in (skip the kiosk)
              <small className="field-hint">Off by default — everyone else clocks in at the shared kiosk.</small>
            </span>
          </label>
          <h3 className="form-section">Personal details</h3>
          <label>
            PPS number
            <input value={ppsNumber} onChange={(e) => setPpsNumber(e.target.value)} disabled={saving} placeholder="1234567A" />
          </label>
          <label>
            Date of birth
            <DateInput value={dateOfBirth} onChange={setDateOfBirth} disabled={saving} />
          </label>
          <label>
            Phone number
            <input type="tel" value={phoneNumber} onChange={(e) => setPhoneNumber(e.target.value)} disabled={saving} placeholder="+353 1 234 5678" />
          </label>
          <label>
            Place of birth
            <input value={placeOfBirth} onChange={(e) => setPlaceOfBirth(e.target.value)} disabled={saving} />
          </label>
          <label>
            Address
            <textarea value={address} onChange={(e) => setAddress(e.target.value)} disabled={saving} rows={2} />
          </label>
          {error && <p className="form-error"><Icon name="warning" size={14} />{error}</p>}
          <div className="admin-modal-actions">
            <button type="button" className="outline-button" onClick={onClose} disabled={saving}>Cancel</button>
            <button className="primary-admin" type="submit" disabled={saving}>{saving ? "Saving…" : "Save changes"}</button>
          </div>
        </form>
      </div>
    </div>
  );
}

function Teams({ setNotice }: NoticeProps) {
  const [teams, setTeams] = useState<AdminTeam[] | null>(null);
  const [employees, setEmployees] = useState<AdminEmployee[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [showModal, setShowModal] = useState(false);
  const [editingTeam, setEditingTeam] = useState<AdminTeam | null>(null);
  const [search, setSearch] = useState("");

  function load() {
    Promise.all([listTeams(), listEmployees()])
      .then(([teamRows, employeeRows]) => {
        setTeams(teamRows);
        setEmployees(employeeRows);
      })
      .catch((err) => setError(errorMessage(err, "Couldn't load teams.")));
  }

  useEffect(() => {
    load();
  }, []);

  const memberCounts = employees.filter((e) => e.active).reduce<Record<string, number>>((acc, e) => {
    if (e.teamId) acc[e.teamId] = (acc[e.teamId] ?? 0) + 1;
    return acc;
  }, {});

  return (
    <>
      <Toolbar action="Create team" onAction={() => setShowModal(true)} search={search} onSearch={setSearch} searchPlaceholder="Search teams, leads or managers" />
      {showModal && (
        <CreateTeamModal
          onClose={() => setShowModal(false)}
          onCreated={(team) => {
            setShowModal(false);
            setNotice(`Team "${team.name}" created.`);
            load();
          }}
        />
      )}
      {editingTeam && (
        <EditTeamModal
          team={editingTeam}
          onClose={() => setEditingTeam(null)}
          onSaved={(team) => {
            setEditingTeam(null);
            setNotice(`Team "${team.name}" was updated.`);
            load();
          }}
        />
      )}
      {error ? (
        <ErrorState message={error} />
      ) : !teams ? (
        <LoadingPanel />
      ) : teams.length === 0 ? (
        <EmptyPanel icon="users" title="No teams yet" note="Create a team and assign a manager so employees can be added to it." />
      ) : (
        <section className="panel">
          <div className="table-head cols-5"><b>Team</b><b>Team lead</b><b>Manager</b><b>Members</b><b className="actions-head">Actions</b></div>
          {teams.filter((team) => matchesSearch(search, team.name, team.teamLeadName, team.managerName)).map((team) => (
            <div className="table-row cols-5" key={team.id}>
              <span>{team.name}</span>
              <span>{team.teamLeadName ?? <span className="pill pending">No lead</span>}</span>
              <span>{team.managerName ?? <span className="pill pending">No manager</span>}</span>
              <span>{memberCounts[team.id] ?? 0}</span>
              <span className="row-actions">
                <button className="icon-action" onClick={() => setEditingTeam(team)} aria-label={`Edit ${team.name}`}>
                  <Icon name="edit" size={15} />
                </button>
              </span>
            </div>
          ))}
        </section>
      )}
    </>
  );
}

function CreateTeamModal({ onClose, onCreated }: { onClose: () => void; onCreated: (team: AdminTeam) => void }) {
  const [name, setName] = useState("");
  const [managerId, setManagerId] = useState("");
  const [teamLeadId, setTeamLeadId] = useState("");
  const [managers, setManagers] = useState<AdminManagerOption[]>([]);
  const [leadCandidates, setLeadCandidates] = useState<AdminManagerOption[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    listManagers()
      .then(setManagers)
      .catch(() => setManagers([]));
    listTeamLeadCandidates()
      .then(setLeadCandidates)
      .catch(() => setLeadCandidates([]));
  }, []);

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (teamLeadId && teamLeadId === managerId) {
      setError("The team lead and manager must be different people — a manager can't override their own decisions.");
      return;
    }
    setError(null);
    setSaving(true);
    try {
      const team = await createTeam({ name, managerId: managerId || null, teamLeadId: teamLeadId || null });
      onCreated(team);
    } catch (err) {
      setError(errorMessage(err, "Couldn't create the team."));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="admin-modal-overlay" onClick={onClose}>
      <div className="admin-modal" onClick={(e) => e.stopPropagation()}>
        <div className="admin-modal-header">
          <h2>Create team</h2>
          <button className="icon-action" onClick={onClose} aria-label="Close"><Icon name="x" size={16} /></button>
        </div>
        <p className="muted small">The team lead handles this team day to day. The manager sits above them and can reverse a lead&apos;s leave decision.</p>
        <form className="admin-login-form" onSubmit={handleSubmit}>
          <label>
            Team name
            <input required value={name} onChange={(e) => setName(e.target.value)} disabled={saving} />
          </label>
          <label>
            Team lead
            <select value={teamLeadId} onChange={(e) => setTeamLeadId(e.target.value)} disabled={saving}>
              <option value="">Assign later</option>
              {leadCandidates.map((m) => (
                <option key={m.id} value={m.id}>{m.fullName}</option>
              ))}
            </select>
          </label>
          <label>
            Manager
            <select value={managerId} onChange={(e) => setManagerId(e.target.value)} disabled={saving}>
              <option value="">Assign later</option>
              {managers.map((m) => (
                <option key={m.id} value={m.id}>{m.fullName}</option>
              ))}
            </select>
          </label>
          {error && <p className="form-error"><Icon name="warning" size={14} />{error}</p>}
          <div className="admin-modal-actions">
            <button type="button" className="outline-button" onClick={onClose} disabled={saving}>Cancel</button>
            <button className="primary-admin" type="submit" disabled={saving}>{saving ? "Creating…" : "Create team"}</button>
          </div>
        </form>
      </div>
    </div>
  );
}

function EditTeamModal({
  team,
  onClose,
  onSaved,
}: {
  team: AdminTeam;
  onClose: () => void;
  onSaved: (team: AdminTeam) => void;
}) {
  const [name, setName] = useState(team.name);
  const [managerId, setManagerId] = useState(team.managerId ?? "");
  const [teamLeadId, setTeamLeadId] = useState(team.teamLeadId ?? "");
  const [managers, setManagers] = useState<AdminManagerOption[]>([]);
  const [leadCandidates, setLeadCandidates] = useState<AdminManagerOption[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    listManagers()
      .then(setManagers)
      .catch(() => setManagers([]));
    listTeamLeadCandidates()
      .then(setLeadCandidates)
      .catch(() => setLeadCandidates([]));
  }, []);

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (teamLeadId && teamLeadId === managerId) {
      setError("The team lead and manager must be different people — a manager can't override their own decisions.");
      return;
    }
    setError(null);
    setSaving(true);
    try {
      const updated = await updateTeam({ id: team.id, name, managerId: managerId || null, teamLeadId: teamLeadId || null });
      onSaved(updated);
    } catch (err) {
      setError(errorMessage(err, "Couldn't save changes."));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="admin-modal-overlay" onClick={onClose}>
      <div className="admin-modal" onClick={(e) => e.stopPropagation()}>
        <div className="admin-modal-header">
          <h2>Edit team</h2>
          <button className="icon-action" onClick={onClose} aria-label="Close"><Icon name="x" size={16} /></button>
        </div>
        <form className="admin-login-form" onSubmit={handleSubmit}>
          <label>
            Team name
            <input required value={name} onChange={(e) => setName(e.target.value)} disabled={saving} />
          </label>
          <label>
            Team lead
            <select value={teamLeadId} onChange={(e) => setTeamLeadId(e.target.value)} disabled={saving}>
              <option value="">Unassigned</option>
              {leadCandidates.map((m) => (
                <option key={m.id} value={m.id}>{m.fullName}</option>
              ))}
            </select>
          </label>
          <label>
            Manager
            <select value={managerId} onChange={(e) => setManagerId(e.target.value)} disabled={saving}>
              <option value="">Unassigned</option>
              {managers.map((m) => (
                <option key={m.id} value={m.id}>{m.fullName}</option>
              ))}
            </select>
          </label>
          {error && <p className="form-error"><Icon name="warning" size={14} />{error}</p>}
          <div className="admin-modal-actions">
            <button type="button" className="outline-button" onClick={onClose} disabled={saving}>Cancel</button>
            <button className="primary-admin" type="submit" disabled={saving}>{saving ? "Saving…" : "Save changes"}</button>
          </div>
        </form>
      </div>
    </div>
  );
}

function Attendance({ setNotice, isHrAdmin }: NoticeProps & { isHrAdmin: boolean }) {
  const [rows, setRows] = useState<AdminAttendanceSession[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
  const [showRecordModal, setShowRecordModal] = useState(false);
  const today = new Date().toISOString().slice(0, 10);

  function load() {
    listAttendanceSessions(today)
      .then(setRows)
      .catch((err) => setError(errorMessage(err, "Couldn't load attendance.")));
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [today]);

  const working = rows?.filter((r) => r.state === "working" || r.state === "on_break" || r.state === "on_lunch").length ?? 0;
  const complete = rows?.filter((r) => r.state === "complete").length ?? 0;

  function handleExport() {
    if (!rows || rows.length === 0) {
      setNotice("No attendance records to export yet.");
      return;
    }
    setExporting(true);
    try {
      downloadCsv(
        `attendance-${today}.csv`,
        ["Employee", "Employee code", "Clock in", "Clock out", "Status"],
        rows.map((row) => [row.employeeName, row.employeeCode, row.clockedInAt ?? "", row.clockedOutAt ?? "", row.state]),
      );
    } finally {
      setExporting(false);
    }
  }

  return (
    <>
      <Toolbar
        action={isHrAdmin ? "Record attendance" : "Review exceptions"}
        onAction={() =>
          isHrAdmin
            ? setShowRecordModal(true)
            : setNotice("Attendance exceptions are drawn from attendance_sessions and attendance_events.")
        }
        onExport={handleExport}
        exporting={exporting}
      />
      {showRecordModal && (
        <RecordAttendanceModal
          onClose={() => setShowRecordModal(false)}
          onRecorded={(employeeName) => {
            setShowRecordModal(false);
            setNotice(`Attendance recorded for ${employeeName}.`);
            load();
          }}
        />
      )}
      <div className="admin-stats">
        <Stat label="Currently working" value={String(working)} note="Live sessions" />
        <Stat label="Work completed" value={String(complete)} note="Today" />
        <Stat label="Total sessions" value={String(rows?.length ?? 0)} note="Today" />
      </div>
      {error ? (
        <ErrorState message={error} />
      ) : !rows ? (
        <LoadingPanel />
      ) : rows.length === 0 ? (
        <EmptyPanel icon="clock" title="No attendance yet today" note="Records will appear as employees clock in." />
      ) : (
        <section className="panel">
          <div className="panel-title"><h2>Attendance records</h2><span className="filter">Today</span></div>
          <div className="table-head"><b>Employee</b><b>Clock in</b><b>Clock out</b><b>Status</b></div>
          {rows.map((row) => (
            <div className="table-row" key={row.id}>
              <span>{row.employeeName}</span>
              <span>{row.clockedInAt ? formatTime(row.clockedInAt) : "--:--"}</span>
              <span>{row.clockedOutAt ? formatTime(row.clockedOutAt) : "--:--"}</span>
              <span className="row-actions">
                <span className={`pill ${row.state === "complete" ? "success" : row.state === "not_started" ? "" : "pending"}`}>{stateLabel(row.state)}</span>
                {row.locationStatus === "out_of_range" && <span className="pill danger">Off-site</span>}
                {row.locationStatus === "unavailable" && <span className="pill pending">Unverified</span>}
              </span>
            </div>
          ))}
        </section>
      )}
    </>
  );
}

const attendanceEventOptions: Array<[AttendanceEventType, string]> = [
  ["clock_in", "🟢 Clock in"],
  ["clock_out", "🔴 Clock out"],
  ["break_start", "☕ First break start"],
  ["break_end", "▶️ First break end"],
  ["lunch_start", "🍽️ Lunch start"],
  ["lunch_end", "▶️ Lunch end"],
];

function RecordAttendanceModal({ onClose, onRecorded }: { onClose: () => void; onRecorded: (employeeName: string) => void }) {
  const [employees, setEmployees] = useState<AdminEmployee[]>([]);
  const [employeeId, setEmployeeId] = useState("");
  const [eventType, setEventType] = useState<AttendanceEventType>("clock_in");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    listEmployees()
      .then((data) => setEmployees(data.filter((e) => e.active)))
      .catch(() => setEmployees([]));
  }, []);

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (!employeeId) {
      setError("Choose an employee.");
      return;
    }
    setError(null);
    setSaving(true);
    try {
      await recordAttendance({ eventType, idempotencyKey: crypto.randomUUID(), source: "admin", employeeId });
      const employee = employees.find((e) => e.id === employeeId);
      onRecorded(employee?.fullName ?? "employee");
    } catch (err) {
      setError(errorMessage(err, "Couldn't record attendance."));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="admin-modal-overlay" onClick={onClose}>
      <div className="admin-modal" onClick={(e) => e.stopPropagation()}>
        <div className="admin-modal-header">
          <h2>Record attendance</h2>
          <button className="icon-action" onClick={onClose} aria-label="Close"><Icon name="x" size={16} /></button>
        </div>
        <p className="muted small">Records the event for today, exactly as if the employee had done it themselves.</p>
        <form className="admin-login-form" onSubmit={handleSubmit}>
          <label>
            Employee
            <select required value={employeeId} onChange={(e) => setEmployeeId(e.target.value)} disabled={saving}>
              <option value="">Select an employee</option>
              {employees.map((e) => (
                <option key={e.id} value={e.id}>{e.fullName}</option>
              ))}
            </select>
          </label>
          <label>
            Action
            <select value={eventType} onChange={(e) => setEventType(e.target.value as AttendanceEventType)} disabled={saving}>
              {attendanceEventOptions.map(([value, label]) => (
                <option key={value} value={value}>{label}</option>
              ))}
            </select>
          </label>
          {error && <p className="form-error"><Icon name="warning" size={14} />{error}</p>}
          <div className="admin-modal-actions">
            <button type="button" className="outline-button" onClick={onClose} disabled={saving}>Cancel</button>
            <button className="primary-admin" type="submit" disabled={saving}>{saving ? "Recording…" : "Record"}</button>
          </div>
        </form>
      </div>
    </div>
  );
}

// Only counts spans that both started *and* ended. A break still running is
// deliberately excluded, matching what hoursWorked has always done -- so
// worked + break + lunch always reconciles against the clock-in/out span.
function spanHours(start: string | null, end: string | null): number {
  if (!start || !end) return 0;
  return Math.max(0, (new Date(end).getTime() - new Date(start).getTime()) / 3600000);
}

function breakHours(row: AdminTimesheetRow): number {
  return spanHours(row.firstBreakStartedAt, row.firstBreakEndedAt);
}

function lunchHours(row: AdminTimesheetRow): number {
  return spanHours(row.lunchStartedAt, row.lunchEndedAt);
}

function hoursWorked(row: AdminTimesheetRow): number {
  if (!row.clockedInAt) return 0;
  const end = row.clockedOutAt ? new Date(row.clockedOutAt) : new Date();
  const ms = end.getTime() - new Date(row.clockedInAt).getTime();
  return Math.max(0, ms / 3600000 - breakHours(row) - lunchHours(row));
}

// Breaks are usually minutes, not hours, so "17m" reads better than "0.3h".
function formatDurationHours(hours: number): string {
  const totalMinutes = Math.round(hours * 60);
  if (totalMinutes <= 0) return "—";
  const h = Math.floor(totalMinutes / 60);
  const m = totalMinutes % 60;
  return h ? `${h}h ${m}m` : `${m}m`;
}

interface EmployeeTimesheetSummary {
  employeeId: string;
  employeeName: string;
  employeeCode: string;
  days: number;
  hours: number;
  breakHours: number;
  lunchHours: number;
}

function Timesheets({ setNotice }: NoticeProps) {
  const now = new Date();
  const [startDate, setStartDate] = useState(() => new Date(now.getFullYear(), now.getMonth(), 1).toISOString().slice(0, 10));
  const [endDate, setEndDate] = useState(() => now.toISOString().slice(0, 10));
  const [rows, setRows] = useState<AdminTimesheetRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);

  function load() {
    setRows(null);
    listTimesheet(startDate, endDate)
      .then(setRows)
      .catch((err) => setError(errorMessage(err, "Couldn't load the timesheet.")));
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [startDate, endDate]);

  const summaries: EmployeeTimesheetSummary[] = [];
  if (rows) {
    const byEmployee = new Map<string, EmployeeTimesheetSummary>();
    for (const row of rows) {
      const existing = byEmployee.get(row.employeeId);
      const hours = hoursWorked(row);
      const breaks = breakHours(row);
      const lunch = lunchHours(row);
      if (existing) {
        existing.days += 1;
        existing.hours += hours;
        existing.breakHours += breaks;
        existing.lunchHours += lunch;
      } else {
        byEmployee.set(row.employeeId, {
          employeeId: row.employeeId,
          employeeName: row.employeeName,
          employeeCode: row.employeeCode,
          days: 1,
          hours,
          breakHours: breaks,
          lunchHours: lunch,
        });
      }
    }
    summaries.push(...Array.from(byEmployee.values()).sort((a, b) => a.employeeName.localeCompare(b.employeeName)));
  }
  const totalHours = summaries.reduce((sum, s) => sum + s.hours, 0);
  const totalBreakHours = summaries.reduce((sum, s) => sum + s.breakHours, 0);
  const totalLunchHours = summaries.reduce((sum, s) => sum + s.lunchHours, 0);

  function handleExport() {
    if (!rows || rows.length === 0) {
      setNotice("No timesheet records to export for this range.");
      return;
    }
    setExporting(true);
    try {
      downloadCsv(
        `timesheet-${startDate}-to-${endDate}.csv`,
        ["Employee", "Employee code", "Date", "Clock in", "Clock out", "Worked hours", "Break minutes", "Lunch minutes"],
        rows.map((row) => [
          row.employeeName,
          row.employeeCode,
          row.workDate,
          row.clockedInAt ? formatTime(row.clockedInAt) : "",
          row.clockedOutAt ? formatTime(row.clockedOutAt) : "",
          Math.round(hoursWorked(row) * 100) / 100,
          Math.round(breakHours(row) * 60),
          Math.round(lunchHours(row) * 60),
        ]),
      );
    } finally {
      setExporting(false);
    }
  }

  return (
    <>
      <div className="toolbar">
        <button className="outline-button" onClick={handleExport} disabled={exporting}>
          <Icon name="download" size={15} /> {exporting ? "Exporting…" : "Export CSV"}
        </button>
      </div>
      <div className="timesheet-range">
        <label>
          From
          <DateInput value={startDate} max={endDate} onChange={setStartDate} />
        </label>
        <label>
          To
          <DateInput value={endDate} min={startDate} onChange={setEndDate} />
        </label>
      </div>
      <div className="admin-stats">
        <Stat label="Employees" value={String(summaries.length)} note="In range" />
        <Stat label="Worked hours" value={totalHours.toFixed(1)} note={summaries.length ? `${(totalHours / summaries.length).toFixed(1)} avg. per employee` : "All employees"} />
        <Stat label="Break time" value={formatDurationHours(totalBreakHours)} note="All employees" />
        <Stat label="Lunch time" value={formatDurationHours(totalLunchHours)} note="All employees" />
      </div>
      {error ? (
        <ErrorState message={error} />
      ) : !rows ? (
        <LoadingPanel />
      ) : summaries.length === 0 ? (
        <EmptyPanel icon="chart" title="No attendance in this range" note="Adjust the date range to see recorded hours." />
      ) : (
        <section className="panel">
          <div className="panel-title"><h2>Timesheet overview</h2><span className="filter">{formatDate(startDate)} – {formatDate(endDate)}</span></div>
          <div className="table-head cols-6">
            <b>Employee</b><b>Employee code</b><b>Days worked</b><b>Worked</b><b>Break</b><b>Lunch</b>
          </div>
          {summaries.map((summary) => (
            <div className="table-row cols-6" key={summary.employeeId}>
              <span>{summary.employeeName}</span>
              <span>{summary.employeeCode}</span>
              <span>{summary.days}</span>
              <span>{summary.hours.toFixed(1)}h</span>
              <span>{formatDurationHours(summary.breakHours)}</span>
              <span>{formatDurationHours(summary.lunchHours)}</span>
            </div>
          ))}
        </section>
      )}
    </>
  );
}

type LeaveTypeFilterValue = "all" | "annual" | "medical" | "unpaid" | "other";

const LEAVE_TYPE_FILTERS: Array<[LeaveTypeFilterValue, string]> = [
  ["all", "All types"],
  ["annual", "Annual"],
  ["medical", "Sick"],
  ["unpaid", "Unpaid"],
  ["other", "Other"],
];

function matchesLeaveType(leaveType: string, filter: LeaveTypeFilterValue) {
  return filter === "all" || leaveType === filter;
}

function leaveTypeFilterLabel(filter: LeaveTypeFilterValue) {
  return filter === "all" ? "leave" : filter === "medical" ? "sick leave" : `${filter} leave`;
}

function LeaveTypeFilter({ value, onChange }: { value: LeaveTypeFilterValue; onChange: (value: LeaveTypeFilterValue) => void }) {
  return (
    <div className="type-filter" role="group" aria-label="Filter by leave type">
      {LEAVE_TYPE_FILTERS.map(([key, label]) => (
        <button key={key} className={value === key ? "active" : ""} aria-pressed={value === key} onClick={() => onChange(key)}>
          {label}
        </button>
      ))}
    </div>
  );
}

// Calendar days, inclusive -- the same count the server uses for balances.
function leaveDays(row: { startsOn: string; endsOn: string }) {
  return Math.round((Date.parse(`${row.endsOn}T00:00:00Z`) - Date.parse(`${row.startsOn}T00:00:00Z`)) / 86400000) + 1;
}

// Per-employee sick leave for the current leave year (1 April onward).
// "Occasions" counts approved sick requests, each request being one absence.
function SickLeaveReport() {
  const [rows, setRows] = useState<AdminLeaveRequest[] | null>(null);
  const [balances, setBalances] = useState<AdminLeaveBalance[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [expanded, setExpanded] = useState<string | null>(null);
  const yearStart = currentLeaveYearStart();

  useEffect(() => {
    listSickLeave(yearStart)
      .then(setRows)
      .catch((err) => setError(errorMessage(err, "Couldn't load sick leave.")));
    // Remaining sick days are a nice-to-have; the report works without them.
    listLeaveBalances()
      .then(setBalances)
      .catch(() => setBalances([]));
  }, [yearStart]);

  const people = useMemo(() => {
    const byEmployee = new Map<string, { employeeId: string; employeeName: string; entries: AdminLeaveRequest[] }>();
    for (const row of rows ?? []) {
      const entry = byEmployee.get(row.employeeId) ?? { employeeId: row.employeeId, employeeName: row.employeeName, entries: [] };
      entry.entries.push(row);
      byEmployee.set(row.employeeId, entry);
    }
    return [...byEmployee.values()]
      .map((p) => {
        const approved = p.entries.filter((e) => e.status === "approved");
        const sickBalance = balances.find((b) => b.employeeId === p.employeeId && b.leaveType === "medical");
        return {
          ...p,
          daysTaken: approved.reduce((sum, e) => sum + leaveDays(e), 0),
          occasions: approved.length,
          pendingDays: p.entries.filter((e) => e.status === "pending").reduce((sum, e) => sum + leaveDays(e), 0),
          lastSickDay: approved.reduce<string | null>((latest, e) => (!latest || e.endsOn > latest ? e.endsOn : latest), null),
          remaining: sickBalance ? sickBalance.earned - sickBalance.used : null,
        };
      })
      .sort((a, b) => b.daysTaken - a.daysTaken || a.employeeName.localeCompare(b.employeeName));
  }, [rows, balances]);

  const visible = people.filter((p) => matchesSearch(search, p.employeeName));
  const totals = {
    days: people.reduce((sum, p) => sum + p.daysTaken, 0),
    people: people.filter((p) => p.daysTaken > 0).length,
    pending: (rows ?? []).filter((r) => r.status === "pending").length,
  };

  function handleExport() {
    if (!rows || rows.length === 0) return;
    downloadCsv(
      `sick-leave-${yearStart.slice(0, 4)}-${new Date().toISOString().slice(0, 10)}.csv`,
      ["Employee", "From", "To", "Days", "Status"],
      [...rows]
        .sort((a, b) => a.employeeName.localeCompare(b.employeeName) || a.startsOn.localeCompare(b.startsOn))
        .map((r) => [r.employeeName, r.startsOn, r.endsOn, leaveDays(r), r.status]),
    );
  }

  return (
    <>
      <div className="admin-stats">
        <Stat label="Sick days taken" value={formatLeaveDays(totals.days)} note={`Approved, since ${formatDate(yearStart)}`} />
        <Stat label="Employees off sick" value={String(totals.people)} note="At least one sick day this leave year" />
        <Stat label="Pending sick requests" value={String(totals.pending)} note="Awaiting a decision" />
      </div>
      <Toolbar
        onExport={rows && rows.length > 0 ? handleExport : undefined}
        search={search}
        onSearch={setSearch}
        searchPlaceholder="Search employee"
      />
      {error ? (
        <ErrorState message={error} />
      ) : !rows ? (
        <LoadingPanel />
      ) : people.length === 0 ? (
        <EmptyPanel icon="calendar" title="No sick leave this leave year" note={`Sick days declared since ${formatDate(yearStart)} will appear here.`} />
      ) : (
        <section className="panel">
          <div className="table-head cols-6">
            <b>Employee</b><b>Days taken</b><b>Occasions</b><b>Last sick day</b><b>Sick days left</b><b className="actions-head">Details</b>
          </div>
          {visible.map((p) => (
            <div key={p.employeeId} className="sick-person">
              <div className="table-row cols-6">
                <span className="person-cell">
                  <i className="person-dot">{p.employeeName[0]}</i>
                  <span className="person-name">{p.employeeName}</span>
                </span>
                <span>
                  <b>{formatLeaveDays(p.daysTaken)}</b>
                  {p.pendingDays > 0 && <em className="asset-sub">+{p.pendingDays} pending</em>}
                </span>
                <span>{p.occasions}</span>
                <span>{p.lastSickDay ? formatDate(p.lastSickDay) : "—"}</span>
                <span>{p.remaining === null ? "—" : formatLeaveDays(p.remaining)}</span>
                <span className="row-actions">
                  <button
                    className="icon-action"
                    onClick={() => setExpanded(expanded === p.employeeId ? null : p.employeeId)}
                    aria-expanded={expanded === p.employeeId}
                    aria-label={`${expanded === p.employeeId ? "Hide" : "Show"} ${p.employeeName}'s sick days`}
                  >
                    <Icon name="chevronRight" size={15} className={expanded === p.employeeId ? "rotate-90" : undefined} />
                  </button>
                </span>
              </div>
              {expanded === p.employeeId && (
                <ul className="sick-entries">
                  {p.entries.map((e) => (
                    <li key={e.id}>
                      <span>{formatDate(e.startsOn)}{e.endsOn !== e.startsOn ? ` – ${formatDate(e.endsOn)}` : ""}</span>
                      <span className="muted small">{leaveDays(e)} day{leaveDays(e) === 1 ? "" : "s"}</span>
                      <span className={`pill ${leaveStatusClass(e.status)}`}>{e.status}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          ))}
        </section>
      )}
    </>
  );
}

function Leaves({
  setNotice,
  isHrAdmin,
  isManager,
  isTeamLead,
  currentUserId,
}: NoticeProps & { isHrAdmin: boolean; isManager: boolean; isTeamLead: boolean; currentUserId: string }) {
  const [view, setView] = useState<"requests" | "upcoming" | "decided" | "sick" | "entitlements">("requests");
  // Shared by Requests / Upcoming / Decided so it sticks when switching tabs.
  const [typeFilter, setTypeFilter] = useState<LeaveTypeFilterValue>("all");
  const showTabs = isHrAdmin || isManager || isTeamLead;
  // Only a manager (or HR) can revisit a decision -- a team lead can't undo
  // their own call, which is what the server enforces too.
  const canOverride = isHrAdmin || isManager;

  return (
    <>
      {showTabs && (
        <div className="module-tabs">
          <button className={view === "requests" ? "active" : ""} onClick={() => setView("requests")}>Requests</button>
          <button className={view === "upcoming" ? "active" : ""} onClick={() => setView("upcoming")}>Upcoming leave</button>
          <button className={view === "decided" ? "active" : ""} onClick={() => setView("decided")}>Decided</button>
          <button className={view === "sick" ? "active" : ""} onClick={() => setView("sick")}>Sick leave</button>
          {isHrAdmin && (
            <button className={view === "entitlements" ? "active" : ""} onClick={() => setView("entitlements")}>Entitlements</button>
          )}
        </div>
      )}
      {(!showTabs || view === "requests" || view === "upcoming" || view === "decided") && (
        <LeaveTypeFilter value={typeFilter} onChange={setTypeFilter} />
      )}
      {showTabs && view === "upcoming" ? (
        <UpcomingLeave typeFilter={typeFilter} />
      ) : showTabs && view === "decided" ? (
        <DecidedLeave setNotice={setNotice} canOverride={canOverride} isHrAdmin={isHrAdmin} typeFilter={typeFilter} />
      ) : showTabs && view === "sick" ? (
        <SickLeaveReport />
      ) : isHrAdmin && view === "entitlements" ? (
        <LeaveEntitlements setNotice={setNotice} />
      ) : (
        <LeaveRequests setNotice={setNotice} isHrAdmin={isHrAdmin} currentUserId={currentUserId} typeFilter={typeFilter} />
      )}
    </>
  );
}

function DecidedLeave({
  setNotice,
  canOverride,
  isHrAdmin,
  typeFilter,
}: NoticeProps & { canOverride: boolean; isHrAdmin: boolean; typeFilter: LeaveTypeFilterValue }) {
  const [rows, setRows] = useState<AdminLeaveRequest[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  function load() {
    listReviewedLeaveRequests()
      .then(setRows)
      .catch((err) => setError(errorMessage(err, "Couldn't load decided leave requests.")));
  }

  useEffect(() => {
    load();
  }, []);

  async function cancel(row: AdminLeaveRequest) {
    const refunds = row.status === "approved";
    const reason = window.prompt(
      `Cancel ${row.employeeName}'s ${row.leaveType} leave (${formatDate(row.startsOn)} – ${formatDate(row.endsOn)})?` +
        (refunds ? "\n\nThe days go back to their balance." : "\n\nThis was rejected, so no days change hands.") +
        "\n\nOptional reason for the record:",
      "",
    );
    if (reason === null) return;
    setBusyId(row.id);
    try {
      await cancelLeaveRequest(row.id, reason);
      setNotice(
        refunds
          ? `${row.employeeName}'s leave was cancelled and the days returned to their balance.`
          : `${row.employeeName}'s leave request was cancelled.`,
      );
      load();
    } catch (err) {
      setNotice(errorMessage(err, "Couldn't cancel the request."));
    } finally {
      setBusyId(null);
    }
  }

  async function override(row: AdminLeaveRequest, status: "approved" | "rejected") {
    const verb = status === "approved" ? "Approve" : "Reject";
    if (!window.confirm(`${verb} ${row.employeeName}'s ${row.leaveType} leave instead? This reverses the earlier decision and adjusts their balance.`)) return;
    setBusyId(row.id);
    try {
      await reviewLeaveRequest(row.id, status);
      setNotice(`${row.employeeName}'s leave request is now ${status}.`);
      load();
    } catch (err) {
      setNotice(errorMessage(err, "Couldn't change the decision."));
    } finally {
      setBusyId(null);
    }
  }

  return error ? (
    <ErrorState message={error} />
  ) : !rows ? (
    <LoadingPanel />
  ) : rows.length === 0 ? (
    <EmptyPanel icon="calendar" title="Nothing decided yet" note="Approved and rejected requests appear here." />
  ) : rows.filter((r) => matchesLeaveType(r.leaveType, typeFilter)).length === 0 ? (
    <EmptyPanel icon="calendar" title={`No decided ${leaveTypeFilterLabel(typeFilter)}`} note="Try another leave type." />
  ) : (
    <section className="panel">
      <div className="panel-title">
        <h2>Decided requests</h2>
        {canOverride && <span className="filter">You can reverse a decision</span>}
      </div>
      <div className="table-head"><b>Employee</b><b>Leave type</b><b>Dates</b><b>{canOverride ? "Decision" : "Status"}</b></div>
      {rows.filter((r) => matchesLeaveType(r.leaveType, typeFilter)).map((row) => (
        <div className="table-row" key={row.id}>
          <span>{row.employeeName}</span>
          <span>{leaveTypeLabel(row.leaveType)}</span>
          <span>{formatDate(row.startsOn)} – {formatDate(row.endsOn)}</span>
          {canOverride || isHrAdmin ? (
            <span className="row-actions">
              <span className={`pill ${leaveStatusClass(row.status)}`}>{row.status}</span>
              {canOverride && (
                <button
                  className={`icon-action ${row.status === "approved" ? "reject" : "approve"}`}
                  disabled={busyId === row.id}
                  onClick={() => override(row, row.status === "approved" ? "rejected" : "approved")}
                  aria-label={`Change ${row.employeeName}'s leave to ${row.status === "approved" ? "rejected" : "approved"}`}
                  title={row.status === "approved" ? "Reverse to rejected" : "Reverse to approved"}
                >
                  <Icon name="swap" size={15} />
                </button>
              )}
              {isHrAdmin && (
                <button
                  className="icon-action reject"
                  disabled={busyId === row.id}
                  onClick={() => cancel(row)}
                  aria-label={`Cancel ${row.employeeName}'s leave`}
                  title={row.status === "approved" ? "Cancel and return the days" : "Cancel this request"}
                >
                  <Icon name="trash" size={15} />
                </button>
              )}
            </span>
          ) : (
            <span className={`pill ${leaveStatusClass(row.status)}`}>{row.status}</span>
          )}
        </div>
      ))}
    </section>
  );
}

function UpcomingLeave({ typeFilter }: { typeFilter: LeaveTypeFilterValue }) {
  const [rows, setRows] = useState<AdminLeaveRequest[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    listUpcomingLeave()
      .then(setRows)
      .catch((err) => setError(errorMessage(err, "Couldn't load upcoming leave.")));
  }, []);

  return error ? (
    <ErrorState message={error} />
  ) : !rows ? (
    <LoadingPanel />
  ) : rows.length === 0 ? (
    <EmptyPanel icon="calendar" title="No upcoming leave" note="Approved and pending leave from today onward will appear here." />
  ) : rows.filter((r) => matchesLeaveType(r.leaveType, typeFilter)).length === 0 ? (
    <EmptyPanel icon="calendar" title={`No upcoming ${leaveTypeFilterLabel(typeFilter)}`} note="Try another leave type." />
  ) : (
    <section className="panel">
      <div className="table-head"><b>Employee</b><b>Leave type</b><b>Dates</b><b>Status</b></div>
      {rows.filter((r) => matchesLeaveType(r.leaveType, typeFilter)).map((row) => (
        <div className="table-row" key={row.id}>
          <span>{row.employeeName}</span>
          <span>{leaveTypeLabel(row.leaveType)}</span>
          <span>{formatDate(row.startsOn)} – {formatDate(row.endsOn)}</span>
          <span className={`pill ${leaveStatusClass(row.status)}`}>{row.status}</span>
        </div>
      ))}
    </section>
  );
}

function LeaveRequests({
  setNotice,
  isHrAdmin,
  currentUserId,
  typeFilter,
}: NoticeProps & { isHrAdmin: boolean; currentUserId: string; typeFilter: LeaveTypeFilterValue }) {
  const [rows, setRows] = useState<AdminLeaveRequest[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [showRequestModal, setShowRequestModal] = useState(false);
  const [myBalance, setMyBalance] = useState<LeaveBalance | null>(null);
  const [myRequests, setMyRequests] = useState<LeaveRequestRecord[] | null>(null);

  async function load() {
    try {
      const data = await listPendingLeaveRequests();
      setRows(data);
    } catch (err) {
      setError(errorMessage(err, "Couldn't load leave requests."));
    }
  }

  async function loadMine() {
    try {
      const [balances, requests] = await Promise.all([getLeaveBalances(), getLeaveRequests()]);
      setMyBalance(balances.find((b) => b.leaveType === "annual") ?? null);
      setMyRequests(requests);
    } catch {
      setMyRequests([]);
    }
  }

  useEffect(() => {
    load();
    loadMine();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function decide(id: string, status: "approved" | "rejected") {
    setBusyId(id);
    try {
      await reviewLeaveRequest(id, status);
      setNotice(`Leave request ${status}.`);
      await load();
    } catch (err) {
      setNotice(errorMessage(err, "Couldn't update the request."));
    } finally {
      setBusyId(null);
    }
  }

  return (
    <>
      <Toolbar action="Request leave" onAction={() => setShowRequestModal(true)} />
      {showRequestModal && (
        <RequestLeaveModal
          onClose={() => setShowRequestModal(false)}
          onSaved={() => {
            setShowRequestModal(false);
            setNotice(isHrAdmin ? "Leave request submitted." : "Leave request submitted for HR approval.");
            load();
            loadMine();
          }}
        />
      )}
      <section className="panel">
        <div className="panel-title"><h2>My leave</h2></div>
        <div className="admin-stats">
          <Stat label="Days earned" value={myBalance ? formatDaysValue(myBalance.earned) : "0"} note={myBalance ? `Of ${formatDaysValue(myBalance.entitlement)} annual` : "No entitlement set"} />
          <Stat label="Days used" value={myBalance ? formatDaysValue(myBalance.used) : "0"} note="This leave year" />
          <Stat label="Available" value={myBalance ? formatDaysValue(myBalance.earned - myBalance.used) : "0"} note="To book now" />
        </div>
        {myRequests === null ? (
          <LoadingPanel />
        ) : myRequests.length === 0 ? (
          <p className="muted small">No leave requests yet.</p>
        ) : (
          <div>
            <div className="table-head"><b>Leave type</b><b>Dates</b><b>Status</b></div>
            {myRequests.map((request) => (
              <div className="table-row" key={request.id}>
                <span className="capitalize">{request.leaveType}</span>
                <span>{formatDate(request.startsOn)} – {formatDate(request.endsOn)}</span>
                <span className={`pill ${leaveStatusClass(request.status)}`}>{request.status}</span>
              </div>
            ))}
          </div>
        )}
      </section>
      <div className="admin-stats">
        <Stat label="Pending requests" value={String(rows?.length ?? 0)} note="Needs a decision" />
      </div>
      {error ? (
        <ErrorState message={error} />
      ) : !rows ? (
        <LoadingPanel />
      ) : rows.length === 0 ? (
        <EmptyPanel icon="calendar" title="No pending leave requests" note="New requests will appear here for review." />
      ) : rows.filter((r) => matchesLeaveType(r.leaveType, typeFilter)).length === 0 ? (
        <EmptyPanel icon="calendar" title={`No pending ${leaveTypeFilterLabel(typeFilter)}`} note="Try another leave type." />
      ) : (
        <section className="panel">
          <div className="table-head"><b>Employee</b><b>Leave type</b><b>Dates</b><b className="actions-head">Actions</b></div>
          {rows.filter((r) => matchesLeaveType(r.leaveType, typeFilter)).map((row) => {
            const isOwnRequest = !isHrAdmin && row.employeeId === currentUserId;
            return (
              <div className="table-row" key={row.id}>
                <span>{row.employeeName}</span>
                <span>{leaveTypeLabel(row.leaveType)}</span>
                <span>{formatDate(row.startsOn)} – {formatDate(row.endsOn)}</span>
                {isOwnRequest ? (
                  <span className="pill pending">Awaiting HR approval</span>
                ) : (
                  <span className="row-actions">
                    <button className="icon-action approve" disabled={busyId === row.id} onClick={() => decide(row.id, "approved")} aria-label="Approve">
                      <Icon name="check" size={15} />
                    </button>
                    <button className="icon-action reject" disabled={busyId === row.id} onClick={() => decide(row.id, "rejected")} aria-label="Reject">
                      <Icon name="x" size={15} />
                    </button>
                  </span>
                )}
              </div>
            );
          })}
        </section>
      )}
    </>
  );
}

function RequestLeaveModal({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const [leaveType, setLeaveType] = useState<LeaveRequestInput["leaveType"]>("annual");
  const [startsOn, setStartsOn] = useState("");
  const [endsOn, setEndsOn] = useState("");
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (!startsOn || !endsOn) {
      setError("Choose a start and end date.");
      return;
    }
    if (endsOn < startsOn) {
      setError("End date must be on or after the start date.");
      return;
    }
    setError(null);
    setSaving(true);
    try {
      await submitLeaveRequest({ leaveType, startsOn, endsOn, note: note || undefined });
      onSaved();
    } catch (err) {
      setError(errorMessage(err, "Couldn't submit the leave request."));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="admin-modal-overlay" onClick={onClose}>
      <div className="admin-modal" onClick={(e) => e.stopPropagation()}>
        <div className="admin-modal-header">
          <h2>Request leave</h2>
          <button className="icon-action" onClick={onClose} aria-label="Close"><Icon name="x" size={16} /></button>
        </div>
        <form className="admin-login-form" onSubmit={handleSubmit}>
          <label>
            Leave type
            <select value={leaveType} onChange={(e) => setLeaveType(e.target.value as LeaveRequestInput["leaveType"])} disabled={saving}>
              {leaveTypeOptions.map(([value, label]) => (
                <option key={value} value={value}>{label}</option>
              ))}
            </select>
          </label>
          <label>
            Starts on
            <DateInput required value={startsOn} onChange={setStartsOn} disabled={saving} />
          </label>
          <label>
            Ends on
            <DateInput required value={endsOn} onChange={setEndsOn} disabled={saving} />
          </label>
          <label>
            Note (optional)
            <textarea value={note} onChange={(e) => setNote(e.target.value)} disabled={saving} rows={2} />
          </label>
          {error && <p className="form-error"><Icon name="warning" size={14} />{error}</p>}
          <div className="admin-modal-actions">
            <button type="button" className="outline-button" onClick={onClose} disabled={saving}>Cancel</button>
            <button className="primary-admin" type="submit" disabled={saving}>{saving ? "Submitting…" : "Submit request"}</button>
          </div>
        </form>
      </div>
    </div>
  );
}

const leaveTypeOptions: Array<[string, string]> = [
  ["annual", "Annual"],
  ["medical", "Sick / medical"],
  ["unpaid", "Unpaid"],
  ["other", "Other"],
];

const leaveTypeLabel = (type: string) => leaveTypeOptions.find(([value]) => value === type)?.[1] ?? type;

// Days to at most 2 decimals, without trailing zeros: 17, 4.3, 11.67.
const formatLeaveDays = (days: number) => String(Math.round(days * 100) / 100);

function LeaveEntitlements({ setNotice }: NoticeProps) {
  const [rows, setRows] = useState<AdminLeaveBalance[] | null>(null);
  const [search, setSearch] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [showModal, setShowModal] = useState(false);
  const [editing, setEditing] = useState<AdminLeaveBalance | null>(null);

  function load() {
    listLeaveBalances()
      .then(setRows)
      .catch((err) => setError(errorMessage(err, "Couldn't load leave entitlements.")));
  }

  useEffect(() => {
    load();
  }, []);

  return (
    <>
      <Toolbar action="Set entitlement" onAction={() => setShowModal(true)} search={search} onSearch={setSearch} searchPlaceholder="Search employee or leave type" />
      {(showModal || editing) && (
        <SetEntitlementModal
          existing={editing}
          onClose={() => {
            setShowModal(false);
            setEditing(null);
          }}
          onSaved={(employeeName) => {
            setShowModal(false);
            setEditing(null);
            setNotice(`Entitlement saved for ${employeeName}.`);
            load();
          }}
        />
      )}
      {error ? (
        <ErrorState message={error} />
      ) : !rows ? (
        <LoadingPanel />
      ) : rows.length === 0 ? (
        <EmptyPanel icon="calendar" title="No entitlements set" note="Set entitlements for employees and managers so their leave balances show up correctly." />
      ) : (
        <section className="panel">
          {/* "Remaining" is what the employee can still book today (earned so far,
              including any imported opening balance, minus used). "Yearly allowance"
              is what keeps accruing at 1/12 per month until the 1 April reset. */}
          <div className="table-head cols-7">
            <b>Employee</b><b>Leave type</b><b>Remaining</b><b>Earned so far</b><b>Used</b><b>Yearly allowance</b><b className="actions-head">Edit</b>
          </div>
          {rows
            .filter((row) => matchesSearch(search, row.employeeName, leaveTypeLabel(row.leaveType)))
            .sort((a, b) => a.employeeName.localeCompare(b.employeeName) || a.leaveType.localeCompare(b.leaveType))
            .map((row) => (
              <div className="table-row cols-7" key={row.id}>
                <span>{row.employeeName}</span>
                <span>{leaveTypeLabel(row.leaveType)}</span>
                <span><b>{formatLeaveDays(row.earned - row.used)}</b></span>
                <span>{formatLeaveDays(row.earned)}</span>
                <span>{formatLeaveDays(row.used)}</span>
                <span>{formatLeaveDays(row.entitlement)}</span>
                <span className="row-actions">
                  <button className="icon-action" onClick={() => setEditing(row)} aria-label={`Edit ${row.employeeName} ${leaveTypeLabel(row.leaveType)}`} title="Edit">
                    <Icon name="edit" size={15} />
                  </button>
                </span>
              </div>
            ))}
        </section>
      )}
    </>
  );
}

function SetEntitlementModal({
  existing,
  onClose,
  onSaved,
}: {
  // When editing a row from the table: person and leave type are fixed and the
  // current figures are pre-filled.
  existing?: AdminLeaveBalance | null;
  onClose: () => void;
  onSaved: (employeeName: string) => void;
}) {
  const [employees, setEmployees] = useState<AdminEmployee[]>([]);
  const [employeeId, setEmployeeId] = useState(existing?.employeeId ?? "");
  const [leaveType, setLeaveType] = useState(existing?.leaveType ?? "annual");
  const [entitlement, setEntitlement] = useState(existing ? formatLeaveDays(existing.entitlement) : "");
  // Blank = leave the current balance alone and only change the allowance.
  const [remaining, setRemaining] = useState(existing ? formatLeaveDays(existing.earned - existing.used) : "");
  // Editing an existing row only. Changing "used" keeps "earned so far" fixed
  // and recalculates "remaining" (earned - used); HR can still override it.
  const [used, setUsed] = useState(existing ? formatLeaveDays(existing.used) : "");
  const canSetRemaining = leaveType !== "unpaid";

  function handleUsedChange(next: string) {
    setUsed(next);
    const n = Number(next);
    if (existing && canSetRemaining && next.trim() !== "" && Number.isFinite(n)) {
      setRemaining(formatLeaveDays(Math.max(0, existing.earned - n)));
    }
  }
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    listEmployees()
      .then((data) => setEmployees(data.filter((e) => e.active)))
      .catch(() => setEmployees([]));
  }, []);

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (!employeeId) {
      setError("Choose an employee.");
      return;
    }
    const value = Number(entitlement);
    if (!Number.isFinite(value) || value < 0) {
      setError("Enter a valid number of days.");
      return;
    }
    const remainingValue = remaining.trim() === "" ? null : Number(remaining);
    if (remainingValue !== null && (!Number.isFinite(remainingValue) || remainingValue < 0)) {
      setError("Remaining days must be zero or more.");
      return;
    }
    const usedValue = existing ? Number(used) : 0;
    if (existing && (used.trim() === "" || !Number.isFinite(usedValue) || usedValue < 0)) {
      setError("Used days must be zero or more.");
      return;
    }
    setError(null);
    setSaving(true);
    try {
      if (existing) {
        // Send "remaining" only if it differs from what earned - used already
        // gives; otherwise keep the current adjustment so nothing drifts by rounding.
        const implied = Number(formatLeaveDays(Math.max(0, existing.earned - usedValue)));
        await setLeaveBalance({
          employeeId,
          leaveType,
          entitlement: value,
          used: usedValue,
          remaining: canSetRemaining && remainingValue !== null && remainingValue !== implied ? remainingValue : null,
        });
        onSaved(existing.employeeName);
        return;
      }
      // New row (or an existing combination picked via "Set entitlement"):
      // set the balance only if HR filled in "remaining", otherwise just the allowance.
      if (canSetRemaining && remainingValue !== null) {
        await setOpeningLeaveBalance(employeeId, leaveType as "annual" | "medical" | "other", remainingValue as number, value);
      } else {
        await setLeaveEntitlement({ employeeId, leaveType, entitlement: value });
      }
      const employee = employees.find((e) => e.id === employeeId);
      onSaved(employee?.fullName ?? "employee");
    } catch (err) {
      setError(errorMessage(err, "Couldn't save the entitlement."));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="admin-modal-overlay" onClick={onClose}>
      <div className="admin-modal" onClick={(e) => e.stopPropagation()}>
        <div className="admin-modal-header">
          <h2>{existing ? `${existing.employeeName} — ${leaveTypeLabel(existing.leaveType)}` : "Set entitlement"}</h2>
          <button className="icon-action" onClick={onClose} aria-label="Close"><Icon name="x" size={16} /></button>
        </div>
        {!existing && (
          <p className="muted small">Works for employees and managers alike. Setting an existing employee/leave type combination updates it.</p>
        )}
        <form className="admin-login-form" onSubmit={handleSubmit}>
          {!existing && (
          <>
          <label>
            Employee or manager
            <select required value={employeeId} onChange={(e) => setEmployeeId(e.target.value)} disabled={saving}>
              <option value="">Select a person</option>
              {employees.map((e) => (
                <option key={e.id} value={e.id}>{e.fullName}</option>
              ))}
            </select>
          </label>
          <label>
            Leave type
            <select value={leaveType} onChange={(e) => setLeaveType(e.target.value)} disabled={saving}>
              {leaveTypeOptions.map(([value, label]) => (
                <option key={value} value={value}>{label}</option>
              ))}
            </select>
          </label>
          </>
          )}
          <label>
            Yearly allowance (days)
            <input type="number" min="0" step="0.5" required value={entitlement} onChange={(e) => setEntitlement(e.target.value)} disabled={saving} />
            <small className="field-hint">Added 1/12 per month until the leave year resets on 1 April.</small>
          </label>
          {existing && (
            <label>
              Used (days)
              <input type="number" min="0" step="0.5" required value={used} onChange={(e) => handleUsedChange(e.target.value)} disabled={saving} />
              <small className="field-hint">Days already taken this leave year. Remaining updates to match.</small>
            </label>
          )}
          {canSetRemaining && (
            <label>
              Remaining today (days) {!existing && <span className="field-optional">optional</span>}
              <input type="number" min="0" step="0.01" value={remaining} onChange={(e) => setRemaining(e.target.value)} disabled={saving} />
              <small className="field-hint">
                What they can still book right now, e.g. carried over from your old records. Monthly accrual continues on top of it.
              </small>
            </label>
          )}
          {error && <p className="form-error"><Icon name="warning" size={14} />{error}</p>}
          <div className="admin-modal-actions">
            <button type="button" className="outline-button" onClick={onClose} disabled={saving}>Cancel</button>
            <button className="primary-admin" type="submit" disabled={saving}>{saving ? "Saving…" : "Save"}</button>
          </div>
        </form>
      </div>
    </div>
  );
}

const severityLabels: Record<DisciplinarySeverity, string> = {
  verbal_warning: "Verbal warning",
  written_warning: "Written warning",
  final_warning: "Final warning",
  suspension: "Suspension",
  termination_notice: "Termination notice",
};

const severityPillClass: Record<DisciplinarySeverity, string> = {
  verbal_warning: "",
  written_warning: "pending",
  final_warning: "danger",
  suspension: "danger",
  termination_notice: "danger",
};

function Disciplinary({ setNotice, canWithdraw }: NoticeProps & { canWithdraw: boolean }) {
  const [rows, setRows] = useState<AdminDisciplinaryAction[] | null>(null);
  const [search, setSearch] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [showModal, setShowModal] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);

  function load() {
    listDisciplinaryActions()
      .then(setRows)
      .catch((err) => setError(errorMessage(err, "Couldn't load disciplinary actions.")));
  }

  useEffect(() => {
    load();
  }, []);

  async function handleDelete(row: AdminDisciplinaryAction) {
    if (!window.confirm(`Delete this ${severityLabels[row.severity].toLowerCase()} for ${row.employeeName}? This cannot be undone.`)) return;
    setBusyId(row.id);
    try {
      await deleteDisciplinaryAction(row.id);
      setNotice("Disciplinary record deleted.");
      load();
    } catch (err) {
      setNotice(errorMessage(err, "Couldn't delete the record."));
    } finally {
      setBusyId(null);
    }
  }

  return (
    <>
      <Toolbar action="Issue action" onAction={() => setShowModal(true)} search={search} onSearch={setSearch} searchPlaceholder="Search employee or reason" />
      {showModal && (
        <IssueDisciplinaryModal
          onClose={() => setShowModal(false)}
          onIssued={() => {
            setShowModal(false);
            setNotice("Disciplinary action recorded.");
            load();
          }}
        />
      )}
      {error ? (
        <ErrorState message={error} />
      ) : !rows ? (
        <LoadingPanel />
      ) : rows.length === 0 ? (
        <EmptyPanel icon="warning" title="No disciplinary actions" note="Actions you issue to employees will appear here." />
      ) : (
        <section className="panel">
          <div className={`table-head ${canWithdraw ? "cols-5" : ""}`}>
            <b>Employee</b><b>Severity</b><b>Reason</b><b>Date</b>{canWithdraw && <b></b>}
          </div>
          {rows.filter((row) => matchesSearch(search, row.employeeName, row.reason, severityLabels[row.severity])).map((row) => (
            <div className={`table-row ${canWithdraw ? "cols-5" : ""}`} key={row.id}>
              <span className="person-cell"><i className="person-dot">{row.employeeName[0]}</i><span className="person-name">{row.employeeName}</span></span>
              <span><span className={`pill ${severityPillClass[row.severity]}`}>{severityLabels[row.severity]}</span></span>
              <span>{row.reason}</span>
              <span>{formatDate(row.occurredOn)}</span>
              {canWithdraw && (
                <span className="row-actions">
                  <button className="icon-action reject" disabled={busyId === row.id} onClick={() => handleDelete(row)} aria-label={`Delete disciplinary record for ${row.employeeName}`}>
                    <Icon name="trash" size={15} />
                  </button>
                </span>
              )}
            </div>
          ))}
        </section>
      )}
    </>
  );
}

function IssueDisciplinaryModal({ onClose, onIssued }: { onClose: () => void; onIssued: () => void }) {
  const [employees, setEmployees] = useState<AdminEmployee[]>([]);
  const [employeeId, setEmployeeId] = useState("");
  const [severity, setSeverity] = useState<DisciplinarySeverity>("verbal_warning");
  const [reason, setReason] = useState("");
  const [details, setDetails] = useState("");
  const [occurredOn, setOccurredOn] = useState(() => new Date().toISOString().slice(0, 10));
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    listEmployees()
      .then((data) => setEmployees(data.filter((e) => e.active)))
      .catch(() => setEmployees([]));
  }, []);

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (!employeeId) {
      setError("Choose an employee.");
      return;
    }
    setError(null);
    setSaving(true);
    try {
      await issueDisciplinaryAction({ employeeId, severity, reason, details, occurredOn });
      onIssued();
    } catch (err) {
      setError(errorMessage(err, "Couldn't record the action."));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="admin-modal-overlay" onClick={onClose}>
      <div className="admin-modal" onClick={(e) => e.stopPropagation()}>
        <div className="admin-modal-header">
          <h2>Issue disciplinary action</h2>
          <button className="icon-action" onClick={onClose} aria-label="Close"><Icon name="x" size={16} /></button>
        </div>
        <p className="muted small">Only visible to HR and the employee's manager.</p>
        <form className="admin-login-form" onSubmit={handleSubmit}>
          <label>
            Employee
            <select required value={employeeId} onChange={(e) => setEmployeeId(e.target.value)} disabled={saving}>
              <option value="">Select an employee</option>
              {employees.map((e) => (
                <option key={e.id} value={e.id}>{e.fullName}</option>
              ))}
            </select>
          </label>
          <label>
            Severity
            <select value={severity} onChange={(e) => setSeverity(e.target.value as DisciplinarySeverity)} disabled={saving}>
              {Object.entries(severityLabels).map(([value, label]) => (
                <option key={value} value={value}>{label}</option>
              ))}
            </select>
          </label>
          <label>
            Date
            <DateInput required value={occurredOn} onChange={setOccurredOn} disabled={saving} />
          </label>
          <label>
            Reason
            <input required value={reason} onChange={(e) => setReason(e.target.value)} disabled={saving} placeholder="e.g. Repeated late arrival" />
          </label>
          <label>
            Details (optional)
            <textarea value={details} onChange={(e) => setDetails(e.target.value)} disabled={saving} rows={3} />
          </label>
          {error && <p className="form-error"><Icon name="warning" size={14} />{error}</p>}
          <div className="admin-modal-actions">
            <button type="button" className="outline-button" onClick={onClose} disabled={saving}>Cancel</button>
            <button className="primary-admin" type="submit" disabled={saving}>{saving ? "Saving…" : "Issue action"}</button>
          </div>
        </form>
      </div>
    </div>
  );
}

function Holidays({ setNotice }: NoticeProps) {
  const [rows, setRows] = useState<AdminHoliday[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [showModal, setShowModal] = useState(false);
  const [seeding, setSeeding] = useState(false);
  const today = new Date().toISOString().slice(0, 10);

  function load() {
    listAdminHolidays()
      .then(setRows)
      .catch((err) => setError(errorMessage(err, "Couldn't load holidays.")));
  }

  useEffect(() => {
    load();
  }, []);

  async function handleSeedNextYear() {
    setSeeding(true);
    try {
      const nextYear = new Date().getFullYear() + 1;
      await seedBankHolidays(nextYear);
      setNotice(`${nextYear} bank holidays seeded.`);
      load();
    } catch (err) {
      setNotice(errorMessage(err, "Couldn't seed next year's holidays."));
    } finally {
      setSeeding(false);
    }
  }

  async function handleDelete(holiday: AdminHoliday) {
    setBusyId(holiday.id);
    try {
      await deleteHoliday(holiday.id);
      setNotice(`${holiday.name} removed.`);
      load();
    } catch (err) {
      setNotice(errorMessage(err, "Couldn't remove the holiday."));
    } finally {
      setBusyId(null);
    }
  }

  return (
    <>
      <div className="toolbar">
        <button className="outline-button" onClick={handleSeedNextYear} disabled={seeding}>
          <Icon name="calendar" size={15} /> {seeding ? "Seeding…" : `Seed ${new Date().getFullYear() + 1}`}
        </button>
        <button className="primary-admin" onClick={() => setShowModal(true)}><Icon name="plus" size={15} /> Add holiday</button>
      </div>
      {showModal && (
        <AddHolidayModal
          onClose={() => setShowModal(false)}
          onAdded={() => {
            setShowModal(false);
            setNotice("Holiday added.");
            load();
          }}
        />
      )}
      {error ? (
        <ErrorState message={error} />
      ) : !rows ? (
        <LoadingPanel />
      ) : rows.length === 0 ? (
        <EmptyPanel icon="calendar" title="No holidays yet" note="Add a holiday, or seed the standard Irish bank holiday calendar." />
      ) : (
        <section className="panel">
          <div className="table-head"><b>Date</b><b>Name</b><b></b><b></b></div>
          {rows.map((row) => (
            <div className="table-row" key={row.id}>
              <span className={row.date < today ? "muted" : undefined}>{formatDate(row.date)}</span>
              <span>{row.name}</span>
              <span />
              <span className="row-actions">
                <button className="outline-button" disabled={busyId === row.id} onClick={() => handleDelete(row)}>
                  <Icon name="trash" size={14} />
                </button>
              </span>
            </div>
          ))}
        </section>
      )}
    </>
  );
}

function AddHolidayModal({ onClose, onAdded }: { onClose: () => void; onAdded: () => void }) {
  const [date, setDate] = useState("");
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    setSaving(true);
    try {
      await addHoliday(date, name);
      onAdded();
    } catch (err) {
      setError(errorMessage(err, "Couldn't add the holiday."));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="admin-modal-overlay" onClick={onClose}>
      <div className="admin-modal" onClick={(e) => e.stopPropagation()}>
        <div className="admin-modal-header">
          <h2>Add holiday</h2>
          <button className="icon-action" onClick={onClose} aria-label="Close"><Icon name="x" size={16} /></button>
        </div>
        <form className="admin-login-form" onSubmit={handleSubmit}>
          <label>
            Date
            <DateInput required value={date} onChange={setDate} disabled={saving} />
          </label>
          <label>
            Name
            <input required value={name} onChange={(e) => setName(e.target.value)} disabled={saving} placeholder="e.g. Company closure day" />
          </label>
          {error && <p className="form-error"><Icon name="warning" size={14} />{error}</p>}
          <div className="admin-modal-actions">
            <button type="button" className="outline-button" onClick={onClose} disabled={saving}>Cancel</button>
            <button className="primary-admin" type="submit" disabled={saving}>{saving ? "Adding…" : "Add holiday"}</button>
          </div>
        </form>
      </div>
    </div>
  );
}

function Schedules({ setNotice }: NoticeProps) {
  const [rows, setRows] = useState<AdminWorkSchedule[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showModal, setShowModal] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);

  function load() {
    listWorkSchedules()
      .then(setRows)
      .catch((err) => setError(errorMessage(err, "Couldn't load schedules.")));
  }

  useEffect(() => {
    load();
  }, []);

  async function handleDelete(row: AdminWorkSchedule) {
    if (!window.confirm(`Delete the "${row.name}" shift template?`)) return;
    setBusyId(row.id);
    try {
      await deleteWorkSchedule(row.id);
      setNotice(`Shift template "${row.name}" deleted.`);
      load();
    } catch (err) {
      setNotice(errorMessage(err, "Couldn't delete the shift template."));
    } finally {
      setBusyId(null);
    }
  }

  return (
    <>
      <Toolbar action="Create shift" onAction={() => setShowModal(true)} />
      {showModal && (
        <CreateShiftModal
          onClose={() => setShowModal(false)}
          onCreated={(schedule) => {
            setShowModal(false);
            setNotice(`Shift template "${schedule.name}" created.`);
            load();
          }}
        />
      )}
      {error ? (
        <ErrorState message={error} />
      ) : !rows ? (
        <LoadingPanel />
      ) : rows.length === 0 ? (
        <EmptyPanel icon="swap" title="No schedules configured" note="Create a working-hour template to assign to employees." />
      ) : (
        <section className="panel">
          <div className="panel-title"><h2>Working templates</h2></div>
          {rows.map((row) => (
            <div className="schedule-row" key={row.id}>
              <b>{row.name}</b>
              <span>
                {row.branchName ?? "All branches"} · {row.startsAt.slice(0, 5)}–{row.endsAt.slice(0, 5)} · {formatWorkingDays(row.workingDays)}
              </span>
              <span className={`pill ${row.isDefault ? "success" : ""}`}>{row.isDefault ? "Default" : "Active"}</span>
              <span className="row-actions">
                <button className="icon-action" disabled={busyId === row.id} onClick={() => handleDelete(row)} aria-label={`Delete ${row.name}`}>
                  <Icon name="trash" size={15} />
                </button>
              </span>
            </div>
          ))}
        </section>
      )}
    </>
  );
}

// Postgres ISO day-of-week numbering (1 = Monday) to match the working_days
// column's default of {1,2,3,4,5}.
const weekdayOptions: Array<[number, string]> = [
  [1, "Mon"],
  [2, "Tue"],
  [3, "Wed"],
  [4, "Thu"],
  [5, "Fri"],
  [6, "Sat"],
  [7, "Sun"],
];

function formatWorkingDays(days: number[]) {
  if (!days.length) return "No days set";
  if (days.length === 7) return "Every day";
  const labels = new Map(weekdayOptions);
  return [...days].sort((a, b) => a - b).map((d) => labels.get(d) ?? d).join(", ");
}

function CreateShiftModal({ onClose, onCreated }: { onClose: () => void; onCreated: (schedule: AdminWorkSchedule) => void }) {
  const [name, setName] = useState("");
  const [branchName, setBranchName] = useState("");
  const [startsAt, setStartsAt] = useState("09:00");
  const [endsAt, setEndsAt] = useState("17:00");
  const [workingDays, setWorkingDays] = useState<number[]>([1, 2, 3, 4, 5]);
  const [isDefault, setIsDefault] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  function toggleDay(day: number) {
    setWorkingDays((current) => (current.includes(day) ? current.filter((d) => d !== day) : [...current, day].sort((a, b) => a - b)));
  }

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (!workingDays.length) {
      setError("Pick at least one working day.");
      return;
    }
    setError(null);
    setSaving(true);
    try {
      const schedule = await createWorkSchedule({
        name,
        branchName: branchName || null,
        startsAt,
        endsAt,
        workingDays,
        isDefault,
      });
      onCreated(schedule);
    } catch (err) {
      setError(errorMessage(err, "Couldn't create the shift template."));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="admin-modal-overlay" onClick={onClose}>
      <div className="admin-modal" onClick={(e) => e.stopPropagation()}>
        <div className="admin-modal-header">
          <h2>Create shift</h2>
          <button className="icon-action" onClick={onClose} aria-label="Close"><Icon name="x" size={16} /></button>
        </div>
        <p className="muted small">A working-hour template that can be assigned to employees.</p>
        <form className="admin-login-form" onSubmit={handleSubmit}>
          <label>
            Name
            <input required value={name} onChange={(e) => setName(e.target.value)} disabled={saving} placeholder="e.g. Warehouse day shift" />
          </label>
          <label>
            Branch (optional)
            <input value={branchName} onChange={(e) => setBranchName(e.target.value)} disabled={saving} placeholder="All branches" />
          </label>
          <label>
            Starts at
            <input type="time" required value={startsAt} onChange={(e) => setStartsAt(e.target.value)} disabled={saving} />
          </label>
          <label>
            Ends at
            <input type="time" required value={endsAt} onChange={(e) => setEndsAt(e.target.value)} disabled={saving} />
          </label>
          <p className="muted small">Working days</p>
          <div className="weekday-picker">
            {weekdayOptions.map(([day, label]) => (
              <button
                key={day}
                type="button"
                className={workingDays.includes(day) ? "active" : ""}
                onClick={() => toggleDay(day)}
                disabled={saving}
                aria-pressed={workingDays.includes(day)}
              >
                {label}
              </button>
            ))}
          </div>
          <label className="checkbox-row">
            <input type="checkbox" checked={isDefault} onChange={(e) => setIsDefault(e.target.checked)} disabled={saving} />
            Make this the default template
          </label>
          {error && <p className="form-error"><Icon name="warning" size={14} />{error}</p>}
          <div className="admin-modal-actions">
            <button type="button" className="outline-button" onClick={onClose} disabled={saving}>Cancel</button>
            <button className="primary-admin" type="submit" disabled={saving}>{saving ? "Creating…" : "Create shift"}</button>
          </div>
        </form>
      </div>
    </div>
  );
}

const assetCategoryLabels: Record<AssetCategory, string> = {
  laptop: "Laptop",
  phone: "Phone",
  vehicle: "Vehicle",
  tool: "Tool",
  uniform: "Uniform",
  other: "Other",
};

const assetCategoryIcons: Record<AssetCategory, Parameters<typeof Icon>[0]["name"]> = {
  laptop: "layout",
  phone: "device",
  vehicle: "swap",
  tool: "settings",
  uniform: "briefcase",
  other: "archive",
};

const assetStatusPill: Record<AssetStatus, string> = {
  available: "success",
  assigned: "pending",
  retired: "",
};

function Assets({ setNotice }: NoticeProps) {
  const [rows, setRows] = useState<AdminAsset[] | null>(null);
  const [search, setSearch] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [assigning, setAssigning] = useState<AdminAsset | null>(null);
  const [historyFor, setHistoryFor] = useState<AdminAsset | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [filter, setFilter] = useState<"all" | AssetStatus>("all");

  function load() {
    listAssets()
      .then(setRows)
      .catch((err) => setError(errorMessage(err, "Couldn't load assets.")));
  }

  useEffect(() => {
    load();
  }, []);

  async function handleReturn(asset: AdminAsset) {
    setBusyId(asset.id);
    try {
      await returnAsset(asset.id);
      setNotice(`${asset.name} marked as returned.`);
      load();
    } catch (err) {
      setNotice(errorMessage(err, "Couldn't record the return."));
    } finally {
      setBusyId(null);
    }
  }

  async function handleRetire(asset: AdminAsset) {
    const retiring = asset.status !== "retired";
    if (retiring && !window.confirm(`Retire ${asset.name}? It won't be assignable until restored.`)) return;
    setBusyId(asset.id);
    try {
      await setAssetRetired(asset.id, retiring);
      setNotice(retiring ? `${asset.name} retired.` : `${asset.name} restored to available.`);
      load();
    } catch (err) {
      setNotice(errorMessage(err, "Couldn't update the asset."));
    } finally {
      setBusyId(null);
    }
  }

  async function handleDelete(asset: AdminAsset) {
    if (!window.confirm(`Permanently delete ${asset.name} (${asset.assetTag}) and its assignment history?`)) return;
    setBusyId(asset.id);
    try {
      await deleteAsset(asset.id);
      setNotice(`${asset.name} deleted.`);
      load();
    } catch (err) {
      setNotice(errorMessage(err, "Couldn't delete the asset."));
    } finally {
      setBusyId(null);
    }
  }

  const visible = rows?.filter((r) => (filter === "all" || r.status === filter) && matchesSearch(search, r.name, r.assetTag, r.serialNumber, r.holderName, assetCategoryLabels[r.category])) ?? null;
  const counts = {
    total: rows?.length ?? 0,
    assigned: rows?.filter((r) => r.status === "assigned").length ?? 0,
    available: rows?.filter((r) => r.status === "available").length ?? 0,
  };

  return (
    <>
      <Toolbar action="Add asset" onAction={() => setShowCreate(true)} search={search} onSearch={setSearch} searchPlaceholder="Search name, tag, serial or holder" />
      {showCreate && (
        <CreateAssetModal
          onClose={() => setShowCreate(false)}
          onCreated={(name) => {
            setShowCreate(false);
            setNotice(`Asset "${name}" added.`);
            load();
          }}
        />
      )}
      {assigning && (
        <AssignAssetModal
          asset={assigning}
          onClose={() => setAssigning(null)}
          onAssigned={(employeeName) => {
            setNotice(`${assigning.name} assigned to ${employeeName}.`);
            setAssigning(null);
            load();
          }}
        />
      )}
      {historyFor && <AssetHistoryModal asset={historyFor} onClose={() => setHistoryFor(null)} />}

      <div className="admin-stats">
        <Stat label="Total assets" value={String(counts.total)} note="In the register" />
        <Stat label="Assigned" value={String(counts.assigned)} note="Currently with staff" />
        <Stat label="Available" value={String(counts.available)} note="Ready to assign" />
      </div>

      <div className="module-tabs">
        {(["all", "assigned", "available", "retired"] as const).map((key) => (
          <button key={key} className={filter === key ? "active" : ""} onClick={() => setFilter(key)}>
            {key === "all" ? "All" : key.charAt(0).toUpperCase() + key.slice(1)}
          </button>
        ))}
      </div>

      {error ? (
        <ErrorState message={error} />
      ) : !visible ? (
        <LoadingPanel />
      ) : visible.length === 0 ? (
        <EmptyPanel
          icon="briefcase"
          title={filter === "all" ? "No assets yet" : `No ${filter} assets`}
          note="Add laptops, phones, vehicles, tools, or uniforms to track who holds them."
        />
      ) : (
        <section className="panel">
          <div className="table-head cols-5"><b>Asset</b><b>Tag</b><b>Assigned to</b><b>Status</b><b className="actions-head">Actions</b></div>
          {visible.map((asset) => (
            <div className="table-row cols-5" key={asset.id}>
              <span className="asset-name">
                <i className="person-dot"><Icon name={assetCategoryIcons[asset.category]} size={14} /></i>
                <span>
                  {asset.name}
                  <em className="asset-sub">{assetCategoryLabels[asset.category]}{asset.serialNumber ? ` · ${asset.serialNumber}` : ""}</em>
                </span>
              </span>
              <span>{asset.assetTag}</span>
              <span>{asset.holderName ?? "—"}</span>
              <span className={`pill ${assetStatusPill[asset.status]}`}>{asset.status}</span>
              <span className="row-actions">
                {asset.status === "assigned" ? (
                  <button className="icon-action approve" disabled={busyId === asset.id} onClick={() => handleReturn(asset)} aria-label={`Mark ${asset.name} returned`} title="Mark returned">
                    <Icon name="check" size={15} />
                  </button>
                ) : (
                  <button className="icon-action" disabled={busyId === asset.id || asset.status === "retired"} onClick={() => setAssigning(asset)} aria-label={`Assign ${asset.name}`} title="Assign">
                    <Icon name="userPlus" size={15} />
                  </button>
                )}
                <button className="icon-action" onClick={() => setHistoryFor(asset)} aria-label={`History for ${asset.name}`} title="History">
                  <Icon name="archive" size={15} />
                </button>
                <button className="icon-action" disabled={busyId === asset.id || asset.status === "assigned"} onClick={() => handleRetire(asset)} aria-label={`Retire ${asset.name}`} title={asset.status === "retired" ? "Restore" : "Retire"}>
                  <Icon name={asset.status === "retired" ? "swap" : "archive"} size={15} />
                </button>
                <button className="icon-action reject" disabled={busyId === asset.id || asset.status === "assigned"} onClick={() => handleDelete(asset)} aria-label={`Delete ${asset.name}`} title="Delete">
                  <Icon name="trash" size={15} />
                </button>
              </span>
            </div>
          ))}
        </section>
      )}
    </>
  );
}

function CreateAssetModal({ onClose, onCreated }: { onClose: () => void; onCreated: (name: string) => void }) {
  const [assetTag, setAssetTag] = useState("");
  const [name, setName] = useState("");
  const [category, setCategory] = useState<AssetCategory>("laptop");
  const [serialNumber, setSerialNumber] = useState("");
  const [notes, setNotes] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    setSaving(true);
    try {
      await createAsset({ assetTag, name, category, serialNumber, notes });
      onCreated(name);
    } catch (err) {
      setError(errorMessage(err, "Couldn't add the asset."));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="admin-modal-overlay" onClick={onClose}>
      <div className="admin-modal" onClick={(e) => e.stopPropagation()}>
        <div className="admin-modal-header">
          <h2>Add asset</h2>
          <button className="icon-action" onClick={onClose} aria-label="Close"><Icon name="x" size={16} /></button>
        </div>
        <form className="admin-login-form" onSubmit={handleSubmit}>
          <label>
            Asset tag
            <input required value={assetTag} onChange={(e) => setAssetTag(e.target.value)} disabled={saving} placeholder="e.g. BAL-LT-014" />
          </label>
          <label>
            Name
            <input required value={name} onChange={(e) => setName(e.target.value)} disabled={saving} placeholder="e.g. Dell Latitude 5540" />
          </label>
          <label>
            Category
            <select value={category} onChange={(e) => setCategory(e.target.value as AssetCategory)} disabled={saving}>
              {(Object.keys(assetCategoryLabels) as AssetCategory[]).map((key) => (
                <option key={key} value={key}>{assetCategoryLabels[key]}</option>
              ))}
            </select>
          </label>
          <label>
            Serial number (optional)
            <input value={serialNumber} onChange={(e) => setSerialNumber(e.target.value)} disabled={saving} />
          </label>
          <label>
            Notes (optional)
            <textarea value={notes} onChange={(e) => setNotes(e.target.value)} disabled={saving} rows={2} />
          </label>
          {error && <p className="form-error"><Icon name="warning" size={14} />{error}</p>}
          <div className="admin-modal-actions">
            <button type="button" className="outline-button" onClick={onClose} disabled={saving}>Cancel</button>
            <button className="primary-admin" type="submit" disabled={saving}>{saving ? "Adding…" : "Add asset"}</button>
          </div>
        </form>
      </div>
    </div>
  );
}

function AssignAssetModal({ asset, onClose, onAssigned }: { asset: AdminAsset; onClose: () => void; onAssigned: (employeeName: string) => void }) {
  const [employees, setEmployees] = useState<AdminEmployee[]>([]);
  const [employeeId, setEmployeeId] = useState("");
  const [notes, setNotes] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    listEmployees()
      .then((data) => setEmployees(data.filter((e) => e.active)))
      .catch(() => setEmployees([]));
  }, []);

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (!employeeId) {
      setError("Choose an employee.");
      return;
    }
    setError(null);
    setSaving(true);
    try {
      await assignAsset(asset.id, employeeId, notes);
      onAssigned(employees.find((e) => e.id === employeeId)?.fullName ?? "employee");
    } catch (err) {
      setError(errorMessage(err, "Couldn't assign the asset."));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="admin-modal-overlay" onClick={onClose}>
      <div className="admin-modal" onClick={(e) => e.stopPropagation()}>
        <div className="admin-modal-header">
          <h2>Assign asset</h2>
          <button className="icon-action" onClick={onClose} aria-label="Close"><Icon name="x" size={16} /></button>
        </div>
        <p className="muted small">{asset.name} · {asset.assetTag}</p>
        <form className="admin-login-form" onSubmit={handleSubmit}>
          <label>
            Employee
            <select required value={employeeId} onChange={(e) => setEmployeeId(e.target.value)} disabled={saving}>
              <option value="">Select an employee</option>
              {employees.map((e) => (
                <option key={e.id} value={e.id}>{e.fullName} ({e.employeeCode})</option>
              ))}
            </select>
          </label>
          <label>
            Notes (optional)
            <textarea value={notes} onChange={(e) => setNotes(e.target.value)} disabled={saving} rows={2} placeholder="Condition, accessories included…" />
          </label>
          {error && <p className="form-error"><Icon name="warning" size={14} />{error}</p>}
          <div className="admin-modal-actions">
            <button type="button" className="outline-button" onClick={onClose} disabled={saving}>Cancel</button>
            <button className="primary-admin" type="submit" disabled={saving}>{saving ? "Assigning…" : "Assign"}</button>
          </div>
        </form>
      </div>
    </div>
  );
}

function AssetHistoryModal({ asset, onClose }: { asset: AdminAsset; onClose: () => void }) {
  const [rows, setRows] = useState<AssetAssignmentRecord[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    listAssetHistory(asset.id)
      .then(setRows)
      .catch((err) => setError(errorMessage(err, "Couldn't load the history.")));
  }, [asset.id]);

  return (
    <div className="admin-modal-overlay" onClick={onClose}>
      <div className="admin-modal" onClick={(e) => e.stopPropagation()}>
        <div className="admin-modal-header">
          <h2>Assignment history</h2>
          <button className="icon-action" onClick={onClose} aria-label="Close"><Icon name="x" size={16} /></button>
        </div>
        <p className="muted small">{asset.name} · {asset.assetTag}</p>
        {error ? (
          <ErrorState message={error} />
        ) : !rows ? (
          <LoadingPanel />
        ) : rows.length === 0 ? (
          <p className="muted small">This asset has never been assigned.</p>
        ) : (
          <div>
            <div className="table-head"><b>Employee</b><b>From</b><b>To</b></div>
            {rows.map((row) => (
              <div className="table-row" key={row.id}>
                <span>{row.employeeName}</span>
                <span>{formatDate(row.assignedOn)}</span>
                <span>{row.returnedOn ? formatDate(row.returnedOn) : <span className="pill pending">Still held</span>}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

const payrollStatusPill: Record<PayrollPeriodStatus, string> = {
  draft: "pending",
  finalized: "",
  paid: "success",
};

function Payroll({ setNotice, isHrAdmin }: NoticeProps & { isHrAdmin: boolean }) {
  const [view, setView] = useState<"periods" | "rates">("periods");

  if (!isHrAdmin) {
    return <EmptyPanel icon="creditCard" title="Payroll" note="Payroll is managed by HR administrators." />;
  }

  return (
    <>
      <div className="module-tabs">
        <button className={view === "periods" ? "active" : ""} onClick={() => setView("periods")}>Periods</button>
        <button className={view === "rates" ? "active" : ""} onClick={() => setView("rates")}>Pay rates</button>
      </div>
      {view === "periods" ? <PayrollPeriods setNotice={setNotice} /> : <PayRates setNotice={setNotice} />}
    </>
  );
}

function PayrollPeriods({ setNotice }: NoticeProps) {
  const [rows, setRows] = useState<AdminPayrollPeriod[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [selected, setSelected] = useState<AdminPayrollPeriod | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  function load() {
    listPayrollPeriods()
      .then(setRows)
      .catch((err) => setError(errorMessage(err, "Couldn't load payroll periods.")));
  }

  async function handleDelete(period: AdminPayrollPeriod) {
    const payslipNote =
      period.payslipCount > 0 ? ` Its ${period.payslipCount} draft payslip${period.payslipCount === 1 ? "" : "s"} will be deleted too.` : "";
    if (!window.confirm(`Delete the draft period "${period.label}"?${payslipNote} This can't be undone.`)) return;
    setBusyId(period.id);
    try {
      await deletePayrollPeriod(period.id);
      setNotice(`${period.label} was deleted.`);
      load();
    } catch (err) {
      setNotice(errorMessage(err, "Couldn't delete the period."));
    } finally {
      setBusyId(null);
    }
  }

  useEffect(() => {
    load();
  }, []);

  if (selected) {
    return (
      <PayrollPeriodDetail
        period={selected}
        onBack={() => {
          setSelected(null);
          load();
        }}
        onChanged={setSelected}
        setNotice={setNotice}
      />
    );
  }

  return (
    <>
      <Toolbar action="New period" onAction={() => setShowCreate(true)} />
      {showCreate && (
        <CreatePayrollPeriodModal
          onClose={() => setShowCreate(false)}
          onCreated={() => {
            setShowCreate(false);
            setNotice("Payroll period created.");
            load();
          }}
        />
      )}
      {error ? (
        <ErrorState message={error} />
      ) : !rows ? (
        <LoadingPanel />
      ) : rows.length === 0 ? (
        <EmptyPanel icon="creditCard" title="No payroll periods yet" note="Create a period to start generating payslips." />
      ) : (
        <section className="panel">
          <div className="table-head cols-5"><b>Period</b><b>Dates</b><b>Status</b><b>Payslips</b><b className="actions-head">Actions</b></div>
          {rows.map((period) => (
            <div className="table-row cols-5" key={period.id}>
              <span>{period.label}</span>
              <span>{formatDate(period.startsOn)} – {formatDate(period.endsOn)}</span>
              <span className={`pill ${payrollStatusPill[period.status]}`}>{period.status}</span>
              <span>{period.payslipCount}</span>
              <span className="row-actions">
                {/* Finalized and paid periods are the payroll record and can't be
                    deleted (enforced in delete_payroll_period / RLS too). */}
                {period.status === "draft" && (
                  <button
                    className="icon-action reject"
                    disabled={busyId === period.id}
                    onClick={() => handleDelete(period)}
                    aria-label={`Delete ${period.label}`}
                    title="Delete draft period"
                  >
                    <Icon name="trash" size={15} />
                  </button>
                )}
                <button className="icon-action" onClick={() => setSelected(period)} aria-label={`Open ${period.label}`} title="Open">
                  <Icon name="chevronRight" size={15} />
                </button>
              </span>
            </div>
          ))}
        </section>
      )}
    </>
  );
}

function CreatePayrollPeriodModal({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const [label, setLabel] = useState("");
  const [startsOn, setStartsOn] = useState("");
  const [endsOn, setEndsOn] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    setSaving(true);
    try {
      await createPayrollPeriod({ label, startsOn, endsOn });
      onCreated();
    } catch (err) {
      setError(errorMessage(err, "Couldn't create the payroll period."));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="admin-modal-overlay" onClick={onClose}>
      <div className="admin-modal" onClick={(e) => e.stopPropagation()}>
        <div className="admin-modal-header">
          <h2>New payroll period</h2>
          <button className="icon-action" onClick={onClose} aria-label="Close"><Icon name="x" size={16} /></button>
        </div>
        <form className="admin-login-form" onSubmit={handleSubmit}>
          <label>
            Label
            <input required value={label} onChange={(e) => setLabel(e.target.value)} disabled={saving} placeholder="e.g. August 2026" />
          </label>
          <label>
            Starts on
            <DateInput required value={startsOn} max={endsOn || undefined} onChange={setStartsOn} disabled={saving} />
          </label>
          <label>
            Ends on
            <DateInput required value={endsOn} min={startsOn || undefined} onChange={setEndsOn} disabled={saving} />
          </label>
          {error && <p className="form-error"><Icon name="warning" size={14} />{error}</p>}
          <div className="admin-modal-actions">
            <button type="button" className="outline-button" onClick={onClose} disabled={saving}>Cancel</button>
            <button className="primary-admin" type="submit" disabled={saving}>{saving ? "Creating…" : "Create period"}</button>
          </div>
        </form>
      </div>
    </div>
  );
}

function PayrollPeriodDetail({
  period,
  onBack,
  onChanged,
  setNotice,
}: {
  period: AdminPayrollPeriod;
  onBack: () => void;
  onChanged: (period: AdminPayrollPeriod) => void;
  setNotice: (value: string) => void;
}) {
  const [rows, setRows] = useState<AdminPayslip[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [generating, setGenerating] = useState(false);
  const [transitioning, setTransitioning] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [selectedPayslip, setSelectedPayslip] = useState<AdminPayslip | null>(null);

  function load() {
    listPayslips(period.id)
      .then(setRows)
      .catch((err) => setError(errorMessage(err, "Couldn't load payslips.")));
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [period.id]);

  async function refreshPeriod() {
    const periods = await listPayrollPeriods();
    const updated = periods.find((p) => p.id === period.id);
    if (updated) onChanged(updated);
  }

  async function handleGenerate() {
    setGenerating(true);
    try {
      await generatePayslips(period.id);
      setNotice("Payslips generated.");
      await load();
      await refreshPeriod();
    } catch (err) {
      setNotice(errorMessage(err, "Couldn't generate payslips."));
    } finally {
      setGenerating(false);
    }
  }

  async function handleFinalize() {
    if (!window.confirm(`Finalize ${period.label}? Payslip line items can't be edited afterwards.`)) return;
    setTransitioning(true);
    try {
      await finalizePayrollPeriod(period.id);
      setNotice(`${period.label} finalized.`);
      await load();
      await refreshPeriod();
    } catch (err) {
      setNotice(errorMessage(err, "Couldn't finalize the period."));
    } finally {
      setTransitioning(false);
    }
  }

  async function handleMarkPaid() {
    if (!window.confirm(`Mark ${period.label} as paid?`)) return;
    setTransitioning(true);
    try {
      await markPayrollPeriodPaid(period.id);
      setNotice(`${period.label} marked paid.`);
      await load();
      await refreshPeriod();
    } catch (err) {
      setNotice(errorMessage(err, "Couldn't update the period."));
    } finally {
      setTransitioning(false);
    }
  }

  function handleExport() {
    if (!rows || rows.length === 0) {
      setNotice("No payslips to export for this period.");
      return;
    }
    setExporting(true);
    try {
      downloadCsv(
        `payroll-${period.label.replace(/\s+/g, "-").toLowerCase()}.csv`,
        ["Employee", "Employee code", "Pay type", "Hours", "Gross pay", "Deductions", "Net pay", "Status"],
        rows.map((row) => [
          row.employeeName,
          row.employeeCode,
          row.payType,
          row.hoursWorked ?? "",
          row.grossPay,
          row.totalDeductions,
          row.netPay,
          row.status,
        ]),
      );
    } finally {
      setExporting(false);
    }
  }

  const totals = (rows ?? []).reduce(
    (acc, row) => ({ gross: acc.gross + row.grossPay, net: acc.net + row.netPay }),
    { gross: 0, net: 0 },
  );

  return (
    <>
      <button className="outline-button back-button" onClick={onBack}>
        <Icon name="arrowLeft" size={15} /> All periods
      </button>
      {selectedPayslip && (
        <PayslipDetailModal
          payslip={selectedPayslip}
          editable={period.status === "draft"}
          onClose={() => setSelectedPayslip(null)}
          onChanged={load}
          setNotice={setNotice}
        />
      )}
      <div className="panel-title">
        <h2>{period.label}</h2>
        <span className={`pill ${payrollStatusPill[period.status]}`}>{period.status}</span>
      </div>
      <p className="muted small">{formatDate(period.startsOn)} – {formatDate(period.endsOn)}</p>

      <div className="admin-stats">
        <Stat label="Payslips" value={String(rows?.length ?? 0)} note="Generated" />
        <Stat label="Total gross" value={totals.gross.toFixed(2)} note="This period" />
        <Stat label="Total net" value={totals.net.toFixed(2)} note="This period" />
      </div>

      <div className="toolbar">
        {period.status === "draft" && (
          <button className="outline-button" onClick={handleGenerate} disabled={generating}>
            <Icon name="plus" size={15} /> {generating ? "Generating…" : "Generate payslips"}
          </button>
        )}
        <button className="outline-button" onClick={handleExport} disabled={exporting || !rows?.length}>
          <Icon name="download" size={15} /> {exporting ? "Exporting…" : "Export CSV"}
        </button>
        {period.status === "draft" && (
          <button className="primary-admin" onClick={handleFinalize} disabled={transitioning || !rows?.length}>
            <Icon name="lock" size={15} /> Finalize period
          </button>
        )}
        {period.status === "finalized" && (
          <button className="primary-admin" onClick={handleMarkPaid} disabled={transitioning}>
            <Icon name="check" size={15} /> Mark paid
          </button>
        )}
      </div>

      {error ? (
        <ErrorState message={error} />
      ) : !rows ? (
        <LoadingPanel />
      ) : rows.length === 0 ? (
        <EmptyPanel icon="creditCard" title="No payslips yet" note="Generate payslips to draft pay for every active employee." />
      ) : (
        <section className="panel">
          <div className="table-head cols-8">
            <b>Employee</b><b>Pay type</b><b>Hours</b><b>Gross</b><b>Deductions</b><b>Net</b><b>Status</b><b>Actions</b>
          </div>
          {rows.map((row) => (
            <div className="table-row cols-8" key={row.id}>
              <span>{row.employeeName}</span>
              <span>{row.payType === "hourly" ? "Hourly" : "Salary"}</span>
              <span>{row.hoursWorked != null ? row.hoursWorked.toFixed(1) : "—"}</span>
              <span>{row.grossPay.toFixed(2)}</span>
              <span>{row.totalDeductions.toFixed(2)}</span>
              <span>{row.netPay.toFixed(2)}</span>
              <span className={`pill ${payrollStatusPill[row.status]}`}>{row.status}</span>
              <span className="row-actions">
                <button className="icon-action" onClick={() => setSelectedPayslip(row)} aria-label={`View payslip for ${row.employeeName}`} title="View payslip">
                  <Icon name="chevronRight" size={15} />
                </button>
              </span>
            </div>
          ))}
        </section>
      )}
    </>
  );
}

function PayslipDetailModal({
  payslip,
  editable,
  onClose,
  onChanged,
  setNotice,
}: {
  payslip: AdminPayslip;
  editable: boolean;
  onClose: () => void;
  onChanged: () => void;
  setNotice: (value: string) => void;
}) {
  const [items, setItems] = useState<AdminPayslipLineItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showAdd, setShowAdd] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);

  function load() {
    listPayslipLineItems(payslip.id)
      .then(setItems)
      .catch((err) => setError(errorMessage(err, "Couldn't load line items.")));
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [payslip.id]);

  async function handleDelete(item: AdminPayslipLineItem) {
    setBusyId(item.id);
    try {
      await deletePayslipLineItem(item.id);
      load();
      onChanged();
    } catch (err) {
      setNotice(errorMessage(err, "Couldn't remove the line item."));
    } finally {
      setBusyId(null);
    }
  }

  const totals = (items ?? []).reduce(
    (acc, item) => {
      if (item.lineType === "earning") acc.gross += item.amount;
      else acc.deductions += item.amount;
      return acc;
    },
    { gross: 0, deductions: 0 },
  );

  return (
    <div className="admin-modal-overlay" onClick={onClose}>
      <div className="admin-modal" onClick={(e) => e.stopPropagation()}>
        <div className="admin-modal-header">
          <h2>{payslip.employeeName}</h2>
          <button className="icon-action" onClick={onClose} aria-label="Close"><Icon name="x" size={16} /></button>
        </div>
        <p className="muted small">
          {payslip.employeeCode} · {payslip.payType === "hourly" ? `${payslip.hoursWorked?.toFixed(1) ?? 0}h worked` : "Salaried"}
        </p>

        {showAdd && (
          <AddPayslipLineItemForm
            payslipId={payslip.id}
            onCancel={() => setShowAdd(false)}
            onAdded={() => {
              setShowAdd(false);
              load();
              onChanged();
            }}
          />
        )}

        {error ? (
          <ErrorState message={error} />
        ) : !items ? (
          <LoadingPanel />
        ) : (
          <div>
            <div className="table-head"><b>Type</b><b>Label</b><b>Amount</b>{editable && <b></b>}</div>
            {items.map((item) => (
              <div className="table-row" key={item.id}>
                <span className={`pill ${item.lineType === "deduction" ? "danger" : "success"}`}>{item.lineType}</span>
                <span>{item.label}</span>
                <span>{item.amount.toFixed(2)}</span>
                {editable && (
                  <span className="row-actions">
                    <button className="icon-action reject" disabled={busyId === item.id} onClick={() => handleDelete(item)} aria-label={`Remove ${item.label}`} title="Remove">
                      <Icon name="trash" size={15} />
                    </button>
                  </span>
                )}
              </div>
            ))}
          </div>
        )}

        <div className="payslip-totals">
          <span>Gross <b>{totals.gross.toFixed(2)}</b></span>
          <span>Deductions <b>{totals.deductions.toFixed(2)}</b></span>
          <span>Net <b>{(totals.gross - totals.deductions).toFixed(2)}</b></span>
        </div>

        <div className="admin-modal-actions">
          {editable && !showAdd && (
            <button type="button" className="outline-button" onClick={() => setShowAdd(true)}>
              <Icon name="plus" size={15} /> Add line
            </button>
          )}
          <button className="primary-admin" onClick={onClose}>Done</button>
        </div>
      </div>
    </div>
  );
}

function AddPayslipLineItemForm({
  payslipId,
  onCancel,
  onAdded,
}: {
  payslipId: string;
  onCancel: () => void;
  onAdded: () => void;
}) {
  const [lineType, setLineType] = useState<PayslipLineType>("deduction");
  const [label, setLabel] = useState("");
  const [amount, setAmount] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    const parsed = Number(amount);
    if (!label.trim() || !Number.isFinite(parsed) || parsed < 0) {
      setError("Enter a label and an amount of 0 or more.");
      return;
    }
    setError(null);
    setSaving(true);
    try {
      await addPayslipLineItem({ payslipId, lineType, label, amount: parsed });
      onAdded();
    } catch (err) {
      setError(errorMessage(err, "Couldn't add the line item."));
    } finally {
      setSaving(false);
    }
  }

  return (
    <form className="admin-login-form payslip-line-form" onSubmit={handleSubmit}>
      <label>
        Type
        <select value={lineType} onChange={(e) => setLineType(e.target.value as PayslipLineType)} disabled={saving}>
          <option value="earning">Earning</option>
          <option value="deduction">Deduction</option>
        </select>
      </label>
      <label>
        Label
        <input required value={label} onChange={(e) => setLabel(e.target.value)} disabled={saving} placeholder="e.g. Income tax" />
      </label>
      <label>
        Amount
        <input required type="number" min="0" step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} disabled={saving} />
      </label>
      {error && <p className="form-error"><Icon name="warning" size={14} />{error}</p>}
      <div className="admin-modal-actions">
        <button type="button" className="outline-button" onClick={onCancel} disabled={saving}>Cancel</button>
        <button className="primary-admin" type="submit" disabled={saving}>{saving ? "Adding…" : "Add line"}</button>
      </div>
    </form>
  );
}

function PayRates({ setNotice }: NoticeProps) {
  const [rows, setRows] = useState<AdminCompensation[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<AdminCompensation | null>(null);

  function load() {
    listEmployeeCompensation()
      .then(setRows)
      .catch((err) => setError(errorMessage(err, "Couldn't load pay rates.")));
  }

  useEffect(() => {
    load();
  }, []);

  return (
    <>
      {editing && (
        <EditCompensationModal
          compensation={editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setNotice(`Pay rate updated for ${editing.employeeName}.`);
            setEditing(null);
            load();
          }}
        />
      )}
      {error ? (
        <ErrorState message={error} />
      ) : !rows ? (
        <LoadingPanel />
      ) : rows.length === 0 ? (
        <EmptyPanel icon="creditCard" title="No active employees" note="Pay rates appear here once employees are added." />
      ) : (
        <section className="panel">
          <div className="table-head cols-6">
            <b>Employee</b><b>Employee code</b><b>Pay type</b><b>Rate</b><b>Currency</b><b>Actions</b>
          </div>
          {rows.map((row) => (
            <div className="table-row cols-6" key={row.employeeId}>
              <span>{row.employeeName}</span>
              <span>{row.employeeCode}</span>
              <span>{row.payType === "hourly" ? "Hourly" : "Salary"}</span>
              <span>{row.payType === "hourly" ? row.hourlyRate?.toFixed(2) ?? "—" : row.monthlySalary?.toFixed(2) ?? "—"}</span>
              <span>{row.currency}</span>
              <span className="row-actions">
                <button className="icon-action" onClick={() => setEditing(row)} aria-label={`Edit pay rate for ${row.employeeName}`} title="Edit">
                  <Icon name="edit" size={15} />
                </button>
              </span>
            </div>
          ))}
        </section>
      )}
    </>
  );
}

function EditCompensationModal({
  compensation,
  onClose,
  onSaved,
}: {
  compensation: AdminCompensation;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [payType, setPayType] = useState<PayType>(compensation.payType);
  const [monthlySalary, setMonthlySalary] = useState(compensation.monthlySalary != null ? String(compensation.monthlySalary) : "");
  const [hourlyRate, setHourlyRate] = useState(compensation.hourlyRate != null ? String(compensation.hourlyRate) : "");
  const [currency, setCurrency] = useState(compensation.currency);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    const salary = Number(monthlySalary);
    const rate = Number(hourlyRate);
    if (payType === "salary" && (!monthlySalary || !Number.isFinite(salary) || salary < 0)) {
      setError("Enter a monthly salary of 0 or more.");
      return;
    }
    if (payType === "hourly" && (!hourlyRate || !Number.isFinite(rate) || rate < 0)) {
      setError("Enter an hourly rate of 0 or more.");
      return;
    }
    setError(null);
    setSaving(true);
    try {
      await upsertEmployeeCompensation({
        employeeId: compensation.employeeId,
        payType,
        monthlySalary: payType === "salary" ? salary : null,
        hourlyRate: payType === "hourly" ? rate : null,
        currency,
      });
      onSaved();
    } catch (err) {
      setError(errorMessage(err, "Couldn't update the pay rate."));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="admin-modal-overlay" onClick={onClose}>
      <div className="admin-modal" onClick={(e) => e.stopPropagation()}>
        <div className="admin-modal-header">
          <h2>{compensation.employeeName}</h2>
          <button className="icon-action" onClick={onClose} aria-label="Close"><Icon name="x" size={16} /></button>
        </div>
        <form className="admin-login-form" onSubmit={handleSubmit}>
          <label>
            Pay type
            <select value={payType} onChange={(e) => setPayType(e.target.value as PayType)} disabled={saving}>
              <option value="salary">Monthly salary</option>
              <option value="hourly">Hourly rate</option>
            </select>
          </label>
          {payType === "salary" ? (
            <label>
              Monthly salary
              <input required type="number" min="0" step="0.01" value={monthlySalary} onChange={(e) => setMonthlySalary(e.target.value)} disabled={saving} />
            </label>
          ) : (
            <label>
              Hourly rate
              <input required type="number" min="0" step="0.01" value={hourlyRate} onChange={(e) => setHourlyRate(e.target.value)} disabled={saving} />
            </label>
          )}
          <label>
            Currency
            <input required value={currency} onChange={(e) => setCurrency(e.target.value.toUpperCase())} disabled={saving} maxLength={3} />
          </label>
          {error && <p className="form-error"><Icon name="warning" size={14} />{error}</p>}
          <div className="admin-modal-actions">
            <button type="button" className="outline-button" onClick={onClose} disabled={saving}>Cancel</button>
            <button className="primary-admin" type="submit" disabled={saving}>{saving ? "Saving…" : "Save"}</button>
          </div>
        </form>
      </div>
    </div>
  );
}

function AttendanceLocations({ setNotice }: NoticeProps) {
  const [rows, setRows] = useState<AdminAttendanceLocation[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [editing, setEditing] = useState<AdminAttendanceLocation | null>(null);

  function load() {
    listAttendanceLocations()
      .then(setRows)
      .catch((err) => setError(errorMessage(err, "Couldn't load attendance locations.")));
  }

  useEffect(() => {
    load();
  }, []);

  return (
    <>
      <Toolbar action="Add location" onAction={() => setShowCreate(true)} />
      {showCreate && (
        <AttendanceLocationModal
          onClose={() => setShowCreate(false)}
          onSaved={(name) => {
            setShowCreate(false);
            setNotice(`Location "${name}" added.`);
            load();
          }}
        />
      )}
      {editing && (
        <AttendanceLocationModal
          location={editing}
          onClose={() => setEditing(null)}
          onSaved={(name) => {
            setEditing(null);
            setNotice(`Location "${name}" updated.`);
            load();
          }}
        />
      )}
      {error ? (
        <ErrorState message={error} />
      ) : !rows ? (
        <LoadingPanel />
      ) : rows.length === 0 ? (
        <EmptyPanel
          icon="building"
          title="No attendance locations yet"
          note="Add a location so employees can clock in as “office” from the PWA — direct clock-in checks that they're within its radius."
        />
      ) : (
        <section className="panel">
          <div className="table-head"><b>Location</b><b>Coordinates</b><b>Radius</b><b className="actions-head">Actions</b></div>
          {rows.map((location) => (
            <div className="table-row" key={location.id}>
              <span>{location.name}</span>
              <span>{location.latitude.toFixed(6)}, {location.longitude.toFixed(6)}</span>
              <span>{location.radiusMeters}m</span>
              <span className="row-actions">
                <button className="icon-action" onClick={() => setEditing(location)} aria-label={`Edit ${location.name}`} title="Edit">
                  <Icon name="edit" size={15} />
                </button>
              </span>
            </div>
          ))}
        </section>
      )}
    </>
  );
}

function AttendanceLocationModal({
  location,
  onClose,
  onSaved,
}: {
  location?: AdminAttendanceLocation;
  onClose: () => void;
  onSaved: (name: string) => void;
}) {
  const [name, setName] = useState(location?.name ?? "");
  const [latitude, setLatitude] = useState(location ? String(location.latitude) : "");
  const [longitude, setLongitude] = useState(location ? String(location.longitude) : "");
  const [radiusMeters, setRadiusMeters] = useState(location ? String(location.radiusMeters) : "150");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    const lat = Number(latitude);
    const lng = Number(longitude);
    const radius = Number(radiusMeters);
    if (!Number.isFinite(lat) || lat < -90 || lat > 90) {
      setError("Enter a valid latitude between -90 and 90.");
      return;
    }
    if (!Number.isFinite(lng) || lng < -180 || lng > 180) {
      setError("Enter a valid longitude between -180 and 180.");
      return;
    }
    if (!Number.isFinite(radius) || radius <= 0) {
      setError("Enter a radius greater than 0.");
      return;
    }
    setError(null);
    setSaving(true);
    try {
      if (location) {
        await updateAttendanceLocation({ id: location.id, name, latitude: lat, longitude: lng, radiusMeters: radius });
      } else {
        await createAttendanceLocation({ name, latitude: lat, longitude: lng, radiusMeters: radius });
      }
      onSaved(name);
    } catch (err) {
      setError(errorMessage(err, "Couldn't save the location."));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="admin-modal-overlay" onClick={onClose}>
      <div className="admin-modal" onClick={(e) => e.stopPropagation()}>
        <div className="admin-modal-header">
          <h2>{location ? "Edit location" : "Add location"}</h2>
          <button className="icon-action" onClick={onClose} aria-label="Close"><Icon name="x" size={16} /></button>
        </div>
        <form className="admin-login-form" onSubmit={handleSubmit}>
          <label>
            Name
            <input required value={name} onChange={(e) => setName(e.target.value)} disabled={saving} placeholder="e.g. Pristina HQ" />
          </label>
          <label>
            Latitude
            <input required type="number" step="any" value={latitude} onChange={(e) => setLatitude(e.target.value)} disabled={saving} placeholder="42.662914" />
          </label>
          <label>
            Longitude
            <input required type="number" step="any" value={longitude} onChange={(e) => setLongitude(e.target.value)} disabled={saving} placeholder="21.165503" />
          </label>
          <label>
            Radius (meters)
            <input required type="number" min="1" step="1" value={radiusMeters} onChange={(e) => setRadiusMeters(e.target.value)} disabled={saving} />
          </label>
          <p className="muted small">An employee clocking in as "office" from this location must be within this radius. Wider radius = more tolerant of GPS drift.</p>
          {error && <p className="form-error"><Icon name="warning" size={14} />{error}</p>}
          <div className="admin-modal-actions">
            <button type="button" className="outline-button" onClick={onClose} disabled={saving}>Cancel</button>
            <button className="primary-admin" type="submit" disabled={saving}>{saving ? "Saving…" : location ? "Save changes" : "Add location"}</button>
          </div>
        </form>
      </div>
    </div>
  );
}

function Devices({ setNotice }: NoticeProps) {
  const [rows, setRows] = useState<AdminDevice[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [showRegisterModal, setShowRegisterModal] = useState(false);
  const [pinReveal, setPinReveal] = useState<{ label: string; pin: string } | null>(null);

  function load() {
    listAttendanceDevices()
      .then(setRows)
      .catch((err) => setError(errorMessage(err, "Couldn't load kiosk devices.")));
  }

  useEffect(() => {
    load();
  }, []);

  async function handleRegenerate(device: AdminDevice) {
    setBusyId(device.id);
    try {
      const pin = await regenerateDevicePin(device.id);
      setPinReveal({ label: device.label, pin });
    } catch (err) {
      setNotice(errorMessage(err, "Couldn't regenerate the PIN."));
    } finally {
      setBusyId(null);
    }
  }

  async function handleToggleActive(device: AdminDevice) {
    setBusyId(device.id);
    try {
      await setDeviceActive(device.id, !device.active);
      setNotice(`${device.label} ${device.active ? "deactivated" : "reactivated"}.`);
      load();
    } catch (err) {
      setNotice(errorMessage(err, "Couldn't update the device."));
    } finally {
      setBusyId(null);
    }
  }

  async function handleDelete(device: AdminDevice) {
    if (!window.confirm(`Delete "${device.label}"? If this tablet is still in use it will stop recording attendance and can't be re-paired with its current PIN.`)) return;
    setBusyId(device.id);
    try {
      await deleteAttendanceDevice(device.id);
      setNotice(`${device.label} deleted.`);
      load();
    } catch (err) {
      setNotice(errorMessage(err, "Couldn't delete the device."));
    } finally {
      setBusyId(null);
    }
  }

  return (
    <>
      <Toolbar action="Register kiosk" onAction={() => setShowRegisterModal(true)} />
      {showRegisterModal && (
        <RegisterKioskModal
          onClose={() => setShowRegisterModal(false)}
          onRegistered={(device) => {
            setShowRegisterModal(false);
            setPinReveal({ label: device.label, pin: device.pin });
            load();
          }}
        />
      )}
      {pinReveal && <KioskPinModal label={pinReveal.label} pin={pinReveal.pin} onClose={() => setPinReveal(null)} />}
      <section className="panel">
        <div className="panel-title"><h2>QR attendance devices</h2><span className="pill success">QR mode enabled</span></div>
        <p className="muted">Employees show their rotating personal QR code. A dedicated tablet scans it and records the server-validated attendance event.</p>
        {error ? (
          <ErrorState message={error} />
        ) : !rows ? (
          <LoadingPanel />
        ) : rows.length === 0 ? (
          <p className="muted small">No kiosk devices registered yet.</p>
        ) : (
          rows.map((device) => (
            <div className="device-card" key={device.id}>
              <div>
                <b>{device.label}</b>
                <p className="muted">
                  {device.active ? "Active" : "Inactive"} · Restricted kiosk account
                  {device.lastSeenAt && <> · Last active {new Date(device.lastSeenAt).toLocaleString([], { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" })}</>}
                </p>
              </div>
              <span className={`pill ${device.paired ? "success" : ""}`}>{device.paired ? "Paired" : "Not paired"}</span>
              <span className="row-actions">
                <button className="outline-button" disabled={busyId === device.id} onClick={() => handleRegenerate(device)}>
                  Regenerate PIN
                </button>
                <button className="outline-button" disabled={busyId === device.id} onClick={() => handleToggleActive(device)}>
                  {device.active ? "Deactivate" : "Reactivate"}
                </button>
                <button className="icon-action reject" disabled={busyId === device.id} onClick={() => handleDelete(device)} aria-label={`Delete ${device.label}`} title="Delete device">
                  <Icon name="trash" size={15} />
                </button>
              </span>
            </div>
          ))
        )}
        <section className="setting-card">
          <div>
            <b>Optional geolocation rule</b>
            <p className="muted">Enable later to limit direct mobile clock-ins to approved locations.</p>
          </div>
          <label className="switch"><input type="checkbox" /><span /></label>
        </section>
      </section>
    </>
  );
}

function RegisterKioskModal({ onClose, onRegistered }: { onClose: () => void; onRegistered: (device: RegisteredDevice) => void }) {
  const [label, setLabel] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    setSaving(true);
    try {
      const device = await registerDevice(label);
      onRegistered(device);
    } catch (err) {
      setError(errorMessage(err, "Couldn't register the kiosk."));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="admin-modal-overlay" onClick={onClose}>
      <div className="admin-modal" onClick={(e) => e.stopPropagation()}>
        <div className="admin-modal-header">
          <h2>Register kiosk</h2>
          <button className="icon-action" onClick={onClose} aria-label="Close"><Icon name="x" size={16} /></button>
        </div>
        <p className="muted small">Creates a restricted attendance device with a one-time PIN. Give the PIN to whoever sets up the shared tablet — it's shown once and can't be retrieved later, only regenerated.</p>
        <form className="admin-login-form" onSubmit={handleSubmit}>
          <label>
            Device label
            <input required value={label} onChange={(e) => setLabel(e.target.value)} disabled={saving} placeholder="e.g. Front desk tablet" />
          </label>
          {error && <p className="form-error"><Icon name="warning" size={14} />{error}</p>}
          <div className="admin-modal-actions">
            <button type="button" className="outline-button" onClick={onClose} disabled={saving}>Cancel</button>
            <button className="primary-admin" type="submit" disabled={saving}>{saving ? "Registering…" : "Register"}</button>
          </div>
        </form>
      </div>
    </div>
  );
}

function KioskPinModal({ label, pin, onClose }: { label: string; pin: string; onClose: () => void }) {
  return (
    <div className="admin-modal-overlay" onClick={onClose}>
      <div className="admin-modal" onClick={(e) => e.stopPropagation()}>
        <div className="admin-modal-header">
          <h2>{label}</h2>
          <button className="icon-action" onClick={onClose} aria-label="Close"><Icon name="x" size={16} /></button>
        </div>
        <p className="muted small">This PIN won't be shown again. Write it down or share it with whoever's setting up the device now.</p>
        <p className="kiosk-pin">{pin}</p>
        <div className="admin-modal-actions">
          <button className="primary-admin" onClick={onClose}>Done</button>
        </div>
      </div>
    </div>
  );
}

function Settings({ setNotice }: NoticeProps) {
  return (
    <section className="panel settings-panel">
      <Setting title="Company details" text="HR representative, leave year and date format" />
      <Setting title="Attendance rules" text="QR kiosk, mobile buttons, web check-in and geolocation" />
      <Setting title="Leave policies" text="Types, entitlements, approvals and holidays" />
      <Setting title="Audit log" text="Review sensitive platform activity" />
      <button className="primary-admin" onClick={() => setNotice("Settings persist directly to Supabase once the settings tables are added.")}>Save settings</button>
    </section>
  );
}

// ---- Recruitment ----

const jobStatusPill: Record<JobStatus, string> = { draft: "", open: "success", on_hold: "pending", closed: "danger" };

// <input type="datetime-local"> works in local time without a zone; the DB stores timestamptz.
function toLocalDateTimeInput(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function fromLocalDateTimeInput(value: string): string | null {
  return value ? new Date(value).toISOString() : null;
}

function formatDateTime(iso: string) {
  return new Date(iso).toLocaleString([], { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });
}

function Recruitment({ setNotice, isHrAdmin, currentUserId }: NoticeProps & { isHrAdmin: boolean; currentUserId: string }) {
  const [jobs, setJobs] = useState<Job[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<"active" | "archived">("active");
  const [search, setSearch] = useState("");
  const [editingJob, setEditingJob] = useState<Job | "new" | null>(null);
  const [openJobId, setOpenJobId] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  function load() {
    listJobs()
      .then(setJobs)
      .catch((err) => setError(errorMessage(err, "Couldn't load jobs.")));
  }

  useEffect(() => {
    load();
  }, []);

  const visible =
    jobs?.filter(
      (job) =>
        (tab === "active" ? !job.archived : job.archived) &&
        matchesSearch(search, job.title, job.teamName, job.location, JOB_STATUS_LABELS[job.status], ...job.hiringTeam.map((m) => m.name)),
    ) ?? null;

  function handleExport() {
    if (!visible || visible.length === 0) {
      setNotice("No jobs to export.");
      return;
    }
    downloadCsv(
      `jobs-${new Date().toISOString().slice(0, 10)}.csv`,
      ["Title", "Department", "Location", "Type", "Openings", "Status", "Applications", "Hiring team", "Created"],
      visible.map((job) => [
        job.title,
        job.teamName ?? "",
        job.location ?? "",
        EMPLOYMENT_TYPE_LABELS[job.employmentType],
        job.openings,
        JOB_STATUS_LABELS[job.status],
        job.applicationCount,
        job.hiringTeam.map((m) => m.name).join("; "),
        job.createdAt.slice(0, 10),
      ]),
    );
  }

  async function handleArchive(job: Job) {
    if (!job.archived && !window.confirm(`Archive "${job.title}"? It moves to the Archived tab; candidates are kept.`)) return;
    setBusyId(job.id);
    try {
      await setJobArchived(job.id, !job.archived);
      setNotice(job.archived ? `"${job.title}" restored.` : `"${job.title}" archived.`);
      load();
    } catch (err) {
      setNotice(errorMessage(err, "Couldn't update the job."));
    } finally {
      setBusyId(null);
    }
  }

  const openJob = jobs?.find((j) => j.id === openJobId) ?? null;
  if (openJob) {
    return (
      <>
        {editingJob && (
          <JobModal
            job={editingJob === "new" ? null : editingJob}
            onClose={() => setEditingJob(null)}
            onSaved={(title) => {
              setEditingJob(null);
              setNotice(`"${title}" saved.`);
              load();
            }}
          />
        )}
        <JobPipeline
          job={openJob}
          isHrAdmin={isHrAdmin}
          currentUserId={currentUserId}
          setNotice={setNotice}
          onBack={() => {
            setOpenJobId(null);
            load();
          }}
          onEdit={() => setEditingJob(openJob)}
        />
      </>
    );
  }

  return (
    <>
      <Toolbar
        action={isHrAdmin ? "Add a job" : undefined}
        onAction={isHrAdmin ? () => setEditingJob("new") : undefined}
        onExport={handleExport}
        search={search}
        onSearch={setSearch}
        searchPlaceholder="Search jobs"
      />
      {editingJob && (
        <JobModal
          job={editingJob === "new" ? null : editingJob}
          onClose={() => setEditingJob(null)}
          onSaved={(title) => {
            setEditingJob(null);
            setNotice(`"${title}" saved.`);
            load();
          }}
        />
      )}
      <div className="module-tabs">
        <button className={tab === "active" ? "active" : ""} onClick={() => setTab("active")}>Active</button>
        <button className={tab === "archived" ? "active" : ""} onClick={() => setTab("archived")}>Archived</button>
      </div>
      {error ? (
        <ErrorState message={error} />
      ) : !visible ? (
        <LoadingPanel />
      ) : visible.length === 0 ? (
        search.trim() ? (
          <EmptyPanel icon="search" title="No matches" note={`No jobs match "${search.trim()}".`} />
        ) : tab === "archived" ? (
          <EmptyPanel icon="archive" title="No archived jobs" note="Jobs you archive will appear here." />
        ) : (
          <EmptyPanel
            icon="userPlus"
            title="No jobs yet"
            note={isHrAdmin ? "Add a job to start tracking candidates." : "Jobs appear here once HR adds you to a hiring team."}
          />
        )
      ) : (
        <section className="panel">
          <div className="table-head cols-6">
            <b>Title</b><b>Applications</b><b>Department</b><b>Status</b><b>Hiring team</b><b className="actions-head">Actions</b>
          </div>
          {visible.map((job) => (
            <div className="table-row cols-6" key={job.id}>
              <span>
                <button className="link-button" onClick={() => setOpenJobId(job.id)}>{job.title}</button>
                <em className="asset-sub">
                  {EMPLOYMENT_TYPE_LABELS[job.employmentType]}
                  {job.location ? ` · ${job.location}` : ""}
                  {job.openings > 1 ? ` · ${job.openings} openings` : ""}
                </em>
              </span>
              <span>{job.applicationCount}</span>
              <span>{job.teamName ?? "—"}</span>
              <span><span className={`pill ${jobStatusPill[job.status]}`}>{JOB_STATUS_LABELS[job.status]}</span></span>
              <span className="team-cell">{job.hiringTeam.length ? job.hiringTeam.map((m) => m.name).join(", ") : "—"}</span>
              <span className="row-actions">
                {isHrAdmin && (
                  <>
                    <button className="icon-action" disabled={busyId === job.id} onClick={() => setEditingJob(job)} aria-label={`Edit ${job.title}`} title="Edit">
                      <Icon name="edit" size={15} />
                    </button>
                    <button
                      className="icon-action"
                      disabled={busyId === job.id}
                      onClick={() => handleArchive(job)}
                      aria-label={job.archived ? `Restore ${job.title}` : `Archive ${job.title}`}
                      title={job.archived ? "Restore" : "Archive"}
                    >
                      <Icon name={job.archived ? "upload" : "archive"} size={15} />
                    </button>
                  </>
                )}
                <button className="icon-action" onClick={() => setOpenJobId(job.id)} aria-label={`Open ${job.title}`} title="Candidates">
                  <Icon name="chevronRight" size={15} />
                </button>
              </span>
            </div>
          ))}
        </section>
      )}
    </>
  );
}

function JobModal({ job, onClose, onSaved }: { job: Job | null; onClose: () => void; onSaved: (title: string) => void }) {
  const [title, setTitle] = useState(job?.title ?? "");
  const [teamId, setTeamId] = useState(job?.teamId ?? "");
  const [location, setLocation] = useState(job?.location ?? "");
  const [employmentType, setEmploymentType] = useState<EmploymentType>(job?.employmentType ?? "full_time");
  const [openings, setOpenings] = useState(String(job?.openings ?? 1));
  const [status, setStatus] = useState<JobStatus>(job?.status ?? "open");
  const [description, setDescription] = useState(job?.description ?? "");
  const [hiringTeamIds, setHiringTeamIds] = useState<string[]>(job?.hiringTeam.map((m) => m.id) ?? []);
  const [teams, setTeams] = useState<AdminTeam[]>([]);
  const [people, setPeople] = useState<AdminEmployee[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    listTeams().then(setTeams).catch(() => setTeams([]));
    listEmployees()
      .then((rows) => setPeople(rows.filter((r) => r.active && ["manager", "team_lead", "hr_admin"].includes(r.role))))
      .catch(() => setPeople([]));
  }, []);

  function toggleMember(id: string) {
    setHiringTeamIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  }

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    const openingsNumber = Number(openings);
    if (!Number.isInteger(openingsNumber) || openingsNumber < 1) {
      setError("Openings must be a whole number of at least 1.");
      return;
    }
    setSaving(true);
    try {
      const input = { title, teamId: teamId || null, location, employmentType, openings: openingsNumber, status, description, hiringTeamIds };
      if (job) await updateJob(job.id, input);
      else await createJob(input);
      onSaved(title.trim());
    } catch (err) {
      setError(errorMessage(err, "Couldn't save the job."));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="admin-modal-overlay" onClick={onClose}>
      <div className="admin-modal wide" onClick={(e) => e.stopPropagation()}>
        <div className="admin-modal-header">
          <h2>{job ? "Edit job" : "Add a job"}</h2>
          <button className="icon-action" onClick={onClose} aria-label="Close"><Icon name="x" size={16} /></button>
        </div>
        <form className="admin-login-form" onSubmit={handleSubmit}>
          <h3 className="form-section">Job</h3>
          <label>
            Job title
            <input required value={title} onChange={(e) => setTitle(e.target.value)} disabled={saving} placeholder="e.g. Warehouse operative" />
          </label>
          <label>
            Department
            <select value={teamId} onChange={(e) => setTeamId(e.target.value)} disabled={saving}>
              <option value="">No department</option>
              {teams.map((t) => (
                <option key={t.id} value={t.id}>{t.name}</option>
              ))}
            </select>
          </label>
          <label>
            Location <span className="field-optional">optional</span>
            <input value={location} onChange={(e) => setLocation(e.target.value)} disabled={saving} placeholder="e.g. Clondalkin, Dublin 22" />
          </label>
          <label>
            Employment type
            <select value={employmentType} onChange={(e) => setEmploymentType(e.target.value as EmploymentType)} disabled={saving}>
              {(Object.keys(EMPLOYMENT_TYPE_LABELS) as EmploymentType[]).map((t) => (
                <option key={t} value={t}>{EMPLOYMENT_TYPE_LABELS[t]}</option>
              ))}
            </select>
          </label>
          <label>
            Openings
            <input type="number" min={1} step={1} required value={openings} onChange={(e) => setOpenings(e.target.value)} disabled={saving} />
          </label>
          <label>
            Status
            <select value={status} onChange={(e) => setStatus(e.target.value as JobStatus)} disabled={saving}>
              {(Object.keys(JOB_STATUS_LABELS) as JobStatus[]).map((s) => (
                <option key={s} value={s}>{JOB_STATUS_LABELS[s]}</option>
              ))}
            </select>
          </label>
          <label>
            Description <span className="field-optional">optional</span>
            <textarea rows={4} value={description} onChange={(e) => setDescription(e.target.value)} disabled={saving} placeholder="Responsibilities, requirements, shift pattern…" />
          </label>
          <h3 className="form-section">
            Hiring team <span className="field-optional">they can see this job&apos;s candidates, add notes and move stages</span>
          </h3>
          <div className="choice-grid">
            {people.length === 0 ? (
              <p className="muted small">No managers, team leads or HR admins to choose from.</p>
            ) : (
              people.map((p) => (
                <label key={p.id} className="choice-chip">
                  <input type="checkbox" checked={hiringTeamIds.includes(p.id)} onChange={() => toggleMember(p.id)} disabled={saving} />
                  <span>
                    {p.fullName}
                    <em>{p.role.replace("_", " ")}</em>
                  </span>
                </label>
              ))
            )}
          </div>
          {error && <p className="form-error"><Icon name="warning" size={14} />{error}</p>}
          <div className="admin-modal-actions">
            <button type="button" className="outline-button" onClick={onClose} disabled={saving}>Cancel</button>
            <button className="primary-admin" type="submit" disabled={saving}>{saving ? "Saving…" : job ? "Save changes" : "Create job"}</button>
          </div>
        </form>
      </div>
    </div>
  );
}

function JobPipeline({
  job,
  isHrAdmin,
  currentUserId,
  setNotice,
  onBack,
  onEdit,
}: NoticeProps & { job: Job; isHrAdmin: boolean; currentUserId: string; onBack: () => void; onEdit: () => void }) {
  const [candidates, setCandidates] = useState<Candidate[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [showAdd, setShowAdd] = useState(false);
  const [openCandidateId, setOpenCandidateId] = useState<string | null>(null);

  function load() {
    listCandidates(job.id)
      .then(setCandidates)
      .catch((err) => setError(errorMessage(err, "Couldn't load candidates.")));
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [job.id]);

  function replaceCandidate(updated: Candidate) {
    setCandidates((prev) => prev?.map((c) => (c.id === updated.id ? updated : c)) ?? prev);
  }

  function handleExport() {
    if (!candidates || candidates.length === 0) {
      setNotice("No candidates to export.");
      return;
    }
    downloadCsv(
      `candidates-${job.title.replace(/\s+/g, "-").toLowerCase()}.csv`,
      ["Name", "Email", "Phone", "Source", "Stage", "Interview", "Added"],
      candidates.map((c) => [
        c.fullName,
        c.email ?? "",
        c.phone ?? "",
        c.source ?? "",
        CANDIDATE_STAGE_LABELS[c.stage],
        c.interviewAt ? formatDateTime(c.interviewAt) : "",
        c.createdAt.slice(0, 10),
      ]),
    );
  }

  const filtered = candidates?.filter((c) => matchesSearch(search, c.fullName, c.email, c.phone, c.source)) ?? null;
  const openCandidate = candidates?.find((c) => c.id === openCandidateId) ?? null;

  return (
    <>
      <button className="outline-button back-button" onClick={onBack}>
        <Icon name="arrowLeft" size={15} /> All jobs
      </button>
      <section className="panel job-summary">
        <div>
          <h2>{job.title}</h2>
          <p className="muted small">
            {[job.teamName, job.location, EMPLOYMENT_TYPE_LABELS[job.employmentType], job.openings > 1 ? `${job.openings} openings` : null]
              .filter(Boolean)
              .join(" · ")}
          </p>
          {job.hiringTeam.length > 0 && <p className="muted small">Hiring team: {job.hiringTeam.map((m) => m.name).join(", ")}</p>}
        </div>
        <div className="job-summary-side">
          <span className={`pill ${jobStatusPill[job.status]}`}>{JOB_STATUS_LABELS[job.status]}</span>
          {isHrAdmin && (
            <button className="outline-button" onClick={onEdit}><Icon name="edit" size={15} /> Edit job</button>
          )}
        </div>
      </section>
      <Toolbar
        action={isHrAdmin ? "Add candidate" : undefined}
        onAction={isHrAdmin ? () => setShowAdd(true) : undefined}
        onExport={handleExport}
        search={search}
        onSearch={setSearch}
        searchPlaceholder="Search candidates"
      />
      {showAdd && (
        <AddCandidateModal
          jobId={job.id}
          onClose={() => setShowAdd(false)}
          onCreated={(candidate, warning) => {
            setShowAdd(false);
            setNotice(warning ?? `${candidate.fullName} added.`);
            load();
          }}
        />
      )}
      {openCandidate && (
        <CandidateModal
          candidate={openCandidate}
          job={job}
          isHrAdmin={isHrAdmin}
          currentUserId={currentUserId}
          setNotice={setNotice}
          onClose={() => setOpenCandidateId(null)}
          onChanged={replaceCandidate}
          onDeleted={() => {
            setOpenCandidateId(null);
            load();
          }}
        />
      )}
      {error ? (
        <ErrorState message={error} />
      ) : !filtered ? (
        <LoadingPanel />
      ) : candidates?.length === 0 ? (
        <EmptyPanel
          icon="users"
          title="No candidates yet"
          note={isHrAdmin ? "Add candidates as applications come in." : "HR hasn't added any candidates to this job yet."}
        />
      ) : (
        <div className="pipeline-board">
          {CANDIDATE_STAGES.map((stage) => {
            const inStage = filtered.filter((c) => c.stage === stage);
            return (
              <section key={stage} className={`pipeline-column stage-${stage}`}>
                <header>
                  <b>{CANDIDATE_STAGE_LABELS[stage]}</b>
                  <span className="pill">{inStage.length}</span>
                </header>
                {inStage.length === 0 ? (
                  <p className="pipeline-empty">—</p>
                ) : (
                  inStage.map((c) => (
                    <button key={c.id} className="candidate-card" onClick={() => setOpenCandidateId(c.id)}>
                      <b>{c.fullName}</b>
                      {c.email && <span>{c.email}</span>}
                      {c.interviewAt && stage === "interview" && (
                        <span className="candidate-card-meta"><Icon name="calendar" size={12} /> {formatDateTime(c.interviewAt)}</span>
                      )}
                      {c.hiredEmployeeId && <span className="candidate-card-meta"><Icon name="check" size={12} /> Employee created</span>}
                      {c.cvPath && <span className="candidate-card-meta"><Icon name="archive" size={12} /> CV</span>}
                    </button>
                  ))
                )}
              </section>
            );
          })}
        </div>
      )}
    </>
  );
}

function AddCandidateModal({
  jobId,
  onClose,
  onCreated,
}: {
  jobId: string;
  onClose: () => void;
  onCreated: (candidate: Candidate, warning?: string) => void;
}) {
  const [fullName, setFullName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [source, setSource] = useState("");
  const [cv, setCv] = useState<File | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    setSaving(true);
    try {
      const candidate = await createCandidate(jobId, { fullName, email, phone, source });
      if (cv) {
        // The candidate exists at this point, so a failed upload is reported
        // rather than thrown -- retrying the whole form would create a duplicate.
        try {
          await uploadCandidateCv(candidate, cv);
        } catch (err) {
          onCreated(candidate, `${candidate.fullName} added, but the CV didn't upload: ${errorMessage(err, "unknown error")}. Open the candidate to try again.`);
          return;
        }
      }
      onCreated(candidate);
    } catch (err) {
      setError(errorMessage(err, "Couldn't add the candidate."));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="admin-modal-overlay" onClick={onClose}>
      <div className="admin-modal" onClick={(e) => e.stopPropagation()}>
        <div className="admin-modal-header">
          <h2>Add candidate</h2>
          <button className="icon-action" onClick={onClose} aria-label="Close"><Icon name="x" size={16} /></button>
        </div>
        <form className="admin-login-form" onSubmit={handleSubmit}>
          <label>
            Full name
            <input required value={fullName} onChange={(e) => setFullName(e.target.value)} disabled={saving} />
          </label>
          <label>
            Email <span className="field-optional">optional</span>
            <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} disabled={saving} />
          </label>
          <label>
            Phone <span className="field-optional">optional</span>
            <input type="tel" value={phone} onChange={(e) => setPhone(e.target.value)} disabled={saving} />
          </label>
          <label>
            Source <span className="field-optional">optional</span>
            <input value={source} onChange={(e) => setSource(e.target.value)} disabled={saving} placeholder="e.g. Indeed, referral, walk-in" />
          </label>
          <label>
            CV <span className="field-optional">PDF or Word, up to 10 MB</span>
            <input type="file" accept=".pdf,.doc,.docx" onChange={(e) => setCv(e.target.files?.[0] ?? null)} disabled={saving} />
          </label>
          {error && <p className="form-error"><Icon name="warning" size={14} />{error}</p>}
          <div className="admin-modal-actions">
            <button type="button" className="outline-button" onClick={onClose} disabled={saving}>Cancel</button>
            <button className="primary-admin" type="submit" disabled={saving}>{saving ? "Adding…" : "Add candidate"}</button>
          </div>
        </form>
      </div>
    </div>
  );
}

function CandidateModal({
  candidate,
  job,
  isHrAdmin,
  currentUserId,
  setNotice,
  onClose,
  onChanged,
  onDeleted,
}: NoticeProps & {
  candidate: Candidate;
  job: Job;
  isHrAdmin: boolean;
  currentUserId: string;
  onClose: () => void;
  onChanged: (candidate: Candidate) => void;
  onDeleted: () => void;
}) {
  const [stage, setStage] = useState<CandidateStage>(candidate.stage);
  const [interviewAt, setInterviewAt] = useState(toLocalDateTimeInput(candidate.interviewAt));
  const [fullName, setFullName] = useState(candidate.fullName);
  const [email, setEmail] = useState(candidate.email ?? "");
  const [phone, setPhone] = useState(candidate.phone ?? "");
  const [source, setSource] = useState(candidate.source ?? "");
  const [notes, setNotes] = useState<CandidateNote[] | null>(null);
  const [noteDraft, setNoteDraft] = useState("");
  const [busy, setBusy] = useState<"stage" | "details" | "note" | "cv" | "delete" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [hiring, setHiring] = useState(false);

  function loadNotes() {
    listCandidateNotes(candidate.id)
      .then(setNotes)
      .catch(() => setNotes([]));
  }

  useEffect(() => {
    loadNotes();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [candidate.id]);

  // Hiring-team members can't move into or out of Hired (enforced server-side too).
  const stageLocked = !isHrAdmin && candidate.stage === "hired";
  const stageOptions = CANDIDATE_STAGES.filter((s) => isHrAdmin || s !== "hired" || candidate.stage === "hired");
  const stageDirty = stage !== candidate.stage || interviewAt !== toLocalDateTimeInput(candidate.interviewAt);
  const detailsDirty =
    fullName !== candidate.fullName || email !== (candidate.email ?? "") || phone !== (candidate.phone ?? "") || source !== (candidate.source ?? "");

  async function run<T>(kind: NonNullable<typeof busy>, fn: () => Promise<T>, fallback: string): Promise<T | undefined> {
    setBusy(kind);
    setError(null);
    try {
      return await fn();
    } catch (err) {
      setError(errorMessage(err, fallback));
      return undefined;
    } finally {
      setBusy(null);
    }
  }

  async function saveStage() {
    const updated = await run("stage", () => setCandidateStage(candidate.id, stage, fromLocalDateTimeInput(interviewAt)), "Couldn't update the stage.");
    if (updated) {
      onChanged(updated);
      setNotice(`${updated.fullName} moved to ${CANDIDATE_STAGE_LABELS[updated.stage]}.`);
    }
  }

  async function saveDetails() {
    const updated = await run("details", () => updateCandidate(candidate.id, { fullName, email, phone, source }), "Couldn't save the details.");
    if (updated) {
      onChanged(updated);
      setNotice("Candidate details saved.");
    }
  }

  async function handleCvUpload(file: File) {
    const updated = await run("cv", () => uploadCandidateCv(candidate, file), "Couldn't upload the CV.");
    if (updated) {
      onChanged(updated);
      setNotice("CV uploaded.");
    }
  }

  async function openCv() {
    if (!candidate.cvPath) return;
    // Open the tab synchronously so popup blockers allow it, then point it at the signed URL.
    const tab = window.open("about:blank", "_blank");
    const url = await run("cv", () => getCandidateCvUrl(candidate.cvPath!), "Couldn't open the CV.");
    if (url && tab) tab.location.href = url;
    else tab?.close();
  }

  async function addNote() {
    if (!noteDraft.trim()) return;
    const ok = await run("note", () => addCandidateNote(candidate.id, noteDraft).then(() => true), "Couldn't add the note.");
    if (ok) {
      setNoteDraft("");
      loadNotes();
    }
  }

  async function removeNote(note: CandidateNote) {
    if (!window.confirm("Delete this note?")) return;
    const ok = await run("note", () => deleteCandidateNote(note.id).then(() => true), "Couldn't delete the note.");
    if (ok) loadNotes();
  }

  async function handleDelete() {
    if (!window.confirm(`Delete ${candidate.fullName}? Their CV and notes are deleted too. This can't be undone.`)) return;
    const ok = await run("delete", () => deleteCandidate(candidate).then(() => true), "Couldn't delete the candidate.");
    if (ok) {
      setNotice(`${candidate.fullName} deleted.`);
      onDeleted();
    }
  }

  if (hiring) {
    return (
      <AddEmployeeModal
        initial={{ fullName: candidate.fullName, email: candidate.email ?? "", teamId: job.teamId, phoneNumber: candidate.phone ?? "" }}
        onClose={() => setHiring(false)}
        onCreated={async (employee) => {
          setHiring(false);
          try {
            await linkHiredEmployee(candidate.id, employee.id);
            onChanged({ ...candidate, hiredEmployeeId: employee.id });
            setNotice(`${employee.fullName} is now an employee. They'll receive an email to set their password.`);
          } catch (err) {
            setNotice(`${employee.fullName} was created as an employee, but linking them to the candidate failed: ${errorMessage(err, "unknown error")}`);
          }
        }}
      />
    );
  }

  return (
    <div className="admin-modal-overlay" onClick={onClose}>
      <div className="admin-modal wide" onClick={(e) => e.stopPropagation()}>
        <div className="admin-modal-header">
          <div>
            <h2>{candidate.fullName}</h2>
            <p className="muted small">{job.title} · added {formatDate(candidate.createdAt.slice(0, 10))}</p>
          </div>
          <button className="icon-action" onClick={onClose} aria-label="Close"><Icon name="x" size={16} /></button>
        </div>

        <div className="candidate-layout">
          <div>
            <h3 className="form-section">Stage</h3>
            <div className="admin-login-form candidate-stage-form">
              <label>
                Stage
                <select value={stage} onChange={(e) => setStage(e.target.value as CandidateStage)} disabled={stageLocked || busy !== null}>
                  {stageOptions.map((s) => (
                    <option key={s} value={s}>{CANDIDATE_STAGE_LABELS[s]}</option>
                  ))}
                </select>
                {stageLocked && <small className="field-hint">Only HR can change a hired candidate&apos;s stage.</small>}
              </label>
              <label>
                Interview <span className="field-optional">optional</span>
                <input type="datetime-local" value={interviewAt} onChange={(e) => setInterviewAt(e.target.value)} disabled={stageLocked || busy !== null} />
              </label>
            </div>
            {stageDirty && (
              <button className="primary-admin" onClick={saveStage} disabled={busy !== null}>
                {busy === "stage" ? "Saving…" : "Save stage"}
              </button>
            )}

            {candidate.stage === "hired" && isHrAdmin && (
              <div className={`hire-callout${candidate.hiredEmployeeId ? " done" : ""}`}>
                {candidate.hiredEmployeeId ? (
                  <><Icon name="check" size={16} /> Employee record created.</>
                ) : (
                  <>
                    <span>Hired — create their employee record so they can be invited.</span>
                    <button className="primary-admin" onClick={() => setHiring(true)}>
                      <Icon name="userPlus" size={15} /> Create employee
                    </button>
                  </>
                )}
              </div>
            )}

            <h3 className="form-section">Details</h3>
            <div className="admin-login-form candidate-details-form">
              <label>
                Full name
                <input value={fullName} onChange={(e) => setFullName(e.target.value)} disabled={!isHrAdmin || busy !== null} />
              </label>
              <label>
                Email
                <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} disabled={!isHrAdmin || busy !== null} />
              </label>
              <label>
                Phone
                <input type="tel" value={phone} onChange={(e) => setPhone(e.target.value)} disabled={!isHrAdmin || busy !== null} />
              </label>
              <label>
                Source
                <input value={source} onChange={(e) => setSource(e.target.value)} disabled={!isHrAdmin || busy !== null} />
              </label>
            </div>
            {isHrAdmin && detailsDirty && (
              <button className="primary-admin" onClick={saveDetails} disabled={busy !== null || !fullName.trim()}>
                {busy === "details" ? "Saving…" : "Save details"}
              </button>
            )}

            <h3 className="form-section">CV</h3>
            <div className="cv-row">
              {candidate.cvPath ? (
                <button className="outline-button" onClick={openCv} disabled={busy !== null}>
                  <Icon name="download" size={15} /> View CV
                </button>
              ) : (
                <span className="muted small">No CV uploaded.</span>
              )}
              {isHrAdmin && (
                <label className="outline-button file-button">
                  <Icon name="upload" size={15} /> {candidate.cvPath ? "Replace" : "Upload"}
                  <input
                    type="file"
                    accept=".pdf,.doc,.docx"
                    disabled={busy !== null}
                    onChange={(e) => {
                      const file = e.target.files?.[0];
                      e.target.value = "";
                      if (file) handleCvUpload(file);
                    }}
                  />
                </label>
              )}
            </div>
          </div>

          <div>
            <h3 className="form-section">Notes</h3>
            <div className="admin-login-form note-form">
              <textarea rows={3} value={noteDraft} onChange={(e) => setNoteDraft(e.target.value)} placeholder="Interview feedback, call notes…" disabled={busy !== null} />
            </div>
            <button className="outline-button" onClick={addNote} disabled={busy !== null || !noteDraft.trim()}>
              {busy === "note" ? "Saving…" : "Add note"}
            </button>
            <ul className="note-list">
              {notes === null ? (
                <li className="muted small">Loading…</li>
              ) : notes.length === 0 ? (
                <li className="muted small">No notes yet.</li>
              ) : (
                notes.map((note) => (
                  <li key={note.id}>
                    <div className="note-meta">
                      <b>{note.authorName ?? "Unknown"}</b>
                      <span>{formatDateTime(note.createdAt)}</span>
                      {(isHrAdmin || note.authorId === currentUserId) && (
                        <button className="purge-link" onClick={() => removeNote(note)} disabled={busy !== null}>Delete</button>
                      )}
                    </div>
                    <p>{note.body}</p>
                  </li>
                ))
              )}
            </ul>
          </div>
        </div>

        {error && <p className="form-error"><Icon name="warning" size={14} />{error}</p>}
        <div className="admin-modal-actions">
          {isHrAdmin && (
            <button className="outline-button danger-outline" onClick={handleDelete} disabled={busy !== null}>
              <Icon name="trash" size={15} /> Delete candidate
            </button>
          )}
          <span className="toolbar-spacer" />
          <button className="outline-button" onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  );
}

function Toolbar({
  action,
  onAction,
  onExport,
  exporting,
  onImport,
  search,
  onSearch,
  searchPlaceholder = "Search",
}: {
  // Optional so a module can render the toolbar without a primary action --
  // e.g. the staff directory for supervisors, who may look but not add.
  action?: string;
  onAction?: () => void;
  onExport?: () => void;
  exporting?: boolean;
  onImport?: () => void;
  // The search box only renders for modules that actually filter on it -- a
  // search field that does nothing reads as a broken product.
  search?: string;
  onSearch?: (value: string) => void;
  searchPlaceholder?: string;
}) {
  return (
    <div className="toolbar">
      {onSearch && (
        <div className="search-input">
          <Icon name="search" size={15} />
          <input type="search" placeholder={searchPlaceholder} aria-label={searchPlaceholder} value={search ?? ""} onChange={(e) => onSearch(e.target.value)} />
        </div>
      )}
      <span className="toolbar-spacer" />
      {onExport && (
        <button className="outline-button" onClick={onExport} disabled={exporting}>
          <Icon name="download" size={15} /> {exporting ? "Exporting…" : "Export"}
        </button>
      )}
      {onImport && (
        <button className="outline-button" onClick={onImport}>
          <Icon name="upload" size={15} /> Import
        </button>
      )}
      {action && onAction && (
        <button className="primary-admin" onClick={onAction}><Icon name="plus" size={15} /> {action}</button>
      )}
    </div>
  );
}

function Stat({ label, value, note }: { label: string; value: string; note: string }) {
  return (
    <section className="stat">
      <p>{label}</p>
      <strong>{value}</strong>
      <small>{note}</small>
    </section>
  );
}

function Setting({ title, text }: { title: string; text: string }) {
  return (
    <button>
      <span><b>{title}</b><small>{text}</small></span>
      <Icon name="chevronRight" size={16} className="muted-icon" />
    </button>
  );
}

function LoadingPanel() {
  return (
    <section className="panel loading-panel">
      <Icon name="spinner" size={20} className="spin" />
      <span className="muted">Loading…</span>
    </section>
  );
}

function ErrorState({ message }: { message: string }) {
  return (
    <section className="panel error-panel">
      <Icon name="warning" size={18} />
      <span>{message}</span>
    </section>
  );
}

function EmptyPanel({ icon, title, note }: { icon: Parameters<typeof Icon>[0]["name"]; title: string; note: string }) {
  return (
    <section className="panel empty-panel">
      <Icon name={icon} size={30} className="muted-icon" />
      <h2>{title}</h2>
      <p className="muted">{note}</p>
    </section>
  );
}

// Case-insensitive "every word appears somewhere" match across the given fields,
// so "max ops" finds Max Murashov on the Operations team.
function matchesSearch(query: string, ...fields: Array<string | null | undefined>) {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return true;
  const haystack = fields.filter(Boolean).join(" ").toLowerCase();
  return words.every((w) => haystack.includes(w));
}

function initials(name: string) {
  return name.split(" ").filter(Boolean).slice(0, 2).map((p) => p[0]?.toUpperCase()).join("");
}

function stateLabel(state: string) {
  return { not_started: "⏳ Not started", working: "🟢 Working", on_break: "☕ On break", on_lunch: "🍽️ On lunch", complete: "✅ Complete" }[state] ?? state;
}

function formatTime(value: string) {
  return new Date(value).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function formatDate(value: string) {
  return new Date(`${value}T00:00:00`).toLocaleDateString([], { day: "2-digit", month: "short" });
}

function formatDaysValue(value: number) {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

function leaveStatusClass(status: string) {
  return { approved: "success", rejected: "danger", pending: "pending", cancelled: "" }[status] ?? "";
}
