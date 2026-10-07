"use client";

import { useEffect, useRef, useState } from "react";
import QrScanner from "qr-scanner";
import "./kiosk.css";
import { Icon } from "../../components/icons";
import {
  clearKioskSession,
  identifyEmployee,
  isKioskSessionInvalidError,
  kioskErrorMessage,
  loadKioskSession,
  pairDevice,
  recordKioskAttendance,
  saveKioskSession,
  type KioskSession,
} from "../../lib/kiosk-service";
import type { AttendanceEventType, AttendanceState } from "../../lib/domain";

const eventLabels: Record<AttendanceEventType, string> = {
  clock_in: "Clock in",
  clock_out: "Clock out",
  break_start: "Start break",
  break_end: "End break",
  lunch_start: "Start lunch",
  lunch_end: "End lunch",
};

// Tone drives the tile's accent colour so the six actions are told apart at a
// glance from across a room, rather than by reading the label.
const eventIcons: Record<AttendanceEventType, { icon: Parameters<typeof Icon>[0]["name"]; tone: string }> = {
  clock_in: { icon: "logIn", tone: "start" },
  clock_out: { icon: "logout", tone: "stop" },
  break_start: { icon: "coffee", tone: "pause" },
  break_end: { icon: "play", tone: "resume" },
  lunch_start: { icon: "utensils", tone: "pause" },
  lunch_end: { icon: "play", tone: "resume" },
};

const actionOrder: AttendanceEventType[] = ["clock_in", "clock_out", "break_start", "break_end", "lunch_start", "lunch_end"];

const stateLabels: Record<AttendanceState, string> = {
  not_started: "not started yet",
  working: "currently working",
  on_break: "on break",
  on_lunch: "on lunch",
  complete: "done for the day",
};

// How long the same QR token is ignored after it was last handled, so a code
// held in front of the camera isn't processed repeatedly.
const SCAN_COOLDOWN_MS = 4000;

// How long staff must hold the logo on the action screen to unpair the kiosk.
const UNPAIR_HOLD_MS = 5000;

type Phase ="loading" | "pairing" | "select-action" | "scanning";
type CameraError = "denied" | "no-camera" | null;

export default function KioskPage() {
  const [phase, setPhase] = useState<Phase>("loading");
  const [session, setSession] = useState<KioskSession | null>(null);
  const [pairError, setPairError] = useState<string | null>(null);
  const [pairing, setPairing] = useState(false);
  const [pin, setPin] = useState("");
  const [selectedAction, setSelectedAction] = useState<AttendanceEventType | null>(null);
  const [manualEntryOpen, setManualEntryOpen] = useState(false);
  const [manualToken, setManualToken] = useState("");
  const [scanMessage, setScanMessage] = useState<string | null>(null);
  const [success, setSuccess] = useState<{ name: string; action: AttendanceEventType; at: Date } | null>(null);
  // One shared timer so a new result replaces the previous one cleanly instead
  // of an older timeout clearing a newer message early.
  const feedbackTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  function showFeedback(next: { error: string } | { name: string; action: AttendanceEventType }) {
    if (feedbackTimerRef.current) clearTimeout(feedbackTimerRef.current);
    if ("error" in next) {
      setSuccess(null);
      setScanMessage(next.error);
    } else {
      setScanMessage(null);
      setSuccess({ ...next, at: new Date() });
    }
    feedbackTimerRef.current = setTimeout(() => {
      setScanMessage(null);
      setSuccess(null);
    }, "error" in next ? 3500 : 2000);
  }
  const [cameraError, setCameraError] = useState<CameraError>(null);
  const [reauthBanner, setReauthBanner] = useState<string | null>(null);

  const videoRef = useRef<HTMLVideoElement>(null);
  const scannerRef = useRef<QrScanner | null>(null);
  const busyRef = useRef(false);
  const lastScanRef = useRef<{ token: string; at: number } | null>(null);

  useEffect(() => {
    const existing = loadKioskSession();
    if (existing) {
      setSession(existing);
      setPhase("select-action");
    } else {
      setPhase("pairing");
    }
  }, []);

  function backToPairing(message: string) {
    clearKioskSession();
    setSession(null);
    setSelectedAction(null);
    setReauthBanner(message || null);
    setPhase("pairing");
  }

  async function handlePair(event: React.FormEvent) {
    event.preventDefault();
    setPairError(null);
    setPairing(true);
    try {
      const next = await pairDevice(pin);
      saveKioskSession(next);
      setSession(next);
      setPin("");
      setReauthBanner(null);
      setPhase("select-action");
    } catch (err) {
      setPairError(kioskErrorMessage(err));
    } finally {
      setPairing(false);
    }
  }

  const unpairHoldRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  function startUnpairHold() {
    cancelUnpairHold();
    unpairHoldRef.current = setTimeout(() => {
      unpairHoldRef.current = null;
      if (window.confirm("Unpair this kiosk? A new PIN from Balkania Admin will be needed to pair it again.")) backToPairing("");
    }, UNPAIR_HOLD_MS);
  }

  function cancelUnpairHold() {
    if (unpairHoldRef.current) clearTimeout(unpairHoldRef.current);
    unpairHoldRef.current = null;
  }

  function chooseAction(action: AttendanceEventType) {
    setSelectedAction(action);
    setPhase("scanning");
  }

  async function handleDecoded(qrToken: string) {
    if (busyRef.current || !session || !selectedAction) return;
    // The scanner keeps decoding the same code every frame while it stays in view.
    // Without this, the second decode lands after the first recorded successfully,
    // sees the employee in their new state, and flashes a spurious red error.
    const last = lastScanRef.current;
    if (last && last.token === qrToken && Date.now() - last.at < SCAN_COOLDOWN_MS) return;
    busyRef.current = true;
    lastScanRef.current = { token: qrToken, at: Date.now() };
    try {
      const identified = await identifyEmployee(session.sessionToken, qrToken);
      if (!identified.validActions.includes(selectedAction)) {
        showFeedback({ error: `${identified.fullName} is ${stateLabels[identified.state]} — can't ${eventLabels[selectedAction].toLowerCase()}.` });
        return;
      }
      await recordKioskAttendance(session.sessionToken, identified.employeeId, selectedAction, crypto.randomUUID());
      showFeedback({ name: identified.fullName, action: selectedAction });
    } catch (err) {
      if (isKioskSessionInvalidError(err)) {
        backToPairing(kioskErrorMessage(err));
        return;
      }
      showFeedback({ error: kioskErrorMessage(err) });
    } finally {
      // Restart the cooldown from when processing finished, not when it started.
      if (lastScanRef.current) lastScanRef.current.at = Date.now();
      busyRef.current = false;
    }
  }

  useEffect(() => {
    if (phase !== "scanning" || !videoRef.current) return;

    let cancelled = false;
    setCameraError(null);

    QrScanner.hasCamera().then((has) => {
      if (cancelled) return;
      if (!has) {
        setCameraError("no-camera");
        setManualEntryOpen(true);
        return;
      }
      const scanner = new QrScanner(videoRef.current!, (result) => handleDecoded(result.data), {
        preferredCamera: "user",
        highlightScanRegion: true,
        highlightCodeOutline: true,
      });
      scannerRef.current = scanner;
      scanner.start().catch(() => {
        if (!cancelled) setCameraError("denied");
      });
    });

    return () => {
      cancelled = true;
      scannerRef.current?.destroy();
      scannerRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, session, selectedAction]);

  function retryCamera() {
    setCameraError(null);
    scannerRef.current?.start().catch(() => setCameraError("denied"));
  }

  async function handleManualSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (!manualToken.trim()) return;
    await handleDecoded(manualToken.trim());
    setManualToken("");
  }

  if (phase === "loading") {
    return (
      <main className="kiosk kiosk-center kiosk-light">
        <Icon name="spinner" size={28} className="spin" />
      </main>
    );
  }

  if (phase === "pairing") {
    return (
      <main className="kiosk kiosk-center kiosk-light">
        <div className="kiosk-pair-card">
          <img src="/icon-color.png" alt="Balkania" className="kiosk-logo" />
          <h1>Pair this device</h1>
          <p className="kiosk-muted">Enter the PIN shown when this kiosk was registered in Balkania Admin.</p>
          {reauthBanner && (
            <div className="kiosk-banner">
              <Icon name="warning" size={16} /> {reauthBanner}
            </div>
          )}
          <form onSubmit={handlePair}>
            <input
              inputMode="numeric"
              maxLength={6}
              autoFocus
              value={pin}
              onChange={(e) => setPin(e.target.value.replace(/\D/g, ""))}
              placeholder="000000"
              className="kiosk-pin-input"
              disabled={pairing}
            />
            {pairError && (
              <p className="kiosk-error">
                <Icon name="warning" size={15} /> {pairError}
              </p>
            )}
            <button className="kiosk-primary-button" type="submit" disabled={pairing || pin.length !== 6}>
              {pairing ? "Pairing…" : "Pair device"}
            </button>
          </form>
        </div>
      </main>
    );
  }

  if (phase === "select-action") {
    return (
      <main className="kiosk kiosk-center kiosk-light">
        <div className="kiosk-pair-card kiosk-action-card">
          {/* Hidden staff escape hatch: hold the logo for 5s to unpair. There is
              deliberately no visible button -- employees use this screen all day.
              The normal route is deleting the device under Kiosk devices in admin. */}
          <img
            src="/icon-color.png"
            alt="Balkania"
            className="kiosk-logo"
            draggable={false}
            onPointerDown={startUnpairHold}
            onPointerUp={cancelUnpairHold}
            onPointerLeave={cancelUnpairHold}
            onPointerCancel={cancelUnpairHold}
            onContextMenu={(e) => e.preventDefault()}
          />
          <h1>What are you recording?</h1>
          <p className="kiosk-muted">Choose an action, then scan each employee&apos;s code.</p>
          <div className="kiosk-action-grid">
            {actionOrder.map((action) => (
              <button
                key={action}
                className={`kiosk-action-tile tone-${eventIcons[action].tone}`}
                onClick={() => chooseAction(action)}
              >
                <span className="kiosk-action-icon">
                  <Icon name={eventIcons[action].icon} size={30} strokeWidth={1.9} />
                </span>
                {eventLabels[action]}
              </button>
            ))}
          </div>
        </div>
      </main>
    );
  }

  if (phase === "scanning" && selectedAction) {
    return (
      <main className="kiosk kiosk-scanner">
        <div className="kiosk-scanner-video-wrap">
          <video ref={videoRef} className="kiosk-scanner-video" muted playsInline />
          <button className="kiosk-mode-badge" onClick={() => setPhase("select-action")}>
            <Icon name={eventIcons[selectedAction].icon} size={16} />
            {eventLabels[selectedAction]}
            <Icon name="swap" size={14} className="kiosk-mode-swap" />
          </button>
          <img src="/icon-white.png" alt="Balkania" className="kiosk-scanner-logo" />
          {!cameraError && (
            <div className="kiosk-scanner-caption">
              <Icon name="qr" size={22} /> Point the camera at your QR code
            </div>
          )}
          {cameraError === "denied" && (
            <div className="kiosk-scanner-overlay">
              <Icon name="warning" size={32} />
              <p>Camera access is required. Allow it in your browser settings and try again.</p>
              <button className="kiosk-primary-button" onClick={retryCamera}>Try again</button>
            </div>
          )}
          {cameraError === "no-camera" && (
            <div className="kiosk-scanner-overlay">
              <Icon name="warning" size={32} />
              <p>No camera was found on this device. Use the manual entry below instead.</p>
            </div>
          )}
          {/* Readable from a metre away: a full-screen confirmation the person
              can't miss, rather than a small pill at the top of the camera view. */}
          {success && (
            <div className="kiosk-result kiosk-result-success" role="status" aria-live="polite">
              <span className="kiosk-result-icon"><Icon name="check" size={56} strokeWidth={2.6} /></span>
              <p className="kiosk-result-name">{success.name}</p>
              <p className="kiosk-result-detail">
                {eventLabels[success.action]} · {success.at.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
              </p>
            </div>
          )}
          {scanMessage && (
            <div className="kiosk-result kiosk-result-error" role="alert">
              <span className="kiosk-result-icon"><Icon name="warning" size={44} strokeWidth={2.2} /></span>
              <p className="kiosk-result-detail">{scanMessage}</p>
            </div>
          )}
        </div>
        <div className="kiosk-manual">
          <button className="kiosk-text-button" onClick={() => setManualEntryOpen((v) => !v)}>
            {manualEntryOpen ? "Hide manual entry" : "Enter code manually"}
          </button>
          {manualEntryOpen && (
            <form onSubmit={handleManualSubmit} className="kiosk-manual-form">
              <input value={manualToken} onChange={(e) => setManualToken(e.target.value)} placeholder="Paste attendance code" />
              <button className="kiosk-secondary-button" type="submit">Submit</button>
            </form>
          )}
        </div>
      </main>
    );
  }

  return null;
}
