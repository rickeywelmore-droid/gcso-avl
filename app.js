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
const auditMetricsRef = db.ref("auditMetrics");

/*********************************************************************
 GCSO AVL CONFIGURATION
 --------------------------------------------------------------------
 Version: 1.1.19
 Build: 2026-09-22

 Temporary client-side access gate. This is a convenience barrier,
 not strong authentication.
*********************************************************************/
const APP_VERSION = "1.1.19";
const BUILD_DATE = "2026-09-22";
const USER_PASSWORD = "GCSO123";
const ADMIN_PASSWORD = "GCSOADMIN123";
const PRESENCE_TIMEOUT_MINUTES = 2;
const UNIT_OFFLINE_MINUTES = 15;
const ABANDONED_UNIT_HOURS = 2;
const HEARTBEAT_SECONDS = 30;
const GPS_MOVING_PUBLISH_MS = 5000;
const GPS_STATIONARY_PUBLISH_MS = 30000;
const GPS_MOVING_SPEED_MPS = 0.8;
const GPS_IMMEDIATE_DISTANCE_METERS = 100;
const GPS_IMMEDIATE_HEADING_DEGREES = 60;
const GPS_SERIAL_COALESCE_MS = 400;
const DISPATCH_IDLE_MINUTES = 60;
const DISPATCH_WARNING_MINUTES = 5;
const DISPATCH_SOUND_ENABLED = true;
const AUDIT_RETENTION_DAYS = 365;
const AUDIT_DEFAULT_VIEW_DAYS = 7;
const AUDIT_MAX_QUERY_DAYS = 31;
const AUDIT_PAGE_SIZE = 100;
const AUDIT_STORAGE_LIMIT_BYTES = 1024 * 1024 * 1024;
const AUDIT_STORAGE_WARNING_BYTES = 750 * 1024 * 1024;
const AUDIT_LEGACY_RESERVE_BYTES = 1024 * 1024;
const GPS_PROBE_MS = 3000;
const GPS_RESCAN_MS = 3000;
const SERIAL_REENUMERATION_MS = 2500;
const SERIAL_STALL_MS = 12000;
const SERIAL_WATCHDOG_MS = 3000;
const FIREBASE_RECOVERY_MS = 15000;
const DEBUG = false;

// Optional field-use sound cues. These run only from deliberate user clicks and
// never block GPS, Firebase, or audit operations. Missing/unplayable files fail
// silently so the AVL remains fully functional.
const AVL_FUN_SOUND_ENABLED = true;
const AVL_FUN_SOUND_VOLUME = 0.72;
const AVL_SOUND_FILES = {
  gpsStart: [
    "audio/gps-start/Start1.wav",
    "audio/gps-start/Start2.wav",
    "audio/gps-start/Start3.wav",
    "audio/gps-start/Start4.wav",
    "audio/gps-start/Start5.wav",
    "audio/gps-start/Start6.wav",
    "audio/gps-start/Start7.wav"
  ],
  gpsStop: [
    "audio/gps-stop/Stop1.wav",
    "audio/gps-stop/Stop2.wav",
    "audio/gps-stop/Stop3.wav",
    "audio/gps-stop/Stop4.wav",
    "audio/gps-stop/Stop5.wav",
    "audio/gps-stop/Stop6.wav"
  ],
  developer: [
    "audio/developer/Dev1.wav"
  ]
};

let currentAvlFunAudio = null;
const lastAvlFunSoundIndex = { gpsStart: -1, gpsStop: -1, developer: -1 };

function playAvlFunSound(category) {
  if (!AVL_FUN_SOUND_ENABLED) return;

  const files = AVL_SOUND_FILES[category];
  if (!Array.isArray(files) || !files.length) return;

  let index = Math.floor(Math.random() * files.length);
  if (files.length > 1 && index === lastAvlFunSoundIndex[category]) {
    index = (index + 1 + Math.floor(Math.random() * (files.length - 1))) % files.length;
  }
  lastAvlFunSoundIndex[category] = index;

  try {
    // Never stack clips on top of each other if someone double-clicks or
    // starts/stops GPS quickly. The newest deliberate action wins.
    if (currentAvlFunAudio) {
      currentAvlFunAudio.pause();
      currentAvlFunAudio.currentTime = 0;
    }

    const audio = new Audio(files[index]);
    currentAvlFunAudio = audio;
    audio.volume = AVL_FUN_SOUND_VOLUME;
    audio.preload = "auto";
    audio.addEventListener("ended", () => {
      if (currentAvlFunAudio === audio) currentAvlFunAudio = null;
    }, { once: true });
    audio.play().catch(err => debugLog("Optional AVL sound unavailable", err));
  } catch (err) {
    debugLog("Optional AVL sound unavailable", err);
  }
}


function debugLog(...args) {
  if (DEBUG) console.log("[GCSO AVL]", ...args);
}

//////////////////////////////////////////////////////
// MAP
//////////////////////////////////////////////////////

const map = L.map("map").setView([38.9, -84.5], 10);

// v1.1.17 deliberately uses the standard OpenStreetMap tile endpoint for
// every map theme. The previous test build introduced a third-party dark
// basemap that can demand an API key. Keeping one keyless tile source also
// means changing themes never interrupts the live AVL map with a tile reload.
const baseTiles = L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
  maxZoom: 19,
  attribution: '&copy; OpenStreetMap contributors'
}).addTo(map);

// v1.1.18 uses one setting for both the map and the interface.
// Migrate a previously selected dark map into the unified dark setting.
let darkMode = localStorage.getItem("avl_darkMode") === "true" ||
  localStorage.getItem("avl_mapTheme") === "dark";

function applyDarkMode() {
  document.body.classList.toggle("dark", darkMode);
  localStorage.setItem("avl_darkMode", darkMode ? "true" : "false");
  localStorage.removeItem("avl_mapTheme");

  const button = document.getElementById("themeToggleButton");
  if (button) {
    button.innerText = darkMode ? "Normal Map" : "Dark Map";
    button.title = darkMode
      ? "Switch to the normal map and light interface"
      : "Switch to the dark map and dark interface";
  }

  setTimeout(() => map.invalidateSize(), 100);
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
let auditSelectedUnit = "all";
let auditSelectedSeverity = "all";
let auditSelectedSource = "all";
let auditLoadedRows = [];
let auditKnownUnitKeys = [];
let auditCurrentPage = 1;
let auditLoading = false;
let auditLastRange = null;
let auditStorageEstimateBytes = 0;
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
let serialReconnectPort = null;
let lastSuccessfulSerialPort = null;
let serialDeviceMissing = false;
let serialDeviceReturnedTime = 0;
let serialConnectGeneration = 0;
let serialReadGeneration = 0;
let serialConnectionAttemptInProgress = false;
let serialConnectionAttemptQueued = false;
let queuedConnectionIsManual = false;
let serialForceBaudScan = false;
let serialFailedBaud = null;
let serialProbeReader = null;
let serialProbePort = null;
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
let lastNetworkPublishedFix = null;
let lastNetworkPublishedUnitId = null;
let lastNetworkPublishTime = 0;
let queuedUnitPublishData = null;
let queuedUnitPublishId = null;
let queuedUnitPublishReason = "";
let unitPublishTimer = null;
let unitPublishTimerDue = 0;
let unitPublishInFlight = false;
let unitPublishInFlightPromise = null;
let unitPublishEpoch = 0;
let sessionRosterSubscribed = false;
let dispatchRosterSubscribed = false;
let dispatchSessionQuery = null;
let preferredSerialPort = null;

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
// ONE-YEAR INDEXED OPERATIONAL AUDIT TRAIL
//////////////////////////////////////////////////////

const AUDIT_SEVERITIES = Object.freeze({ INFO: "info", WARNING: "warning", ACTION: "action" });

function getAuditUnitKey(unitId) {
  return sanitizeFirebaseKey(unitId || "unknown");
}

function normalizeAuditSeverity(value, eventType = "") {
  const severity = String(value || "").toLowerCase();
  if (Object.values(AUDIT_SEVERITIES).includes(severity)) return severity;
  if (/button|manual|logout|force|remove|disconnect_requested|closure/.test(eventType)) return AUDIT_SEVERITIES.ACTION;
  if (/lost|offline|disconnected|failed|error|unexpected|no_fix|denied|unexplained/.test(eventType)) return AUDIT_SEVERITIES.WARNING;
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

function estimateUtf8Bytes(value) {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  try {
    return new TextEncoder().encode(text).length;
  } catch (_) {
    return text.length * 2;
  }
}

function getAuditMetricDay(timestamp = Date.now()) {
  return new Date(timestamp).toISOString().slice(0, 10);
}

function recordAuditUsage(unitKey, eventKey, record) {
  const day = getAuditMetricDay(record.clientTime || Date.now());
  const estimatedBytes = estimateUtf8Bytes({ [unitKey]: { [eventKey]: { ...record, timestamp: Date.now() } } });
  auditMetricsRef.child("daily").child(day).transaction((current) => ({
    eventCount: Number(current?.eventCount || 0) + 1,
    estimatedBytes: Number(current?.estimatedBytes || 0) + estimatedBytes,
    updatedAt: Date.now()
  })).catch((err) => console.warn("Audit usage estimate update failed:", err));
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
      const uploadedRecord = {
        ...record,
        timestamp: firebase.database.ServerValue.TIMESTAMP,
        uploadedAfterReconnect: true
      };
      await auditLogsRef.child(item.unitKey).child(item.eventKey).set(uploadedRecord);
      recordAuditUsage(item.unitKey, item.eventKey, uploadedRecord);
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
  const clientTime = Date.now();
  const record = {
    timestamp: firebase.database.ServerValue.TIMESTAMP,
    clientTime,
    eventTime: clientTime,
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
    closureReason: details.closureReason || "",
    closureNotes: details.closureNotes || "",
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
    recordAuditUsage(unitKey, eventKey, record);
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

function toDateInputValue(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function parseAuditDate(value, endOfDay = false) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value || "");
  if (!match) return null;
  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]), endOfDay ? 23 : 0, endOfDay ? 59 : 0, endOfDay ? 59 : 0, endOfDay ? 999 : 0);
  return Number.isNaN(date.getTime()) ? null : date;
}

function getAuditRangeFromInputs(showErrors = true) {
  const startValue = document.getElementById("auditStartDate")?.value || "";
  const endValue = document.getElementById("auditEndDate")?.value || "";
  const startDate = parseAuditDate(startValue, false);
  const endDate = parseAuditDate(endValue, true);
  if (!startDate || !endDate || startDate > endDate) {
    if (showErrors) alert("Choose a valid audit start and end date.");
    return null;
  }
  const calendarStart = Date.UTC(startDate.getFullYear(), startDate.getMonth(), startDate.getDate());
  const calendarEnd = Date.UTC(endDate.getFullYear(), endDate.getMonth(), endDate.getDate());
  const dayCount = Math.round((calendarEnd - calendarStart) / 86400000) + 1;
  if (dayCount > AUDIT_MAX_QUERY_DAYS) {
    if (showErrors) alert(`Load no more than ${AUDIT_MAX_QUERY_DAYS} days at once. Use monthly exports for longer archives.`);
    return null;
  }
  const retentionCutoff = Date.now() - (AUDIT_RETENTION_DAYS * 86400000);
  if (endDate.getTime() < retentionCutoff || startDate.getTime() < retentionCutoff - 86400000) {
    if (showErrors) alert(`The live audit trail retains ${AUDIT_RETENTION_DAYS} days.`);
    return null;
  }
  return { startMs: startDate.getTime(), endMs: endDate.getTime(), startValue, endValue, dayCount };
}

function setDefaultAuditRange(force = false) {
  const start = document.getElementById("auditStartDate");
  const end = document.getElementById("auditEndDate");
  const month = document.getElementById("auditExportMonth");
  if (!start || !end) return;
  const today = new Date();
  const firstDay = new Date(today.getFullYear(), today.getMonth(), today.getDate() - (AUDIT_DEFAULT_VIEW_DAYS - 1));
  const oldestDay = new Date(today.getFullYear(), today.getMonth(), today.getDate() - (AUDIT_RETENTION_DAYS - 1));
  const todayValue = toDateInputValue(today);
  const oldestValue = toDateInputValue(oldestDay);
  start.min = oldestValue;
  start.max = todayValue;
  end.min = oldestValue;
  end.max = todayValue;
  if (force || !start.value) start.value = toDateInputValue(firstDay);
  if (force || !end.value) end.value = todayValue;
  if (month) {
    month.min = oldestValue.slice(0, 7);
    month.max = todayValue.slice(0, 7);
    if (force || !month.value) month.value = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}`;
  }
}

async function getAuditUnitKeys() {
  try {
    const response = await fetch(`${firebaseConfig.databaseURL}/auditLogs.json?shallow=true`, { cache: "no-store" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    const keys = data && typeof data === "object" ? Object.keys(data).filter(Boolean) : [];
    auditKnownUnitKeys = keys;
    return keys;
  } catch (err) {
    console.warn("Unable to list audit unit buckets:", err);
    return auditKnownUnitKeys;
  }
}

async function fetchAuditRange(startMs, endMs) {
  const unitKeys = await getAuditUnitKeys();
  const snapshots = await Promise.all(unitKeys.map(async (unitKey) => {
    const snapshot = await auditLogsRef.child(unitKey)
      .orderByChild("timestamp")
      .startAt(startMs)
      .endAt(endMs)
      .once("value");
    return { unitKey, snapshot };
  }));
  const rows = [];
  snapshots.forEach(({ unitKey, snapshot }) => {
    snapshot.forEach((eventSnap) => {
      const event = eventSnap.val();
      if (event && typeof event === "object") rows.push({ ...event, _unitKey: unitKey, _eventKey: eventSnap.key });
    });
  });
  rows.sort((a, b) => (b.timestamp || b.clientTime || 0) - (a.timestamp || a.clientTime || 0));
  return rows;
}

function getFilteredAuditRows() {
  return auditLoadedRows.filter((event) => {
    const unitMatch = auditSelectedUnit === "all" || String(event.unitId) === auditSelectedUnit;
    const severityMatch = auditSelectedSeverity === "all" || normalizeAuditSeverity(event.severity, event.eventType) === auditSelectedSeverity;
    const sourceMatch = auditSelectedSource === "all" || getAuditSource(event.source) === auditSelectedSource;
    return unitMatch && severityMatch && sourceMatch;
  });
}

function renderAuditEntries() {
  const list = document.getElementById("auditTrailList");
  if (!list) return;
  const filtered = getFilteredAuditRows();
  const totalPages = Math.max(1, Math.ceil(filtered.length / AUDIT_PAGE_SIZE));
  auditCurrentPage = Math.min(Math.max(1, auditCurrentPage), totalPages);
  const pageStart = (auditCurrentPage - 1) * AUDIT_PAGE_SIZE;
  const pageRows = filtered.slice(pageStart, pageStart + AUDIT_PAGE_SIZE);

  list.innerHTML = pageRows.length ? pageRows.map(event => {
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
      event.closureReason ? `Closure reason: ${event.closureReason}` : "",
      event.closureNotes ? `Notes: ${event.closureNotes}` : "",
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
  }).join("") : '<div class="audit-empty">No matching audit events found in the selected date range.</div>';

  const select = document.getElementById("auditUnitFilter");
  if (select) {
    const units = [...new Set(auditLoadedRows.map(r => String(r.unitId || "Unknown")))].sort((a,b)=>a.localeCompare(b, undefined, {numeric:true}));
    const value = auditSelectedUnit;
    select.innerHTML = '<option value="all">All units / users</option>' + units.map(u => `<option value="${escapeHtml(u)}">${escapeHtml(u)}</option>`).join("");
    select.value = units.includes(value) || value === "all" ? value : "all";
  }

  const pageLabel = document.getElementById("auditPageLabel");
  const previous = document.getElementById("auditPreviousPage");
  const next = document.getElementById("auditNextPage");
  if (pageLabel) pageLabel.textContent = `Page ${auditCurrentPage} of ${totalPages} · ${filtered.length} matching event${filtered.length === 1 ? "" : "s"}`;
  if (previous) previous.disabled = auditCurrentPage <= 1;
  if (next) next.disabled = auditCurrentPage >= totalPages;
}

async function loadAuditTrail() {
  if (userRole !== "admin" || auditLoading) return;
  setDefaultAuditRange();
  const range = getAuditRangeFromInputs();
  if (!range) return;
  auditLoading = true;
  auditLastRange = range;
  const list = document.getElementById("auditTrailList");
  const rangeStatus = document.getElementById("auditRangeStatus");
  if (list) list.innerHTML = '<div class="audit-empty">Loading indexed audit events…</div>';
  if (rangeStatus) rangeStatus.textContent = `Loading ${range.startValue} through ${range.endValue}…`;
  try {
    auditLoadedRows = await fetchAuditRange(range.startMs, range.endMs);
    if (auditSelectedUnit !== "all" && !auditLoadedRows.some((event) => String(event.unitId) === auditSelectedUnit)) {
      auditSelectedUnit = "all";
    }
    auditCurrentPage = 1;
    if (rangeStatus) rangeStatus.textContent = `Loaded ${auditLoadedRows.length} events · ${range.startValue} through ${range.endValue}`;
    renderAuditEntries();
    updateAuditStorageEstimate();
    cleanupOldAuditEvents();
  } catch (err) {
    console.error("Audit range load failed:", err);
    if (list) list.innerHTML = `<div class="audit-empty">Audit load failed: ${escapeHtml(err.message)}</div>`;
    if (rangeStatus) rangeStatus.textContent = "Audit range could not be loaded.";
  } finally {
    auditLoading = false;
  }
}

function stopAuditTrail() {
  auditLoading = false;
}

function filterAuditTrail() {
  auditSelectedUnit = document.getElementById("auditUnitFilter")?.value || "all";
  auditSelectedSeverity = document.getElementById("auditSeverityFilter")?.value || "all";
  auditSelectedSource = document.getElementById("auditSourceFilter")?.value || "all";
  auditCurrentPage = 1;
  renderAuditEntries();
}

function changeAuditPage(direction) {
  auditCurrentPage += direction;
  renderAuditEntries();
  document.getElementById("auditTrailList")?.scrollTo({ top: 0, behavior: "smooth" });
}

function formatAuditBytes(bytes) {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

async function updateAuditStorageEstimate() {
  const status = document.getElementById("auditStorageStatus");
  if (!status) return;
  try {
    const snapshot = await auditMetricsRef.child("daily").once("value");
    let measuredBytes = 0;
    let eventCount = 0;
    snapshot.forEach((daySnap) => {
      const metric = daySnap.val() || {};
      measuredBytes += Number(metric.estimatedBytes || 0);
      eventCount += Number(metric.eventCount || 0);
    });
    auditStorageEstimateBytes = Math.ceil((measuredBytes + AUDIT_LEGACY_RESERVE_BYTES) * 1.25);
    const percent = (auditStorageEstimateBytes / AUDIT_STORAGE_LIMIT_BYTES) * 100;
    const warning = auditStorageEstimateBytes >= AUDIT_STORAGE_WARNING_BYTES;
    status.classList.toggle("audit-storage-warning", warning);
    status.textContent = `${warning ? "WARNING — " : ""}Estimated audit storage: ${formatAuditBytes(auditStorageEstimateBytes)} of 1,024 MB (${percent.toFixed(1)}%) · ${eventCount.toLocaleString()} metered v1.1.12+ events`;
  } catch (err) {
    status.textContent = "Audit storage estimate unavailable.";
  }
}

async function cleanupOldAuditEvents(cutoff = Date.now() - (AUDIT_RETENTION_DAYS * 86400000)) {
  if (userRole !== "admin") return;
  try {
    const unitKeys = auditKnownUnitKeys.length ? auditKnownUnitKeys : await getAuditUnitKeys();
    for (const unitKey of unitKeys) {
      let found = true;
      while (found) {
        const snapshot = await auditLogsRef.child(unitKey)
          .orderByChild("timestamp")
          .endAt(cutoff - 1)
          .limitToFirst(250)
          .once("value");
        const removals = {};
        snapshot.forEach((eventSnap) => {
          const event = eventSnap.val() || {};
          const eventTime = Number(event.timestamp || event.clientTime || 0);
          if (eventTime > 0 && eventTime < cutoff) removals[`${unitKey}/${eventSnap.key}`] = null;
        });
        const count = Object.keys(removals).length;
        found = count === 250;
        if (count) await auditLogsRef.update(removals);
      }
    }

    const metricsSnapshot = await auditMetricsRef.child("daily").once("value");
    const metricRemovals = {};
    metricsSnapshot.forEach((daySnap) => {
      const dayTime = Date.parse(`${daySnap.key}T00:00:00Z`);
      if (Number.isFinite(dayTime) && dayTime < cutoff) metricRemovals[daySnap.key] = null;
    });
    if (Object.keys(metricRemovals).length) await auditMetricsRef.child("daily").update(metricRemovals);
  } catch (err) {
    console.warn("One-year audit cleanup failed:", err);
  }
}

function getAuditExportRows(rows) {
  return rows.map((event) => {
    const clean = { ...event, eventKey: event._eventKey };
    delete clean._unitKey;
    delete clean._eventKey;
    return clean;
  });
}

function escapeAuditCsv(value) {
  const text = value === null || value === undefined ? "" : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function downloadAuditFile(filename, text, mimeType) {
  const blob = new Blob([text], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function exportAuditMonth(format) {
  if (userRole !== "admin") return alert("Admin access required");
  const monthValue = document.getElementById("auditExportMonth")?.value || "";
  const match = /^(\d{4})-(\d{2})$/.exec(monthValue);
  if (!match) return alert("Choose a month to export.");
  const start = new Date(Number(match[1]), Number(match[2]) - 1, 1, 0, 0, 0, 0);
  const end = new Date(Number(match[1]), Number(match[2]), 0, 23, 59, 59, 999);
  const oldestAllowed = Date.now() - (AUDIT_RETENTION_DAYS * 86400000);
  if (end.getTime() < oldestAllowed) return alert(`Only the most recent ${AUDIT_RETENTION_DAYS} days remain in live storage.`);

  const status = document.getElementById("auditRangeStatus");
  if (status) status.textContent = `Preparing ${monthValue} ${String(format).toUpperCase()} archive…`;
  try {
    const rows = await fetchAuditRange(start.getTime(), end.getTime());
    const exported = getAuditExportRows(rows);
    if (format === "json") {
      downloadAuditFile(`GCSO_AVL_Audit_${monthValue}.json`, JSON.stringify({
        generatedAt: new Date().toISOString(),
        month: monthValue,
        retentionDays: AUDIT_RETENTION_DAYS,
        eventCount: exported.length,
        events: exported
      }, null, 2), "application/json");
    } else {
      const fields = ["eventKey", "timestamp", "clientTime", "unitId", "actorName", "actorType", "severity", "eventType", "description", "source", "buttonLabel", "targetUnit", "reason", "closureReason", "closureNotes", "deviceId", "sessionId", "appVersion", "browser", "platform", "publicIp", "lastGpsLat", "lastGpsLon", "lastGpsTimestamp", "lastGpsSource", "serialReceiver", "serialPortId", "serialBaud", "fixQuality", "satellites", "hdop"];
      const csv = [fields.join(","), ...exported.map((event) => fields.map((field) => escapeAuditCsv(event[field])).join(","))].join("\r\n");
      downloadAuditFile(`GCSO_AVL_Audit_${monthValue}.csv`, csv, "text/csv;charset=utf-8");
    }
    writeAuditEvent("audit_month_exported", `Administrator exported ${monthValue} audit archive as ${String(format).toUpperCase()}`, {
      source: "admin",
      severity: "action",
      reason: `${exported.length} events exported`
    });
    if (status) status.textContent = `Exported ${exported.length} events for ${monthValue}.`;
  } catch (err) {
    console.error("Audit export failed:", err);
    if (status) status.textContent = `Audit export failed: ${err.message}`;
  }
}

document.addEventListener("click", (event) => {
  const button = event.target.closest("button");
  if (!button || !currentUnitId) return;
  const label = (button.innerText || button.getAttribute("aria-label") || "Button").trim();
  const adminAction = userRole === "admin" && /remove|disconnect|force|audit|export/i.test(label);
  writeAuditEvent("button_pressed", `Button pressed: ${label}`, {
    source: adminAction ? "admin" : "user",
    severity: "action",
    buttonLabel: label,
    controlLocation: button.closest("#developerPanel") ? "admin audit panel" : button.closest("#adminControls") ? "admin controls" : "main interface",
    targetUnit: selectedRosterUnitId || ""
  });
});

//////////////////////////////////////////////////////
// RETIRED CONTROL CLEANUP
//////////////////////////////////////////////////////

// Remove state left by the retired GPS lock and closure-reason workflow. A
// prior unexplained close must never block GPS controls after this update.
localStorage.removeItem("avl_gpsDisconnectLock");
localStorage.removeItem("avl_openSessionMarker");
localStorage.removeItem("avl_plannedClosureUntil");

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
  const activeIdentity = document.getElementById("activeIdentity");
  const logoutButton = document.getElementById("logoutButton");

  if (gpsControls) gpsControls.classList.toggle("mode-hidden", userMode === "dispatch");
  if (logoutButton) logoutButton.classList.toggle("mode-hidden", userMode !== "dispatch");
  if (activeIdentity) {
    const identityType = userMode === "dispatch" ? "Dispatcher" : "Unit";
    activeIdentity.textContent = currentUnitId ? `${identityType}: ${currentUnitId}` : "Not logged in";
  }

  document.querySelectorAll(".admin-only").forEach((el) => {
    const shouldShow = userRole === "admin" && (el.id !== "developerPanel" || developerPanelVisible);
    el.classList.toggle("mode-hidden", !shouldShow);
  });

  if (userMode === "dispatch") {
    setFixDetails("Dispatch view only. GPS controls are hidden.");
  }
  configureRosterDataSubscriptions();
}

function startPresenceHeartbeat() {
  if (!currentUnitId) return;

  if (presenceTimer) {
    clearInterval(presenceTimer);
    presenceTimer = null;
  }

  publishPresence();
  presenceTimer = setInterval(() => publishPresence(true), HEARTBEAT_SECONDS * 1000);
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
    eventTime: Date.now(),
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
    closureReason: "",
    closureNotes: "",
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

function publishPresence(heartbeatOnly = false) {
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

  const heartbeatPayload = {
    lastSeen: presencePayload.lastSeen,
    serverLastSeen: presencePayload.serverLastSeen,
    networkOnline: presencePayload.networkOnline,
    firebaseConnected: presencePayload.firebaseConnected,
    gpsSource: presencePayload.gpsSource,
    lastGpsTime: presencePayload.lastGpsTime,
    lastUploadTime: presencePayload.lastUploadTime,
    serialConnected: presencePayload.serialConnected,
    serialPhase: presencePayload.serialPhase,
    lastNmeaType: presencePayload.lastNmeaType,
    lastNmeaTime: presencePayload.lastNmeaTime,
    fixQuality: presencePayload.fixQuality,
    satellites: presencePayload.satellites,
    hdop: presencePayload.hdop
  };

  const presenceWrite = heartbeatOnly
    ? sessionsRef.child(currentSessionKey).update(heartbeatPayload)
    : sessionsRef.child(currentSessionKey).set(presencePayload);

  presenceWrite.then(() => {
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

  await disconnectSerialGPS(true, { bypassLock: true, endSession: true, reason: "Explicit logout" });
  await stopLiveUnitPublishing(currentUnitId);
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

    // Chrome can pause serial callbacks while the Toughbook is asleep or
    // undocked. Re-check promptly when the page becomes active again.
    if (serialAutoMode && !serialPort) {
      scheduleSerialRescan("AVL resumed — checking for docked GPS receiver", 500, true);
    }
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
    const pendingFixPublished = lastPendingFix ? await flushPendingFix() : false;
    if (!pendingFixPublished && currentUnitId && lastFix) {
      // Reassert the latest known fix once after a cellular outage. The GPS
      // timestamp is preserved, so this does not pretend an old fix is new.
      queueUnitFixForPublish(currentUnitId, lastFix, { force: true, reason: "firebase_recovery" });
      await flushQueuedUnitPublish("firebase_recovery");
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

  const summary = document.getElementById("gpsDetailsSummary");
  if (summary) {
    const state = connected && packetFresh
      ? "Connected"
      : connected || serialAutoMode
        ? "Connecting"
        : "Stopped";
    summary.innerText = `GPS Details — ${state}`;
    summary.dataset.state = healthClass;
  }

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
    `Publishing: ${firebaseConnected ? "Firebase connected · adaptive 5s moving / 30s stopped" : lastPendingFix ? "Queued for reconnect" : "Firebase disconnected"}`
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

async function publishUnitData(id, data, publishEpoch = unitPublishEpoch) {
  if (!id || !data) return false;
  savePendingFix(id, data);

  try {
    await unitsRef.child(id).set(data);
    lastSuccessfulWriteTime = Date.now();
    if (publishEpoch === unitPublishEpoch && id === currentUnitId && isValidLatLon(data.lat, data.lon)) {
      lastNetworkPublishedFix = data;
      lastNetworkPublishedUnitId = id;
      lastNetworkPublishTime = lastSuccessfulWriteTime;
    }
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
  if (!firebaseConnected || !currentUnitId || !lastPendingFix || !lastPendingUnitId) return false;
  if (lastPendingUnitId !== currentUnitId) return false;
  if (unitPublishInFlightPromise) await unitPublishInFlightPromise.catch(() => {});
  if (!lastPendingFix || !lastPendingUnitId) return true;

  const pendingId = lastPendingUnitId;
  const pendingData = lastPendingFix;
  queueUnitFixForPublish(pendingId, pendingData, { force: true, reason: "offline_fix_recovery" });
  return flushQueuedUnitPublish("offline_fix_recovery");
}

function getGpsPublishInterval(data) {
  return Number(data?.speed || 0) >= GPS_MOVING_SPEED_MPS
    ? GPS_MOVING_PUBLISH_MS
    : GPS_STATIONARY_PUBLISH_MS;
}

function getGpsDistanceMeters(a, b) {
  if (!a || !b || !isValidLatLon(a.lat, a.lon) || !isValidLatLon(b.lat, b.lon)) return 0;
  const toRadians = (degrees) => degrees * Math.PI / 180;
  const earthRadiusMeters = 6371000;
  const latitudeDelta = toRadians(b.lat - a.lat);
  const longitudeDelta = toRadians(b.lon - a.lon);
  const latitudeA = toRadians(a.lat);
  const latitudeB = toRadians(b.lat);
  const haversine =
    Math.sin(latitudeDelta / 2) ** 2 +
    Math.cos(latitudeA) * Math.cos(latitudeB) * Math.sin(longitudeDelta / 2) ** 2;
  return earthRadiusMeters * 2 * Math.atan2(Math.sqrt(haversine), Math.sqrt(1 - haversine));
}

function getHeadingDifference(a, b) {
  const headingA = Number(a?.heading);
  const headingB = Number(b?.heading);
  if (!Number.isFinite(headingA) || !Number.isFinite(headingB)) return 0;
  const difference = Math.abs(((headingB - headingA + 540) % 360) - 180);
  return Number.isFinite(difference) ? difference : 0;
}

function shouldImmediatelyPublishFix(id, data) {
  if (!lastNetworkPublishedFix || lastNetworkPublishedUnitId !== id) return false;

  const wasMoving = Number(lastNetworkPublishedFix.speed || 0) >= GPS_MOVING_SPEED_MPS;
  const isMoving = Number(data?.speed || 0) >= GPS_MOVING_SPEED_MPS;
  if (!wasMoving && isMoving) return true;
  if (getGpsDistanceMeters(lastNetworkPublishedFix, data) >= GPS_IMMEDIATE_DISTANCE_METERS) return true;
  return isMoving && getHeadingDifference(lastNetworkPublishedFix, data) >= GPS_IMMEDIATE_HEADING_DEGREES;
}

function clearUnitPublishTimer() {
  if (unitPublishTimer) clearTimeout(unitPublishTimer);
  unitPublishTimer = null;
  unitPublishTimerDue = 0;
}

function armUnitPublishTimer(delayMs, reason) {
  const safeDelay = Math.max(0, Math.round(delayMs || 0));
  const due = Date.now() + safeDelay;
  if (unitPublishTimer && unitPublishTimerDue <= due) return;

  clearUnitPublishTimer();
  unitPublishTimerDue = due;
  unitPublishTimer = setTimeout(() => {
    unitPublishTimer = null;
    unitPublishTimerDue = 0;
    flushQueuedUnitPublish(reason);
  }, safeDelay);
}

async function flushQueuedUnitPublish(reason = "scheduled") {
  if (unitPublishInFlight || !firebaseConnected || !queuedUnitPublishData || !queuedUnitPublishId) return false;

  clearUnitPublishTimer();
  const id = queuedUnitPublishId;
  const data = queuedUnitPublishData;
  const publishReason = queuedUnitPublishReason || reason;
  queuedUnitPublishId = null;
  queuedUnitPublishData = null;
  queuedUnitPublishReason = "";

  if (
    lastNetworkPublishedUnitId === id &&
    lastNetworkPublishedFix?.gpsTime &&
    lastNetworkPublishedFix.gpsTime === data.gpsTime
  ) {
    return true;
  }

  unitPublishInFlight = true;
  const publishEpoch = unitPublishEpoch;
  const publishPromise = publishUnitData(id, data, publishEpoch);
  unitPublishInFlightPromise = publishPromise;
  const succeeded = await publishPromise;
  if (unitPublishInFlightPromise !== publishPromise) return succeeded;
  unitPublishInFlightPromise = null;
  unitPublishInFlight = false;
  debugLog(`Live GPS publish ${succeeded ? "completed" : "failed"}: ${publishReason}`);

  if (queuedUnitPublishData && queuedUnitPublishId) {
    const interval = getGpsPublishInterval(queuedUnitPublishData);
    const elapsed = Math.max(0, Date.now() - lastNetworkPublishTime);
    armUnitPublishTimer(succeeded ? Math.max(0, interval - elapsed) : 1000, "queued_after_write");
  }

  return succeeded;
}

async function stopLiveUnitPublishing(id, discardOfflineFix = true) {
  unitPublishEpoch += 1;
  clearUnitPublishTimer();
  if (!id || queuedUnitPublishId === id) {
    queuedUnitPublishId = null;
    queuedUnitPublishData = null;
    queuedUnitPublishReason = "";
  }

  // Firebase preserves local write order, so the following remove is queued
  // after any earlier position write. Detach that older promise so poor service
  // cannot delay Stop GPS or block a later Start GPS from publishing.
  unitPublishInFlightPromise = null;
  unitPublishInFlight = false;

  if (discardOfflineFix && (!id || lastPendingUnitId === id)) {
    lastPendingFix = null;
    lastPendingUnitId = null;
    localStorage.removeItem("avl_pendingUnitId");
    localStorage.removeItem("avl_pendingFix");
  }

  if (!id || lastNetworkPublishedUnitId === id) {
    lastNetworkPublishedFix = null;
    lastNetworkPublishedUnitId = null;
    lastNetworkPublishTime = 0;
  }
}

function queueUnitFixForPublish(id, data, options = {}) {
  if (!id || !data || !isValidLatLon(data.lat, data.lon)) return;

  queuedUnitPublishId = id;
  queuedUnitPublishData = data;
  queuedUnitPublishReason = options.reason || "gps_update";

  if (!firebaseConnected) {
    // Keep only the newest offline position. It is restored after connectivity
    // returns instead of replaying an expensive trail of stale fixes.
    savePendingFix(id, data);
    return;
  }

  if (options.force) {
    armUnitPublishTimer(0, queuedUnitPublishReason);
    return;
  }

  const firstPublishForUnit = !lastNetworkPublishedFix || lastNetworkPublishedUnitId !== id;
  if (firstPublishForUnit) {
    // RMC and GGA normally arrive as a pair. A short delay lets the richer GGA
    // data replace the RMC-only candidate so one combined fix is sent.
    const delay = data.gpsSource?.startsWith("serial") ? GPS_SERIAL_COALESCE_MS : 0;
    armUnitPublishTimer(delay, "first_fix");
    return;
  }

  if (shouldImmediatelyPublishFix(id, data)) {
    armUnitPublishTimer(0, "significant_movement");
    return;
  }

  const interval = getGpsPublishInterval(data);
  const elapsed = Math.max(0, Date.now() - lastNetworkPublishTime);
  armUnitPublishTimer(Math.max(0, interval - elapsed), queuedUnitPublishReason);
}

function toggleDeveloperPanel() {
  if (userRole !== "admin") return alert("Admin access required");
  developerPanelVisible = !developerPanelVisible;
  if (developerPanelVisible) playAvlFunSound("developer");
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
    `Last GPS location upload: ${lastWrite}`,
    `Live GPS cadence: 5 sec moving / 30 sec stopped`,
    `Presence heartbeat: ${HEARTBEAT_SECONDS} sec dynamic-field update`,
    `Last live GPS publish: ${lastNetworkPublishTime ? formatLastUpdateAge(lastNetworkPublishTime) : "Not published yet"}`,
    `Live GPS fix queued: ${queuedUnitPublishData ? "YES" : "NO"}`,
    `Session roster feed: ${sessionRosterSubscribed ? "FULL (dispatch/admin)" : dispatchRosterSubscribed ? "DISPATCH ONLY (bandwidth-saving unit mode)" : "DISABLED"}`,
    `Pending fix: ${lastPendingFix ? "YES" : "NO"}`,
    `Pending audit events: ${pendingAuditEvents.length}`,
    `Serial: ${serialPort ? `CONNECTED @ ${currentSerialBaud || "?"}` : "DISCONNECTED"}`,
    `Receiver: ${currentSerialLabel}`,
    `Port ID: ${currentSerialPortId}`,
    `Preferred receiver: ${getPreferredReceiverDescription()}`,
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

function getPreferredReceiverDescription() {
  const label = localStorage.getItem("avl_preferredGpsLabel");
  const portId = localStorage.getItem("avl_preferredGpsPortId");
  if (preferredSerialPort) return `${getSerialPortLabel(preferredSerialPort)} · ${getSerialPortId(preferredSerialPort)}`;
  if (label || portId) return `${label || "Selected GPS receiver"}${portId ? ` · ${portId}` : ""}`;
  return "Not selected";
}

function renderSelectedReceiverStatus() {
  const status = document.getElementById("selectedReceiverStatus");
  if (!status) return;
  const preferredSignature = localStorage.getItem("avl_preferredGpsSignature");
  status.textContent = preferredSignature
    ? `Selected: ${getPreferredReceiverDescription()}`
    : "No preferred receiver selected. Choose Select Receiver before starting GPS.";
}

function prioritizeAuthorizedSerialPorts(ports) {
  const preferredSignature = localStorage.getItem("avl_preferredGpsSignature");
  if (!preferredSignature) return [];

  if (preferredSerialPort && ports.includes(preferredSerialPort)) return [preferredSerialPort];

  const preferredMatches = ports.filter((port) => getSerialPortSignature(port) === preferredSignature);
  if (preferredMatches.length) {
    const storedOrdinal = parseInt(localStorage.getItem("avl_preferredGpsOrdinal"), 10);
    preferredSerialPort = Number.isInteger(storedOrdinal) && preferredMatches[storedOrdinal]
      ? preferredMatches[storedOrdinal]
      : preferredMatches[0];
    renderSelectedReceiverStatus();
  }
  return preferredSerialPort ? [preferredSerialPort] : [];
}

function clearPreferredSerialReceiverSelection() {
  preferredSerialPort = null;
  serialReconnectPort = null;
  currentSerialLabel = "External USB GPS";
  currentSerialPortId = "Not selected";
  localStorage.removeItem("avl_preferredGpsSignature");
  localStorage.removeItem("avl_preferredGpsLabel");
  localStorage.removeItem("avl_preferredGpsPortId");
  localStorage.removeItem("avl_preferredGpsOrdinal");
  localStorage.removeItem("avl_preferredGpsBaud");
  localStorage.removeItem("avl_preferredGpsValidated");
  localStorage.removeItem("avl_hasAuthorizedGps");
  renderSelectedReceiverStatus();
}

function getSerialEventPort(event) {
  const candidate = event?.port || event?.target || null;
  return candidate && typeof candidate.getInfo === "function" ? candidate : null;
}

function cancelActiveSerialProbe() {
  if (serialProbeReader) serialProbeReader.cancel().catch(() => {});
}

function getBaudCandidates(excludedBaud = null) {
  const baudSelect = document.getElementById("baudRate");
  const selected = parseInt(baudSelect?.value || localStorage.getItem("avl_lastBaudRate"), 10) || 4800;
  localStorage.setItem("avl_lastBaudRate", String(selected));
  return [selected, ...SERIAL_BAUD_RATES]
    .filter((v, i, arr) => arr.indexOf(v) === i)
    .filter((v) => v !== excludedBaud);
}

function looksLikeNMEA(sentence) {
  return (
    sentence.startsWith("$GPRMC") || sentence.startsWith("$GNRMC") ||
    sentence.startsWith("$GARMC") || sentence.startsWith("$GLRMC") ||
    sentence.startsWith("$GPGGA") || sentence.startsWith("$GNGGA") ||
    sentence.startsWith("$GAGGA") || sentence.startsWith("$GLGGA")
  );
}

function scheduleSerialRescan(reason = "GPS disconnected", delayMs = GPS_RESCAN_MS, replaceExisting = false) {
  if (!serialAutoMode) return;
  if (serialReconnectTimer && !replaceExisting) return;
  if (serialReconnectTimer) clearTimeout(serialReconnectTimer);

  serialConnectionPhase = `${reason} — retrying in ${Math.round(delayMs / 100) / 10} sec`;
  setStatus(`${reason}. Start GPS will keep retrying the selected receiver...`, "warn");
  renderReceiverHealth();

  serialReconnectTimer = setTimeout(async () => {
    serialReconnectTimer = null;
    if (serialAutoMode) await connectSerialGPS(true);
  }, delayMs);
}

async function handleSerialDeviceDisconnected(event) {
  const removedPort = getSerialEventPort(event);
  const removedActivePort = !!serialPort && (!removedPort || removedPort === serialPort);
  const removedProbePort = !!serialProbePort && (!removedPort || removedPort === serialProbePort);
  const removedLastReceiver = !!removedPort && removedPort === lastSuccessfulSerialPort;
  const removedPreferredReceiver = !!removedPort && removedPort === preferredSerialPort;

  // Ignore unrelated serial hardware. A receiver is accepted by its NMEA
  // stream, not by a hard-coded USB vendor/product identifier.
  if (!removedActivePort && !removedProbePort && !removedLastReceiver && !removedPreferredReceiver) return;
  if (!serialAutoMode && !removedActivePort && !removedProbePort) return;

  serialDeviceMissing = true;
  serialDeviceReturnedTime = 0;
  serialReconnectPort = null;
  serialConnectionPhase = "GPS receiver removed from USB/dock — waiting for redock";
  serialConnectGeneration += 1;
  serialReadGeneration += 1;
  serialKeepReading = false;

  const readerToCancel = serialReader;
  serialReader = null;
  serialPort = null;
  if (readerToCancel) readerToCancel.cancel().catch(() => {});
  cancelActiveSerialProbe();

  setStatus("External GPS hardware unavailable. Computer may be undocked; waiting for receiver...", "warn");
  addDiagnosticEvent("USB GPS removed from host/dock");
  writeAuditEvent("serial_device_removed", "USB GPS receiver was removed from the computer; waiting for redock or reconnection", {
    source: "system",
    severity: "warning",
    reason: "Web Serial device-disconnect event",
    includeLocation: true,
    lookupStoredLocation: true
  });
  renderReceiverHealth();

  scheduleSerialRescan("Waiting for docked GPS receiver", GPS_RESCAN_MS, true);
}

function handleSerialDeviceConnected(event) {
  const returnedPort = getSerialEventPort(event);
  if (!returnedPort || !serialAutoMode || userMode === "dispatch") return;
  if (serialPort && !serialDeviceMissing) return;
  const wasWaitingForKnownGps = (
    serialDeviceMissing ||
    !!preferredSerialPort ||
    !!localStorage.getItem("avl_preferredGpsSignature") ||
    !!lastSuccessfulSerialPort ||
    !!localStorage.getItem("avl_lastGpsSignature")
  );
  if (!wasWaitingForKnownGps) return;

  // Treat the returned port only as the first candidate. It still has to
  // produce valid NMEA before AVL accepts it as the GPS receiver.
  serialReconnectPort = returnedPort;
  serialDeviceReturnedTime = Date.now();
  serialConnectionPhase = "Serial device detected after redock — waiting for Windows to finish setup";
  setStatus("Serial device detected after redock. Waiting for Windows, then validating GPS data...", "warn");
  addDiagnosticEvent("Serial device detected after redock; NMEA validation pending");
  writeAuditEvent("serial_device_detected", "A serial device reappeared after undocking; GPS validation and automatic reopen started", {
    source: "automatic",
    severity: "info",
    reason: "Web Serial device-connect event",
    includeLocation: true,
    lookupStoredLocation: true
  });
  renderReceiverHealth();

  scheduleSerialRescan("Serial device detected after redock", SERIAL_REENUMERATION_MS, true);
}

if ("serial" in navigator) {
  navigator.serial.addEventListener("disconnect", handleSerialDeviceDisconnected);
  navigator.serial.addEventListener("connect", handleSerialDeviceConnected);
}

//////////////////////////////////////////////////////
// SELECT THE AUTHORITATIVE GPS RECEIVER
//////////////////////////////////////////////////////

async function selectSerialGPSReceiver() {
  if (!("serial" in navigator)) {
    alert("Web Serial is not supported in this browser. Use Chrome or Edge.");
    return;
  }
  if (userMode === "dispatch") return alert("Dispatch view is view-only. GPS controls are disabled.");

  try {
    serialConnectionPhase = "Waiting for receiver selection";
    renderReceiverHealth();
    setStatus("Choose the GPS receiver attached to this computer.", "warn");
    const selectedPort = await navigator.serial.requestPort();
    const previousLastSignature = localStorage.getItem("avl_lastGpsSignature");
    const previousLastBaud = parseInt(localStorage.getItem("avl_lastBaudRate"), 10);

    // Selecting hardware must not depend on an immediate satellite fix or even
    // an immediately available NMEA stream. Start GPS owns the connection test.
    serialAutoMode = false;
    serialConnectGeneration += 1;
    serialConnectionAttemptQueued = false;
    queuedConnectionIsManual = false;
    serialForceBaudScan = false;
    serialFailedBaud = null;
    cancelActiveSerialProbe();
    await disconnectSerialGPS(false);
    clearPreferredSerialReceiverSelection();

    preferredSerialPort = selectedPort;
    serialReconnectPort = selectedPort;
    currentSerialLabel = getSerialPortLabel(selectedPort);
    currentSerialPortId = getSerialPortId(selectedPort);
    const preferredSignature = getSerialPortSignature(selectedPort);
    currentSerialBaud = (
      previousLastSignature === preferredSignature &&
      SERIAL_BAUD_RATES.includes(previousLastBaud)
    ) ? previousLastBaud : 4800;
    const authorizedPorts = await navigator.serial.getPorts();
    const stalePorts = authorizedPorts.filter((port) => port !== selectedPort);
    let forgottenPortCount = 0;
    for (const stalePort of stalePorts) {
      if (typeof stalePort.forget !== "function") continue;
      try {
        await stalePort.forget();
        forgottenPortCount += 1;
      } catch (_) {}
    }
    const retainedPorts = await navigator.serial.getPorts();
    const matchingPorts = retainedPorts.filter((port) => getSerialPortSignature(port) === preferredSignature);
    const preferredOrdinal = Math.max(0, matchingPorts.indexOf(selectedPort));
    localStorage.setItem("avl_preferredGpsSignature", preferredSignature);
    localStorage.setItem("avl_preferredGpsLabel", currentSerialLabel);
    localStorage.setItem("avl_preferredGpsPortId", currentSerialPortId);
    localStorage.setItem("avl_preferredGpsOrdinal", String(preferredOrdinal));
    localStorage.setItem("avl_preferredGpsBaud", String(currentSerialBaud));
    localStorage.setItem("avl_hasAuthorizedGps", "true");
    serialConnectionPhase = `Receiver selected — ready to open at ${currentSerialBaud} baud`;
    renderSelectedReceiverStatus();
    renderReceiverHealth();
    writeAuditEvent("gps_receiver_selected", `GPS receiver selected: ${currentSerialLabel}; initial baud ${currentSerialBaud}`, {
      source: "user",
      severity: "action",
      buttonLabel: "Select Receiver",
      reason: currentSerialPortId
    });
    addDiagnosticEvent(
      `GPS receiver selected: ${currentSerialLabel}; initial baud ${currentSerialBaud}` +
      (forgottenPortCount ? `; cleared ${forgottenPortCount} stale serial permission${forgottenPortCount === 1 ? "" : "s"}` : "")
    );
    setStatus(`Receiver selected: ${currentSerialLabel}. Press Start GPS.`, "good");
  } catch (err) {
    if (err?.name === "NotFoundError") {
      setStatus("Receiver selection canceled.", "warn");
      return;
    }
    setStatus("GPS receiver could not be selected: " + err.message, "bad");
  }
}

// Backward-compatible alias for an older cached page.
function grantSerialGPSPermission() {
  return selectSerialGPSReceiver();
}

async function restorePreferredSerialReceiver() {
  renderSelectedReceiverStatus();
  if (!("serial" in navigator)) return;
  const preferredSignature = localStorage.getItem("avl_preferredGpsSignature");
  if (!preferredSignature) return;

  try {
    const authorizedPorts = await navigator.serial.getPorts();
    const preferredMatches = authorizedPorts.filter((port) => getSerialPortSignature(port) === preferredSignature);
    const storedOrdinal = parseInt(localStorage.getItem("avl_preferredGpsOrdinal"), 10);
    preferredSerialPort = Number.isInteger(storedOrdinal) && preferredMatches[storedOrdinal]
      ? preferredMatches[storedOrdinal]
      : preferredMatches[0] || null;
    if (preferredSerialPort) {
      currentSerialLabel = getSerialPortLabel(preferredSerialPort);
      currentSerialPortId = getSerialPortId(preferredSerialPort);
      localStorage.setItem("avl_preferredGpsLabel", currentSerialLabel);
      localStorage.setItem("avl_preferredGpsPortId", currentSerialPortId);
    }
    renderSelectedReceiverStatus();
  } catch (_) {}
}

restorePreferredSerialReceiver();

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

  if (!localStorage.getItem("avl_preferredGpsSignature")) {
    setStatus("Select a GPS receiver before starting GPS.", "warn");
    if (!isRetry) alert("Press Select Receiver and choose the GPS dongle this unit should use.");
    return;
  }

  currentUnitId = id;
  localStorage.setItem("avl_unitId", id);
  localStorage.setItem("avl_mode", userMode || "unit");

  // User-initiated Start GPS sound. Automatic retry attempts stay silent.
  if (!isRetry) playAvlFunSound("gpsStart");

  serialAutoMode = true;
  if (!isRetry) {
    serialForceBaudScan = false;
    serialFailedBaud = null;
    pendingManualGpsStart = {
      requestedAt: Date.now(),
      buttonLabel: "Start GPS"
    };
  }

  // A retry may already be probing a port when the user presses Start GPS.
  // Invalidate that probe and queue one clean attempt instead of letting two
  // scans fight over the same receiver.
  if (serialConnectionAttemptInProgress) {
    serialConnectionAttemptQueued = true;
    queuedConnectionIsManual = queuedConnectionIsManual || !isRetry;
    serialConnectGeneration += 1;
    cancelActiveSerialProbe();
    serialConnectionPhase = "Fresh GPS scan queued — releasing the previous attempt";
    setStatus("Restarting GPS detection with a fresh serial scan...", "warn");
    renderReceiverHealth();
    return;
  }

  serialConnectionAttemptInProgress = true;
  const attemptGeneration = ++serialConnectGeneration;

  try {
    await runSerialGpsConnectionAttempt(isRetry, attemptGeneration);
  } finally {
    serialConnectionAttemptInProgress = false;

    if (serialConnectionAttemptQueued && serialAutoMode) {
      const nextAttemptIsRetry = !queuedConnectionIsManual;
      serialConnectionAttemptQueued = false;
      queuedConnectionIsManual = false;
      setTimeout(() => connectSerialGPS(nextAttemptIsRetry), 250);
    }
  }
}

async function runSerialGpsConnectionAttempt(isRetry, attemptGeneration) {
  const attemptIsCurrent = () => attemptGeneration === serialConnectGeneration;

  try {
    serialConnectionPhase = "Releasing previous serial connection";
    renderReceiverHealth();
    await disconnectSerialGPS(false);
    if (!attemptIsCurrent()) return;

    // The USB stack needs a moment after redocking before the returning device
    // can be opened reliably. A single Start GPS press is enough; retries
    // continue automatically if enumeration is not finished yet.
    if (serialDeviceReturnedTime) {
      const remainingSettleTime = SERIAL_REENUMERATION_MS - (Date.now() - serialDeviceReturnedTime);
      if (remainingSettleTime > 0) await new Promise(resolve => setTimeout(resolve, remainingSettleTime));
      if (!attemptIsCurrent()) return;
    }

    let ports = await navigator.serial.getPorts();
    if (!attemptIsCurrent()) return;

    if (!ports.length) {
      serialDeviceMissing = true;
      scheduleSerialRescan("Selected GPS receiver is not available in Windows");
      return;
    }

    // Selection is authoritative. Other authorized serial devices—including a
    // no-fix onboard modem—are never substituted for the chosen receiver.
    ports = prioritizeAuthorizedSerialPorts(ports);
    if (!ports.length) {
      serialDeviceMissing = true;
      scheduleSerialRescan("Selected GPS receiver is unavailable; use Select Receiver if it was replaced");
      return;
    }

    const preferredBaud = parseInt(
      localStorage.getItem("avl_preferredGpsBaud") ||
      localStorage.getItem("avl_lastBaudRate"),
      10
    ) || 4800;
    let found = null;

    if (!serialForceBaudScan) {
      // The deputy already chose this exact hardware. Open it immediately;
      // selection must not depend on the receiver already having a GPS fix.
      found = { port: ports[0], baudRate: preferredBaud };
      serialConnectionPhase = `Opening selected receiver directly at ${preferredBaud} baud`;
      setStatus(`Opening ${getPreferredReceiverDescription()} @ ${preferredBaud} baud...`, "warn");
      renderReceiverHealth();
    } else {
      serialConnectionPhase = "No NMEA at preferred baud — checking alternate baud rates";
      setStatus(`Receiver opened but sent no NMEA at ${serialFailedBaud || preferredBaud} baud. Checking alternate rates...`, "warn");
      renderReceiverHealth();
      found = await findNmeaGpsPort(ports, attemptGeneration, serialFailedBaud);
      if (found) {
        localStorage.setItem("avl_preferredGpsBaud", String(found.baudRate));
        serialForceBaudScan = false;
        serialFailedBaud = null;
      }
    }
    if (!attemptIsCurrent()) return;

    if (!found) {
      serialForceBaudScan = false;
      serialFailedBaud = null;
      scheduleSerialRescan("No valid NMEA GPS stream found");
      return;
    }

    if (serialReconnectTimer) {
      clearTimeout(serialReconnectTimer);
      serialReconnectTimer = null;
    }

    serialPort = found.port;
    lastSuccessfulSerialPort = found.port;
    serialReconnectPort = null;
    serialDeviceMissing = false;
    serialDeviceReturnedTime = 0;
    currentSerialBaud = found.baudRate;
    currentSerialLabel = getSerialPortLabel(serialPort);
    currentSerialPortId = getSerialPortId(serialPort);
    localStorage.setItem("avl_lastGpsSignature", getSerialPortSignature(serialPort));
    localStorage.setItem("avl_lastBaudRate", String(currentSerialBaud));
    localStorage.setItem("avl_preferredGpsBaud", String(currentSerialBaud));
    localStorage.setItem("avl_hasAuthorizedGps", "true");
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
    if (!attemptIsCurrent()) {
      await serialPort.close().catch(() => {});
      if (serialPort === found.port) serialPort = null;
      return;
    }

    serialKeepReading = true;
    serialFixLoggedForConnection = false;
    serialOpenedTime = Date.now();
    lastNmeaPacketTime = 0;
    serialConnectionPhase = "Serial port open — waiting for NMEA";
    setStatus(`External GPS connected: ${currentSerialLabel} @ ${currentSerialBaud} baud — waiting for position`, "good");
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

    const readGeneration = ++serialReadGeneration;
    readSerialLoop(serialPort, readGeneration);

  } catch (err) {
    if (!attemptIsCurrent()) return;
    console.error(err);
    const busy = /busy|open|access|networkerror/i.test(String(err?.message || err));
    serialConnectionPhase = busy
      ? "Receiver busy or not fully released by another application"
      : `Connection error: ${err.message}`;
    setStatus("Start GPS failed: " + err.message, "bad");
    renderReceiverHealth();
    writeAuditEvent("serial_connect_failed", `External GPS connection failed: ${err.message}`, { source: "system", severity: "warning", reason: err.message });
    scheduleSerialRescan("External GPS error");
  }
}

async function findNmeaGpsPort(ports, attemptGeneration, excludedBaud = null) {
  const baudCandidates = getBaudCandidates(excludedBaud);

  for (const port of ports) {
    for (const baudRate of baudCandidates) {
      if (attemptGeneration !== serialConnectGeneration) return null;
      serialConnectionPhase = `Checking ${getSerialPortLabel(port)} at ${baudRate} baud`;
      setStatus(`Checking ${getSerialPortLabel(port)} @ ${baudRate} baud...`, "warn");
      renderReceiverHealth();

      const ok = await probePortForNmea(port, baudRate, GPS_PROBE_MS, attemptGeneration);
      if (attemptGeneration !== serialConnectGeneration) return null;
      if (ok) {
        return { port, baudRate };
      }
    }
  }

  return null;
}

async function probePortForNmea(port, baudRate, probeMs, attemptGeneration) {
  let reader = null;
  let buffer = "";
  const decoder = new TextDecoder();

  try {
    serialProbePort = port;
    await port.open({
      baudRate,
      dataBits: 8,
      stopBits: 1,
      parity: "none",
      flowControl: "none"
    });

    reader = port.readable.getReader();
    serialProbeReader = reader;
    const deadline = Date.now() + probeMs;

    while (Date.now() < deadline) {
      if (attemptGeneration !== serialConnectGeneration) break;
      const remaining = Math.max(250, deadline - Date.now());
      const readPromise = reader.read();
      const timeoutPromise = new Promise(resolve => setTimeout(() => resolve({ timeout: true }), remaining));
      const result = await Promise.race([readPromise, timeoutPromise]);

      if (attemptGeneration !== serialConnectGeneration) break;
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

    if (serialProbeReader === reader) serialProbeReader = null;
    if (serialProbePort === port) serialProbePort = null;

    try {
      await port.close();
    } catch (_) {}
  }

  return false;
}

//////////////////////////////////////////////////////
// DISCONNECT SERIAL GPS
//////////////////////////////////////////////////////

async function disconnectSerialGPS(manual = true, options = {}) {
  // Only the deliberate Stop GPS action gets a sound. Internal reconnects and
  // logout/session cleanup remain silent. Keep this before the first await so
  // browser audio permission is satisfied by the user's click.
  if (manual && !options.endSession) playAvlFunSound("gpsStop");

  if (manual) {
    serialAutoMode = false;
    serialConnectGeneration += 1;
    serialConnectionAttemptQueued = false;
    queuedConnectionIsManual = false;
    serialForceBaudScan = false;
    serialFailedBaud = null;
    cancelActiveSerialProbe();
  }

  // Invalidate the currently running read loop before touching the global
  // port. Its finally block must never close a replacement port opened after
  // a redock.
  serialReadGeneration += 1;
  serialKeepReading = false;
  serialBuffer = "";

  if (serialReconnectTimer) {
    clearTimeout(serialReconnectTimer);
    serialReconnectTimer = null;
  }

  try {
    const readerToClose = serialReader;
    const portToClose = serialPort;
    serialReader = null;
    serialPort = null;

    if (readerToClose) {
      await readerToClose.cancel().catch(() => {});
      try { readerToClose.releaseLock(); } catch (_) {}
    }

    if (portToClose) {
      await portToClose.close().catch(() => {});
    }

    if (manual) {
      pendingManualGpsStart = null;
      serialDeviceMissing = false;
      serialReconnectPort = null;
      serialConnectionPhase = "Disconnected manually";
      serialOpenedTime = 0;
      lastNmeaPacketTime = 0;
      lastNmeaSentenceType = "None";
      addDiagnosticEvent("External GPS disconnected");
      const endingSession = !!options.endSession;
      const stoppedUnitId = currentUnitId;
      writeAuditEvent(
        endingSession ? "serial_disconnected_for_session_end" : "serial_manual_disconnect",
        endingSession ? `External GPS stopped as part of session closure${options.reason ? `: ${options.reason}` : ""}` : "Stop GPS requested",
        {
          source: userRole === "admin" ? "admin" : "user",
          severity: "action",
          buttonLabel: endingSession ? "Session closure" : "Stop GPS",
          reason: options.reason || "",
          includeLocation: userMode !== "dispatch",
          locationData: lastFixUnitId === stoppedUnitId ? lastFix : null,
          lookupStoredLocation: true
        }
      );

      if (!endingSession && stoppedUnitId && userMode !== "dispatch") {
        // Stop means off the live map. Keep the saved login/presence session so
        // the same deputy can press Start GPS again without signing back in.
        await stopLiveUnitPublishing(stoppedUnitId);
        await unitsRef.child(stoppedUnitId).remove().catch((err) => {
          console.warn(`Unable to remove stopped unit ${stoppedUnitId} from live map:`, err);
        });
        delete latestUnits[stoppedUnitId];
        if (markers[stoppedUnitId]) {
          map.removeLayer(markers[stoppedUnitId]);
          delete markers[stoppedUnitId];
        }
        scheduleRenderUnitList();
        setStatus("GPS stopped — unit removed from live map", "warn");
        setFixDetails("GPS stopped. This unit is off the live map. Press Start GPS to return.");
      } else {
        setStatus("External GPS disconnected", "warn");
      }
    }
    renderReceiverHealth();
    return true;

  } catch (err) {
    console.error(err);
    setStatus("Disconnect error: " + err.message, "bad");
    return false;
  }
}

//////////////////////////////////////////////////////
// READ SERIAL LOOP
//////////////////////////////////////////////////////

async function readSerialLoop(activePort, readGeneration) {
  const decoder = new TextDecoder();
  const isCurrentRead = () => (
    readGeneration === serialReadGeneration &&
    serialPort === activePort
  );

  try {
    while (isCurrentRead() && activePort.readable && serialKeepReading) {
      const activeReader = activePort.readable.getReader();
      serialReader = activeReader;

      try {
        while (serialKeepReading && isCurrentRead()) {
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
    if (!isCurrentRead()) return;
    console.error(err);
    serialConnectionPhase = `Serial read error: ${err.message}`;
    setStatus("External GPS read error: " + err.message, "bad");
    writeAuditEvent("serial_read_error", `External GPS data stream error: ${err.message}`, { source: "system", severity: "warning", reason: err.message });
  } finally {
    // A stale read loop from before undocking must not touch the newly opened
    // replacement port. Only the generation that still owns activePort may
    // start recovery.
    if (!isCurrentRead()) return;

    serialKeepReading = false;
    serialReader = null;
    serialPort = null;
    try { await activePort.close().catch(() => {}); } catch (_) {}

    if (!serialAutoMode) return;
    if (!serialDeviceMissing) {
      writeAuditEvent("serial_unexpected_disconnect", "External GPS connection/data stream ended unexpectedly; automatic reconnect started", { source: "system", severity: "warning" });
    }
    scheduleSerialRescan(serialDeviceMissing ? "Waiting for docked GPS receiver" : "External GPS lost");
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
  const neverReceivedNmea = !lastNmeaPacketTime;
  if (neverReceivedNmea) {
    serialForceBaudScan = true;
    serialFailedBaud = currentSerialBaud;
  } else {
    serialForceBaudScan = false;
    serialFailedBaud = null;
  }
  serialConnectionPhase = neverReceivedNmea
    ? `No NMEA at ${currentSerialBaud || "selected"} baud for ${stalledSeconds} sec — checking alternates`
    : `NMEA stream stalled for ${stalledSeconds} sec — restarting receiver`;
  setStatus(
    neverReceivedNmea
      ? "Receiver opened but sent no NMEA. Checking alternate baud rates..."
      : "External GPS stream stalled. Restarting receiver...",
    "warn"
  );
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
  serialForceBaudScan = false;
  serialFailedBaud = null;
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

  if (data.gpsSource?.startsWith("serial") && !serialFixLoggedForConnection) {
    serialFixLoggedForConnection = true;
    const manualStart = pendingManualGpsStart;
    const secondsToFix = manualStart?.requestedAt
      ? Math.max(0, Math.round((Date.now() - manualStart.requestedAt) / 1000))
      : null;
    writeAuditEvent(
      manualStart ? "gps_stream_started_manual" : "gps_stream_resumed_automatic",
      manualStart
        ? `GPS STREAM STARTED HERE — Start GPS produced its first valid position${secondsToFix !== null ? ` after ${secondsToFix} seconds` : ""}`
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
    publishPresence();
    pendingManualGpsStart = null;
  }

  queueUnitFixForPublish(currentUnitId, data, { reason: "external_gps" });
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

  // Do not automatically recenter the map on every GPS update. Dispatchers
  // control the fleet map position directly with normal pan/zoom gestures.
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
  // Only clients with the full session roster can safely distinguish an
  // abandoned unit from a logged-in unit that has not acquired GPS.
  if (!firebaseConnected || !sessionRosterSubscribed) return;

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

function handleUnitAddedOrChanged(snap) {
  if (!snap?.key) return;
  latestUnits[snap.key] = snap.val();
  scheduleRenderUnitList();
}

function handleUnitRemoved(snap) {
  if (!snap?.key) return;
  delete latestUnits[snap.key];
  scheduleRenderUnitList();
}

unitsRef.on("child_added", handleUnitAddedOrChanged);
unitsRef.on("child_changed", handleUnitAddedOrChanged);
unitsRef.on("child_removed", handleUnitRemoved);

function handleSessionAddedOrChanged(snap) {
  if (!snap?.key) return;
  latestSessions[snap.key] = snap.val();

  // Modern clients remove the known invalid legacy dispatcher record when seen.
  // The Firebase Rules patch included with this release is what permanently
  // prevents the old browser tab from writing it back.
  if (snap.key === "dispatch__") {
    sessionsRef.child("dispatch__").remove().catch(() => {});
    delete latestSessions.dispatch__;
  }

  scheduleRenderUnitList();
}

function handleSessionRemoved(snap) {
  if (!snap?.key) return;
  delete latestSessions[snap.key];
  scheduleRenderUnitList();
}

function shouldSubscribeToSessionRoster() {
  return !!currentUnitId && (userMode === "dispatch" || userRole === "admin");
}

function shouldSubscribeToDispatchRoster() {
  return !!currentUnitId && userMode === "unit" && userRole !== "admin";
}

function startSessionRosterSubscription() {
  if (sessionRosterSubscribed) return;
  sessionRosterSubscribed = true;
  sessionsRef.on("child_added", handleSessionAddedOrChanged);
  sessionsRef.on("child_changed", handleSessionAddedOrChanged);
  sessionsRef.on("child_removed", handleSessionRemoved);
}

function stopSessionRosterSubscription() {
  if (!sessionRosterSubscribed) return;
  sessionsRef.off("child_added", handleSessionAddedOrChanged);
  sessionsRef.off("child_changed", handleSessionAddedOrChanged);
  sessionsRef.off("child_removed", handleSessionRemoved);
  sessionRosterSubscribed = false;
  latestSessions = {};
  scheduleRenderUnitList();
}

function startDispatchRosterSubscription() {
  if (dispatchRosterSubscribed) return;
  dispatchRosterSubscribed = true;
  dispatchSessionQuery = sessionsRef
    .orderByKey()
    .startAt("dispatch_")
    .endAt("dispatch_\uf8ff");
  dispatchSessionQuery.on("child_added", handleSessionAddedOrChanged);
  dispatchSessionQuery.on("child_changed", handleSessionAddedOrChanged);
  dispatchSessionQuery.on("child_removed", handleSessionRemoved);
}

function stopDispatchRosterSubscription() {
  if (!dispatchRosterSubscribed || !dispatchSessionQuery) return;
  dispatchSessionQuery.off("child_added", handleSessionAddedOrChanged);
  dispatchSessionQuery.off("child_changed", handleSessionAddedOrChanged);
  dispatchSessionQuery.off("child_removed", handleSessionRemoved);
  dispatchRosterSubscribed = false;
  dispatchSessionQuery = null;
  latestSessions = {};
  scheduleRenderUnitList();
}

function configureRosterDataSubscriptions() {
  if (shouldSubscribeToSessionRoster()) {
    stopDispatchRosterSubscription();
    startSessionRosterSubscription();
    return;
  }

  if (shouldSubscribeToDispatchRoster()) {
    stopSessionRosterSubscription();
    startDispatchRosterSubscription();
    return;
  }

  stopSessionRosterSubscription();
  stopDispatchRosterSubscription();
}
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
    queueUnitFixForPublish(id, data, { reason: "browser_gps" });
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
// REMOVE UNIT
//////////////////////////////////////////////////////

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

    if (id === currentUnitId) {
      await disconnectSerialGPS(true, { bypassLock: true, endSession: true, reason: "Administrator removal" });
      await stopLiveUnitPublishing(id);
    }

    await sessionsRef.child(getSessionKey("unit", id)).remove().catch(() => {});
    await unitsRef.child(id).remove();

    if (markers[id]) {
      map.removeLayer(markers[id]);
      delete markers[id];
    }

    if (id === currentUnitId) {
      currentUnitId = null;
      configureRosterDataSubscriptions();
    }

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
