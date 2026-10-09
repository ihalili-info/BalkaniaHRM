"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { QRCodeSVG } from "qrcode.react";
import { Icon } from "../components/icons";
import { changePassword, getCurrentSession, onAuthStateChange, signInWithPassword, signOut, supabaseConfigured } from "../lib/auth-service";
import { errorMessage } from "../lib/errors";
import { recordAttendance } from "../lib/attendance-service";
import {
  getLeaveBalances,
  getLeaveRequests,
  getMonthSessions,
  getMyDisciplinaryNotes,
  getMyProfile,
  getTodayEvents,
  getTodaySession,
  getWhoIsOnLeaveToday,
  issueQrToken,
  listHolidays,
  submitLeaveRequest,
  type Holiday,
  type MonthSessionSummary,
} from "../lib/employee-service";
import { isAdminPortalRole } from "../lib/domain";
import type {
  AttendanceEventRecord,
  AttendanceEventType,
  AttendanceState,
  DisciplinaryNote,
  LeaveBalance,
  LeaveRequestRecord,
  OnLeaveEntry,
  Profile,
} from "../lib/domain";

type Screen = "home" | "leaves" | "code" | "tracking" | "profile" | "documents" | "holidays" | "changePassword";
type AuthStatus = "loading" | "signedOut" | "needsSetup" | "deactivated" | "signedIn";
type AttendanceAction = "clockOut" | "breakIn" | "breakOut" | "lunchIn" | "lunchOut";

const stateText: Record<AttendanceState, string> = {
  not_started: "⏳ Ready to start your day",
  working: "🟢 You're currently working",
  on_break: "☕ First break is active",
  on_lunch: "🍽️ Lunch break is active",
  complete: "✅ Workday complete",
};

const actionMap: Record<AttendanceAction, [string, AttendanceEventType]> = {
  clockOut: ["🔴 Clock out", "clock_out"],
  breakIn: ["☕ First break started", "break_start"],
  breakOut: ["▶️ First break ended", "break_end"],
  lunchIn: ["🍽️ Lunch started", "lunch_start"],
  lunchOut: ["▶️ Lunch ended", "lunch_end"],
};

export default function Home() {
  const router = useRouter();
  const [status, setStatus] = useState<AuthStatus>("loading");
  const [profile, setProfile] = useState<Profile | null>(null);
  const [wantsEmployeeView, setWantsEmployeeView] = useState(false);
  const configured = useMemo(() => supabaseConfigured(), []);

  useEffect(() => {
    setWantsEmployeeView(new URLSearchParams(window.location.search).get("view") === "employee");
  }, []);

  useEffect(() => {
    if (!configured) {
      setStatus("signedOut");
      return;
    }
    let active = true;

    async function load() {
      const session = await getCurrentSession();
      if (!active) return;
      if (!session) {
        setStatus("signedOut");
        return;
      }
      try {
        const p = await getMyProfile();
        if (!active) return;
        if (p && !p.active) {
          setStatus("deactivated");
        } else if (p) {
          setProfile(p);
          setStatus("signedIn");
        } else {
          setStatus("needsSetup");
        }
      } catch {
        if (active) setStatus("needsSetup");
      }
    }
    load();

    const unsubscribe = onAuthStateChange((session) => {
      if (!session) {
        setProfile(null);
        setStatus("signedOut");
        return;
      }
      getMyProfile()
        .then((p) => {
          if (p && !p.active) {
            setStatus("deactivated");
          } else if (p) {
            setProfile(p);
            setStatus("signedIn");
          } else {
            setStatus("needsSetup");
          }
        })
        .catch(() => setStatus("needsSetup"));
    });

    return () => {
      active = false;
      unsubscribe();
    };
  }, [configured]);

  const isAdminRole = isAdminPortalRole(profile?.role);

  useEffect(() => {
    if (status === "signedIn" && isAdminRole && !wantsEmployeeView) {
      router.replace("/admin");
    }
  }, [status, isAdminRole, wantsEmployeeView, router]);

  if (status === "loading") return <SplashScreen />;
  if (status === "signedIn" && profile) {
    if (isAdminRole && !wantsEmployeeView) return <SplashScreen />;
    return <AppShell profile={profile} configured={configured} />;
  }
  if (status === "needsSetup") return <SetupNoticeScreen />;
  if (status === "deactivated") return <DeactivatedScreen />;
  return <LoginScreen configured={configured} />;
}

function SplashScreen() {
  return (
    <main className="shell centered">
      <img src="/icon.png" alt="" className="brand-mark large" />
      <Icon name="spinner" size={22} className="spin muted-icon" />
    </main>
  );
}

function SetupNoticeScreen() {
  return (
    <main className="shell centered">
      <Icon name="warning" size={40} className="warn-icon" />
      <h1>Account not linked</h1>
      <p className="muted center">
        Your sign-in succeeded, but no employee profile exists yet for this account. Ask HR to create your employee
        record in Balkania Admin, then sign in again.
      </p>
      <button className="secondary-button" onClick={() => signOut()}>Sign out</button>
    </main>
  );
}

function DeactivatedScreen() {
  return (
    <main className="shell centered">
      <Icon name="warning" size={40} className="warn-icon" />
      <h1>Account deactivated</h1>
      <p className="muted center">Your account has been deactivated. Contact HR if you believe this is a mistake.</p>
      <button className="secondary-button" onClick={() => signOut()}>Sign out</button>
    </main>
  );
}

function LoginScreen({ configured }: { configured: boolean }) {
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
      setError(errorMessage(err, "Sign-in failed. Check your details and try again."));
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="shell centered login">
      <img src="/icon.png" alt="" className="brand-mark large" />
      <h1>Balkania</h1>
      <p className="muted center">Sign in to check in, view your schedule, and manage leave.</p>

      {!configured && (
        <div className="notice warn">
          <Icon name="warning" size={16} />
          Supabase environment variables are not set for this deployment. Add them in Vercel project settings to enable sign-in.
        </div>
      )}

      <form className="login-form" onSubmit={handleSubmit}>
        <label>
          <span>Work email</span>
          <div className="input-with-icon">
            <Icon name="mail" size={17} />
            <input type="email" required autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@company.com" disabled={!configured} />
          </div>
        </label>
        <label>
          <span>Password</span>
          <div className="input-with-icon">
            <Icon name="lock" size={17} />
            <input type="password" required autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="••••••••" disabled={!configured} />
          </div>
        </label>
        {error && <p className="form-error"><Icon name="warning" size={15} />{error}</p>}
        <button className="primary-button" type="submit" disabled={loading || !configured}>
          {loading ? "Signing in…" : "Sign in"}
        </button>
      </form>
      <p className="muted small center">Don&apos;t have an account? Ask your HR administrator to add you in Balkania Admin.</p>
    </main>
  );
}

function AppShell({ profile, configured }: { profile: Profile; configured: boolean }) {
  const [screen, setScreen] = useState<Screen>("home");
  const [notice, setNotice] = useState<string | null>(null);
  const [attendanceState, setAttendanceState] = useState<AttendanceState>("not_started");
  const [todayEvents, setTodayEvents] = useState<AttendanceEventRecord[]>([]);
  const [monthSessions, setMonthSessions] = useState<MonthSessionSummary[]>([]);
  const [leaveBalances, setLeaveBalances] = useState<LeaveBalance[]>([]);
  const [leaveRequests, setLeaveRequests] = useState<LeaveRequestRecord[]>([]);
  const [onLeaveToday, setOnLeaveToday] = useState<OnLeaveEntry[]>([]);
  const [disciplinaryNotes, setDisciplinaryNotes] = useState<DisciplinaryNote[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyAction, setBusyAction] = useState<AttendanceAction | "clockInOffice" | "clockInRemote" | null>(null);

  async function refresh() {
    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString().slice(0, 10);
    const monthEnd = new Date(now.getFullYear(), now.getMonth() + 1, 0).toISOString().slice(0, 10);
    const [session, events, sessions, balances, requests, onLeave, notes] = await Promise.all([
      getTodaySession(),
      getTodayEvents(),
      getMonthSessions(monthStart, monthEnd),
      getLeaveBalances(),
      getLeaveRequests(),
      getWhoIsOnLeaveToday(),
      getMyDisciplinaryNotes(),
    ]);
    setAttendanceState(session?.state ?? "not_started");
    setTodayEvents(events);
    setMonthSessions(sessions);
    setLeaveBalances(balances);
    setLeaveRequests(requests);
    setOnLeaveToday(onLeave);
    setDisciplinaryNotes(notes);
  }

  useEffect(() => {
    setLoading(true);
    refresh()
      .catch(() => setNotice("Couldn't load your data. Check your connection and try again."))
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // The app never re-fetches on its own once mounted, so a tab left open (or a PWA
  // kept in the background) across midnight would keep showing yesterday's
  // "complete" state forever, with clock-in stuck disabled until a hard reload.
  // Revalidate whenever the calendar day has moved on and the app regains attention.
  //
  // Separately, attendance can also be recorded from outside this session
  // entirely (a shared kiosk scanning the employee's QR code), which this
  // tab has no way to know about until it re-fetches -- so also poll the
  // attendance state periodically and on every regained-focus, independent
  // of the day-change check.
  useEffect(() => {
    let lastDate = new Date().toDateString();

    function revalidateIfNewDay() {
      const currentDate = new Date().toDateString();
      if (currentDate !== lastDate) {
        lastDate = currentDate;
        refresh().catch(() => undefined);
      }
    }

    function refreshAttendance() {
      Promise.all([getTodaySession(), getTodayEvents()])
        .then(([session, events]) => {
          setAttendanceState(session?.state ?? "not_started");
          setTodayEvents(events);
        })
        .catch(() => undefined);
    }

    function onWake() {
      revalidateIfNewDay();
      refreshAttendance();
    }

    function onVisibilityChange() {
      if (document.visibilityState === "visible") onWake();
    }

    document.addEventListener("visibilitychange", onVisibilityChange);
    window.addEventListener("focus", onWake);
    const dayCheckInterval = setInterval(revalidateIfNewDay, 60000);
    const attendancePollInterval = setInterval(refreshAttendance, 30000);
    return () => {
      document.removeEventListener("visibilitychange", onVisibilityChange);
      window.removeEventListener("focus", onWake);
      clearInterval(dayCheckInterval);
      clearInterval(attendancePollInterval);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!notice) return;
    const id = setTimeout(() => setNotice(null), 4500);
    return () => clearTimeout(id);
  }, [notice]);

  async function handleAction(action: AttendanceAction) {
    const [label, eventType] = actionMap[action];
    setBusyAction(action);
    try {
      const session = await recordAttendance({ eventType, idempotencyKey: crypto.randomUUID(), source: "pwa" });
      setAttendanceState(session.state);
      const events = await getTodayEvents();
      setTodayEvents(events);
      setNotice(`${label} recorded at ${formatTime(new Date().toISOString())}.`);
    } catch (err) {
      setNotice(errorMessage(err, "Couldn't record that action."));
    } finally {
      setBusyAction(null);
    }
  }

  // "Office" attempts a location fix so the server can confirm the employee is
  // near an assigned attendance location; "remote" skips geolocation entirely
  // -- there's nothing to check for someone who isn't expected to be on-site.
  // Either way the clock-in always proceeds: a denied/failed location fix is
  // flagged for HR review server-side, never blocked here.
  async function handleClockIn(workMode: "office" | "remote") {
    const busyKey = workMode === "office" ? "clockInOffice" : "clockInRemote";
    setBusyAction(busyKey);
    try {
      let latitude: number | undefined;
      let longitude: number | undefined;
      if (workMode === "office" && typeof navigator !== "undefined" && "geolocation" in navigator) {
        try {
          const position = await new Promise<GeolocationPosition>((resolve, reject) =>
            navigator.geolocation.getCurrentPosition(resolve, reject, { timeout: 8000 }),
          );
          latitude = position.coords.latitude;
          longitude = position.coords.longitude;
        } catch {
          // Denied, timed out, or unavailable -- fall through and clock in anyway.
        }
      }
      const session = await recordAttendance({
        eventType: "clock_in",
        idempotencyKey: crypto.randomUUID(),
        source: "pwa",
        workMode,
        latitude,
        longitude,
      });
      setAttendanceState(session.state);
      const events = await getTodayEvents();
      setTodayEvents(events);
      setNotice(`🟢 Clock in recorded at ${formatTime(new Date().toISOString())}.`);
    } catch (err) {
      setNotice(errorMessage(err, "Couldn't record that action."));
    } finally {
      setBusyAction(null);
    }
  }

  async function handleLeaveSubmit(input: Parameters<typeof submitLeaveRequest>[0]) {
    await submitLeaveRequest(input);
    const requests = await getLeaveRequests();
    setLeaveRequests(requests);
    setNotice("Leave request submitted for approval.");
  }

  return (
    <main className="shell">
      <header className="topbar">
        <div className="brand-row">
          <img src="/icon-white.png" alt="" className="brand-mark" />
          <strong>Balkania</strong>
        </div>
        <button className="icon-button" onClick={() => setScreen("profile")} aria-label="Open profile">
          <Icon name="user" size={19} />
        </button>
      </header>

      {notice && (
        <div className="toast" role="status">
          {notice}
        </div>
      )}

      <section className="content">
        {loading ? (
          <LoadingState />
        ) : (
          <>
            {screen === "home" && (
              <HomeScreen
                profile={profile}
                monthSessions={monthSessions}
                attendanceState={attendanceState}
                onLeaveToday={onLeaveToday}
                onNavigate={setScreen}
              />
            )}
            {screen === "leaves" && (
              <LeavesScreen profile={profile} balances={leaveBalances} requests={leaveRequests} onSubmit={handleLeaveSubmit} />
            )}
            {screen === "code" && (
              <CodeScreen
                state={attendanceState}
                selfServiceAttendance={profile.selfServiceAttendance}
                busyAction={busyAction}
                onAction={handleAction}
                onClockIn={handleClockIn}
              />
            )}
            {screen === "tracking" && <TrackingScreen events={todayEvents} monthSessions={monthSessions} />}
            {screen === "profile" && (
              <ProfileScreen
                profile={profile}
                configured={configured}
                onDocuments={() => setScreen("documents")}
                onChangePassword={() => setScreen("changePassword")}
              />
            )}
            {screen === "documents" && <DocumentsScreen notes={disciplinaryNotes} onBack={() => setScreen("profile")} />}
            {screen === "changePassword" && <ChangePasswordScreen onBack={() => setScreen("profile")} />}
            {screen === "holidays" && <HolidaysScreen onBack={() => setScreen("home")} />}
          </>
        )}
      </section>

      <nav className="bottom-nav" aria-label="Main navigation">
        <NavButton active={screen === "home"} label="Home" icon="home" onClick={() => setScreen("home")} />
        <NavButton active={screen === "leaves"} label="Leaves" icon="calendar" onClick={() => setScreen("leaves")} />
        <NavButton active={screen === "code"} label="Check in" icon="qr" onClick={() => setScreen("code")} primary />
        <NavButton active={screen === "tracking"} label="Tracking" icon="clock" onClick={() => setScreen("tracking")} />
        <NavButton active={screen === "profile"} label="Profile" icon="user" onClick={() => setScreen("profile")} />
      </nav>
    </main>
  );
}

function LoadingState() {
  return (
    <div className="loading-state">
      <Icon name="spinner" size={24} className="spin muted-icon" />
      <p className="muted">Loading your workspace…</p>
    </div>
  );
}

function HomeScreen({
  profile,
  monthSessions,
  attendanceState,
  onLeaveToday,
  onNavigate,
}: {
  profile: Profile;
  monthSessions: MonthSessionSummary[];
  attendanceState: AttendanceState;
  onLeaveToday: OnLeaveEntry[];
  onNavigate: (screen: Screen) => void;
}) {
  const { avgCheckIn, avgCheckOut } = useMemo(() => averageTimes(monthSessions), [monthSessions]);
  const heat = useMemo(() => buildHeatmap(monthSessions), [monthSessions]);
  const greeting = useMemo(() => timeGreeting(), []);
  const firstName = profile.fullName.split(" ")[0];

  return (
    <>
      <p className="eyebrow">EMPLOYEE PORTAL</p>
      <h1>
        {greeting}, {firstName}
      </h1>
      <p className="muted">{stateText[attendanceState]}.</p>

      <section className="card">
        <div className="row">
          <h2>This month</h2>
          <Icon name="calendar" size={18} className="muted-icon" />
        </div>
        <div className="metric-pair">
          <Metric label="Avg. check in" value={avgCheckIn} />
          <Metric label="Avg. check out" value={avgCheckOut} />
        </div>
      </section>

      <section className="card">
        <div className="row">
          <h2>Quick tools</h2>
        </div>
        <div className="tool-grid">
          <button onClick={() => onNavigate("leaves")}>
            <Icon name="calendar" size={22} />
            <span>Request leave</span>
          </button>
          <button onClick={() => onNavigate("tracking")}>
            <Icon name="clock" size={22} />
            <span>Attendance</span>
          </button>
          <button onClick={() => onNavigate("code")}>
            <Icon name="swap" size={22} />
            <span>Shift swap</span>
          </button>
          <button onClick={() => onNavigate("holidays")}>
            <Icon name="calendar" size={22} />
            <span>Holidays</span>
          </button>
        </div>
      </section>

      <section className="card">
        <h2>Attendance activity</h2>
        <div className="heatmap">
          {heat.map((cell) => (
            <span key={cell.day} className={cell.className} title={cell.title} />
          ))}
        </div>
        <p className="muted small">Light to dark: worked time · Red: missed clock-out</p>
      </section>

      <section className="card">
        <div className="row">
          <h2>On leave today</h2>
          <Icon name="users" size={18} className="muted-icon" />
        </div>
        {onLeaveToday.length ? (
          <ul className="leave-list">
            {onLeaveToday.map((entry, index) => (
              <li key={`${entry.employeeName}-${index}`}>
                <div>
                  <b>{entry.employeeName}</b>
                </div>
                <span className="pill">{leaveTypeLabel(entry.leaveType)}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="muted small">Everyone&apos;s in today.</p>
        )}
      </section>
    </>
  );
}

function LeavesScreen({
  profile,
  balances,
  requests,
  onSubmit,
}: {
  profile: Profile;
  balances: LeaveBalance[];
  requests: LeaveRequestRecord[];
  onSubmit: (input: Parameters<typeof submitLeaveRequest>[0]) => Promise<void>;
}) {
  const [tab, setTab] = useState<"mine" | "team">("mine");
  const [openForm, setOpenForm] = useState(false);
  const isManager = isAdminPortalRole(profile.role);
  const annual = balances.find((b) => b.leaveType === "annual");
  const available = annual ? annual.earned - annual.used : 0;
  const sick = balances.find((b) => b.leaveType === "medical");

  return (
    <>
      <h1>Leaves</h1>
      <div className="tabs">
        <button className={tab === "mine" ? "active" : ""} onClick={() => setTab("mine")}>My leaves</button>
        {isManager && <button className={tab === "team" ? "active" : ""} onClick={() => setTab("team")}>My team</button>}
      </div>

      {tab === "mine" ? (
        <>
          <section className="card balance">
            <p className="eyebrow">AVAILABLE TO BOOK</p>
            <strong>
              {annual ? formatDays(available) : "0"} <small>days</small>
            </strong>
            {annual ? (
              <>
                {/* "earned" can include a balance carried in when HR imported staff, so
                    it isn't framed as a fraction of the yearly allowance. */}
                <p>
                  Your allowance is <b>{formatDays(annual.entitlement)} days</b> a year, added monthly. You&apos;ve built up{" "}
                  <b>{formatDays(annual.earned)}</b> this leave year and used <b>{formatDays(annual.used)}</b>.
                </p>
                <div className="progress">
                  <span style={{ width: `${annual.entitlement ? Math.min(100, (annual.earned / annual.entitlement) * 100) : 0}%` }} />
                </div>
                <div className="legend">
                  Allowance {formatDays(annual.entitlement)}/year <b>·</b> Built up {formatDays(annual.earned)} <b>·</b> Used {formatDays(annual.used)}
                </div>
              </>
            ) : (
              <p className="muted">No leave entitlement configured yet. Ask HR to set your leave balance.</p>
            )}
            {sick && (
              <p className="sick-balance">
                Sick days available: <b>{formatDays(sick.earned - sick.used)}</b>
              </p>
            )}
          </section>

          {requests.length ? (
            <section className="card">
              <h2>Requests</h2>
              <ul className="leave-list">
                {requests.map((request) => (
                  <li key={request.id}>
                    <div>
                      <b>{leaveTypeLabel(request.leaveType)}</b>
                      <span className="muted small">
                        {formatDate(request.startsOn)} – {formatDate(request.endsOn)}
                      </span>
                    </div>
                    <span className={`pill ${statusClass(request.status)}`}>{request.status}</span>
                  </li>
                ))}
              </ul>
            </section>
          ) : (
            <section className="empty">
              <Icon name="calendar" size={44} className="empty-icon" />
              <h2>No leave requests</h2>
              <p className="muted">Your submitted and reviewed requests will appear here.</p>
            </section>
          )}

          <button className="primary-button" onClick={() => setOpenForm(true)}>
            <Icon name="plus" size={17} /> Request a leave
          </button>
        </>
      ) : (
        <section className="empty">
          <Icon name="users" size={44} className="empty-icon" />
          <h2>Team leave</h2>
          <p className="muted">Review and approve your team&apos;s leave requests in Balkania Admin.</p>
        </section>
      )}

      {openForm && <LeaveForm onCancel={() => setOpenForm(false)} onSubmit={onSubmit} />}
    </>
  );
}

function LeaveForm({
  onCancel,
  onSubmit,
}: {
  onCancel: () => void;
  onSubmit: (input: Parameters<typeof submitLeaveRequest>[0]) => Promise<void>;
}) {
  const [kind, setKind] = useState<"annual" | "medical">("annual");
  const [startsOn, setStartsOn] = useState("");
  const [endsOn, setEndsOn] = useState("");
  const [note, setNote] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    if (!startsOn || !endsOn) {
      setError("Choose a start and end date.");
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      await onSubmit({ leaveType: kind, startsOn, endsOn, note: note || undefined });
      onCancel();
    } catch (err) {
      setError(errorMessage(err, "Couldn't submit the request."));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="modal">
      <div className="modal-card">
        <h2>{kind === "medical" ? "Declare sick day" : "Request time off"}</h2>
        <label>
          Type
          <select value={kind} onChange={(e) => setKind(e.target.value as "annual" | "medical")}>
            <option value="annual">Annual leave</option>
            <option value="medical">Medical / sick day</option>
          </select>
        </label>
        <label>
          Start date
          <input type="date" required value={startsOn} onChange={(e) => setStartsOn(e.target.value)} />
        </label>
        <label>
          End date
          <input type="date" required value={endsOn} onChange={(e) => setEndsOn(e.target.value)} />
        </label>
        <label>
          Note
          <textarea placeholder="Optional note" value={note} onChange={(e) => setNote(e.target.value)} />
        </label>
        {error && <p className="form-error"><Icon name="warning" size={15} />{error}</p>}
        <button className="primary-button" onClick={submit} disabled={submitting}>
          {submitting ? "Submitting…" : "Submit request"}
        </button>
        <button className="text-button" onClick={onCancel}>Cancel</button>
      </div>
    </div>
  );
}

function CodeScreen({
  state,
  selfServiceAttendance,
  busyAction,
  onAction,
  onClockIn,
}: {
  state: AttendanceState;
  selfServiceAttendance: boolean;
  busyAction: AttendanceAction | "clockInOffice" | "clockInRemote" | null;
  onAction: (action: AttendanceAction) => void;
  onClockIn: (workMode: "office" | "remote") => void;
}) {
  const [qr, setQr] = useState<{ token: string; expiresAt: string } | null>(null);
  const [qrError, setQrError] = useState(false);

  useEffect(() => {
    let active = true;
    function fetchToken() {
      issueQrToken()
        .then((next) => {
          if (active) {
            setQr(next);
            setQrError(false);
          }
        })
        .catch(() => {
          if (active) setQrError(true);
        });
    }
    fetchToken();
    const id = setInterval(fetchToken, 25000);
    return () => {
      active = false;
      clearInterval(id);
    };
  }, []);

  return (
    <>
      <h1>Check in</h1>
      <p className="muted">{stateText[state]}.</p>
      {state === "not_started" && (
        <div className="notice">
          <Icon name="warning" size={16} /> You haven&apos;t started your workday yet.
        </div>
      )}
      <section className="card qr-card">
        {qr ? (
          <QRCodeSVG value={qr.token} size={320} marginSize={3} />
        ) : (
          <div className="qr-placeholder">
            <Icon name={qrError ? "warning" : "spinner"} size={24} className={qrError ? undefined : "spin"} />
          </div>
        )}
        <h2>My attendance code</h2>
        <p className="muted small">
          {qrError ? "Couldn't refresh your code. Check your connection." : "Show this code on the shared Balkania tablet. It refreshes every 30 seconds."}
        </p>
      </section>
      {selfServiceAttendance ? (
        <>
          <div className="action-grid">
            <Action label="🟢 Office" enabled={state === "not_started"} busy={busyAction === "clockInOffice"} onClick={() => onClockIn("office")} />
            <Action label="🏠 Remote" enabled={state === "not_started"} busy={busyAction === "clockInRemote"} onClick={() => onClockIn("remote")} />
            <Action label="🔴 Clock out" enabled={state === "working"} danger busy={busyAction === "clockOut"} onClick={() => onAction("clockOut")} />
            <Action label="☕ First break in" enabled={state === "working"} busy={busyAction === "breakIn"} onClick={() => onAction("breakIn")} />
            <Action label="▶️ First break out" enabled={state === "on_break"} busy={busyAction === "breakOut"} onClick={() => onAction("breakOut")} />
            <Action label="🍽️ Lunch in" enabled={state === "working"} busy={busyAction === "lunchIn"} onClick={() => onAction("lunchIn")} />
            <Action label="▶️ Lunch out" enabled={state === "on_lunch"} busy={busyAction === "lunchOut"} onClick={() => onAction("lunchOut")} />
          </div>
          {state === "not_started" && (
            <p className="muted small">
              "Office" confirms you're near an approved location before clocking in. It's only used to flag check-ins for HR review — not for ongoing tracking.
            </p>
          )}
        </>
      ) : (
        <div className="notice">
          <Icon name="warning" size={16} /> Clock in, clock out, breaks, and lunch must all be recorded at the kiosk — they can't be done from this app.
        </div>
      )}
    </>
  );
}

function TrackingScreen({
  events,
  monthSessions,
}: {
  events: AttendanceEventRecord[];
  monthSessions: MonthSessionSummary[];
}) {
  const [tab, setTab] = useState<"today" | "month">("today");
  const durations = useMemo(() => computeDurations(events), [events]);

  return (
    <>
      <h1>My attendance</h1>
      <div className="tabs">
        <button className={tab === "today" ? "active" : ""} onClick={() => setTab("today")}>Today</button>
        <button className={tab === "month" ? "active" : ""} onClick={() => setTab("month")}>This month</button>
      </div>

      {tab === "today" ? (
        <>
          <AttendanceCard title="Working time" value={durations.working} clockIn={durations.clockIn} clockOut={durations.clockOut} />
          <AttendanceCard title="First break time" value={durations.firstBreak} clockIn={durations.breakIn} clockOut={durations.breakOut} />
          <AttendanceCard title="Lunch break time" value={durations.lunch} clockIn={durations.lunchIn} clockOut={durations.lunchOut} />
          <section className="card">
            <h2>Today&apos;s events</h2>
            {events.length ? (
              <ul className="events">
                {events.map((event, index) => (
                  <li key={`${event.eventType}-${event.occurredAt}-${index}`}>
                    {formatTime(event.occurredAt)} — {eventLabel(event.eventType)}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="muted">No attendance events recorded today.</p>
            )}
          </section>
        </>
      ) : (
        <MonthTab sessions={monthSessions} />
      )}
    </>
  );
}

function MonthTab({ sessions }: { sessions: MonthSessionSummary[] }) {
  const summary = useMemo(() => monthSummary(sessions), [sessions]);
  const monthLabel = new Date().toLocaleDateString([], { month: "long", year: "numeric" });

  return (
    <>
      <section className="card">
        <div className="row">
          <h2>{monthLabel}</h2>
          <Icon name="calendar" size={18} className="muted-icon" />
        </div>
        <div className="metric-pair">
          <Metric label="Days worked" value={String(summary.daysWorked)} />
          <Metric label="Total hours" value={summary.totalHours} />
        </div>
        <div className="metric-pair">
          <Metric label="Avg. check in" value={summary.avgCheckIn} />
          <Metric label="Avg. check out" value={summary.avgCheckOut} />
        </div>
        <div className="metric-pair">
          <Metric label="Avg. day" value={summary.avgDay} />
          <Metric label="Incomplete" value={String(summary.incomplete)} />
        </div>
      </section>

      <section className="card">
        <h2>Daily breakdown</h2>
        {summary.days.length ? (
          <ul className="events month-days">
            {summary.days.map((day) => (
              <li key={day.workDate}>
                <span>{formatDate(day.workDate)}</span>
                <span className="muted small">
                  {day.clockIn} – {day.clockOut}
                </span>
                <b>{day.hours}</b>
              </li>
            ))}
          </ul>
        ) : (
          <p className="muted">No attendance recorded this month yet.</p>
        )}
      </section>
    </>
  );
}

function ProfileScreen({
  profile,
  configured,
  onDocuments,
  onChangePassword,
}: {
  profile: Profile;
  configured: boolean;
  onDocuments: () => void;
  onChangePassword: () => void;
}) {
  const locationPermission = useLocationPermission();
  return (
    <>
      <h1>Profile</h1>
      <section className="card profile-card">
        <div className="avatar-lg">{initials(profile.fullName)}</div>
        <div>
          <h2>{profile.fullName}</h2>
          <p className="muted small">
            {profile.employeeCode} · {roleLabel(profile.role)}
          </p>
        </div>
      </section>
      <section className="settings">
        {/* Only real settings here. Language, notifications and camera used to be
            listed with hard-coded values, but the app has no language switch, sends
            no push notifications, and never uses the camera (the kiosk scans). */}
        <Setting label="Location access" value={locationPermission} icon="building" />
        <Setting label="Change password" value="" icon="lock" chevron onClick={onChangePassword} />
        <Setting label="Documents" value="" icon="archive" chevron onClick={onDocuments} />
      </section>
      {isAdminPortalRole(profile.role) && (
        <a className="secondary-button" href="/admin">
          <Icon name="layout" size={17} /> Open Balkania Admin
        </a>
      )}
      <button className="danger-button" onClick={() => signOut()}>
        <Icon name="logout" size={17} /> Sign out
      </button>
      {!configured && <p className="muted small center">Demo mode — Supabase is not connected in this environment.</p>}
    </>
  );
}

const disciplinarySeverityLabels: Record<string, string> = {
  verbal_warning: "Verbal warning",
  written_warning: "Written warning",
  final_warning: "Final warning",
  suspension: "Suspension",
  termination_notice: "Termination notice",
};

function DocumentsScreen({ notes, onBack }: { notes: DisciplinaryNote[]; onBack: () => void }) {
  return (
    <>
      <button className="text-button back" onClick={onBack}>
        <Icon name="arrowLeft" size={16} /> Back to profile
      </button>
      <h1>Documents</h1>
      <p className="muted">Disciplinary notices issued to you.</p>
      {notes.length ? (
        <ul className="leave-list">
          {notes.map((note) => (
            <li key={note.id} className="document-note">
              <div>
                <b>{disciplinarySeverityLabels[note.severity] ?? note.severity}</b>
                <span className="muted small">{formatDate(note.occurredOn)}</span>
                <p className="muted small">{note.reason}</p>
                {note.details && <p className="muted small">{note.details}</p>}
              </div>
            </li>
          ))}
        </ul>
      ) : (
        <section className="empty">
          <Icon name="archive" size={44} className="empty-icon" />
          <h2>No documents</h2>
          <p className="muted">Notices and records issued to you will appear here.</p>
        </section>
      )}
    </>
  );
}

function ChangePasswordScreen({ onBack }: { onBack: () => void }) {
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);
  const [saving, setSaving] = useState(false);

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    setSuccess(false);
    if (newPassword.length < 8) {
      setError("New password must be at least 8 characters.");
      return;
    }
    if (newPassword !== confirmPassword) {
      setError("New passwords don't match.");
      return;
    }
    if (newPassword === currentPassword) {
      setError("New password must be different from your current password.");
      return;
    }
    setSaving(true);
    try {
      await changePassword(currentPassword, newPassword);
      setCurrentPassword("");
      setNewPassword("");
      setConfirmPassword("");
      setSuccess(true);
    } catch (err) {
      setError(errorMessage(err, "Couldn't change your password."));
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <button className="text-button back" onClick={onBack}>
        <Icon name="arrowLeft" size={16} /> Back to profile
      </button>
      <h1>Change password</h1>
      <p className="muted">Enter your current password and choose a new one.</p>

      <form className="login-form" onSubmit={handleSubmit}>
        <label>
          <span>Current password</span>
          <div className="input-with-icon">
            <Icon name="lock" size={17} />
            <input
              type="password"
              required
              autoComplete="current-password"
              value={currentPassword}
              onChange={(e) => setCurrentPassword(e.target.value)}
              placeholder="••••••••"
              disabled={saving}
            />
          </div>
        </label>
        <label>
          <span>New password</span>
          <div className="input-with-icon">
            <Icon name="lock" size={17} />
            <input
              type="password"
              required
              autoComplete="new-password"
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              placeholder="••••••••"
              disabled={saving}
            />
          </div>
        </label>
        <label>
          <span>Confirm new password</span>
          <div className="input-with-icon">
            <Icon name="lock" size={17} />
            <input
              type="password"
              required
              autoComplete="new-password"
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              placeholder="••••••••"
              disabled={saving}
            />
          </div>
        </label>
        {error && <p className="form-error"><Icon name="warning" size={15} />{error}</p>}
        {success && (
          <p className="form-success">
            <Icon name="check" size={15} /> Password updated.
          </p>
        )}
        <button className="primary-button" type="submit" disabled={saving}>
          {saving ? "Updating…" : "Update password"}
        </button>
      </form>
    </>
  );
}

function HolidaysScreen({ onBack }: { onBack: () => void }) {
  const [holidays, setHolidays] = useState<Holiday[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const today = new Date().toISOString().slice(0, 10);

  useEffect(() => {
    listHolidays()
      .then(setHolidays)
      .catch((err) => setError(errorMessage(err, "Couldn't load holidays.")));
  }, []);

  return (
    <>
      <button className="text-button back" onClick={onBack}>
        <Icon name="arrowLeft" size={16} /> Back
      </button>
      <h1>Bank holidays</h1>
      <p className="muted">Irish public holidays.</p>
      {error ? (
        <div className="notice">
          <Icon name="warning" size={16} /> {error}
        </div>
      ) : !holidays ? (
        <p className="muted small">Loading…</p>
      ) : holidays.length ? (
        <ul className="leave-list">
          {holidays.map((holiday) => (
            <li key={holiday.date} className={holiday.date < today ? "muted" : undefined}>
              <div>
                <b>{holiday.name}</b>
              </div>
              <span className="pill">{formatDate(holiday.date)}</span>
            </li>
          ))}
        </ul>
      ) : (
        <section className="empty">
          <Icon name="calendar" size={44} className="empty-icon" />
          <h2>No holidays listed</h2>
          <p className="muted">Ask HR to add the bank holiday calendar.</p>
        </section>
      )}
    </>
  );
}

function NavButton({ active, label, icon, onClick, primary }: { active: boolean; label: string; icon: Parameters<typeof Icon>[0]["name"]; onClick: () => void; primary?: boolean }) {
  return (
    <button className={`${active ? "selected" : ""} ${primary ? "nav-primary" : ""}`} onClick={onClick}>
      <span>
        <Icon name={icon} size={primary ? 24 : 20} strokeWidth={primary ? 2 : 1.8} />
      </span>
      {label}
    </button>
  );
}

function Action({ label, enabled, danger, busy, onClick }: { label: string; enabled: boolean; danger?: boolean; busy?: boolean; onClick: () => void }) {
  return (
    <button className={`action ${danger ? "danger" : ""}`} disabled={!enabled || busy} onClick={onClick}>
      <Icon name={busy ? "spinner" : "clock"} size={22} className={busy ? "spin" : undefined} />
      <span>{label}</span>
    </button>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="muted">{label}</p>
      <strong>{value}</strong>
    </div>
  );
}

function AttendanceCard({ title, value, clockIn, clockOut }: { title: string; value: string; clockIn: string; clockOut: string }) {
  return (
    <section className="card attendance-card">
      <div className="row">
        <h2>{title}</h2>
        <strong>{value}</strong>
      </div>
      <div className="metric-pair">
        <Metric label="Start" value={clockIn} />
        <Metric label="End" value={clockOut} />
      </div>
    </section>
  );
}

function Setting({
  label,
  value,
  icon,
  chevron,
  onClick,
}: {
  label: string;
  value: string;
  icon: Parameters<typeof Icon>[0]["name"];
  chevron?: boolean;
  onClick?: () => void;
}) {
  return (
    <button onClick={onClick} disabled={!onClick}>
      <span className="setting-label">
        <Icon name={icon} size={18} className="muted-icon" />
        {label}
      </span>
      {chevron ? <Icon name="chevronRight" size={16} className="muted-icon" /> : <b>{value}</b>}
    </button>
  );
}

// The browser's actual geolocation permission, used for "office" clock-in.
// Falls back to "Asked when needed" where the Permissions API isn't available
// (older iOS Safari), since the prompt then appears on first office clock-in.
function useLocationPermission(): string {
  const [label, setLabel] = useState("Checking…");
  useEffect(() => {
    const labels: Record<PermissionState, string> = { granted: "Allowed", denied: "Blocked", prompt: "Asked when needed" };
    if (typeof navigator === "undefined" || !("geolocation" in navigator)) {
      setLabel("Not supported");
      return;
    }
    if (!navigator.permissions?.query) {
      setLabel("Asked when needed");
      return;
    }
    let status: PermissionStatus | null = null;
    const update = () => status && setLabel(labels[status.state]);
    navigator.permissions
      .query({ name: "geolocation" })
      .then((s) => {
        status = s;
        update();
        s.addEventListener("change", update);
      })
      .catch(() => setLabel("Asked when needed"));
    return () => status?.removeEventListener("change", update);
  }, []);
  return label;
}

// ---- formatting & derived-state helpers ----

function timeGreeting() {
  const hour = new Date().getHours();
  if (hour < 12) return "Good morning";
  if (hour < 18) return "Good afternoon";
  return "Good evening";
}

function initials(name: string) {
  return name
    .split(" ")
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase())
    .join("");
}

function roleLabel(role: string) {
  return { employee: "Employee", manager: "Manager", hr_admin: "HR Administrator", kiosk: "Kiosk device" }[role] ?? role;
}

function leaveTypeLabel(type: string) {
  return { annual: "Annual leave", medical: "Medical / sick day", unpaid: "Unpaid leave", other: "Other" }[type] ?? type;
}

function statusClass(status: string) {
  return { approved: "success", rejected: "danger", pending: "pending", cancelled: "" }[status] ?? "";
}

function formatDays(value: number) {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

function formatDate(value: string) {
  return new Date(`${value}T00:00:00`).toLocaleDateString([], { day: "2-digit", month: "short", year: "numeric" });
}

function formatTime(value: string) {
  return new Date(value).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function eventLabel(type: AttendanceEventType) {
  return {
    clock_in: "🟢 Clocked in",
    clock_out: "🔴 Clocked out",
    break_start: "☕ First break started",
    break_end: "▶️ First break ended",
    lunch_start: "🍽️ Lunch started",
    lunch_end: "▶️ Lunch ended",
  }[type];
}

function averageTimes(sessions: MonthSessionSummary[]) {
  const ins = sessions.map((s) => s.clockedInAt).filter((v): v is string => !!v);
  const outs = sessions.map((s) => s.clockedOutAt).filter((v): v is string => !!v);
  return { avgCheckIn: averageTimeOfDay(ins), avgCheckOut: averageTimeOfDay(outs) };
}

function averageTimeOfDay(timestamps: string[]) {
  if (!timestamps.length) return "--:--";
  const totalMinutes = timestamps.reduce((sum, ts) => {
    const d = new Date(ts);
    return sum + d.getHours() * 60 + d.getMinutes();
  }, 0);
  const avg = Math.round(totalMinutes / timestamps.length);
  const hours = Math.floor(avg / 60)
    .toString()
    .padStart(2, "0");
  const minutes = (avg % 60).toString().padStart(2, "0");
  return `${hours}:${minutes}`;
}

function monthSummary(sessions: MonthSessionSummary[]) {
  // Only completed days count toward totals — a session that's still open (or
  // was never clocked out) has no meaningful duration, so counting it would
  // silently understate or inflate the month. Those surface as "Incomplete".
  const worked = sessions.filter((s) => s.clockedInAt);
  const complete = worked.filter((s) => s.clockedOutAt);

  const totalMinutes = complete.reduce(
    (sum, s) => sum + Math.max(0, (new Date(s.clockedOutAt!).getTime() - new Date(s.clockedInAt!).getTime()) / 60000),
    0,
  );

  const days = [...worked]
    .sort((a, b) => b.workDate.localeCompare(a.workDate))
    .map((s) => {
      const minutes = s.clockedOutAt
        ? Math.max(0, (new Date(s.clockedOutAt).getTime() - new Date(s.clockedInAt!).getTime()) / 60000)
        : null;
      return {
        workDate: s.workDate,
        clockIn: formatTime(s.clockedInAt!),
        clockOut: s.clockedOutAt ? formatTime(s.clockedOutAt) : "—",
        hours: minutes === null ? "Open" : formatHours(minutes),
      };
    });

  return {
    daysWorked: worked.length,
    incomplete: worked.length - complete.length,
    totalHours: formatHours(totalMinutes),
    avgDay: complete.length ? formatHours(totalMinutes / complete.length) : "0h 0m",
    avgCheckIn: averageTimeOfDay(worked.map((s) => s.clockedInAt).filter((v): v is string => !!v)),
    avgCheckOut: averageTimeOfDay(complete.map((s) => s.clockedOutAt).filter((v): v is string => !!v)),
    days,
  };
}

function formatHours(minutes: number) {
  const rounded = Math.round(minutes);
  return `${Math.floor(rounded / 60)}h ${rounded % 60}m`;
}

function buildHeatmap(sessions: MonthSessionSummary[]) {
  const now = new Date();
  const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
  const byDate = new Map(sessions.map((s) => [s.workDate, s]));
  const today = now.toISOString().slice(0, 10);

  return Array.from({ length: daysInMonth }, (_, index) => {
    const day = index + 1;
    const date = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    const session = byDate.get(date);
    if (date > today) return { day, className: "future", title: "Upcoming" };
    if (!session || !session.clockedInAt) return { day, className: "empty-cell", title: "No attendance" };
    if (session.clockedInAt && !session.clockedOutAt && date < today) return { day, className: "missed", title: "Missing clock-out" };
    const minutes = session.clockedOutAt
      ? (new Date(session.clockedOutAt).getTime() - new Date(session.clockedInAt).getTime()) / 60000
      : (Date.now() - new Date(session.clockedInAt).getTime()) / 60000;
    const level = minutes > 420 ? "high" : minutes > 180 ? "normal" : "low";
    return { day, className: level, title: `${Math.round(minutes / 60)}h worked` };
  });
}

function computeDurations(events: AttendanceEventRecord[]) {
  const byType = new Map<AttendanceEventType, string>();
  for (const event of events) if (!byType.has(event.eventType)) byType.set(event.eventType, event.occurredAt);

  function span(startType: AttendanceEventType, endType: AttendanceEventType) {
    const start = byType.get(startType);
    const end = byType.get(endType);
    if (!start) return { label: "0m", start: "--:--", end: "--:--" };
    const startMs = new Date(start).getTime();
    const endMs = end ? new Date(end).getTime() : Date.now();
    const minutes = Math.max(0, Math.round((endMs - startMs) / 60000));
    return {
      label: `${Math.floor(minutes / 60)}h ${minutes % 60}m`,
      start: formatTime(start),
      end: end ? formatTime(end) : "Active",
    };
  }

  const working = span("clock_in", "clock_out");
  const firstBreak = span("break_start", "break_end");
  const lunch = span("lunch_start", "lunch_end");

  return {
    working: working.label,
    clockIn: working.start,
    clockOut: working.end,
    firstBreak: firstBreak.label,
    breakIn: firstBreak.start,
    breakOut: firstBreak.end,
    lunch: lunch.label,
    lunchIn: lunch.start,
    lunchOut: lunch.end,
  };
}
