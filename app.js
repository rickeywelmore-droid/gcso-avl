//////////////////////////////////////////////////////
// FIREBASE
//////////////////////////////////////////////////////

const firebaseConfig = {
  apiKey: "AIzaSyA5hXURTrwoUkMRBkI2iEYU74CsG4z_vcU",
  authDomain: "gcso-avl.firebaseapp.com",
  databaseURL: "https://gcso-avl-default-rtdb.firebaseio.com",
  projectId: "gcso-avl"
};

firebase.initializeApp(firebaseConfig);
const db = firebase.database();
const unitsRef = db.ref("units");
const sessionsRef = db.ref("sessions");
const connectedRef = db.ref(".info/connected");
const auditLogsRef = db.ref("auditLogs");

/*********************************************************************
 GCSO AVL CONFIGURATION
 --------------------------------------------------------------------
 Version: 1.1.10
 Build: 2026-08-01

 Temporary client-side access gate. This is a convenience barrier,
 not strong authentication.
*********************************************************************/
const APP_VERSION = "1.1.10";
const BUILD_DATE = "2026-08-01";
const USER_PASSWORD = "GCSO123";
const ADMIN_PASSWORD = "GCSOADMIN123";
const PRESENCE_TIMEOUT_MINUTES = 2;
const UNIT_OFFLINE_MINUTES = 15;
const ABANDONED_UNIT_HOURS = 2;
const HEARTBEAT_SECONDS = 30;
const DISPATCH_IDLE_MINUTES = 60;
const DISPATCH_WARNING_MINUTES = 5;
const DISPATCH_SOUND_ENABLED = true;
const AUDIT_RETENTION_DAYS = 5;
const GPS_PROBE_MS = 5000;
const GPS_RESCAN_MS = 3000;
const SERIAL_STALL_MS = 12000;
const SERIAL_WATCHDOG_MS = 3000;
const FIREBASE_RECOVERY_MS = 15000;
const DEBUG = false;


function debugLog(...args) {
  if (DEBUG) console.log("[GCSO AVL]", ...args);
}

//////////////////////////////////////////////////////
// MAP
//////////////////////////////////////////////////////

const map = L.map("map").setView([38.9, -84.5], 10);

let lightTiles = L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
  maxZoom: 19
}).addTo(map);

let darkTiles = L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
  maxZoom: 19,
  attribution: '&copy; OpenStreetMap contributors',
  className: "dark-contrast-tiles"
});

let darkMode = localStorage.getItem("avl_darkMode") === "true";

function applyDarkMode() {
  document.body.classList.toggle("dark", darkMode);

  if (darkMode) {
    if (map.hasLayer(lightTiles)) map.removeLayer(lightTiles);
    if (!map.hasLayer(darkTiles)) darkTiles.addTo(map);
  } else {
    if (map.hasLayer(darkTiles)) map.removeLayer(darkTiles);
    if (!map.hasLayer(lightTiles)) lightTiles.addTo(map);
  }

  localStorage.setItem("avl_darkMode", darkMode ? "true" : "false");
  setTimeout(() => map.invalidateSize(), 200);
}

function toggleDarkMode() {
  darkMode = !darkMode;
  applyDarkMode();
}

applyDarkMode();

function restoreSavedBaudRate() {
  const baudSelect = document.getElementById("baudRate");
  if (!baudSelect) return;

  const savedBaud = localStorage.getItem("avl_lastBaudRate");
  if (savedBaud && Array.from(baudSelect.options).some(opt => opt.value === savedBaud)) {
    baudSelect.value = savedBaud;
  }

  baudSelect.addEventListener("change", () => {
    localStorage.setItem("avl_lastBaudRate", baudSelect.value);
  });
}

restoreSavedBaudRate();

let markers = {};
let currentUnitId = null;
let currentSessionKey = null;
let userMode = "unit";
let browserWatchId = null;
let browserGpsConnectedLogged = false;
let presenceTimer = null;
let latestUnits = {};
let latestSessions = {};
let renderUnitListTimer = null;
let sessionLoginTime = null;
let userRole = "user";
let selectedRosterUnitId = null;
let selectedRosterMode = null;
let ownDispatchSessionRef = null;
let ownDispatchSessionEstablished = false;
let adminBootInProgress = false;
let firebaseConnected = false;
let lastPendingFix = null;
let lastPendingUnitId = null;
let lastSuccessfulWriteTime = 0;
let lastFirebaseConnectionChange = Date.now();
let developerPanelVisible = false;
let clientSessionId = localStorage.getItem("avl_clientSessionId") || createClientSessionId();
let clientInstallId = localStorage.getItem("avl_clientInstallId") || createClientInstallId();
let publicIpAddress = "Checking...";
let localEventLog = [];
let dispatchLastActivityTime = Date.now();
let dispatchIdleTimer = null;
let dispatchCountdownTimer = null;
let dispatchWarningVisible = false;
let dispatchWarningOneMinutePlayed = false;
let audioContext = null;
let auditListenerRef = null;
let auditSelectedUnit = "all";
let auditSelectedSeverity = "all";
let auditSelectedSource = "all";
let disconnectAuditRef = null;
let lastDisconnectAuditArmTime = 0;
let disconnectAuditHasLocation = false;
let infoConnectedState = null;
let unexpectedDisconnectObserved = false;
let pendingAuditEvents = restorePendingAuditEvents();

// Runtime state used by restored sessions, diagnostics, wake lock, and serial GPS.
// These must be initialized before restoreLogin() or any load/connection callbacks run.
let wakeLock = null;
let serialPort = null;
let serialReader = null;
let serialKeepReading = false;
let serialBuffer = "";
let serialAutoMode = false;
let serialReconnectTimer = null;
let currentSerialLabel = "External USB GPS";
let currentSerialBaud = null;
let currentSerialPortId = "Not selected";
let serialConnectionPhase = "Disconnected";
let serialOpenedTime = 0;
let lastNmeaPacketTime = 0;
let lastNmeaSentenceType = "None";
let serialFixQuality = null;
let serialSatellites = null;
let serialHdop = null;
let serialWatchdogRecoveryInProgress = false;
let serialFixLoggedForConnection = false;
let pendingManualGpsStart = null;
let lastFirebaseRecoveryAttempt = 0;
let lastValidFixTime = 0;
let lastFix = null;
let lastFixUnitId = null;

const SERIAL_BAUD_RATES = [9600, 4800, 38400, 115200];

localStorage.setItem("avl_clientSessionId", clientSessionId);
localStorage.setItem("avl_clientInstallId", clientInstallId);

const SESSION_STALE_MS = PRESENCE_TIMEOUT_MINUTES * 60 * 1000; // logged-in heartbeat grace period

// A unit should only show OFFLINE after no GPS data has been received for this long.
const UNIT_OFFLINE_MS = UNIT_OFFLINE_MINUTES * 60 * 1000;
// Remove abandoned unit records after two hours with no GPS and no active session.
// This preserves last-known positions through ordinary rural coverage gaps without
// leaving cars from prior shifts on the map indefinitely.
const UNIT_EXPIRE_MS = 2 * 60 * 60 * 1000; // 2 hours
let unitListRenderTimer = null;
let latestUnitsSnapshot = {};



//////////////////////////////////////////////////////
// FIVE-DAY OPERATIONAL AUDIT TRAIL
//////////////////////////////////////////////////////

const AUDIT_SEVERITIES = Object.freeze({ INFO: "info", WARNING: "warning", ACTION: "action" });

function getAuditUnitKey(unitId) {
  return sanitizeFirebaseKey(unitId || "unknown");
}

function normalizeAuditSeverity(value, eventType = "") {
  const severity = String(value || "").toLowerCase();
  if (Object.values(AUDIT_SEVERITIES).includes(severity)) return severity;
  if (/button|manual|logout|force|remove|disconnect_requested/.test(eventType)) return AUDIT_SEVERITIES.ACTION;
  if (/lost|offline|disconnected|failed|error|unexpected|no_fix/.test(eventType)) return AUDIT_SEVERITIES.WARNING;
  return AUDIT_SEVERITIES.INFO;
}

function getAuditSource(value) {
  const source = String(value || "system").toLowerCase();
  if (["user", "admin", "system", "automatic"].includes(source)) return source;
  return "system";
}

function normalizeAuditLocation(data) {
  if (!data || !isValidLatLon(Number(data.lat), Number(data.lon))) return null;
  return {
    lat: Number(data.lat),
    lon: Number(data.lon),
    gpsTime: Number(data.gpsTime || data.time || 0),
    gpsSource: data.gpsSource || "unknown"
  };
}

async function resolveAuditLocation(details = {}) {
  const explicit = normalizeAuditLocation(details.locationData);
  if (explicit) return explicit;

  const unitId = details.locationUnitId || currentUnitId;
  const liveFix = lastFixUnitId === unitId ? normalizeAuditLocation(lastFix) : null;
  if (liveFix) return liveFix;

  const rosterFix = normalizeAuditLocation((latestUnits || {})[unitId]);
  if (rosterFix) return rosterFix;

  if (!details.lookupStoredLocation || !firebaseConnected || !unitId) return null;
  try {
    const snapshot = await unitsRef.child(unitId).once("value");
    return normalizeAuditLocation(snapshot.val());
  } catch (_) {
    return null;
  }
}

function restorePendingAuditEvents() {
  try {
    const parsed = JSON.parse(localStorage.getItem("avl_pendingAuditEvents") || "[]");
    return Array.isArray(parsed) ? parsed.slice(-100) : [];
  } catch (_) {
    return [];
  }
}

function persistPendingAuditEvents() {
  try {
    localStorage.setItem("avl_pendingAuditEvents", JSON.stringify(pendingAuditEvents.slice(-100)));
  } catch (_) {}
}

function queuePendingAuditEvent(unitKey, eventKey, record) {
  if (!unitKey || !eventKey || !record) return;
  if (!pendingAuditEvents.some((item) => item.unitKey === unitKey && item.eventKey === eventKey)) {
    pendingAuditEvents.push({ unitKey, eventKey, record: { ...record, timestamp: null } });
    pendingAuditEvents = pendingAuditEvents.slice(-100);
    persistPendingAuditEvents();
  }
}

async function flushPendingAuditEvents() {
  if (!firebaseConnected || !pendingAuditEvents.length) return;
  const remaining = [];
  for (const item of pendingAuditEvents) {
    try {
      let record = item.record;
      if (record.locationRequested && (record.lastGpsLat === null || record.lastGpsLon === null)) {
        const recoveredLocation = await resolveAuditLocation({
          locationUnitId: record.unitId,
          lookupStoredLocation: true
        });
        if (recoveredLocation) {
          record = {
            ...record,
            lastGpsLat: recoveredLocation.lat,
            lastGpsLon: recoveredLocation.lon,
            lastGpsTimestamp: recoveredLocation.gpsTime || null,
            lastGpsSource: recoveredLocation.gpsSource || "unknown",
            secondsSinceLastFix: recoveredLocation.gpsTime
              ? Math.max(0, Math.round((Date.now() - recoveredLocation.gpsTime) / 1000))
              : null
          };
        }
      }
      await auditLogsRef.child(item.unitKey).child(item.eventKey).set({
        ...record,
        timestamp: firebase.database.ServerValue.TIMESTAMP,
        uploadedAfterReconnect: true
      });
    } catch (_) {
      remaining.push(item);
    }
  }
  pendingAuditEvents = remaining;
  persistPendingAuditEvents();
}

async function writeAuditEvent(eventType, description, details = {}) {
  if (!currentUnitId) return;

  const actorUnitId = currentUnitId;
  const recordUnitId = details.recordUnitId || actorUnitId;
  const unitKey = getAuditUnitKey(recordUnitId);
  const source = getAuditSource(details.source);
  const severity = normalizeAuditSeverity(details.severity, eventType);
  const location = details.includeLocation ? await resolveAuditLocation(details) : null;
  const record = {
    timestamp: firebase.database.ServerValue.TIMESTAMP,
    clientTime: Date.now(),
    unitId: recordUnitId,
    actorName: details.actorName || actorUnitId,
    actorType: source === "system" || source === "automatic" ? "SYSTEM" : (userRole === "admin" ? "ADMIN" : String(userMode || "USER").toUpperCase()),
    mode: userMode || "unknown",
    role: userRole || "user",
    severity,
    eventType,
    description,
    source,
    buttonLabel: details.buttonLabel || "",
    controlLocation: details.controlLocation || "",
    targetUnit: details.targetUnit || "",
    reason: details.reason || "",
    deviceId: clientInstallId,
    sessionId: clientSessionId,
    appVersion: APP_VERSION,
    browser: getBrowserLabel(),
    platform: getPlatformLabel(),
    publicIp: publicIpAddress || "Unknown",
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || "Unknown",
    gpsSource: location?.gpsSource || (lastFixUnitId === recordUnitId ? lastFix?.gpsSource : null) || "none",
    secondsSinceLastFix: location?.gpsTime
      ? Math.max(0, Math.round((Date.now() - location.gpsTime) / 1000))
      : (lastFixUnitId === recordUnitId && lastValidFixTime
        ? Math.max(0, Math.round((Date.now() - lastValidFixTime) / 1000))
        : null),
    lastGpsLat: location?.lat ?? null,
    lastGpsLon: location?.lon ?? null,
    lastGpsTimestamp: location?.gpsTime || null,
    lastGpsSource: location?.gpsSource || "none",
    locationRequested: !!details.includeLocation,
    serialConnected: !!serialPort,
    serialReceiver: currentSerialLabel,
    serialPortId: currentSerialPortId,
    serialBaud: currentSerialBaud || null,
    serialPhase: serialConnectionPhase,
    lastNmeaType: lastNmeaSentenceType,
    secondsSinceLastNmea: lastNmeaPacketTime ? Math.max(0, Math.round((Date.now() - lastNmeaPacketTime) / 1000)) : null,
    fixQuality: serialFixQuality,
    satellites: serialSatellites,
    hdop: serialHdop,
    networkOnline: navigator.onLine,
    firebaseConnected: firebaseConnected
  };

  const eventRef = auditLogsRef.child(unitKey).push();
  const eventKey = eventRef.key;

  if (!firebaseConnected) {
    queuePendingAuditEvent(unitKey, eventKey, record);
    return;
  }

  try {
    await eventRef.set(record);
  } catch (err) {
    console.warn("Audit write failed:", err);
    queuePendingAuditEvent(unitKey, eventKey, record);
  }
}

function formatAuditTime(timestamp) {
  if (!timestamp) return "Unknown time";
  return new Date(timestamp).toLocaleString();
}

function auditSeverityLabel(severity) {
  return severity === "action" ? "ACTION" : severity === "warning" ? "WARNING" : "INFO";
}

function getAuditMapUrl(lat, lon) {
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${lat},${lon}`)}`;
}

function renderAuditEntries(snapshot) {
  const list = document.getElementById("auditTrailList");
  if (!list) return;
  const rows = [];
  snapshot.forEach(unitSnap => {
    unitSnap.forEach(eventSnap => {
      const event = eventSnap.val();
      if (event) rows.push(event);
    });
  });
  rows.sort((a,b) => (b.timestamp || b.clientTime || 0) - (a.timestamp || a.clientTime || 0));
  const filtered = rows.filter(event => {
    const unitMatch = auditSelectedUnit === "all" || String(event.unitId) === auditSelectedUnit;
    const severityMatch = auditSelectedSeverity === "all" || normalizeAuditSeverity(event.severity, event.eventType) === auditSelectedSeverity;
    const sourceMatch = auditSelectedSource === "all" || getAuditSource(event.source) === auditSelectedSource;
    return unitMatch && severityMatch && sourceMatch;
  });

  list.innerHTML = filtered.length ? filtered.map(event => {
    const severity = normalizeAuditSeverity(event.severity, event.eventType);
    const hasLocation = typeof event.lastGpsLat === "number" && typeof event.lastGpsLon === "number" &&
      isValidLatLon(event.lastGpsLat, event.lastGpsLon);
    const locationHtml = hasLocation ? `
      <div class="audit-location">
        <strong>Last GPS:</strong> ${event.lastGpsLat.toFixed(6)}, ${event.lastGpsLon.toFixed(6)}
        ${event.lastGpsTimestamp ? ` · Fix ${escapeHtml(formatLastUpdateAge(event.lastGpsTimestamp))}` : ""}
        ${event.lastGpsSource && event.lastGpsSource !== "none" ? ` · ${escapeHtml(formatGpsSource(event.lastGpsSource))}` : ""}
        <a class="audit-map-link" href="${getAuditMapUrl(event.lastGpsLat, event.lastGpsLon)}" target="_blank" rel="noopener noreferrer">Open Last GPS in Google Maps ↗</a>
      </div>` : "";
    const details = [
      `${event.actorType || "SYSTEM"}: ${event.actorName || event.unitId || "Unknown"}`,
      event.buttonLabel ? `Button: ${event.buttonLabel}` : "",
      event.targetUnit ? `Target: ${event.targetUnit}` : "",
      `Source: ${event.source || "system"}`,
      `Device: ${event.deviceId || "legacy"}`,
      `Session: ${event.sessionId || "legacy"}`,
      `App: ${event.appVersion || "legacy"}`,
      event.browser ? `Browser: ${event.browser}` : "",
      event.platform ? `Platform: ${event.platform}` : "",
      event.publicIp ? `IP: ${event.publicIp}` : "",
      Number.isFinite(event.secondsSinceLastFix) ? `Last GPS fix: ${event.secondsSinceLastFix}s earlier` : "",
      event.serialReceiver ? `Receiver: ${event.serialReceiver}` : "",
      event.serialPortId ? `Port ID: ${event.serialPortId}` : "",
      event.serialBaud ? `Baud: ${event.serialBaud}` : "",
      event.lastNmeaType ? `NMEA: ${event.lastNmeaType}` : "",
      Number.isFinite(event.secondsSinceLastNmea) ? `Last packet: ${event.secondsSinceLastNmea}s earlier` : "",
      Number.isFinite(event.fixQuality) ? `Fix: ${formatFixQuality(event.fixQuality)}` : "",
      Number.isFinite(event.satellites) ? `Satellites: ${event.satellites}` : "",
      Number.isFinite(event.hdop) ? `HDOP: ${event.hdop}` : ""
    ].filter(Boolean).join(" · ");
    return `
      <div class="audit-row audit-${severity}">
        <div class="audit-head"><strong>${escapeHtml(event.unitId || "Unknown")}</strong><span>${escapeHtml(formatAuditTime(event.timestamp || event.clientTime))}</span></div>
        <div class="audit-badge audit-badge-${severity}">${auditSeverityLabel(severity)}</div>
        <div class="audit-description">${escapeHtml(event.description || event.eventType || "Event")}</div>
        <div class="audit-type">${escapeHtml(event.eventType || "event")}</div>
        <div class="audit-meta">${escapeHtml(details)}</div>
        ${locationHtml}
      </div>`;
  }).join("") : '<div class="audit-empty">No matching audit events found in the last five days.</div>';

  const select = document.getElementById("auditUnitFilter");
  if (select) {
    const units = [...new Set(rows.map(r => String(r.unitId || "Unknown")))].sort((a,b)=>a.localeCompare(b, undefined, {numeric:true}));
    const value = select.value || auditSelectedUnit;
    select.innerHTML = '<option value="all">All units / users</option>' + units.map(u => `<option value="${escapeHtml(u)}">${escapeHtml(u)}</option>`).join("");
    select.value = units.includes(value) || value === "all" ? value : "all";
  }
}

function loadAuditTrail() {
  if (userRole !== "admin") return;
  if (auditListenerRef) auditListenerRef.off();
  const cutoff = Date.now() - (AUDIT_RETENTION_DAYS * 24 * 60 * 60 * 1000);
  auditListenerRef = auditLogsRef;
  auditListenerRef.on("value", renderAuditEntries);
  cleanupOldAuditEvents(cutoff);
}

function stopAuditTrail() {
  if (auditListenerRef) auditListenerRef.off();
  auditListenerRef = null;
}

function filterAuditTrail() {
  auditSelectedUnit = document.getElementById("auditUnitFilter")?.value || "all";
  auditSelectedSeverity = document.getElementById("auditSeverityFilter")?.value || "all";
  auditSelectedSource = document.getElementById("auditSourceFilter")?.value || "all";
  loadAuditTrail();
}

async function cleanupOldAuditEvents(cutoff = Date.now() - (AUDIT_RETENTION_DAYS * 86400000)) {
  if (userRole !== "admin") return;
  try {
    const snap = await auditLogsRef.once("value");
    const removals = [];
    snap.forEach(unitSnap => unitSnap.forEach(eventSnap => {
      const e = eventSnap.val() || {};
      if ((e.timestamp || e.clientTime || 0) < cutoff) removals.push(eventSnap.ref.remove());
    }));
    await Promise.all(removals);
  } catch (err) {
    console.warn("Audit cleanup failed:", err);
  }
}

document.addEventListener("click", (event) => {
  const button = event.target.closest("button");
  if (!button || !currentUnitId) return;
  const label = (button.innerText || button.getAttribute("aria-label") || "Button").trim();
  const adminAction = userRole === "admin" && /remove|disconnect|force/i.test(label);
  writeAuditEvent("button_pressed", `Button pressed: ${label}`, {
    source: adminAction ? "admin" : "user",
    severity: "action",
    buttonLabel: label,
    controlLocation: button.closest("#developerPanel") ? "admin audit panel" : button.closest("#adminControls") ? "admin controls" : "main interface",
    targetUnit: selectedRosterUnitId || ""
  });
});

//////////////////////////////////////////////////////
// DISPATCH INACTIVITY TIMEOUT
//////////////////////////////////////////////////////

const DISPATCH_IDLE_MS = DISPATCH_IDLE_MINUTES * 60 * 1000;
const DISPATCH_WARNING_MS = DISPATCH_WARNING_MINUTES * 60 * 1000;

function playDispatchTone(kind = "warning") {
  if (!DISPATCH_SOUND_ENABLED) return;

  try {
    audioContext = audioContext || new (window.AudioContext || window.webkitAudioContext)();
    if (audioContext.state === "suspended") audioContext.resume();

    const now = audioContext.currentTime;
    const tones = kind === "logout"
      ? [[520, 0], [390, 0.18]]
      : [[740, 0], [920, 0.16]];

    tones.forEach(([frequency, delay]) => {
      const oscillator = audioContext.createOscillator();
      const gain = audioContext.createGain();
      oscillator.type = "sine";
      oscillator.frequency.value = frequency;
      gain.gain.setValueAtTime(0.0001, now + delay);
      gain.gain.exponentialRampToValueAtTime(0.16, now + delay + 0.015);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + delay + 0.13);
      oscillator.connect(gain);
      gain.connect(audioContext.destination);
      oscillator.start(now + delay);
      oscillator.stop(now + delay + 0.15);
    });
  } catch (err) {
    debugLog("Dispatch tone unavailable", err);
  }
}

function formatDispatchCountdown(milliseconds) {
  const totalSeconds = Math.max(0, Math.ceil(milliseconds / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

function hideDispatchIdleWarning() {
  const modal = document.getElementById("dispatchIdleModal");
  if (modal) modal.classList.add("mode-hidden");
  dispatchWarningVisible = false;
  dispatchWarningOneMinutePlayed = false;

  if (dispatchCountdownTimer) {
    clearInterval(dispatchCountdownTimer);
    dispatchCountdownTimer = null;
  }
}

function resetDispatchActivity() {
  if (userMode !== "dispatch" || !currentUnitId || dispatchWarningVisible) return;
  dispatchLastActivityTime = Date.now();
}

function stayLoggedInDispatch() {
  if (userMode !== "dispatch") return;
  dispatchLastActivityTime = Date.now();
  hideDispatchIdleWarning();
  publishPresence();
  setStatus("Dispatcher session extended", "good");
  addDiagnosticEvent("Dispatcher extended idle session");
}

function showDispatchIdleWarning() {
  if (userMode !== "dispatch" || dispatchWarningVisible) return;

  dispatchWarningVisible = true;
  dispatchWarningOneMinutePlayed = false;
  const modal = document.getElementById("dispatchIdleModal");
  if (modal) modal.classList.remove("mode-hidden");
  playDispatchTone("warning");
  addDiagnosticEvent("Dispatcher idle timeout warning displayed");

  const updateCountdown = async () => {
    if (userMode !== "dispatch" || !currentUnitId) {
      hideDispatchIdleWarning();
      return;
    }

    const logoutAt = dispatchLastActivityTime + DISPATCH_IDLE_MS;
    const remaining = logoutAt - Date.now();
    const display = document.getElementById("dispatchIdleCountdown");
    if (display) display.textContent = formatDispatchCountdown(remaining);

    if (remaining <= 60000 && !dispatchWarningOneMinutePlayed) {
      dispatchWarningOneMinutePlayed = true;
      playDispatchTone("warning");
    }

    if (remaining <= 0) {
      hideDispatchIdleWarning();
      playDispatchTone("logout");
      setStatus("Dispatcher session expired due to inactivity", "warn");
      addDiagnosticEvent("Dispatcher automatically logged out after inactivity");
      await logout();
    }
  };

  updateCountdown();
  dispatchCountdownTimer = setInterval(updateCountdown, 1000);
}

function startDispatchIdleMonitor() {
  stopDispatchIdleMonitor();
  if (userMode !== "dispatch" || !currentUnitId) return;

  dispatchLastActivityTime = Date.now();
  dispatchIdleTimer = setInterval(() => {
    if (userMode !== "dispatch" || !currentUnitId) return;
    const idleFor = Date.now() - dispatchLastActivityTime;
    if (idleFor >= DISPATCH_IDLE_MS - DISPATCH_WARNING_MS) showDispatchIdleWarning();
  }, 15000);
}

function stopDispatchIdleMonitor() {
  if (dispatchIdleTimer) {
    clearInterval(dispatchIdleTimer);
    dispatchIdleTimer = null;
  }
  hideDispatchIdleWarning();
}

["pointerdown", "keydown", "wheel", "touchstart"].forEach((eventName) => {
  window.addEventListener(eventName, resetDispatchActivity, { passive: true });
});

//////////////////////////////////////////////////////
// ADMIN DIAGNOSTICS
//////////////////////////////////////////////////////

function createClientSessionId() {
  const cryptoPart = (window.crypto && crypto.getRandomValues)
    ? Array.from(crypto.getRandomValues(new Uint8Array(4)))
        .map((value) => value.toString(16).padStart(2, "0"))
        .join("")
    : Math.random().toString(16).slice(2, 10);

  return cryptoPart.toUpperCase().match(/.{1,4}/g).join("-");
}

function createClientInstallId() {
  const cryptoPart = (window.crypto && crypto.getRandomValues)
    ? Array.from(crypto.getRandomValues(new Uint8Array(6)))
        .map((value) => value.toString(16).padStart(2, "0"))
        .join("")
    : `${Date.now().toString(16)}${Math.random().toString(16).slice(2, 8)}`;

  return `DEVICE-${cryptoPart.toUpperCase().match(/.{1,4}/g).join("-")}`;
}

function getScreenLabel() {
  return `${window.screen?.width || "?"}x${window.screen?.height || "?"}`;
}

function getTimeZoneLabel() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "Unknown";
  } catch (_) {
    return "Unknown";
  }
}

function getBrowserLabel() {
  const ua = navigator.userAgent || "";
  let match = ua.match(/Edg\/([\d.]+)/);
  if (match) return `Edge ${match[1]}`;
  match = ua.match(/Chrome\/([\d.]+)/);
  if (match) return `Chrome ${match[1]}`;
  match = ua.match(/Firefox\/([\d.]+)/);
  if (match) return `Firefox ${match[1]}`;
  match = ua.match(/Version\/([\d.]+).*Safari/);
  if (match) return `Safari ${match[1]}`;
  return "Unknown browser";
}

function getPlatformLabel() {
  const ua = navigator.userAgent || "";
  if (/Windows NT 10.0/.test(ua)) return "Windows 10/11";
  if (/iPhone/.test(ua)) return "iPhone";
  if (/iPad/.test(ua)) return "iPad";
  if (/Android/.test(ua)) return "Android";
  if (/Macintosh/.test(ua)) return "macOS";
  return navigator.platform || "Unknown platform";
}

function addDiagnosticEvent(message) {
  const stamp = new Date().toLocaleTimeString();
  localEventLog.unshift(`${stamp}  ${message}`);
  localEventLog = localEventLog.slice(0, 20);
  updateDeveloperInfo();
}

async function loadPublicIpAddress() {
  try {
    const response = await fetch("https://api.ipify.org?format=json", { cache: "no-store" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const result = await response.json();
    publicIpAddress = result.ip || "Unavailable";
    addDiagnosticEvent("Public IP detected");
    if (currentUnitId) publishPresence();
  } catch (err) {
    publicIpAddress = "Unavailable";
    console.warn("Public IP lookup failed:", err);
    addDiagnosticEvent("Public IP lookup unavailable");
  }
}

function getSessionDiagnostics(session) {
  if (!session) return "No live session diagnostics available.";

  const lastSeen = session.serverLastSeen || session.lastSeen || 0;
  const lastGps = session.lastGpsTime || 0;
  const lastUpload = session.lastUploadTime || 0;
  const heartbeatFresh = lastSeen && (Date.now() - lastSeen) <= SESSION_STALE_MS;
  const reportedFirebase = session.firebaseConnected === false ? "DISCONNECTED" : "CONNECTED";
  const effectiveFirebase = heartbeatFresh ? "CONNECTED — heartbeat confirmed" : reportedFirebase;

  return [
    `Device ID: ${session.deviceId || "Unknown / legacy client"}`,
    `Session ID: ${session.sessionId || "Unknown"}`,
    `Public IP: ${session.publicIp || "Unavailable"}`,
    `Browser: ${session.browser || "Unknown"}`,
    `Platform: ${session.platform || "Unknown"}`,
    `Version: ${session.appVersion || "Unknown / legacy client"}`,
    `Time zone: ${session.timeZone || "Unknown"}`,
    `Screen: ${session.screen || "Unknown"}`,
    `Language: ${session.language || "Unknown"}`,
    `Login time: ${session.loginTime ? new Date(session.loginTime).toLocaleString() : "Unknown"}`,
    `User agent: ${session.userAgent || "Unavailable"}`,
    `Browser network: ${session.networkOnline === false ? "OFFLINE" : "ONLINE"}`,
    `Firebase: ${effectiveFirebase}`,
    ...(heartbeatFresh && session.firebaseConnected === false
      ? [`Reported client state: DISCONNECTED (stale/contradictory)`]
      : []),
    `GPS source: ${formatGpsSource(session.gpsSource)}`,
    `Last GPS: ${lastGps ? formatLastUpdateAge(lastGps) : "No GPS fix"}`,
    `Last upload: ${lastUpload ? formatLastUpdateAge(lastUpload) : "No confirmed upload"}`,
    `Last heartbeat: ${lastSeen ? formatLastUpdateAge(lastSeen) : "Unknown"}`,
    `Serial: ${session.serialConnected ? "CONNECTED" : "DISCONNECTED"}`,
    `Receiver: ${session.serialReceiver || "Unknown / legacy client"}`,
    `Port ID: ${session.serialPortId || "Unknown / legacy client"}`,
    `Baud: ${session.serialBaud || "Unknown"}`,
    `Serial phase: ${session.serialPhase || "Unknown"}`,
    `Last NMEA: ${session.lastNmeaType || "Unknown"}`,
    `Last packet: ${session.lastNmeaTime ? formatLastUpdateAge(session.lastNmeaTime) : "No packet reported"}`,
    `Fix: ${session.fixQuality === null || session.fixQuality === undefined
      ? (lastGps ? "Valid position (quality not reported)" : "Not reported")
      : formatFixQuality(session.fixQuality)}`,
    `Satellites: ${session.satellites ?? "Unknown"}`,
    `HDOP: ${session.hdop ?? "Unknown"}`
  ].join("\n");
}

function getSelectedRosterSession() {
  if (!selectedRosterUnitId) return null;

  if ((selectedRosterMode || "Unit") === "Dispatch") {
    const direct = latestSessions[getSessionKey("dispatch", selectedRosterUnitId)];
    if (direct) return direct;
  } else {
    const direct = latestSessions[getSessionKey("unit", selectedRosterUnitId)];
    if (direct) return direct;
  }

  return Object.values(latestSessions || {}).find((session) =>
    session &&
    (session.displayName || session.id) === selectedRosterUnitId &&
    ((selectedRosterMode === "Dispatch" && session.mode === "dispatch") ||
     (selectedRosterMode !== "Dispatch" && session.mode !== "dispatch"))
  ) || null;
}

window.addEventListener("load", () => {
  addDiagnosticEvent("AVL application loaded");
  loadPublicIpAddress();
});

//////////////////////////////////////////////////////
// LOGIN / SESSION
//////////////////////////////////////////////////////



function updateLoginPlaceholder() {
  const loginInput = document.getElementById("loginUnitId");
  const loginMode = document.getElementById("loginMode");
  if (!loginInput || !loginMode) return;
  loginInput.placeholder = loginMode.value === "dispatch" ? "Dispatcher Name" : "Unit Number";
}

function setupLoginInputHelpers() {
  const loginInput = document.getElementById("loginUnitId");
  const sidebarInput = document.getElementById("unitId");
  const passwordInput = document.getElementById("loginPassword");

  if (loginInput && sidebarInput) {
    loginInput.addEventListener("input", () => {
      sidebarInput.value = loginInput.value;
    });

    loginInput.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        login();
      }
    });
  }

  if (passwordInput) {
    passwordInput.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        login();
      }
    });
  }
}

setupLoginInputHelpers();

function applyModeUi() {
  const gpsControls = document.getElementById("unitGpsControls");
  const unitIdInput = document.getElementById("unitId");

  if (gpsControls) gpsControls.classList.toggle("mode-hidden", userMode === "dispatch");
  if (unitIdInput) unitIdInput.placeholder = userMode === "dispatch" ? "Dispatcher Name" : "Unit Number";

  document.querySelectorAll(".admin-only").forEach((el) => {
    const shouldShow = userRole === "admin" && (el.id !== "developerPanel" || developerPanelVisible);
    el.classList.toggle("mode-hidden", !shouldShow);
  });

  if (userMode === "dispatch") {
    setFixDetails("Dispatch view only. GPS controls are hidden.");
  }
}

function startPresenceHeartbeat() {
  if (!currentUnitId) return;

  if (presenceTimer) {
    clearInterval(presenceTimer);
    presenceTimer = null;
  }

  publishPresence();
  presenceTimer = setInterval(publishPresence, HEARTBEAT_SECONDS * 1000);
}

function sanitizeFirebaseKey(value) {
  return String(value || "")
    .trim()
    .replace(/[.#$\[\]\/]/g, "_")
    .replace(/\s+/g, "_") || "unknown";
}

function getSessionKey(mode, id) {
  const prefix = mode === "dispatch" ? "dispatch" : "unit";
  return `${prefix}_${sanitizeFirebaseKey(id)}`;
}

function getImmediateAuditLocation(unitId = currentUnitId) {
  if (lastFixUnitId === unitId) {
    const live = normalizeAuditLocation(lastFix);
    if (live) return live;
  }
  return normalizeAuditLocation((latestUnits || {})[unitId]);
}

function armUnexpectedDisconnectAudit() {
  if (!currentUnitId || userMode === "dispatch") return;
  const unitKey = getAuditUnitKey(currentUnitId);
  const location = getImmediateAuditLocation(currentUnitId);
  if (disconnectAuditRef && (Date.now() - lastDisconnectAuditArmTime) < 5000 && (disconnectAuditHasLocation || !location)) return;
  if (!disconnectAuditRef) disconnectAuditRef = auditLogsRef.child(unitKey).push();
  const record = {
    timestamp: firebase.database.ServerValue.TIMESTAMP,
    clientTime: Date.now(),
    unitId: currentUnitId,
    actorName: currentUnitId,
    actorType: "SYSTEM",
    mode: userMode || "unit",
    role: userRole || "user",
    severity: "warning",
    eventType: "session_connection_ended_unexpectedly",
    description: "Unit session/Firebase connection ended unexpectedly",
    source: "system",
    reason: "Possible coverage loss, browser close, sleep, crash, or power loss",
    deviceId: clientInstallId,
    sessionId: clientSessionId,
    appVersion: APP_VERSION,
    browser: getBrowserLabel(),
    platform: getPlatformLabel(),
    publicIp: publicIpAddress || "Unknown",
    timeZone: getTimeZoneLabel(),
    gpsSource: location?.gpsSource || "none",
    lastGpsLat: location?.lat ?? null,
    lastGpsLon: location?.lon ?? null,
    lastGpsTimestamp: location?.gpsTime || null,
    lastGpsSource: location?.gpsSource || "none",
    // The server resolves timestamp when the disconnect actually occurs. Keep
    // the fix timestamp and let the admin UI calculate its age accurately.
    secondsSinceLastFix: null,
    serialConnected: !!serialPort,
    serialReceiver: currentSerialLabel,
    serialPortId: currentSerialPortId,
    serialBaud: currentSerialBaud || null,
    networkOnline: false,
    firebaseConnected: false
  };
  disconnectAuditRef.onDisconnect().set(record).catch((err) => {
    console.warn("Unable to arm unexpected-disconnect audit:", err);
  });
  lastDisconnectAuditArmTime = Date.now();
  disconnectAuditHasLocation = !!location;
}

async function cancelDisconnectCleanup(keyToCancel) {
  const tasks = [];
  if (keyToCancel) tasks.push(sessionsRef.child(keyToCancel).onDisconnect().cancel().catch(() => {}));
  if (disconnectAuditRef) tasks.push(disconnectAuditRef.onDisconnect().cancel().catch(() => {}));
  await Promise.all(tasks);
  disconnectAuditRef = null;
  lastDisconnectAuditArmTime = 0;
  disconnectAuditHasLocation = false;
}

function configureDisconnectCleanup() {
  if (!currentUnitId) return;

  currentSessionKey = currentSessionKey || getSessionKey(userMode, currentUnitId);

  // Remove only the live session when Firebase determines this client connection
  // has ended. The unit GPS record is deliberately left alone so a short rural
  // service interruption retains the last-known location. When connectivity
  // returns, publishPresence() recreates the session automatically.
  sessionsRef.child(currentSessionKey).onDisconnect().remove().catch((err) => {
    console.warn("Unable to register session disconnect cleanup:", err);
  });
  armUnexpectedDisconnectAudit();
}

function publishPresence() {
  if (!currentUnitId) return;

  // Enforce dispatcher-name validation on every heartbeat, not only at login.
  // This prevents an older saved/cached session such as "." from resurrecting itself.
  if (userMode === "dispatch" && !isValidDispatchName(currentUnitId)) {
    const invalidKey = currentSessionKey || getSessionKey("dispatch", currentUnitId);

    if (presenceTimer) {
      clearInterval(presenceTimer);
      presenceTimer = null;
    }

    sessionsRef.child(invalidKey).remove().catch(() => {});
    clearSavedLogin();

    currentUnitId = null;
    currentSessionKey = null;
    userMode = null;
    userRole = "user";

    const unitIdInput = document.getElementById("unitId");
    const loginIdInput = document.getElementById("loginUnitId");
    const loginScreen = document.getElementById("loginScreen");

    if (unitIdInput) unitIdInput.value = "";
    if (loginIdInput) loginIdInput.value = "";
    if (loginScreen) loginScreen.style.display = "flex";

    applyModeUi();
    setStatus("Invalid dispatcher name blocked. Please log in with a real name.", "warn");
    setFixDetails("Invalid dispatcher name blocked.");
    addDiagnosticEvent("Invalid dispatcher session blocked and cleared");
    return;
  }

  currentSessionKey = currentSessionKey || getSessionKey(userMode, currentUnitId);
  configureDisconnectCleanup();

  const presencePayload = {
    id: currentUnitId,
    displayName: currentUnitId,
    mode: userMode || "unit",
    loggedIn: true,
    lastSeen: Date.now(),
    serverLastSeen: firebase.database.ServerValue.TIMESTAMP,
    loginTime: sessionLoginTime || Date.now(),
    deviceId: clientInstallId,
    sessionId: clientSessionId,
    publicIp: publicIpAddress,
    browser: getBrowserLabel(),
    platform: getPlatformLabel(),
    appVersion: APP_VERSION,
    buildDate: BUILD_DATE,
    timeZone: getTimeZoneLabel(),
    screen: getScreenLabel(),
    language: navigator.language || "Unknown",
    userAgent: navigator.userAgent || "Unavailable",
    networkOnline: navigator.onLine,
    // A completed write proves this client can reach Firebase. Publishing true
    // prevents a stale pre-outage false value from surviving after recovery.
    firebaseConnected: true,
    gpsSource: lastFix?.gpsSource || "none",
    lastGpsTime: lastFix?.gpsTime || 0,
    lastUploadTime: lastSuccessfulWriteTime || 0,
    serialConnected: !!serialPort && serialKeepReading,
    serialReceiver: currentSerialLabel,
    serialPortId: currentSerialPortId,
    serialBaud: currentSerialBaud || 0,
    serialPhase: serialConnectionPhase,
    lastNmeaType: lastNmeaSentenceType,
    lastNmeaTime: lastNmeaPacketTime || 0,
    fixQuality: serialFixQuality,
    satellites: serialSatellites,
    hdop: serialHdop
  };

  sessionsRef.child(currentSessionKey).set(presencePayload).then(() => {
    // Heartbeat success is a stronger signal than an old client-side flag.
    const recoveredByWrite = !firebaseConnected;
    firebaseConnected = true;
    setNetworkStatus("ONLINE — HEARTBEAT CONFIRMED", "good");
    if (recoveredByWrite) {
      addDiagnosticEvent("Firebase write confirmed recovery");
      writeAuditEvent("firebase_write_recovered", "Firebase recovery confirmed by successful heartbeat write", {
        source: "automatic",
        severity: "info",
        includeLocation: true,
        lookupStoredLocation: true
      });
      flushPendingAuditEvents();
    }
    updateDeveloperInfo();
  }).catch((err) => {
    console.error("Presence write failed:", err);
    firebaseConnected = false;
    setStatus("Presence update failed: " + err.message, "bad");
    updateDeveloperInfo();
  });
}

function removeCurrentSessionNow() {
  if (!currentUnitId) return;

  const keyToRemove = currentSessionKey || getSessionKey(userMode, currentUnitId);
  sessionsRef.child(keyToRemove).remove().catch(() => {});

  if (userMode !== "dispatch") {
    unitsRef.child(currentUnitId).remove().catch(() => {});
  }
}

async function stopPresence(remove = true) {
  if (presenceTimer) {
    clearInterval(presenceTimer);
    presenceTimer = null;
  }

  const keyToRemove = currentSessionKey || (currentUnitId ? getSessionKey(userMode, currentUnitId) : null);

  // Normal logout/logoff has its own explicit audit event. Cancel the armed
  // unexpected-disconnect record so the same action is not logged twice later.
  await cancelDisconnectCleanup(keyToRemove);

  if (remove && keyToRemove) {
    await sessionsRef.child(keyToRemove).remove().catch(() => {});
  }

  currentSessionKey = null;
}

function stopWatchingOwnDispatchSession() {
  if (ownDispatchSessionRef) {
    ownDispatchSessionRef.off();
    ownDispatchSessionRef = null;
  }

  ownDispatchSessionEstablished = false;
}

function clearSavedLogin() {
  localStorage.removeItem("avl_unitId");
  localStorage.removeItem("avl_mode");
  localStorage.removeItem("avl_role");
  localStorage.removeItem("avl_temp_access");
  localStorage.removeItem("avl_sessionLoginTime");
}

function forceBackToLogin(message) {
  if (adminBootInProgress) return;
  adminBootInProgress = true;

  if (presenceTimer) {
    clearInterval(presenceTimer);
    presenceTimer = null;
  }

  stopWatchingOwnDispatchSession();
  clearSavedLogin();

  currentUnitId = null;
  currentSessionKey = null;
  userMode = null;
  userRole = "user";
  selectedRosterUnitId = null;
  selectedRosterMode = null;

  const unitIdInput = document.getElementById("unitId");
  const loginIdInput = document.getElementById("loginUnitId");
  const loginScreen = document.getElementById("loginScreen");

  if (unitIdInput) unitIdInput.value = "";
  if (loginIdInput) loginIdInput.value = "";
  if (loginScreen) loginScreen.style.display = "flex";

  applyModeUi();
  setStatus(message || "Disconnected by an administrator", "warn");
  setFixDetails(message || "You were disconnected by an administrator.");

  alert(message || "You were disconnected by an administrator.");
  adminBootInProgress = false;
}

function watchOwnDispatchSession() {
  stopWatchingOwnDispatchSession();

  if (!currentSessionKey || userMode !== "dispatch") return;

  ownDispatchSessionRef = sessionsRef.child(currentSessionKey);
  ownDispatchSessionEstablished = false;

  ownDispatchSessionRef.on("value", (snapshot) => {
    if (snapshot.exists()) {
      ownDispatchSessionEstablished = true;
      return;
    }

    // Ignore the initial gap before the first presence write reaches Firebase.
    if (!ownDispatchSessionEstablished || !currentUnitId || userMode !== "dispatch") return;

    forceBackToLogin("You were disconnected by an administrator.");
  });
}

function restoreLogin() {
  const savedId = localStorage.getItem("avl_unitId");
  const savedMode = localStorage.getItem("avl_mode");
  const savedAccess = localStorage.getItem("avl_temp_access");
  const savedRole = localStorage.getItem("avl_role");

  if (!savedId || savedAccess !== "granted") return;

  const restoredMode = savedMode || "unit";
  if (restoredMode === "dispatch" && !isValidDispatchName(savedId)) {
    clearSavedLogin();
    const loginScreen = document.getElementById("loginScreen");
    if (loginScreen) loginScreen.style.display = "flex";
    setStatus("Saved dispatcher name rejected. Please log in with a real name.", "warn");
    return;
  }

  currentUnitId = savedId;
  userMode = restoredMode;
  userRole = savedRole === "admin" ? "admin" : "user";
  currentSessionKey = getSessionKey(userMode, currentUnitId);
  sessionLoginTime = parseInt(localStorage.getItem("avl_sessionLoginTime"), 10) || Date.now();
  localStorage.setItem("avl_sessionLoginTime", String(sessionLoginTime));

  document.getElementById("unitId").value = savedId;
  document.getElementById("loginScreen").style.display = "none";

  applyModeUi();
  startPresenceHeartbeat();
  watchOwnDispatchSession();
  startDispatchIdleMonitor();
  setStatus(`Session restored for ${savedId}`, "good");
  addDiagnosticEvent(`Session restored: ${savedId} (${userMode})`);
  writeAuditEvent("session_restored", `Session restored for ${savedId} (${userMode})`, {
    source: "automatic",
    severity: "info",
    includeLocation: userMode !== "dispatch",
    lookupStoredLocation: true
  });
}

function getTypedLoginId() {
  const loginInput = document.getElementById("loginUnitId");
  const sidebarInput = document.getElementById("unitId");

  const loginValue = loginInput ? loginInput.value.trim() : "";
  const sidebarValue = sidebarInput ? sidebarInput.value.trim() : "";

  // Primary source is the login screen box. Sidebar fallback prevents a false
  // "Enter Unit ID" if a browser autofill or older cached page put the value
  // into the main Unit ID box instead.
  return loginValue || sidebarValue;
}

function isValidDispatchName(name) {
  // Real-name style only: letters with optional spaces, apostrophes, or hyphens.
  // Examples: Rickey, Mary Ann, O'Neil, Smith-Jones.
  return /^[A-Za-z]+(?:[ '\-][A-Za-z]+)*$/.test(name) && name.length >= 2;
}

function validateLoginId(mode, id) {
  if (mode !== "dispatch") return true;

  if (!isValidDispatchName(id)) {
    alert("Enter a real dispatcher name using letters only. Spaces, apostrophes, and hyphens are allowed.");
    return false;
  }

  return true;
}

function login() {
  const modeEl = document.getElementById("loginMode");
  const passwordEl = document.getElementById("loginPassword");
  const mode = modeEl ? modeEl.value : "unit";
  const id = getTypedLoginId();
  const password = passwordEl ? passwordEl.value : "";

  if (!id) return alert(mode === "dispatch" ? "Enter dispatcher name" : "Enter Unit ID");
  if (!validateLoginId(mode, id)) return;

  if (password === ADMIN_PASSWORD) {
    userRole = "admin";
  } else if (password === USER_PASSWORD) {
    userRole = "user";
  } else {
    if (passwordEl) passwordEl.value = "";
    alert("Incorrect AVL password");
    return;
  }

  currentUnitId = id;
  userMode = mode;
  currentSessionKey = getSessionKey(userMode, currentUnitId);
  sessionLoginTime = Date.now();

  localStorage.setItem("avl_unitId", id);
  localStorage.setItem("avl_mode", mode);
  localStorage.setItem("avl_role", userRole);
  localStorage.setItem("avl_temp_access", "granted");
  localStorage.setItem("avl_sessionLoginTime", String(sessionLoginTime));

  document.getElementById("unitId").value = id;
  document.getElementById("loginScreen").style.display = "none";
  if (passwordEl) passwordEl.value = "";

  applyModeUi();
  startPresenceHeartbeat();
  watchOwnDispatchSession();
  startDispatchIdleMonitor();
  setStatus(`Logged in as ${id} (${mode}${userRole === "admin" ? ", admin" : ""})`, "good");
  addDiagnosticEvent(`Login: ${id} (${mode}${userRole === "admin" ? ", admin" : ""})`);
  writeAuditEvent("login", `Logged in as ${id} (${mode}${userRole === "admin" ? ", admin" : ""})`, {
    source: "user",
    severity: "info",
    includeLocation: mode !== "dispatch",
    lookupStoredLocation: true
  });
}

async function logout() {
  await writeAuditEvent("logout", "Logout requested", {
    source: "user",
    severity: "action",
    includeLocation: userMode !== "dispatch",
    lookupStoredLocation: true
  });
  stopAuditTrail();
  stopDispatchIdleMonitor();
  stopWatchingOwnDispatchSession();

  if (browserWatchId !== null) {
    navigator.geolocation.clearWatch(browserWatchId);
    browserWatchId = null;
  }

  await disconnectSerialGPS();
  await stopPresence(true);

  if (currentUnitId && userMode !== "dispatch") {
    await unitsRef.child(currentUnitId).remove();
  }

  if (currentUnitId && markers[currentUnitId]) {
    map.removeLayer(markers[currentUnitId]);
    delete markers[currentUnitId];
  }

  currentUnitId = null;
  currentSessionKey = null;
  userMode = null;
  userRole = "user";
  selectedRosterUnitId = null;
  selectedRosterMode = null;

  localStorage.removeItem("avl_unitId");
  localStorage.removeItem("avl_mode");
  localStorage.removeItem("avl_sessionLoginTime");
  localStorage.removeItem("avl_role");
  localStorage.removeItem("avl_temp_access");

  document.getElementById("unitId").value = "";
  document.getElementById("loginScreen").style.display = "flex";
  applyModeUi();

  setStatus("Logged out", "warn");
  addDiagnosticEvent("Logout completed");
}

updateLoginPlaceholder();
restoreLogin();
//////////////////////////////////////////////////////
// WAKE LOCK / BACKGROUND SAFEGUARDS
//////////////////////////////////////////////////////

async function enableWakeLock() {
  if (!("wakeLock" in navigator)) {
    console.log("Wake Lock not supported in this browser");
    return;
  }

  try {
    wakeLock = await navigator.wakeLock.request("screen");
    console.log("Wake Lock active");
  } catch (err) {
    console.log("Wake Lock failed:", err.message);
  }
}

enableWakeLock();

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") {
    enableWakeLock();

    setTimeout(() => {
      map.invalidateSize();
    }, 300);
  }
});

// Do not remove the Firebase session from pagehide/beforeunload.
// Mobile browsers can fire pagehide when the tab or browser is merely
// backgrounded, which made named dispatchers disappear from the roster.
// Explicit Logout / Log Off handles immediate removal. Otherwise the
// heartbeat naturally becomes stale if the page is truly closed.


//////////////////////////////////////////////////////
// NETWORK / FIREBASE RECONNECTION
//////////////////////////////////////////////////////

restorePendingFix();

connectedRef.on("value", async (snap) => {
  const nextConnectedState = snap.val() === true;
  if (!nextConnectedState && infoConnectedState === true) unexpectedDisconnectObserved = true;
  if (nextConnectedState && unexpectedDisconnectObserved) {
    // The previous onDisconnect record has executed. Use a fresh audit key for
    // the next connection lifecycle.
    disconnectAuditRef = null;
    lastDisconnectAuditArmTime = 0;
    disconnectAuditHasLocation = false;
    unexpectedDisconnectObserved = false;
  }
  infoConnectedState = nextConnectedState;
  firebaseConnected = nextConnectedState;
  lastFirebaseConnectionChange = Date.now();

  if (firebaseConnected) {
    setNetworkStatus("ONLINE", "good");
    addDiagnosticEvent("Firebase connected");
    writeAuditEvent("firebase_connected", "Firebase connection restored", {
      source: "system",
      severity: "info",
      includeLocation: true,
      lookupStoredLocation: true
    });
    if (currentUnitId) publishPresence();
    await flushPendingAuditEvents();
    if (lastPendingFix) {
      await flushPendingFix();
    } else if (currentUnitId && lastFix) {
      // Reassert the latest known fix once after a cellular outage. The GPS
      // timestamp is preserved, so this does not pretend an old fix is new.
      await publishUnitData(currentUnitId, lastFix);
    }
  } else {
    setNetworkStatus("FIREBASE DISCONNECTED — GPS WILL KEEP RUNNING", "warn");
    addDiagnosticEvent("Firebase disconnected");
    writeAuditEvent("firebase_disconnected", "Firebase connection lost", { source: "system", severity: "warning" });
  }

  updateDeveloperInfo();
});

window.addEventListener("offline", () => {
  setNetworkStatus("INTERNET LOST — SAVING LATEST FIX", "warn");
  addDiagnosticEvent("Browser network offline");
  writeAuditEvent("network_offline", "Browser reported internet connection lost", { source: "system", severity: "warning" });
  updateDeveloperInfo();
});

window.addEventListener("online", async () => {
  setNetworkStatus("RECONNECTING...", "warn");
  try { db.goOnline(); } catch (_) {}
  addDiagnosticEvent("Browser network restored");
  writeAuditEvent("network_online", "Browser reported internet connection restored", {
    source: "system",
    severity: "info",
    includeLocation: userMode !== "dispatch",
    lookupStoredLocation: true
  });
  if (currentUnitId) publishPresence();
  await flushPendingFix();
  updateDeveloperInfo();
});

setInterval(() => {
  updateDeveloperInfo();
  renderReceiverHealth();
  if (firebaseConnected && lastPendingFix) flushPendingFix();
}, 10000);

async function attemptFirebaseRecovery() {
  if (!navigator.onLine || firebaseConnected) return;
  if ((Date.now() - lastFirebaseRecoveryAttempt) < FIREBASE_RECOVERY_MS) return;
  lastFirebaseRecoveryAttempt = Date.now();
  addDiagnosticEvent("Firebase recovery watchdog retrying connection");
  setNetworkStatus("RECONNECTING TO FIREBASE...", "warn");
  try { db.goOnline(); } catch (_) {}
  if (currentUnitId) publishPresence();
}

setInterval(attemptFirebaseRecovery, FIREBASE_RECOVERY_MS);

//////////////////////////////////////////////////////
// SERIAL STATE
//////////////////////////////////////////////////////


//////////////////////////////////////////////////////
// BROWSER SUPPORT CHECK
//////////////////////////////////////////////////////

if (!("serial" in navigator)) {
  setStatus("Web Serial not supported. Use Chrome or Edge.", "bad");
}

//////////////////////////////////////////////////////
// STATUS HELPERS
//////////////////////////////////////////////////////

function setStatus(message, className = "") {
  const el = document.getElementById("gpsStatus");
  el.className = className;
  el.innerText = message;
}

function setFixDetails(message) {
  document.getElementById("fixDetails").innerText = message;
}

function setRawNmea(sentence) {
  document.getElementById("rawNmea").innerText = sentence;
}

function setNetworkStatus(label, className = "") {
  const el = document.getElementById("networkStatus");
  if (!el) return;
  el.className = `network-banner ${className}`.trim();
  el.innerText = `NETWORK: ${label}`;
}

function formatFixQuality(value) {
  if (value === null || value === undefined || value === "") {
    return lastFix ? "Valid position (quality not reported)" : "Waiting for fix";
  }
  const quality = Number(value);
  const labels = {
    0: "No fix",
    1: "GPS fix",
    2: "DGPS fix",
    3: "PPS fix",
    4: "RTK fixed",
    5: "RTK float",
    6: "Estimated",
    7: "Manual",
    8: "Simulation"
  };
  return Number.isFinite(quality) && labels[quality]
    ? `${labels[quality]} (${quality})`
    : (lastFix ? "Valid position" : "Waiting for fix");
}

function formatPacketAge(timestamp) {
  if (!timestamp) return "No packet received";
  const ageMs = Math.max(0, Date.now() - timestamp);
  if (ageMs < 10000) return `${(ageMs / 1000).toFixed(1)} sec ago`;
  return formatLastUpdateAge(timestamp);
}

function renderReceiverHealth() {
  const panel = document.getElementById("receiverHealth");
  const details = document.getElementById("receiverHealthDetails");
  if (!panel || !details) return;

  const packetFresh = !!lastNmeaPacketTime && (Date.now() - lastNmeaPacketTime) <= SERIAL_STALL_MS;
  const connected = !!serialPort && serialKeepReading;
  const healthClass = connected && packetFresh ? "good" : connected || serialAutoMode ? "warn" : "bad";
  panel.className = `receiver-health ${healthClass}`;

  details.innerText = [
    `Status: ${serialConnectionPhase}`,
    `Receiver: ${currentSerialLabel}`,
    `Port ID: ${currentSerialPortId}`,
    `Baud: ${currentSerialBaud || "Not detected"}`,
    `Stream: ${packetFresh ? "Receiving" : connected ? "Waiting for NMEA" : "Not receiving"}`,
    `Last sentence: ${lastNmeaSentenceType}`,
    `Last packet: ${formatPacketAge(lastNmeaPacketTime)}`,
    `Fix: ${formatFixQuality(serialFixQuality)}`,
    `Satellites: ${serialSatellites ?? "Waiting"}`,
    `HDOP: ${serialHdop ?? "Waiting"}`,
    `Publishing: ${firebaseConnected ? "Firebase connected" : lastPendingFix ? "Queued for reconnect" : "Firebase disconnected"}`
  ].join("\n");
}

async function copyDiagnostics() {
  if (userRole !== "admin") return alert("Admin access required");
  updateDeveloperInfo();
  const text = document.getElementById("developerInfo")?.innerText || "Diagnostics unavailable";
  try {
    await navigator.clipboard.writeText(`=== GCSO AVL Diagnostics ===\n${text}`);
    addDiagnosticEvent("Diagnostics copied to clipboard");
    setStatus("Diagnostics copied to clipboard", "good");
  } catch (err) {
    alert("Unable to copy diagnostics automatically. Select the text in the developer panel and copy it manually.");
  }
}

function savePendingFix(id, data) {
  lastPendingUnitId = id;
  lastPendingFix = data;
  try {
    localStorage.setItem("avl_pendingUnitId", id);
    localStorage.setItem("avl_pendingFix", JSON.stringify(data));
  } catch (_) {}
}

function clearPendingFix(data) {
  if (!lastPendingFix || !data || lastPendingFix.gpsTime !== data.gpsTime) return;
  lastPendingFix = null;
  lastPendingUnitId = null;
  localStorage.removeItem("avl_pendingUnitId");
  localStorage.removeItem("avl_pendingFix");
}

function restorePendingFix() {
  try {
    const id = localStorage.getItem("avl_pendingUnitId");
    const raw = localStorage.getItem("avl_pendingFix");
    if (!id || !raw) return;
    const data = JSON.parse(raw);
    if (data && isValidLatLon(data.lat, data.lon)) {
      lastPendingUnitId = id;
      lastPendingFix = data;
    }
  } catch (_) {}
}

async function publishUnitData(id, data) {
  if (!id || !data) return false;
  savePendingFix(id, data);

  try {
    await unitsRef.child(id).set(data);
    lastSuccessfulWriteTime = Date.now();
    clearPendingFix(data);
    updateDeveloperInfo();
    return true;
  } catch (err) {
    console.error("Firebase unit write failed:", err);
    setNetworkStatus("OFFLINE — SAVING LATEST FIX", "warn");
    updateDeveloperInfo();
    return false;
  }
}

async function flushPendingFix() {
  if (!firebaseConnected || !lastPendingFix || !lastPendingUnitId) return;
  await publishUnitData(lastPendingUnitId, lastPendingFix);
}

function toggleDeveloperPanel() {
  if (userRole !== "admin") return alert("Admin access required");
  developerPanelVisible = !developerPanelVisible;
  applyModeUi();
  updateDeveloperInfo();
  if (developerPanelVisible) loadAuditTrail(); else stopAuditTrail();
}

function updateDeveloperInfo() {
  const el = document.getElementById("developerInfo");
  if (!el) return;

  const lastGps = lastFix && lastFix.gpsTime
    ? `${formatLastUpdateAge(lastFix.gpsTime)} (${formatGpsSource(lastFix.gpsSource)})`
    : "No GPS fix yet";
  const lastWrite = lastSuccessfulWriteTime
    ? formatLastUpdateAge(lastSuccessfulWriteTime)
    : "No confirmed write yet";

  const selectedSession = getSelectedRosterSession();
  const selectedTitle = selectedRosterUnitId
    ? `${selectedRosterMode || "Unit"} ${selectedRosterUnitId}`
    : "None";

  const localDiagnostics = [
    "THIS DEVICE",
    `Version: ${APP_VERSION} (${BUILD_DATE})`,
    `User: ${currentUnitId || "Not logged in"}`,
    `Role: ${userRole}`,
    `Mode: ${userMode || "not logged in"}`,
    `Device ID: ${clientInstallId}`,
    `Session ID: ${clientSessionId}`,
    `Public IP: ${publicIpAddress}`,
    `Browser: ${getBrowserLabel()}`,
    `Platform: ${getPlatformLabel()}`,
    `Firebase: ${firebaseConnected ? "CONNECTED" : "DISCONNECTED"}`,
    `Browser network: ${navigator.onLine ? "ONLINE" : "OFFLINE"}`,
    `Last GPS: ${lastGps}`,
    `Last Firebase write: ${lastWrite}`,
    `Pending fix: ${lastPendingFix ? "YES" : "NO"}`,
    `Pending audit events: ${pendingAuditEvents.length}`,
    `Serial: ${serialPort ? `CONNECTED @ ${currentSerialBaud || "?"}` : "DISCONNECTED"}`,
    `Receiver: ${currentSerialLabel}`,
    `Port ID: ${currentSerialPortId}`,
    `Serial phase: ${serialConnectionPhase}`,
    `Last NMEA: ${lastNmeaSentenceType}`,
    `Last packet: ${formatPacketAge(lastNmeaPacketTime)}`,
    `Fix: ${formatFixQuality(serialFixQuality)}`,
    `Satellites: ${serialSatellites ?? "Unknown"}`,
    `HDOP: ${serialHdop ?? "Unknown"}`,
    `Wake lock: ${wakeLock ? "ACTIVE" : "INACTIVE"}`,
    "",
    `SELECTED: ${selectedTitle}`,
    getSessionDiagnostics(selectedSession),
    "",
    "LOCAL EVENT LOG (CLEARS ON REFRESH)",
    ...(localEventLog.length ? localEventLog : ["No events yet"])
  ];

  el.innerText = localDiagnostics.join("\n");
}

function getSerialPortLabel(port) {
  const info = port && port.getInfo ? port.getInfo() : {};

  if (info.usbVendorId || info.usbProductId) {
    const vid = info.usbVendorId ? info.usbVendorId.toString(16).toUpperCase().padStart(4, "0") : "????";
    const pid = info.usbProductId ? info.usbProductId.toString(16).toUpperCase().padStart(4, "0") : "????";
    if (vid === "067B") return `Prolific PL2303 GPS (USB ${vid}:${pid})`;
    return `USB GPS VID:${vid} PID:${pid}`;
  }

  return "External USB GPS";
}

function getSerialPortId(port) {
  const info = port && port.getInfo ? port.getInfo() : {};
  if (info.usbVendorId || info.usbProductId) {
    const vid = info.usbVendorId ? info.usbVendorId.toString(16).toUpperCase().padStart(4, "0") : "????";
    const pid = info.usbProductId ? info.usbProductId.toString(16).toUpperCase().padStart(4, "0") : "????";
    return `USB ${vid}:${pid} (Chrome does not expose Windows COM number)`;
  }
  return "Browser-authorized serial port (COM number unavailable)";
}

function getSerialPortSignature(port) {
  const info = port && port.getInfo ? port.getInfo() : {};
  return `${info.usbVendorId || "unknown"}:${info.usbProductId || "unknown"}`;
}

function getBaudCandidates() {
  const selected = parseInt(document.getElementById("baudRate").value, 10) || 9600;
  localStorage.setItem("avl_lastBaudRate", String(selected));
  return [selected, ...SERIAL_BAUD_RATES].filter((v, i, arr) => arr.indexOf(v) === i);
}

function looksLikeNMEA(sentence) {
  return (
    sentence.startsWith("$GPRMC") || sentence.startsWith("$GNRMC") ||
    sentence.startsWith("$GARMC") || sentence.startsWith("$GLRMC") ||
    sentence.startsWith("$GPGGA") || sentence.startsWith("$GNGGA") ||
    sentence.startsWith("$GAGGA") || sentence.startsWith("$GLGGA")
  );
}

function scheduleSerialRescan(reason = "GPS disconnected") {
  if (!serialAutoMode) return;
  if (serialReconnectTimer) return;

  serialConnectionPhase = `${reason} — retrying in ${GPS_RESCAN_MS / 1000} sec`;
  setStatus(`${reason}. Auto-detect will retry...`, "warn");
  renderReceiverHealth();

  serialReconnectTimer = setTimeout(async () => {
    serialReconnectTimer = null;
    if (serialAutoMode) await connectSerialGPS(true);
  }, GPS_RESCAN_MS);
}

//////////////////////////////////////////////////////
// GRANT SERIAL GPS PERMISSION
//////////////////////////////////////////////////////

async function grantSerialGPSPermission() {
  if (!("serial" in navigator)) {
    alert("Web Serial is not supported in this browser. Use Chrome or Edge.");
    return;
  }

  try {
    serialConnectionPhase = "Waiting for receiver permission";
    renderReceiverHealth();
    setStatus("Choose the external GPS receiver one time. After that, Auto Detect can reuse it.", "warn");
    await navigator.serial.requestPort();
    writeAuditEvent("serial_permission_granted", "Serial GPS permission granted", { source: "user", severity: "action" });
    setStatus("GPS receiver permission saved. Press Auto Detect External GPS.", "good");
  } catch (err) {
    setStatus("GPS permission was not granted: " + err.message, "bad");
  }
}

//////////////////////////////////////////////////////
// AUTO-DETECT EXTERNAL GPS
//////////////////////////////////////////////////////

async function connectSerialGPS(isRetry = false) {
  if (userMode === "dispatch") return alert("Dispatch view is view-only. GPS controls are disabled.");
  const id = document.getElementById("unitId").value.trim();
  if (!id) return alert("Enter Unit ID first");

  if (!("serial" in navigator)) {
    alert("Web Serial is not supported in this browser. Use Chrome or Edge.");
    return;
  }

  currentUnitId = id;
  localStorage.setItem("avl_unitId", id);
  localStorage.setItem("avl_mode", userMode || "unit");

  serialAutoMode = true;
  if (!isRetry) {
    pendingManualGpsStart = {
      requestedAt: Date.now(),
      buttonLabel: "Auto Detect External GPS"
    };
  }

  try {
    serialConnectionPhase = "Releasing previous serial connection";
    renderReceiverHealth();
    await disconnectSerialGPS(false);

    let ports = await navigator.serial.getPorts();

    // Browser security requires at least one manual grant before a web page can reuse a USB serial device.
    // If no receiver has been granted yet, ask once, then future starts should be automatic.
    if (!ports.length && !isRetry) {
      setStatus("No authorized GPS receiver found. Choose the external GPS once.", "warn");
      const firstPort = await navigator.serial.requestPort();
      ports = [firstPort];
    }

    if (!ports.length) {
      scheduleSerialRescan("No authorized external GPS found");
      return;
    }

    const lastSignature = localStorage.getItem("avl_lastGpsSignature");
    ports.sort((a, b) => {
      const aMatch = getSerialPortSignature(a) === lastSignature ? -1 : 0;
      const bMatch = getSerialPortSignature(b) === lastSignature ? -1 : 0;
      return aMatch - bMatch;
    });

    serialConnectionPhase = `Scanning ${ports.length} authorized serial device(s)`;
    setStatus(`Auto-detect scanning ${ports.length} serial device(s)...`, "warn");
    renderReceiverHealth();

    const found = await findNmeaGpsPort(ports);

    if (!found) {
      scheduleSerialRescan("No valid NMEA GPS stream found");
      return;
    }

    serialPort = found.port;
    currentSerialBaud = found.baudRate;
    currentSerialLabel = getSerialPortLabel(serialPort);
    currentSerialPortId = getSerialPortId(serialPort);
    localStorage.setItem("avl_lastGpsSignature", getSerialPortSignature(serialPort));
    localStorage.setItem("avl_lastBaudRate", String(currentSerialBaud));
    const baudSelect = document.getElementById("baudRate");
    if (baudSelect) baudSelect.value = String(currentSerialBaud);

    serialConnectionPhase = `Opening receiver at ${currentSerialBaud} baud`;
    renderReceiverHealth();
    await serialPort.open({
      baudRate: currentSerialBaud,
      dataBits: 8,
      stopBits: 1,
      parity: "none",
      flowControl: "none"
    });

    serialKeepReading = true;
    serialFixLoggedForConnection = false;
    serialOpenedTime = Date.now();
    lastNmeaPacketTime = 0;
    serialConnectionPhase = "Serial port open — waiting for NMEA";
    setStatus(`External GPS locked: ${currentSerialLabel} @ ${currentSerialBaud} baud`, "good");
    addDiagnosticEvent(`External GPS connected @ ${currentSerialBaud} baud`);
    writeAuditEvent("serial_connected", `External GPS connected at ${currentSerialBaud} baud`, {
      source: isRetry ? "automatic" : "user",
      severity: "info",
      includeLocation: true,
      lookupStoredLocation: true
    });
    setFixDetails(
      `GPS Source: External USB GPS\n` +
      `Device: ${currentSerialLabel}\n` +
      `Baud: ${currentSerialBaud}\n` +
      `Fix: waiting for valid RMC or GGA...`
    );
    renderReceiverHealth();

    readSerialLoop();

  } catch (err) {
    console.error(err);
    const busy = /busy|open|access|networkerror/i.test(String(err?.message || err));
    serialConnectionPhase = busy
      ? "Receiver busy or not fully released by another application"
      : `Connection error: ${err.message}`;
    setStatus("External GPS auto-detect failed: " + err.message, "bad");
    renderReceiverHealth();
    writeAuditEvent("serial_connect_failed", `External GPS connection failed: ${err.message}`, { source: "system", severity: "warning", reason: err.message });
    scheduleSerialRescan("External GPS error");
  }
}

async function findNmeaGpsPort(ports) {
  const baudCandidates = getBaudCandidates();

  for (const port of ports) {
    for (const baudRate of baudCandidates) {
      serialConnectionPhase = `Checking ${getSerialPortLabel(port)} at ${baudRate} baud`;
      setStatus(`Checking ${getSerialPortLabel(port)} @ ${baudRate} baud...`, "warn");
      renderReceiverHealth();

      const ok = await probePortForNmea(port, baudRate, GPS_PROBE_MS);
      if (ok) {
        return { port, baudRate };
      }
    }
  }

  return null;
}

async function probePortForNmea(port, baudRate, probeMs) {
  let reader = null;
  let buffer = "";
  const decoder = new TextDecoder();

  try {
    await port.open({
      baudRate,
      dataBits: 8,
      stopBits: 1,
      parity: "none",
      flowControl: "none"
    });

    reader = port.readable.getReader();
    const deadline = Date.now() + probeMs;

    while (Date.now() < deadline) {
      const remaining = Math.max(250, deadline - Date.now());
      const readPromise = reader.read();
      const timeoutPromise = new Promise(resolve => setTimeout(() => resolve({ timeout: true }), remaining));
      const result = await Promise.race([readPromise, timeoutPromise]);

      if (result.timeout) break;
      if (result.done) break;
      if (!result.value) continue;

      buffer += decoder.decode(result.value, { stream: true });
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop();

      for (const rawLine of lines) {
        const sentence = rawLine.trim();
        if (sentence) setRawNmea(sentence);
        if (looksLikeNMEA(sentence) && isChecksumValid(sentence)) {
          return true;
        }
      }
    }
  } catch (err) {
    // Not every serial device can be opened at every baud. Ignore and keep scanning.
    console.log(`Probe failed at ${baudRate}:`, err.message);
  } finally {
    try {
      if (reader) {
        await reader.cancel().catch(() => {});
        reader.releaseLock();
      }
    } catch (_) {}

    try {
      await port.close();
    } catch (_) {}
  }

  return false;
}

//////////////////////////////////////////////////////
// DISCONNECT SERIAL GPS
//////////////////////////////////////////////////////

async function disconnectSerialGPS(manual = true) {
  if (manual) serialAutoMode = false;
  serialKeepReading = false;

  if (serialReconnectTimer) {
    clearTimeout(serialReconnectTimer);
    serialReconnectTimer = null;
  }

  try {
    if (serialReader) {
      await serialReader.cancel().catch(() => {});
      serialReader.releaseLock();
      serialReader = null;
    }

    if (serialPort) {
      await serialPort.close().catch(() => {});
      serialPort = null;
    }

    if (manual) {
      pendingManualGpsStart = null;
      serialConnectionPhase = "Disconnected manually";
      serialOpenedTime = 0;
      lastNmeaPacketTime = 0;
      lastNmeaSentenceType = "None";
      setStatus("External GPS disconnected", "warn");
      addDiagnosticEvent("External GPS disconnected");
      writeAuditEvent("serial_manual_disconnect", "Manual Disconnect External GPS requested", { source: "user", severity: "action", buttonLabel: "Disconnect External GPS" });
    }
    renderReceiverHealth();

  } catch (err) {
    console.error(err);
    setStatus("Disconnect error: " + err.message, "bad");
  }
}

//////////////////////////////////////////////////////
// READ SERIAL LOOP
//////////////////////////////////////////////////////

async function readSerialLoop() {
  const decoder = new TextDecoder();

  try {
    while (serialPort && serialPort.readable && serialKeepReading) {
      const activeReader = serialPort.readable.getReader();
      serialReader = activeReader;

      try {
        while (serialKeepReading) {
          const { value, done } = await activeReader.read();

          if (done) break;
          if (!value) continue;

          serialBuffer += decoder.decode(value, { stream: true });

          let lines = serialBuffer.split(/\r?\n/);
          serialBuffer = lines.pop();

          for (const rawLine of lines) {
            const sentence = rawLine.trim();
            if (sentence) handleNMEA(sentence);
          }
        }
      } finally {
        try { activeReader.releaseLock(); } catch (_) {}
        if (serialReader === activeReader) serialReader = null;
      }
    }
  } catch (err) {
    console.error(err);
    setStatus("External GPS read error: " + err.message, "bad");
    writeAuditEvent("serial_read_error", `External GPS data stream error: ${err.message}`, { source: "system", severity: "warning", reason: err.message });
  } finally {
    if (serialAutoMode) {
      try {
        if (serialPort) await serialPort.close().catch(() => {});
      } catch (_) {}
      serialPort = null;
      writeAuditEvent("serial_unexpected_disconnect", "External GPS connection/data stream ended unexpectedly; automatic reconnect started", { source: "system", severity: "warning" });
      scheduleSerialRescan("External GPS lost");
    }
  }
}

async function checkSerialStreamHealth() {
  renderReceiverHealth();
  if (!serialAutoMode || !serialPort || !serialKeepReading) return;
  const streamReferenceTime = lastNmeaPacketTime || serialOpenedTime;
  if (!streamReferenceTime || (Date.now() - streamReferenceTime) <= SERIAL_STALL_MS) return;
  if (serialWatchdogRecoveryInProgress) return;

  serialWatchdogRecoveryInProgress = true;
  const stalledSeconds = Math.round((Date.now() - streamReferenceTime) / 1000);
  serialConnectionPhase = `NMEA stream stalled for ${stalledSeconds} sec — restarting receiver`;
  setStatus("External GPS stream stalled. Restarting receiver...", "warn");
  addDiagnosticEvent(`Serial watchdog detected ${stalledSeconds} sec without NMEA`);
  writeAuditEvent(
    "serial_stream_stalled",
    `External GPS remained connected but no NMEA packet arrived for ${stalledSeconds} seconds; automatic restart started`,
    { source: "automatic", severity: "warning", reason: "NMEA packet timeout" }
  );
  renderReceiverHealth();

  try {
    await disconnectSerialGPS(false);
  } finally {
    scheduleSerialRescan("GPS data stream stalled");
    setTimeout(() => { serialWatchdogRecoveryInProgress = false; }, GPS_RESCAN_MS + 1000);
  }
}

setInterval(checkSerialStreamHealth, SERIAL_WATCHDOG_MS);
setInterval(renderReceiverHealth, 1000);

//////////////////////////////////////////////////////
// NMEA HANDLER
//////////////////////////////////////////////////////

function handleNMEA(sentence) {
  setRawNmea(sentence);

  if (!sentence.startsWith("$")) return;

  lastNmeaPacketTime = Date.now();
  serialWatchdogRecoveryInProgress = false;
  lastNmeaSentenceType = sentence.split(",")[0].replace(/^\$/, "") || "Unknown";
  serialConnectionPhase = "Receiving NMEA data";
  renderReceiverHealth();

  if (!isChecksumValid(sentence)) {
    setStatus("Bad NMEA checksum ignored", "warn");
    return;
  }

  const type = sentence.split(",")[0];

  if (
    type === "$GPRMC" ||
    type === "$GNRMC" ||
    type === "$GARMC" ||
    type === "$GLRMC"
  ) {
    parseRMC(sentence);
    return;
  }

  if (
    type === "$GPGGA" ||
    type === "$GNGGA" ||
    type === "$GAGGA" ||
    type === "$GLGGA"
  ) {
    parseGGA(sentence);
    return;
  }
}

//////////////////////////////////////////////////////
// CHECKSUM VALIDATION
//////////////////////////////////////////////////////

function isChecksumValid(sentence) {
  const star = sentence.indexOf("*");

  // Some receivers omit checksum. Do not kill the feed for that.
  if (star === -1) return true;

  const data = sentence.substring(1, star);
  const supplied = sentence.substring(star + 1).trim().toUpperCase();

  let checksum = 0;
  for (let i = 0; i < data.length; i++) {
    checksum ^= data.charCodeAt(i);
  }

  const calculated = checksum.toString(16).toUpperCase().padStart(2, "0");
  return calculated === supplied;
}

//////////////////////////////////////////////////////
// RMC PARSER
//////////////////////////////////////////////////////

function hasRecentUsableSerialFix(maxAgeMs = 10000) {
  return !!(
    lastFix &&
    lastFix.gpsTime &&
    (Date.now() - lastFix.gpsTime) <= maxAgeMs &&
    lastFix.gpsSource &&
    lastFix.gpsSource.startsWith("serial") &&
    isValidLatLon(lastFix.lat, lastFix.lon)
  );
}

function showGpsAcquiringStatus(reason) {
  if (hasRecentUsableSerialFix()) {
    // Some inexpensive receivers send a good GGA position and then a bad/void RMC sentence.
    // Do not let that one bad sentence make AVL look offline or broken.
    setStatus(`External GPS valid fix (${formatGpsSource(lastFix.gpsSource)}): ${currentSerialLabel}`, "good");
    return;
  }

  setStatus(reason || "External GPS connected. Waiting for position fix...", "warn");
}

function parseRMC(sentence) {
  const parts = sentence.split(",");

  const fixStatus = parts[2]; // A = valid, V = void
  if (fixStatus !== "A") {
    showGpsAcquiringStatus("External GPS connected. Waiting for valid RMC/GGA position fix...");
    return;
  }

  const lat = nmeaToDecimal(parts[3], parts[4], true);
  const lon = nmeaToDecimal(parts[5], parts[6], false);

  if (!isValidLatLon(lat, lon)) {
    showGpsAcquiringStatus("External GPS connected. RMC position not usable yet...");
    return;
  }

  const speedKnots = parseFloat(parts[7]) || 0;
  const heading = parseFloat(parts[8]) || 0;

  const data = {
    lat,
    lon,
    speed: speedKnots * 0.514444, // m/s for compatibility with browser GPS
    heading,
    acc: 5,
    gpsSource: "serial-external-rmc",
    gpsTime: Date.now()
  };

  publishFix(data);
}

//////////////////////////////////////////////////////
// GGA PARSER
//////////////////////////////////////////////////////

function parseGGA(sentence) {
  const parts = sentence.split(",");

  const fixQuality = parseInt(parts[6], 10); // 0 invalid, 1 GPS, 2 DGPS, 4 RTK, etc.
  serialFixQuality = Number.isFinite(fixQuality) ? fixQuality : null;
  serialSatellites = parseInt(parts[7], 10) || 0;
  serialHdop = Number.isFinite(parseFloat(parts[8])) ? parseFloat(parts[8]) : null;
  renderReceiverHealth();
  if (!fixQuality || fixQuality === 0) {
    showGpsAcquiringStatus("External GPS connected. Waiting for valid RMC/GGA position fix...");
    return;
  }

  const lat = nmeaToDecimal(parts[2], parts[3], true);
  const lon = nmeaToDecimal(parts[4], parts[5], false);

  if (!isValidLatLon(lat, lon)) {
    showGpsAcquiringStatus("External GPS connected. GGA position not usable yet...");
    return;
  }

  const satellites = serialSatellites;
  const hdop = serialHdop;

  const data = {
    lat,
    lon,
    speed: lastFix?.speed || 0,
    heading: lastFix?.heading || 0,
    acc: hdop ? Math.round(hdop * 5) : 10,
    gpsSource: "serial-external-gga",
    satellites,
    hdop,
    gpsTime: Date.now()
  };

  publishFix(data);
}

//////////////////////////////////////////////////////
// NMEA COORDINATE CONVERSION
//////////////////////////////////////////////////////

function nmeaToDecimal(raw, direction, isLatitude) {
  if (!raw || !direction) return null;

  const degreeLength = isLatitude ? 2 : 3;
  const degrees = parseInt(raw.substring(0, degreeLength), 10);
  const minutes = parseFloat(raw.substring(degreeLength));

  if (Number.isNaN(degrees) || Number.isNaN(minutes)) return null;

  let decimal = degrees + (minutes / 60);

  if (direction === "S" || direction === "W") {
    decimal *= -1;
  }

  return decimal;
}

function isValidLatLon(lat, lon) {
  return (
    typeof lat === "number" &&
    typeof lon === "number" &&
    !Number.isNaN(lat) &&
    !Number.isNaN(lon) &&
    lat >= -90 &&
    lat <= 90 &&
    lon >= -180 &&
    lon <= 180
  );
}

//////////////////////////////////////////////////////
// PUBLISH FIX
//////////////////////////////////////////////////////

function publishFix(data) {
  if (!currentUnitId) return;

  lastValidFixTime = Date.now();
  lastFix = data;
  lastFixUnitId = currentUnitId;
  serialConnectionPhase = data.gpsSource?.startsWith("serial")
    ? `${formatFixQuality(serialFixQuality)} acquired`
    : "Browser GPS active";
  publishPresence();

  if (data.gpsSource?.startsWith("serial") && !serialFixLoggedForConnection) {
    serialFixLoggedForConnection = true;
    const manualStart = pendingManualGpsStart;
    const secondsToFix = manualStart?.requestedAt
      ? Math.max(0, Math.round((Date.now() - manualStart.requestedAt) / 1000))
      : null;
    writeAuditEvent(
      manualStart ? "gps_stream_started_manual" : "gps_stream_resumed_automatic",
      manualStart
        ? `GPS STREAM STARTED HERE — Auto Detect External GPS produced its first valid position${secondsToFix !== null ? ` after ${secondsToFix} seconds` : ""}`
        : "GPS stream resumed automatically with a valid position",
      {
        source: manualStart ? "user" : "automatic",
        severity: manualStart ? "action" : "info",
        buttonLabel: manualStart?.buttonLabel || "",
        controlLocation: manualStart ? "GPS controls" : "automatic recovery",
        includeLocation: true,
        locationData: data
      }
    );
    pendingManualGpsStart = null;
  }

  publishUnitData(currentUnitId, data);
  updateMap(currentUnitId, data);

  const age = new Date(data.gpsTime).toLocaleTimeString();

  setStatus(`External GPS valid fix (${formatGpsSource(data.gpsSource)}): ${currentSerialLabel}`, "good");

  setFixDetails(
    `Unit: ${currentUnitId}\n` +
    `Lat: ${data.lat.toFixed(6)}\n` +
    `Lon: ${data.lon.toFixed(6)}\n` +
    `Movement: ${getMovementLabel(data)}\n` +
    `Heading: ${data.heading || 0}\n` +
    `Accuracy est: ${data.acc} m\n` +
    `GPS: ${formatGpsSource(data.gpsSource)}\n` +
    (data.satellites ? `Satellites: ${data.satellites}\n` : "") +
    `Updated: ${age}`
  );
  renderReceiverHealth();
}


function getCardinalDirection(heading) {
  const h = Number(heading);
  if (Number.isNaN(h)) return "unknown direction";

  const directions = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
  return directions[Math.round((((h % 360) + 360) % 360) / 45) % 8];
}

function getMovementLabel(data) {
  const speedMph = (Number(data.speed) || 0) * 2.237;

  if (speedMph < 2) return "Stationary";
  return `Moving ${getCardinalDirection(data.heading)}`;
}

//////////////////////////////////////////////////////
// MAP UPDATE
//////////////////////////////////////////////////////

function markerColor(source) {
  if (source && source.startsWith("serial")) return "lime";
  if (source === "browser") return "deepskyblue";
  return "gray";
}

function getHeadingDegrees(data) {
  const heading = Number(data.heading || 0);
  if (Number.isNaN(heading)) return 0;
  return heading;
}

function getPoliceCarIcon(id, data) {
  const heading = getHeadingDegrees(data);
  const gpsLost = isUnitOffline(data);
  const safeId = String(id || "").replace(/[<>&"']/g, "");

  // Keep the police car visually recognizable and upright.
  // The small arrow rotates to show direction of travel, so the car no longer turns into a boat/pencil.
  return L.divIcon({
    className: "police-car-marker",
    html: `
      <div class="unit-marker-wrap">
        <div class="unit-marker-label">${safeId}</div>
        <div class="police-car-wrap ${gpsLost ? "gps-lost" : ""}">
          <div class="direction-arrow" style="transform: rotate(${heading}deg);"></div>
          <div class="police-car-emoji">🚓</div>
        </div>
      </div>
    `,
    iconSize: [52, 48],
    iconAnchor: [26, 32],
    popupAnchor: [0, -34],
    tooltipAnchor: [0, -34]
  });
}

function updateMap(id, data) {
  const movementLabel = getMovementLabel(data);
  const updated = data.gpsTime
    ? new Date(data.gpsTime).toLocaleTimeString()
    : "Unknown";

  const popupHtml = `
    <b>Unit ${id}</b><br>
    Health: ${getUnitHealthLabel(data)}<br>
    Source: ${formatGpsSource(data.gpsSource)}<br>
    ${data.satellites ? `Satellites: ${data.satellites}<br>` : ""}
    Movement: ${movementLabel}<br>
    Heading: ${Math.round(data.heading || 0)}°<br>
    Updated: ${updated}
  `;

  const icon = getPoliceCarIcon(id, data);

  if (!markers[id]) {
    markers[id] = L.marker([data.lat, data.lon], {
      icon: icon
    }).addTo(map);

    markers[id].bindPopup(popupHtml);
    markers[id]._lastHeading = Math.round(getHeadingDegrees(data));
    markers[id]._lastGpsSource = data.gpsSource;

  } else {
    markers[id].setLatLng([data.lat, data.lon]);

    // Only rebuild the icon when the source or heading meaningfully changes.
    // Rebuilding the emoji marker every single GPS tick can make the map appear to flicker/glitch.
    const newHeading = Math.round(getHeadingDegrees(data));
    const oldHeading = markers[id]._lastHeading;
    const oldSource = markers[id]._lastGpsSource;

    const headingDelta = oldHeading === undefined
      ? 999
      : Math.abs((((newHeading - oldHeading) + 540) % 360) - 180);

    if (oldSource !== data.gpsSource || headingDelta >= 5) {
      markers[id].setIcon(icon);
      markers[id]._lastHeading = newHeading;
      markers[id]._lastGpsSource = data.gpsSource;
    }

    markers[id].setPopupContent(popupHtml);
  }

  // Do not automatically recenter the map on every GPS update.
  // Use the "Center On My Unit" button when you want the map to jump back to your unit.
}

//////////////////////////////////////////////////////
// CENTER ON CURRENT UNIT
//////////////////////////////////////////////////////

function centerOnUnit() {
  const id = currentUnitId || document.getElementById("unitId").value.trim();

  if (!id) {
    alert("Enter or log in with a Unit ID first");
    return;
  }

  const marker = markers[id];

  if (!marker) {
    alert("No current marker found for this unit yet");
    return;
  }

  map.setView(marker.getLatLng(), 17);
  marker.openPopup();
}

function isUnitOffline(data) {
  const last = data.gpsTime || data.time || 0;
  return last ? (Date.now() - last) > UNIT_OFFLINE_MS : true;
}

function getUnitHealthLabel(data) {
  return isUnitOffline(data) ? "OFFLINE" : "ONLINE";
}

function formatGpsSource(source) {
  if (!source) return "unknown";
  if (source.startsWith("serial")) return "External GPS";
  if (source === "browser") return "Browser fallback";
  return source;
}

function formatLastUpdateAge(timestamp) {
  if (!timestamp) return "Unknown";

  const seconds = Math.max(0, Math.round((Date.now() - timestamp) / 1000));
  if (seconds < 60) return `${seconds} sec ago`;

  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;

  const hours = Math.round(minutes / 60);
  return `${hours} hr ago`;
}

function getUnitLastGpsTime(data) {
  return data ? (data.gpsTime || data.time || 0) : 0;
}

function isUnitExpired(data, session) {
  const lastGps = getUnitLastGpsTime(data);
  if (!lastGps) return !isSessionActive(session);
  return !isSessionActive(session) && (Date.now() - lastGps) > UNIT_EXPIRE_MS;
}

async function purgeExpiredUnits() {
  if (!firebaseConnected) return;

  const units = latestUnits || {};
  const sessions = latestSessions || {};
  const removals = [];

  Object.keys(units).forEach((id) => {
    const session = findUnitSession(id, sessions) || null;
    if (isUnitExpired(units[id], session)) {
      removals.push(unitsRef.child(id).remove().catch((err) => {
        console.warn(`Unable to purge expired unit ${id}:`, err);
      }));
    }
  });

  if (removals.length) await Promise.all(removals);
}

setInterval(purgeExpiredUnits, 5 * 60 * 1000);

//////////////////////////////////////////////////////
// LIVE UNIT LIST / OTHER UNITS ON MAP
//////////////////////////////////////////////////////

function scheduleRenderUnitList() {
  if (renderUnitListTimer) return;

  renderUnitListTimer = setTimeout(() => {
    renderUnitListTimer = null;
    renderUnitList();
  }, 750);
}

function isSessionActive(session) {
  const last = session
    ? (session.serverLastSeen || session.lastSeen || 0)
    : 0;
  return last ? (Date.now() - last) <= SESSION_STALE_MS : false;
}

function isEffectivelyConnected(session, unitData) {
  // If a unit has sent a recent GPS fix, the browser is obviously still talking
  // to Firebase even if the separate heartbeat record is missing/stale.
  // This prevents a good GPS feed from being labeled "not connected."
  if (isSessionActive(session)) return true;
  return !!(unitData && typeof unitData.lat === "number" && typeof unitData.lon === "number" && !isUnitOffline(unitData));
}

function getSessionDisplayId(key, session) {
  if (session && (session.displayName || session.id)) return session.displayName || session.id;
  return String(key || "")
    .replace(/^dispatch_/, "")
    .replace(/^unit_/, "")
    .replace(/_/g, " ");
}

function findUnitSession(unitId, sessions) {
  if (sessions[unitId]) return sessions[unitId]; // backwards compatibility with earlier build
  const directKey = getSessionKey("unit", unitId);
  if (sessions[directKey]) return sessions[directKey];

  return Object.keys(sessions)
    .map((key) => sessions[key])
    .find((session) => session && session.mode !== "dispatch" && getSessionDisplayId("", session) === unitId) || null;
}

function buildListEntries(data, sessions) {
  const entries = [];
  const addedUnitIds = new Set();

  Object.keys(data).forEach((id) => {
    const session = findUnitSession(id, sessions) || null;
    if (isUnitExpired(data[id], session)) return;

    // Keep a last-known point through normal coverage gaps, but stop showing
    // records that have been abandoned for the expiration period.
    entries.push({ id, key: `unit:${id}`, mode: "Unit", unitData: data[id], session });
    addedUnitIds.add(id);
  });

  Object.keys(sessions).forEach((key) => {
    const session = sessions[key];
    if (!session || !isSessionActive(session)) return;

    const displayId = getSessionDisplayId(key, session);
    const mode = session.mode === "dispatch" ? "Dispatch" : "Unit";

    if (mode === "Unit" && addedUnitIds.has(displayId)) return;

    entries.push({
      id: displayId,
      key: `${mode.toLowerCase()}:${key}`,
      mode,
      unitData: mode === "Unit" ? data[displayId] : null,
      session
    });
  });

  return entries.sort((a, b) => {
    if (a.mode !== b.mode) return a.mode === "Unit" ? -1 : 1;
    return a.id.localeCompare(b.id, undefined, { numeric: true });
  });
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function getRosterState(entry) {
  const u = entry.unitData;
  const s = entry.session;
  const mode = entry.mode;
  const hasGps = !!(u && typeof u.lat === "number" && typeof u.lon === "number");
  const gpsActive = hasGps && !isUnitOffline(u);
  const connected = isEffectivelyConnected(s, u);
  const loggedIn = isSessionActive(s);

  if (mode === "Dispatch") {
    return {
      group: "dispatch",
      rowClass: "dispatch",
      badgeClass: "dispatch",
      badge: loggedIn ? "ONLINE" : "STALE",
      main: loggedIn ? "Dispatch view" : "Dispatch session stale",
      sub: loggedIn ? "Logged in" : "No recent heartbeat"
    };
  }

  if (gpsActive) {
    return {
      group: "active",
      rowClass: "active",
      badgeClass: "active",
      badge: "ACTIVE",
      main: getMovementLabel(u),
      sub: `${formatGpsSource(u.gpsSource)} · Last GPS ${formatLastUpdateAge(u.gpsTime || u.time || 0)}`
    };
  }

  if (connected && hasGps) {
    return {
      group: "gpsIssues",
      rowClass: "gps-issue",
      badgeClass: "issue",
      badge: "GPS LOST",
      main: "GPS stale",
      sub: `Last GPS ${formatLastUpdateAge(u.gpsTime || u.time || 0)} · ${formatGpsSource(u.gpsSource)}`
    };
  }

  if (connected && !hasGps) {
    return {
      group: "gpsIssues",
      rowClass: "gps-issue",
      badgeClass: "issue",
      badge: "NO GPS",
      main: "Acquiring / no GPS feed yet",
      sub: "Browser is connected"
    };
  }

  if (hasGps) {
    return {
      group: "connectionLost",
      rowClass: "connection-lost",
      badgeClass: "lost",
      badge: "LAST FIX",
      main: "Connection lost",
      sub: `Last known GPS ${formatLastUpdateAge(u.gpsTime || u.time || 0)}`
    };
  }

  return {
    group: "connectionLost",
    rowClass: "connection-lost",
    badgeClass: "lost",
    badge: "OFFLINE",
    main: "No active connection",
    sub: "No GPS point available"
  };
}

function renderUnitList() {
  const data = latestUnits || {};
  const sessions = latestSessions || {};
  const list = document.getElementById("unitList");

  if (list) list.innerHTML = "";

  // Remove markers only when the GPS record is actually gone.
  // Do not hide a unit just because the heartbeat went stale; bad cell coverage
  // can stop heartbeat updates while the last known GPS point is still useful.
  Object.keys(markers).forEach((id) => {
    const session = data[id] ? (findUnitSession(id, sessions) || null) : null;
    if (!data[id] || isUnitExpired(data[id], session)) {
      map.removeLayer(markers[id]);
      delete markers[id];
    }
  });

  // Keep map markers for recent units, including last-known positions during
  // short coverage gaps. Expired prior-shift records are not redrawn.
  Object.keys(data).forEach((id) => {
    const u = data[id];
    const session = findUnitSession(id, sessions) || null;
    if (isUnitExpired(u, session)) return;
    if (!u || typeof u.lat !== "number" || typeof u.lon !== "number") return;
    updateMap(id, u);
  });

  if (!list) return;

  const title = document.createElement("div");
  title.className = "cad-roster-title";
  title.textContent = "GCSO AVL ROSTER";
  list.appendChild(title);

  const entries = buildListEntries(data, sessions);
  const groups = {
    active: [],
    gpsIssues: [],
    connectionLost: [],
    dispatch: []
  };

  entries.forEach((entry) => {
    const state = getRosterState(entry);
    entry._rosterState = state;
    groups[state.group].push(entry);
  });

  function addSection(titleText, items) {
    const header = document.createElement("div");
    header.className = "cad-section-title";
    header.innerHTML = `<span>${escapeHtml(titleText)}</span><span class="cad-count">${items.length}</span>`;
    list.appendChild(header);

    if (!items.length) {
      const empty = document.createElement("div");
      empty.className = "cad-empty";
      empty.textContent = "None";
      list.appendChild(empty);
      return;
    }

    items.forEach(addEntryToList);
  }

  function addEntryToList(entry) {
    const id = entry.id;
    const u = entry.unitData;
    const s = entry.session;
    const mode = entry.mode;
    const state = entry._rosterState || getRosterState(entry);
    const hasGps = !!(u && typeof u.lat === "number" && typeof u.lon === "number");
    const gpsActive = hasGps && !isUnitOffline(u);
    const loggedIn = isSessionActive(s);
    const last = hasGps ? (u.gpsTime || u.time || 0) : 0;
    const updateAge = hasGps ? formatLastUpdateAge(last) : "No GPS data yet";
    const sourceLabel = hasGps ? formatGpsSource(u.gpsSource) : (mode === "Dispatch" ? "View only" : "No GPS feed");
    const movementLabel = hasGps ? getMovementLabel(u) : (mode === "Dispatch" ? "View only" : "Not displaying");

    const div = document.createElement("div");
    div.className = `cad-row ${state.rowClass}`;
    div.innerHTML = `
      <div class="cad-unit-id">${escapeHtml(mode === "Dispatch" ? id : id)}</div>
      <div class="cad-main">
        ${escapeHtml(state.main)}
        <div class="cad-sub">${escapeHtml(state.sub)}</div>
      </div>
      <div class="cad-badge ${state.badgeClass}">${escapeHtml(state.badge)}</div>
    `;

    div.onclick = () => {
      if (userRole === "admin") {
        selectedRosterUnitId = id;
        selectedRosterMode = mode;
        const selectedLabel = document.getElementById("selectedUnitLabel");
        if (selectedLabel) selectedLabel.textContent = `Selected: ${mode} ${id}`;
        updateDeveloperInfo();
      }

      if (hasGps && markers[id]) {
        map.setView([u.lat, u.lon], 17);
        markers[id].openPopup();
      }

      setFixDetails(
        `${mode}: ${id}\n` +
        `Connection: ${loggedIn || gpsActive ? "Online / recently updating" : "Connection lost / heartbeat stale"}\n` +
        `GPS: ${mode === "Dispatch" ? "View only" : gpsActive ? "Active" : hasGps ? "Lost / stale" : "No GPS yet"}\n` +
        `Source: ${sourceLabel}\n` +
        (hasGps && u.satellites ? `Satellites: ${u.satellites}\n` : "") +
        (hasGps ? `Lat: ${u.lat.toFixed(6)}\n` : "") +
        (hasGps ? `Lon: ${u.lon.toFixed(6)}\n` : "") +
        `Movement: ${movementLabel}\n` +
        (hasGps ? `Heading: ${Math.round(u.heading || 0)}°\n` : "") +
        `Last GPS: ${updateAge}`
      );
    };

    list.appendChild(div);
  }

  addSection("ACTIVE", groups.active);
  addSection("GPS ISSUES", groups.gpsIssues);
  addSection("CONNECTION LOST / LAST KNOWN", groups.connectionLost);
  addSection("DISPATCH", groups.dispatch);
}

unitsRef.on("value", (snap) => {
  latestUnits = snap.val() || {};
  scheduleRenderUnitList();
});

sessionsRef.on("value", (snap) => {
  latestSessions = snap.val() || {};

  // Modern clients remove the known invalid legacy dispatcher record when seen.
  // The Firebase Rules patch included with this release is what permanently
  // prevents the old browser tab from writing it back.
  if (latestSessions.dispatch__) {
    sessionsRef.child("dispatch__").remove().catch(() => {});
    delete latestSessions.dispatch__;
  }

  scheduleRenderUnitList();
});
//////////////////////////////////////////////////////
// BROWSER GPS FALLBACK
//////////////////////////////////////////////////////

function startBrowserGPS() {
  if (userMode === "dispatch") return alert("Dispatch view is view-only. GPS controls are disabled.");
  const id = document.getElementById("unitId").value.trim();
  if (!id) return alert("Enter Unit ID first");

  currentUnitId = id;
  localStorage.setItem("avl_unitId", id);
  localStorage.setItem("avl_mode", userMode || "unit");

  if (browserWatchId !== null) {
    navigator.geolocation.clearWatch(browserWatchId);
  }
  browserGpsConnectedLogged = false;

  browserWatchId = navigator.geolocation.watchPosition((pos) => {
    const data = {
      lat: pos.coords.latitude,
      lon: pos.coords.longitude,
      speed: pos.coords.speed || 0,
      heading: pos.coords.heading || 0,
      acc: pos.coords.accuracy,
        gpsSource: "browser",
      gpsTime: Date.now()
    };

    lastFix = data;
    lastFixUnitId = id;
    lastValidFixTime = data.gpsTime;
    publishPresence();
    publishUnitData(id, data);
    updateMap(id, data);

    if (!browserGpsConnectedLogged) {
      browserGpsConnectedLogged = true;
      writeAuditEvent("browser_gps_connected", "GPS STREAM STARTED HERE — Browser GPS fallback produced its first valid position", {
        source: "user",
        severity: "action",
        buttonLabel: "Start Browser GPS Fallback",
        controlLocation: "GPS controls",
        includeLocation: true,
        locationData: data
      });
    }

    setStatus("Browser GPS active", "good");
    if (!lastFix || lastFix.gpsSource !== "browser") addDiagnosticEvent("Browser GPS fallback active");

  }, (err) => {
    setStatus("Browser GPS error: " + err.message, "bad");
  }, {
    enableHighAccuracy: true,
    maximumAge: 0,
    timeout: 10000
  });
}

//////////////////////////////////////////////////////
// LOG OFF / REMOVE UNIT
//////////////////////////////////////////////////////

async function logOffUnit() {
  const id = currentUnitId || document.getElementById("unitId").value.trim();
  if (!id) return alert("Enter Unit ID first");

  await writeAuditEvent("unit_logoff", "Unit logged off and ended its AVL session", {
    source: "user",
    severity: "action",
    includeLocation: true,
    locationUnitId: id,
    lookupStoredLocation: true
  });

  if (browserWatchId !== null) {
    navigator.geolocation.clearWatch(browserWatchId);
    browserWatchId = null;
  }

  await disconnectSerialGPS();
  await stopPresence(true);
  await unitsRef.child(id).remove();

  if (markers[id]) {
    map.removeLayer(markers[id]);
    delete markers[id];
  }

  currentUnitId = null;

  setStatus("Unit logged off", "warn");
  setFixDetails("Unit logged off.");
}

async function forceRemoveUnit() {
  if (userRole !== "admin") {
    alert("Admin access required");
    return;
  }

  const id = selectedRosterUnitId;
  const mode = selectedRosterMode || "Unit";
  if (!id) {
    alert("Select a unit or dispatcher from the roster first");
    return;
  }

  if (!confirm(`Remove ${mode} ${id} from AVL?`)) return;

  await writeAuditEvent("admin_session_removed", `${mode} ${id} removed from AVL by administrator ${currentUnitId}`, {
    source: "admin",
    severity: "action",
    actorName: currentUnitId,
    targetUnit: id,
    recordUnitId: id,
    includeLocation: mode !== "Dispatch",
    locationUnitId: id,
    lookupStoredLocation: true
  });

  if (mode === "Dispatch") {
    await sessionsRef.child(getSessionKey("dispatch", id)).remove().catch(() => {});
    setStatus(`Dispatcher ${id} removed`, "warn");
    setFixDetails(`Dispatcher ${id} removed by admin.`);
  } else {
    if (browserWatchId !== null && id === currentUnitId) {
      navigator.geolocation.clearWatch(browserWatchId);
      browserWatchId = null;
    }

    if (id === currentUnitId) await disconnectSerialGPS();

    await sessionsRef.child(getSessionKey("unit", id)).remove().catch(() => {});
    await unitsRef.child(id).remove();

    if (markers[id]) {
      map.removeLayer(markers[id]);
      delete markers[id];
    }

    if (id === currentUnitId) currentUnitId = null;

    setStatus(`Unit ${id} removed`, "warn");
    setFixDetails(`Unit ${id} removed by admin.`);
  }

  selectedRosterUnitId = null;
  selectedRosterMode = null;
  const selectedLabel = document.getElementById("selectedUnitLabel");
  if (selectedLabel) selectedLabel.textContent = "Selected: None";
  updateDeveloperInfo();
}

// Backward-compatible alias for old Remove Unit button behavior.
function removeUnit() {
  forceRemoveUnit();
}
