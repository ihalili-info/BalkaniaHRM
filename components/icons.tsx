const paths: Record<string, string> = {
  home: "M3 11.5 12 4l9 7.5M5.5 10v9a1 1 0 0 0 1 1H10v-6h4v6h3.5a1 1 0 0 0 1-1v-9",
  calendar: "M7 3v3M17 3v3M4 8h16M5 5h14a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1Z",
  qr: "M4 4h6v6H4V4Zm10 0h6v6h-6V4ZM4 14h6v6H4v-6Zm10 1h2v2h-2v-2Zm4 0h2v2h-2v-2Zm-4 4h2v2h-2v-2Zm4 0h2v2h-2v-2Z",
  clock: "M12 7v5l3.5 2M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Z",
  user: "M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8Zm-7 9a7 7 0 0 1 14 0",
  bell: "M6 9a6 6 0 1 1 12 0c0 4 1.5 5.5 1.5 5.5H4.5S6 13 6 9Zm4.3 8.5a1.9 1.9 0 0 0 3.4 0",
  settings: "M12 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7ZM4 12h1.2m1.35-5.45.85.85M12 4v1.2m5.45 1.35-.85.85M20 12h-1.2m-1.35 5.45-.85-.85M12 20v-1.2m-5.45-1.35.85-.85",
  plus: "M12 5v14M5 12h14",
  chevronRight: "m9 6 6 6-6 6",
  logout: "M9 21H6a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3M16 17l5-5-5-5M21 12H9",
  users: "M17 21v-1.5a3.5 3.5 0 0 0-3.5-3.5h-5A3.5 3.5 0 0 0 5 19.5V21M11 13a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7Zm8 8v-1.5a3 3 0 0 0-2.2-2.9M15 6.2a3.5 3.5 0 0 1 0 6.6",
  layout: "M4 5h16v4H4V5Zm0 6h7v8H4v-8Zm9 0h7v8h-7v-8Z",
  briefcase: "M4 8h16v11a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V8Zm4 0V6a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M4 13h16",
  device: "M6 3h12a1 1 0 0 1 1 1v16a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1Zm5 15h2",
  download: "M12 4v11m0 0-4-4m4 4 4-4M5 20h14",
  upload: "M12 15V4m0 0-4 4m4-4 4 4M5 20h14",
  menu: "M4 6h16M4 12h16M4 18h16",
  search: "m21 21-4.3-4.3M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16Z",
  filter: "M4 6h16M7 12h10M10 18h4",
  check: "m5 13 4 4L19 7",
  x: "m6 6 12 12M18 6 6 18",
  warning: "M12 9v4m0 4h.01M10.3 3.9 1.9 18a1 1 0 0 0 .9 1.5h18.4a1 1 0 0 0 .9-1.5L13.7 3.9a1 1 0 0 0-1.7 0Z",
  sun: "M12 4V2m0 20v-2M4 12H2m20 0h-2M5.6 5.6 4.2 4.2m15.6 1.4 1.4-1.4M5.6 18.4l-1.4 1.4m15.6-1.4 1.4 1.4M12 17a5 5 0 1 0 0-10 5 5 0 0 0 0 10Z",
  swap: "m7 4-4 4 4 4M3 8h13m1 8 4-4-4-4m5 4H8",
  archive: "M4 7h16v13a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7Zm-1-4h18v4H3V3Zm6 8h6",
  arrowLeft: "M19 12H5m0 0 6-6m-6 6 6 6",
  spinner: "M12 3a9 9 0 1 0 9 9",
  mail: "M4 6h16a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1Zm0 0 8 7 8-7",
  lock: "M6 11V8a6 6 0 1 1 12 0v3m-13 0h14v9a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1v-9Z",
  building: "M4 21V5a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v16M4 21h16M9 8h.01M9 12h.01M9 16h.01M13 8h.01M13 12h.01M13 16h.01M16 21v-6h4v6",
  graduationCap: "M2 8 12 3l10 5-10 5L2 8Zm4 3v5c0 1.5 2.5 3 6 3s6-1.5 6-3v-5",
  userPlus: "M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8Zm-6 10a6 6 0 0 1 9-5.2M17 15v6m3-3h-6",
  chart: "M4 20V10M10 20V4M16 20v-7M4 20h16",
  creditCard: "M3 7a1 1 0 0 1 1-1h16a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V7Zm0 4h18M7 15h4",
  edit: "M4 20h4L18.5 9.5a2.1 2.1 0 0 0-3-3L5 17v3Zm10-14 3 3",
  trash: "M4 7h16M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2M6 7l1 12a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1l1-12M10 11v6M14 11v6",
  logIn: "M15 3h3a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-3M10 17l5-5-5-5M15 12H3",
  coffee: "M4 8h13v5a5 5 0 0 1-5 5H9a5 5 0 0 1-5-5V8Zm13 1h2a2.5 2.5 0 0 1 0 5h-2M7 2v2.5M11 2v2.5M15 2v2.5",
  utensils: "M6 2v7a2.5 2.5 0 0 0 5 0V2M8.5 11.5V22M18 2c-1.5 2.2-2 4.3-2 6.5 0 1.8.7 2.5 2 2.5v11",
  play: "M8 5.5v13l10-6.5-10-6.5Z",
};

export function Icon({ name, size = 20, className, strokeWidth = 1.8 }: { name: keyof typeof paths; size?: number; className?: string; strokeWidth?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      <path d={paths[name]} />
    </svg>
  );
}
