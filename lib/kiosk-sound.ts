import type { AttendanceEventType } from "./domain";

// Kiosk feedback tones, synthesized with Web Audio so there are no sound files
// to ship or cache. Browsers keep an AudioContext suspended until a user
// gesture, so call unlockKioskSound() from a click handler before scanning
// starts — QR decodes don't count as gestures.

type Note = { freq: number; start: number; duration: number };

let context: AudioContext | null = null;

function getContext(): AudioContext | null {
  if (typeof window === "undefined") return null;
  if (!context) {
    const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return null;
    context = new Ctor();
  }
  return context;
}

export function unlockKioskSound() {
  const ctx = getContext();
  if (ctx && ctx.state === "suspended") void ctx.resume();
}

function playNotes(notes: Note[], type: OscillatorType, volume: number) {
  const ctx = getContext();
  if (!ctx) return;
  if (ctx.state === "suspended") void ctx.resume();
  const now = ctx.currentTime;
  for (const note of notes) {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = type;
    osc.frequency.value = note.freq;
    // Short attack/release envelope so notes don't click.
    const t0 = now + note.start;
    gain.gain.setValueAtTime(0, t0);
    gain.gain.linearRampToValueAtTime(volume, t0 + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + note.duration);
    osc.connect(gain).connect(ctx.destination);
    osc.start(t0);
    osc.stop(t0 + note.duration + 0.02);
  }
}

// Clock in rises, clock out falls, so the two are distinguishable by ear;
// breaks/lunch get a single neutral chime.
export function playKioskSuccess(action: AttendanceEventType) {
  if (action === "clock_in") {
    playNotes([
      { freq: 660, start: 0, duration: 0.15 },
      { freq: 880, start: 0.12, duration: 0.15 },
      { freq: 1320, start: 0.24, duration: 0.3 },
    ], "sine", 0.35);
  } else if (action === "clock_out") {
    playNotes([
      { freq: 1320, start: 0, duration: 0.15 },
      { freq: 880, start: 0.12, duration: 0.15 },
      { freq: 660, start: 0.24, duration: 0.3 },
    ], "sine", 0.35);
  } else {
    playNotes([{ freq: 990, start: 0, duration: 0.25 }], "sine", 0.3);
  }
}

export function playKioskError() {
  playNotes([
    { freq: 220, start: 0, duration: 0.18 },
    { freq: 220, start: 0.22, duration: 0.25 },
  ], "square", 0.12);
}
