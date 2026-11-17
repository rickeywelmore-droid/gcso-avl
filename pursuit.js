//////////////////////////////////////////////////////
// GCSO AVL PURSUIT MODE
// v1.2.0 — 2026-11-17
//
// Separate, opt-in historical recorder layered over the
// existing AVL. Normal unit publishing remains untouched.
//////////////////////////////////////////////////////

const PURSUIT_SCHEMA_VERSION = 1;
const PURSUIT_RECORD_MIN_INTERVAL_MS = 900;
const PURSUIT_MAX_FIX_AGE_MS = 5000;
const PURSUIT_PENDING_STORAGE_KEY = "avl_pursuitPendingPoints_v1";
const PURSUIT_PENDING_MAX_POINTS = 15000;
const PURSUIT_ROLLING_STORAGE_KEY = "avl_pursuitRollingFixes_v1";
const PURSUIT_ROLLING_WINDOW_MS = 15 * 60 * 1000;
const PURSUIT_ROLLING_MAX_POINTS = 1200;
const PURSUIT_ROLLING_PERSIST_MS = 5000;
const PURSUIT_RECENT_REPORT_LIMIT = 12;
const PURSUIT_UNIT_COLORS = [
  "#ff3b30", "#007aff", "#34c759", "#ff9500",
  "#af52de", "#5ac8fa", "#ff2d55", "#64d2ff",
  "#ffd60a", "#30d158", "#bf5af2", "#ff9f0a"
];

const pursuitRootRef = db.ref("pursuits");
const pursuitActiveIdRef = db.ref("pursuitControl/activePursuitId");

let pursuitActiveId = null;
let pursuitActiveMeta = null;
let pursuitActiveMetaListener = null;
let pursuitRecordingTimer = null;
let pursuitElapsedTimer = null;
let pursuitLastRecordedGpsTime = 0;
let pursuitLastRecordedClientTime = 0;
let pursuitPointSequence = 0;
let pursuitUnitMetaInitializedFor = null;
let pursuitLastCompletedId = localStorage.getItem("avl_lastPursuitId") || "";
let pursuitTrailUnitListener = null;
let pursuitTrailPointListeners = [];
let pursuitTrailLayers = {};
let pursuitTrailLabels = {};
let pursuitPendingPoints = restorePendingPursuitPoints();
let pursuitFlushInProgress = false;
let pursuitRecentLoadTimer = null;
let pursuitRollingFixes = restoreRollingPursuitFixes();
let pursuitRollingLastGpsTime = 0;
let pursuitRollingLastPersistTime = 0;
let pursuitActivationReceivedAt = 0;
let pursuitBackfilledForId = null;

function getPursuitPanel() {
  return document.getElementById("pursuitPanel");
}

function pursuitEscapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function pursuitFirebaseKey(value) {
  if (typeof sanitizeFirebaseKey === "function") return sanitizeFirebaseKey(value);
  return String(value || "unknown").replace(/[.#$[\]/]/g, "_");
}

function pursuitDisplayTime(timestamp) {
  const n = Number(timestamp || 0);
  if (!n) return "Unknown";
  return new Date(n).toLocaleString();
}

function pursuitFormatDuration(ms) {
  const total = Math.max(0, Math.floor(Number(ms || 0) / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h) return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  return `${m}:${String(s).padStart(2, "0")}`;
}

function pursuitFormatMph(speedMps) {
  const mph = Number(speedMps || 0) * 2.2369362921;
  return Number.isFinite(mph) ? mph : 0;
}

function pursuitIsFreshFix(fix) {
  if (!fix || !isValidLatLon(Number(fix.lat), Number(fix.lon))) return false;
  const gpsTime = Number(fix.gpsTime || 0);
  return !!gpsTime && (Date.now() - gpsTime) <= PURSUIT_MAX_FIX_AGE_MS;
}

function restoreRollingPursuitFixes() {
  try {
    const parsed = JSON.parse(localStorage.getItem(PURSUIT_ROLLING_STORAGE_KEY) || "[]");
    if (!Array.isArray(parsed)) return [];
    const cutoff = Date.now() - PURSUIT_ROLLING_WINDOW_MS;
    return parsed
      .filter(p => p && Number(p.gpsTime || 0) >= cutoff && isValidLatLon(Number(p.lat), Number(p.lon)))
      .slice(-PURSUIT_ROLLING_MAX_POINTS);
  } catch (_) {
    return [];
  }
}

function persistRollingPursuitFixes(force = false) {
  const now = Date.now();
  if (!force && (now - pursuitRollingLastPersistTime) < PURSUIT_ROLLING_PERSIST_MS) return;
  pursuitRollingLastPersistTime = now;
  try {
    localStorage.setItem(PURSUIT_ROLLING_STORAGE_KEY, JSON.stringify(pursuitRollingFixes.slice(-PURSUIT_ROLLING_MAX_POINTS)));
  } catch (_) {
    // The pursuit-specific pending queue remains the higher priority store.
  }
}

function compactRollingFix(fix) {
  return {
    lat: Number(fix.lat),
    lon: Number(fix.lon),
    speed: Number(fix.speed || 0),
    heading: Number(fix.heading || 0),
    acc: Number(fix.acc || 0),
    satellites: Number(fix.satellites || serialSatellites || 0),
    hdop: Number(fix.hdop || serialHdop || 0),
    gpsSource: String(fix.gpsSource || "unknown"),
    gpsTime: Number(fix.gpsTime || Date.now()),
    capturedAt: Date.now()
  };
}

function captureRollingPursuitFix() {
  if (!currentUnitId || userMode === "dispatch") return;
  const fix = lastFix;
  if (!pursuitIsFreshFix(fix)) return;

  const gpsTime = Number(fix.gpsTime || 0);
  if (!gpsTime || gpsTime <= pursuitRollingLastGpsTime) return;
  pursuitRollingLastGpsTime = gpsTime;

  pursuitRollingFixes.push(compactRollingFix(fix));
  const cutoff = Date.now() - PURSUIT_ROLLING_WINDOW_MS;
  pursuitRollingFixes = pursuitRollingFixes
    .filter(p => Number(p.gpsTime || 0) >= cutoff)
    .slice(-PURSUIT_ROLLING_MAX_POINTS);

  persistRollingPursuitFixes();
}

function pursuitActor() {
  return {
    id: String(currentUnitId || "Unknown"),
    mode: String(userMode || "unknown"),
    role: String(userRole || "user")
  };
}

function buildPursuitDisplayId(now = Date.now()) {
  const d = new Date(now);
  const pad = n => String(n).padStart(2, "0");
  return `P${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

function showPursuitMessage(message, className = "") {
  const el = document.getElementById("pursuitStatus");
  if (!el) return;
  el.textContent = message || "";
  el.className = `pursuit-status ${className}`.trim();
}

function updatePursuitPanelVisibility() {
  const panel = getPursuitPanel();
  if (!panel) return;
  panel.classList.toggle("mode-hidden", !currentUnitId);

  const startArea = document.getElementById("pursuitStartArea");
  const activeArea = document.getElementById("pursuitActiveArea");
  const reportArea = document.getElementById("pursuitReportArea");

  if (startArea) startArea.classList.toggle("mode-hidden", !!pursuitActiveId);
  if (activeArea) activeArea.classList.toggle("mode-hidden", !pursuitActiveId);
  if (reportArea) reportArea.classList.toggle("mode-hidden", !currentUnitId);

  const dispatchHint = document.getElementById("pursuitDispatchHint");
  if (dispatchHint) {
    dispatchHint.textContent = userMode === "dispatch"
      ? "Dispatch console — preferred activation point"
      : "Any logged-in AVL user may activate pursuit mode";
  }

  const startButton = document.getElementById("startPursuitButton");
  if (startButton) {
    startButton.textContent = userMode === "dispatch" ? "START PURSUIT" : "START PURSUIT";
  }
}

function renderPursuitActiveState() {
  updatePursuitPanelVisibility();

  const banner = document.getElementById("pursuitBanner");
  const details = document.getElementById("pursuitActiveDetails");
  if (!pursuitActiveId) {
    if (banner) banner.classList.add("mode-hidden");
    if (details) details.textContent = "";
    return;
  }

  if (banner) banner.classList.remove("mode-hidden");
  const meta = pursuitActiveMeta || {};
  const displayId = meta.displayId || pursuitActiveId;
  const incident = meta.incidentNumber ? ` • CAD ${meta.incidentNumber}` : "";
  const by = meta.startedBy ? ` • Started by ${meta.startedBy}` : "";
  if (details) details.textContent = `${displayId}${incident}${by}`;
  updatePursuitElapsed();
}

function updatePursuitElapsed() {
  const el = document.getElementById("pursuitElapsed");
  if (!el) return;
  if (!pursuitActiveId) {
    el.textContent = "";
    return;
  }
  const started = Number(pursuitActiveMeta?.startedAtClient || pursuitActiveMeta?.startedAt || Date.now());
  el.textContent = `ACTIVE ${pursuitFormatDuration(Date.now() - started)}`;
}

function restorePendingPursuitPoints() {
  try {
    const parsed = JSON.parse(localStorage.getItem(PURSUIT_PENDING_STORAGE_KEY) || "[]");
    return Array.isArray(parsed) ? parsed.slice(-PURSUIT_PENDING_MAX_POINTS) : [];
  } catch (_) {
    return [];
  }
}

function persistPendingPursuitPoints() {
  try {
    localStorage.setItem(
      PURSUIT_PENDING_STORAGE_KEY,
      JSON.stringify(pursuitPendingPoints.slice(-PURSUIT_PENDING_MAX_POINTS))
    );
  } catch (err) {
    showPursuitMessage("Pursuit local buffer is full. Keep AVL open and restore data service.", "bad");
    if (typeof addDiagnosticEvent === "function") {
      addDiagnosticEvent(`Pursuit buffer storage failed: ${err?.message || err}`);
    }
  }
}

function queuePendingPursuitPoint(record) {
  if (!record?.pursuitId || !record?.unitKey || !record?.pointKey || !record?.point) return;
  if (!pursuitPendingPoints.some(p => p.pointKey === record.pointKey && p.pursuitId === record.pursuitId)) {
    pursuitPendingPoints.push(record);
    if (pursuitPendingPoints.length > PURSUIT_PENDING_MAX_POINTS) {
      pursuitPendingPoints = pursuitPendingPoints.slice(-PURSUIT_PENDING_MAX_POINTS);
    }
    persistPendingPursuitPoints();
  }
}

function removePendingPursuitPoint(pursuitId, pointKey) {
  const before = pursuitPendingPoints.length;
  pursuitPendingPoints = pursuitPendingPoints.filter(
    p => !(p.pursuitId === pursuitId && p.pointKey === pointKey)
  );
  if (pursuitPendingPoints.length !== before) persistPendingPursuitPoints();
}

async function getPursuitEndClientTime(pursuitId) {
  try {
    const snap = await pursuitRootRef.child(pursuitId).child("meta").once("value");
    const meta = snap.val() || {};
    return Number(meta.endedAtClient || meta.endedAt || 0);
  } catch (_) {
    return 0;
  }
}

async function flushPendingPursuitPoints() {
  if (pursuitFlushInProgress || !firebaseConnected || !pursuitPendingPoints.length) return;
  pursuitFlushInProgress = true;

  try {
    const endTimes = new Map();
    const copy = [...pursuitPendingPoints];

    for (const item of copy) {
      if (!firebaseConnected) break;

      if (!endTimes.has(item.pursuitId)) {
        endTimes.set(item.pursuitId, await getPursuitEndClientTime(item.pursuitId));
      }

      const endedAt = endTimes.get(item.pursuitId) || 0;
      const pointTime = Number(item.point?.gpsTime || item.point?.clientTime || 0);

      // A unit that loses cellular service may not hear "END PURSUIT" until it
      // reconnects. Do not upload the later patrol route once the authoritative
      // end time is known.
      if (endedAt && pointTime > endedAt + 2000) {
        removePendingPursuitPoint(item.pursuitId, item.pointKey);
        continue;
      }

      const path = `pursuits/${item.pursuitId}/units/${item.unitKey}/points/${item.pointKey}`;
      try {
        await db.ref(path).set(item.point);
        removePendingPursuitPoint(item.pursuitId, item.pointKey);
      } catch (_) {
        break;
      }
    }
  } finally {
    pursuitFlushInProgress = false;
    updatePursuitBufferStatus();
  }
}

function updatePursuitBufferStatus() {
  const el = document.getElementById("pursuitBufferStatus");
  if (!el) return;
  if (!pursuitActiveId && !pursuitPendingPoints.length) {
    el.textContent = "";
    return;
  }
  if (pursuitPendingPoints.length) {
    el.textContent = `${pursuitPendingPoints.length} breadcrumb${pursuitPendingPoints.length === 1 ? "" : "s"} buffered locally`;
    el.className = "pursuit-buffer warn";
  } else {
    el.textContent = pursuitActiveId ? "Breadcrumbs synced" : "";
    el.className = "pursuit-buffer good";
  }
}

async function ensurePursuitUnitMeta(pursuitId, unitKey, fix) {
  const token = `${pursuitId}|${unitKey}`;
  if (pursuitUnitMetaInitializedFor === token) return;

  const actor = pursuitActor();
  const metaRef = pursuitRootRef.child(pursuitId).child("units").child(unitKey).child("meta");
  try {
    await metaRef.transaction(current => current || {
      unitId: actor.id,
      mode: actor.mode,
      firstGpsTime: Number(fix.gpsTime || Date.now()),
      firstPointClientTime: Date.now(),
      gpsSource: String(fix.gpsSource || "unknown"),
      sessionKey: String(currentSessionKey || ""),
      clientSessionId: String(clientSessionId || "")
    });
    pursuitUnitMetaInitializedFor = token;
  } catch (_) {
    // Breadcrumb writes are independently buffered and will still retry.
  }
}

async function sendOrBufferPursuitPoint(record) {
  queuePendingPursuitPoint(record);
  updatePursuitBufferStatus();

  if (!firebaseConnected) return;

  const path = `pursuits/${record.pursuitId}/units/${record.unitKey}/points/${record.pointKey}`;
  try {
    await db.ref(path).set(record.point);
    removePendingPursuitPoint(record.pursuitId, record.pointKey);
  } catch (_) {
    // The local copy stays queued for reconnection.
  }
  updatePursuitBufferStatus();
}

function buildPursuitPoint(fix) {
  const gpsTime = Number(fix.gpsTime || Date.now());
  const speedMps = Number(fix.speed ?? fix.speedMps ?? 0);
  return {
    lat: Number(fix.lat),
    lon: Number(fix.lon),
    speedMps: Number.isFinite(speedMps) ? speedMps : 0,
    speedMph: pursuitFormatMph(speedMps),
    heading: Number(fix.heading || 0),
    accuracyMeters: Number(fix.acc || 0),
    satellites: Number(fix.satellites || serialSatellites || 0),
    hdop: Number(fix.hdop || serialHdop || 0),
    gpsSource: String(fix.gpsSource || "unknown"),
    gpsTime,
    clientTime: Date.now(),
    serverTime: firebase.database.ServerValue.TIMESTAMP,
    sessionKey: String(currentSessionKey || ""),
    schemaVersion: PURSUIT_SCHEMA_VERSION
  };
}

async function backfillRollingPursuitPoints(pursuitId, meta = {}) {
  if (!pursuitId || userMode === "dispatch" || !currentUnitId) return;
  if (pursuitBackfilledForId === pursuitId) return;

  const startedAt = Number(meta.startedAt || meta.startedAtClient || 0);
  if (!startedAt) return;

  pursuitBackfilledForId = pursuitId;
  const unitKey = pursuitFirebaseKey(currentUnitId);
  const upperBound = pursuitActivationReceivedAt ? (pursuitActivationReceivedAt - 250) : Date.now();
  const lowerBound = startedAt - 2000;

  const candidates = pursuitRollingFixes.filter(fix => {
    const t = Number(fix.gpsTime || 0);
    return t >= lowerBound && t <= upperBound && isValidLatLon(Number(fix.lat), Number(fix.lon));
  });

  if (!candidates.length) return;

  await ensurePursuitUnitMeta(pursuitId, unitKey, candidates[0]);

  for (const fix of candidates) {
    const gpsTime = Number(fix.gpsTime || 0);
    if (!gpsTime) continue;
    const point = buildPursuitPoint(fix);
    const pointKey = `b_${gpsTime}`;
    sendOrBufferPursuitPoint({ pursuitId, unitKey, pointKey, point });
  }

  if (typeof addDiagnosticEvent === "function") {
    addDiagnosticEvent(`Pursuit backfill queued: ${candidates.length} point(s) from rolling GPS buffer`);
  }
}

function recordCurrentPursuitFix() {
  if (!pursuitActiveId || userMode === "dispatch" || !currentUnitId) return;
  const fix = lastFix;
  if (!pursuitIsFreshFix(fix)) return;

  const gpsTime = Number(fix.gpsTime || 0);
  const now = Date.now();
  if (gpsTime <= pursuitLastRecordedGpsTime) return;
  if ((now - pursuitLastRecordedClientTime) < PURSUIT_RECORD_MIN_INTERVAL_MS) return;

  pursuitLastRecordedGpsTime = gpsTime;
  pursuitLastRecordedClientTime = now;

  const pursuitId = pursuitActiveId;
  const unitKey = pursuitFirebaseKey(currentUnitId);
  const point = buildPursuitPoint(fix);
  pursuitPointSequence = (pursuitPointSequence + 1) % 100000;
  const pointKey = `p_${gpsTime}_${String(pursuitPointSequence).padStart(5, "0")}`;

  ensurePursuitUnitMeta(pursuitId, unitKey, fix);
  sendOrBufferPursuitPoint({ pursuitId, unitKey, pointKey, point });
}

function startLocalPursuitRecording() {
  stopLocalPursuitRecording();
  pursuitLastRecordedGpsTime = 0;
  pursuitLastRecordedClientTime = 0;
  pursuitUnitMetaInitializedFor = null;

  recordCurrentPursuitFix();
  pursuitRecordingTimer = setInterval(recordCurrentPursuitFix, 400);
  pursuitElapsedTimer = setInterval(updatePursuitElapsed, 1000);
  updatePursuitBufferStatus();
}

function stopLocalPursuitRecording() {
  if (pursuitRecordingTimer) clearInterval(pursuitRecordingTimer);
  if (pursuitElapsedTimer) clearInterval(pursuitElapsedTimer);
  pursuitRecordingTimer = null;
  pursuitElapsedTimer = null;
  pursuitUnitMetaInitializedFor = null;
}

async function writePursuitEvent(pursuitId, type, label, notes = "") {
  if (!pursuitId) return;
  const actor = pursuitActor();
  const eventRef = pursuitRootRef.child(pursuitId).child("events").push();
  const fix = (userMode !== "dispatch" && pursuitIsFreshFix(lastFix)) ? lastFix : null;
  const event = {
    type: String(type || "note"),
    label: String(label || type || "Event"),
    notes: String(notes || ""),
    by: actor.id,
    byMode: actor.mode,
    clientTime: Date.now(),
    serverTime: firebase.database.ServerValue.TIMESTAMP,
    schemaVersion: PURSUIT_SCHEMA_VERSION
  };

  if (fix) {
    event.lat = Number(fix.lat);
    event.lon = Number(fix.lon);
    event.gpsTime = Number(fix.gpsTime || Date.now());
  }

  await eventRef.set(event);
}

async function startPursuitMode() {
  if (!currentUnitId) return alert("Log in before starting pursuit mode.");
  if (pursuitActiveId) return alert("A pursuit is already active.");

  const incidentEl = document.getElementById("pursuitIncidentNumber");
  const incidentNumber = String(incidentEl?.value || "").trim();
  const actor = pursuitActor();
  const now = Date.now();
  const newRef = pursuitRootRef.push();
  const pursuitId = newRef.key;
  const displayId = buildPursuitDisplayId(now);

  if (!confirm(`Start PURSUIT MODE now?\n\n${incidentNumber ? `CAD / Incident: ${incidentNumber}\n` : ""}All logged-in field units will begin breadcrumb recording when they receive the activation.`)) {
    return;
  }

  showPursuitMessage("Starting pursuit mode…", "warn");

  try {
    const tx = await pursuitActiveIdRef.transaction(current => current || pursuitId);
    if (!tx.committed || tx.snapshot.val() !== pursuitId) {
      const existing = tx.snapshot.val();
      showPursuitMessage("Another pursuit is already active.", "warn");
      if (existing) alert("Another pursuit was activated before this request completed.");
      return;
    }

    const meta = {
      status: "active",
      displayId,
      incidentNumber,
      startedAt: firebase.database.ServerValue.TIMESTAMP,
      startedAtClient: now,
      startedBy: actor.id,
      startedByMode: actor.mode,
      startedByRole: actor.role,
      schemaVersion: PURSUIT_SCHEMA_VERSION,
      appVersion: typeof APP_VERSION !== "undefined" ? APP_VERSION : "unknown"
    };

    await newRef.child("meta").set(meta);
    await writePursuitEvent(pursuitId, "pursuit_started", "Pursuit mode activated");

    if (typeof writeAuditEvent === "function") {
      writeAuditEvent("pursuit_mode_started", `Pursuit mode activated${incidentNumber ? ` for ${incidentNumber}` : ""}`, {
        source: "user",
        severity: "action",
        buttonLabel: "START PURSUIT",
        controlLocation: "Pursuit Mode",
        includeLocation: userMode !== "dispatch",
        lookupStoredLocation: true
      });
    }

    if (incidentEl) incidentEl.value = "";
    showPursuitMessage("Pursuit mode active.", "good");
  } catch (err) {
    // If meta creation fails after the control transaction succeeded, release
    // only the pursuit ID we created.
    try {
      await pursuitActiveIdRef.transaction(current => current === pursuitId ? null : undefined);
    } catch (_) {}
    showPursuitMessage(`Could not start pursuit mode: ${err?.message || err}`, "bad");
    alert("Pursuit mode could not be activated. Firebase may be offline or the database rules may not permit the pursuit path.");
  }
}

async function endPursuitMode() {
  if (!currentUnitId || !pursuitActiveId) return;
  const pursuitId = pursuitActiveId;
  const meta = pursuitActiveMeta || {};
  const actor = pursuitActor();

  if (!confirm(`END PURSUIT MODE?\n\n${meta.displayId || pursuitId}\nBreadcrumb recording will stop for all connected units.`)) {
    return;
  }

  showPursuitMessage("Ending pursuit mode…", "warn");

  try {
    await writePursuitEvent(pursuitId, "pursuit_ended", "Pursuit mode terminated");

    const endedAtClient = Date.now();
    await pursuitRootRef.child(pursuitId).child("meta").update({
      status: "ended",
      endedAt: firebase.database.ServerValue.TIMESTAMP,
      endedAtClient,
      endedBy: actor.id,
      endedByMode: actor.mode,
      locked: true,
      lockedAtClient: endedAtClient
    });

    const tx = await pursuitActiveIdRef.transaction(current => current === pursuitId ? null : current);
    if (!tx.committed) throw new Error("Pursuit control could not be released");

    pursuitLastCompletedId = pursuitId;
    localStorage.setItem("avl_lastPursuitId", pursuitId);

    if (typeof writeAuditEvent === "function") {
      writeAuditEvent("pursuit_mode_ended", "Pursuit mode terminated and historical record locked in the AVL application", {
        source: "user",
        severity: "action",
        buttonLabel: "END PURSUIT",
        controlLocation: "Pursuit Mode",
        includeLocation: userMode !== "dispatch",
        lookupStoredLocation: true
      });
    }

    showPursuitMessage("Pursuit ended. Report is available below.", "good");
    scheduleRecentPursuitLoad(250);
  } catch (err) {
    showPursuitMessage(`Could not end pursuit mode: ${err?.message || err}`, "bad");
    alert("Pursuit mode could not be ended cleanly. Keep AVL open and try again when Firebase connectivity is restored.");
  }
}

async function addPursuitTimelineMarker() {
  if (!pursuitActiveId) return alert("No pursuit is active.");
  const select = document.getElementById("pursuitMarkerType");
  const type = select?.value || "note";

  const labels = {
    other_agency_joined: "Other agency joined",
    primary_changed: "Primary unit changed",
    crash: "Crash / collision",
    apprehension: "Apprehension",
    pursuit_terminated_by_supervisor: "Supervisor ordered termination",
    note: "Timeline note"
  };

  let notes = "";
  if (type === "note" || type === "primary_changed" || type === "other_agency_joined") {
    notes = prompt(`${labels[type] || "Timeline marker"} — optional details:`) || "";
  }

  try {
    await writePursuitEvent(pursuitActiveId, type, labels[type] || type, notes);
    if (typeof writeAuditEvent === "function") {
      writeAuditEvent("pursuit_timeline_marker", `Pursuit timeline marker: ${labels[type] || type}${notes ? ` — ${notes}` : ""}`, {
        source: "user",
        severity: "action",
        buttonLabel: "ADD TIMELINE MARKER",
        controlLocation: "Pursuit Mode",
        includeLocation: userMode !== "dispatch",
        lookupStoredLocation: true
      });
    }
    showPursuitMessage(`Timeline marker added: ${labels[type] || type}`, "good");
  } catch (err) {
    showPursuitMessage(`Marker failed: ${err?.message || err}`, "bad");
  }
}

function pursuitColorForUnit(unitKey) {
  let hash = 0;
  for (const ch of String(unitKey || "")) hash = ((hash << 5) - hash) + ch.charCodeAt(0);
  return PURSUIT_UNIT_COLORS[Math.abs(hash) % PURSUIT_UNIT_COLORS.length];
}

function clearPursuitTrails() {
  pursuitTrailPointListeners.forEach(({ ref, handler }) => {
    try { ref.off("child_added", handler); } catch (_) {}
  });
  pursuitTrailPointListeners = [];

  if (pursuitTrailUnitListener) {
    try { pursuitTrailUnitListener.ref.off("child_added", pursuitTrailUnitListener.handler); } catch (_) {}
    pursuitTrailUnitListener = null;
  }

  Object.values(pursuitTrailLayers).forEach(layer => {
    try { map.removeLayer(layer); } catch (_) {}
  });
  pursuitTrailLayers = {};
  pursuitTrailLabels = {};
}

function attachPursuitTrails(pursuitId) {
  clearPursuitTrails();
  if (!pursuitId) return;

  const units = pursuitRootRef.child(pursuitId).child("units");
  const unitHandler = unitSnap => {
    const unitKey = unitSnap.key;
    if (!unitKey || pursuitTrailLayers[unitKey]) return;

    const unitValue = unitSnap.val() || {};
    const unitId = unitValue.meta?.unitId || unitKey;
    pursuitTrailLabels[unitKey] = unitId;

    const color = pursuitColorForUnit(unitKey);
    const layer = L.polyline([], {
      color,
      weight: 4,
      opacity: 0.82,
      lineJoin: "round"
    }).addTo(map);
    layer.bindTooltip(`Unit ${unitId}`, { sticky: true });
    pursuitTrailLayers[unitKey] = layer;

    const pointsRef = units.child(unitKey).child("points");
    const pointHandler = pointSnap => {
      const p = pointSnap.val() || {};
      if (!isValidLatLon(Number(p.lat), Number(p.lon))) return;
      layer.addLatLng([Number(p.lat), Number(p.lon)]);
    };
    pointsRef.on("child_added", pointHandler);
    pursuitTrailPointListeners.push({ ref: pointsRef, handler: pointHandler });
  };

  units.on("child_added", unitHandler);
  pursuitTrailUnitListener = { ref: units, handler: unitHandler };
}

function subscribePursuitMeta(pursuitId) {
  if (pursuitActiveMetaListener) {
    try { pursuitActiveMetaListener.ref.off("value", pursuitActiveMetaListener.handler); } catch (_) {}
    pursuitActiveMetaListener = null;
  }

  pursuitActiveMeta = null;
  if (!pursuitId) {
    renderPursuitActiveState();
    return;
  }

  const ref = pursuitRootRef.child(pursuitId).child("meta");
  const handler = snap => {
    pursuitActiveMeta = snap.val() || {};
    renderPursuitActiveState();
    if (pursuitActiveId === pursuitId && pursuitActiveMeta?.status === "active") {
      backfillRollingPursuitPoints(pursuitId, pursuitActiveMeta);
    }
  };
  ref.on("value", handler);
  pursuitActiveMetaListener = { ref, handler };
}

function onActivePursuitChanged(nextId) {
  const oldId = pursuitActiveId;
  pursuitActiveId = nextId || null;

  if (pursuitActiveId) {
    pursuitActivationReceivedAt = Date.now();
    pursuitBackfilledForId = null;
    subscribePursuitMeta(pursuitActiveId);
    attachPursuitTrails(pursuitActiveId);
    startLocalPursuitRecording();
    showPursuitMessage("Pursuit mode active — breadcrumb recording enabled.", "good");
  } else {
    stopLocalPursuitRecording();
    pursuitActivationReceivedAt = 0;
    pursuitBackfilledForId = null;
    subscribePursuitMeta(null);
    if (oldId) {
      pursuitLastCompletedId = oldId;
      localStorage.setItem("avl_lastPursuitId", oldId);
      scheduleRecentPursuitLoad(300);
      // Leave the just-completed trails visible for immediate after-action
      // review. They can be cleared with the report controls.
    }
    showPursuitMessage(oldId ? "Pursuit ended — report available." : "", oldId ? "good" : "");
  }

  renderPursuitActiveState();
  updatePursuitBufferStatus();
}

function scheduleRecentPursuitLoad(delay = 500) {
  if (pursuitRecentLoadTimer) clearTimeout(pursuitRecentLoadTimer);
  pursuitRecentLoadTimer = setTimeout(() => {
    pursuitRecentLoadTimer = null;
    loadRecentPursuits();
  }, delay);
}

async function loadRecentPursuits() {
  const select = document.getElementById("pursuitReportSelect");
  if (!select || !firebaseConnected) return;

  try {
    const snap = await pursuitRootRef
      .orderByChild("meta/startedAtClient")
      .limitToLast(PURSUIT_RECENT_REPORT_LIMIT)
      .once("value");

    const rows = [];
    snap.forEach(child => {
      const meta = child.child("meta").val() || {};
      rows.push({ id: child.key, meta });
    });
    rows.sort((a, b) => Number(b.meta.startedAtClient || b.meta.startedAt || 0) - Number(a.meta.startedAtClient || a.meta.startedAt || 0));

    select.innerHTML = "";
    if (!rows.length) {
      const opt = document.createElement("option");
      opt.value = "";
      opt.textContent = "No pursuit records yet";
      select.appendChild(opt);
      return;
    }

    rows.forEach(row => {
      const opt = document.createElement("option");
      opt.value = row.id;
      const incident = row.meta.incidentNumber ? ` • ${row.meta.incidentNumber}` : "";
      const status = row.meta.status === "active" ? " • ACTIVE" : "";
      opt.textContent = `${row.meta.displayId || row.id}${incident}${status}`;
      if (row.id === pursuitLastCompletedId) opt.selected = true;
      select.appendChild(opt);
    });
  } catch (err) {
    showPursuitMessage(`Could not load pursuit reports: ${err?.message || err}`, "warn");
  }
}

function selectedPursuitReportId() {
  return document.getElementById("pursuitReportSelect")?.value || pursuitLastCompletedId || pursuitActiveId || "";
}

async function loadPursuitRecord(pursuitId) {
  if (!pursuitId) throw new Error("Select a pursuit record first.");
  const snap = await pursuitRootRef.child(pursuitId).once("value");
  if (!snap.exists()) throw new Error("Pursuit record not found.");
  return { id: pursuitId, ...(snap.val() || {}) };
}

function normalizedPursuitUnits(record) {
  const out = [];
  const units = record?.units || {};

  Object.entries(units).forEach(([unitKey, unitData]) => {
    const meta = unitData?.meta || {};
    const pointsObj = unitData?.points || {};
    const points = Object.entries(pointsObj)
      .map(([key, p]) => ({ key, ...(p || {}) }))
      .filter(p => isValidLatLon(Number(p.lat), Number(p.lon)))
      .sort((a, b) => Number(a.gpsTime || a.clientTime || 0) - Number(b.gpsTime || b.clientTime || 0));

    out.push({
      unitKey,
      unitId: meta.unitId || unitKey,
      meta,
      points
    });
  });

  return out.sort((a, b) => String(a.unitId).localeCompare(String(b.unitId), undefined, { numeric: true }));
}

function normalizedPursuitEvents(record) {
  return Object.values(record?.events || {})
    .filter(Boolean)
    .sort((a, b) => Number(a.clientTime || 0) - Number(b.clientTime || 0));
}

function haversineMeters(a, b) {
  const R = 6371000;
  const toRad = d => Number(d) * Math.PI / 180;
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const dLat = lat2 - lat1;
  const dLon = toRad(Number(b.lon) - Number(a.lon));
  const x = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(x));
}

function summarizePursuitUnit(unit) {
  let distanceMeters = 0;
  let maxSpeedMph = 0;
  let maxSpeedPoint = null;

  for (let i = 0; i < unit.points.length; i++) {
    const p = unit.points[i];
    if (i > 0) distanceMeters += haversineMeters(unit.points[i - 1], p);
    const mph = Number.isFinite(Number(p.speedMph)) ? Number(p.speedMph) : pursuitFormatMph(p.speedMps);
    if (mph > maxSpeedMph) {
      maxSpeedMph = mph;
      maxSpeedPoint = p;
    }
  }

  return {
    distanceMiles: distanceMeters / 1609.344,
    maxSpeedMph,
    maxSpeedPoint,
    firstPoint: unit.points[0] || null,
    lastPoint: unit.points[unit.points.length - 1] || null,
    pointCount: unit.points.length
  };
}

function csvCell(value) {
  const text = String(value ?? "");
  return `"${text.replaceAll('"', '""')}"`;
}

function downloadBlobFile(filename, content, mimeType) {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function pursuitSafeFilename(record, extension) {
  const meta = record?.meta || {};
  const base = String(meta.displayId || record.id || "pursuit")
    .replace(/[^A-Za-z0-9_-]+/g, "_");
  return `${base}.${extension}`;
}

async function exportPursuitCsv() {
  try {
    const record = await loadPursuitRecord(selectedPursuitReportId());
    const units = normalizedPursuitUnits(record);
    const rows = [[
      "Pursuit ID", "Incident/CAD", "Unit", "GPS Time", "Client Time",
      "Latitude", "Longitude", "Speed MPH", "Speed m/s", "Heading",
      "Accuracy m", "Satellites", "HDOP", "GPS Source"
    ]];

    units.forEach(unit => unit.points.forEach(p => {
      rows.push([
        record.meta?.displayId || record.id,
        record.meta?.incidentNumber || "",
        unit.unitId,
        pursuitDisplayTime(p.gpsTime),
        pursuitDisplayTime(p.clientTime),
        Number(p.lat).toFixed(7),
        Number(p.lon).toFixed(7),
        (Number.isFinite(Number(p.speedMph)) ? Number(p.speedMph) : pursuitFormatMph(p.speedMps)).toFixed(2),
        Number(p.speedMps || 0).toFixed(3),
        Number(p.heading || 0).toFixed(1),
        Number(p.accuracyMeters || 0).toFixed(1),
        Number(p.satellites || 0),
        Number(p.hdop || 0),
        p.gpsSource || ""
      ]);
    }));

    const csv = rows.map(row => row.map(csvCell).join(",")).join("\r\n");
    downloadBlobFile(pursuitSafeFilename(record, "csv"), csv, "text/csv;charset=utf-8");
  } catch (err) {
    alert(err?.message || err);
  }
}

function kmlEscape(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

async function exportPursuitKml() {
  try {
    const record = await loadPursuitRecord(selectedPursuitReportId());
    const units = normalizedPursuitUnits(record);
    const events = normalizedPursuitEvents(record);

    const unitKml = units.map(unit => {
      const coords = unit.points.map(p => `${Number(p.lon)},${Number(p.lat)},0`).join(" ");
      return `
      <Placemark>
        <name>${kmlEscape(`Unit ${unit.unitId}`)}</name>
        <description>${kmlEscape(`${unit.points.length} AVL breadcrumb points`)}</description>
        <LineString><tessellate>1</tessellate><coordinates>${coords}</coordinates></LineString>
      </Placemark>`;
    }).join("");

    const eventKml = events
      .filter(e => isValidLatLon(Number(e.lat), Number(e.lon)))
      .map(e => `
      <Placemark>
        <name>${kmlEscape(e.label || e.type || "Pursuit event")}</name>
        <description>${kmlEscape(`${pursuitDisplayTime(e.clientTime)}${e.by ? ` — ${e.by}` : ""}${e.notes ? ` — ${e.notes}` : ""}`)}</description>
        <Point><coordinates>${Number(e.lon)},${Number(e.lat)},0</coordinates></Point>
      </Placemark>`)
      .join("");

    const kml = `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2">
  <Document>
    <name>${kmlEscape(record.meta?.displayId || record.id)}</name>
    ${unitKml}
    ${eventKml}
  </Document>
</kml>`;

    downloadBlobFile(pursuitSafeFilename(record, "kml"), kml, "application/vnd.google-earth.kml+xml;charset=utf-8");
  } catch (err) {
    alert(err?.message || err);
  }
}

function buildReportHtml(record) {
  const meta = record.meta || {};
  const units = normalizedPursuitUnits(record);
  const events = normalizedPursuitEvents(record);
  const start = Number(meta.startedAt || meta.startedAtClient || 0);
  const end = Number(meta.endedAt || meta.endedAtClient || Date.now());
  const duration = end && start ? pursuitFormatDuration(end - start) : "Unknown";

  const summaries = units.map(unit => ({ unit, summary: summarizePursuitUnit(unit) }));
  const summaryRows = summaries.map(({ unit, summary }) => `
    <tr>
      <td>${pursuitEscapeHtml(unit.unitId)}</td>
      <td>${summary.pointCount}</td>
      <td>${summary.distanceMiles.toFixed(2)} mi</td>
      <td>${summary.maxSpeedMph.toFixed(1)} mph</td>
      <td>${summary.maxSpeedPoint ? pursuitEscapeHtml(pursuitDisplayTime(summary.maxSpeedPoint.gpsTime || summary.maxSpeedPoint.clientTime)) : "—"}</td>
      <td>${summary.firstPoint ? pursuitEscapeHtml(pursuitDisplayTime(summary.firstPoint.gpsTime || summary.firstPoint.clientTime)) : "—"}</td>
      <td>${summary.lastPoint ? pursuitEscapeHtml(pursuitDisplayTime(summary.lastPoint.gpsTime || summary.lastPoint.clientTime)) : "—"}</td>
    </tr>`).join("");

  const eventRows = events.map(e => `
    <tr>
      <td>${pursuitEscapeHtml(pursuitDisplayTime(e.serverTime || e.clientTime))}</td>
      <td>${pursuitEscapeHtml(e.label || e.type || "Event")}</td>
      <td>${pursuitEscapeHtml(e.by || "")}</td>
      <td>${pursuitEscapeHtml(e.notes || "")}</td>
    </tr>`).join("");

  const reportData = {
    units: units.map(unit => ({
      unitId: unit.unitId,
      color: pursuitColorForUnit(unit.unitKey),
      points: unit.points.map(p => [Number(p.lat), Number(p.lon)])
    })),
    events: events
      .filter(e => isValidLatLon(Number(e.lat), Number(e.lon)))
      .map(e => ({
        lat: Number(e.lat), lon: Number(e.lon),
        label: e.label || e.type || "Event",
        time: pursuitDisplayTime(e.serverTime || e.clientTime)
      }))
  };
  const safeJson = JSON.stringify(reportData).replaceAll("<", "\\u003c");

  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>${pursuitEscapeHtml(meta.displayId || record.id)} — GCSO Pursuit Report</title>
<style>
body{font-family:Arial,sans-serif;margin:24px;color:#111}
h1{margin:0 0 4px} h2{margin-top:26px;border-bottom:2px solid #333;padding-bottom:5px}
.meta{display:grid;grid-template-columns:180px 1fr;gap:5px 12px;margin:18px 0}
#map{height:520px;border:1px solid #777;margin:12px 0;position:relative;overflow:hidden;background:#f7f8fa}
#map .map-overlay{position:absolute;inset:0;width:100%;height:100%}
#map .map-message{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;padding:24px;text-align:center;color:#555;font-size:13px;background:linear-gradient(135deg,#f7f8fa,#e8ebef)}
#map .map-north{position:absolute;left:8px;top:8px;padding:4px 6px;background:rgba(255,255,255,.92);border:1px solid #999;font-size:10px;font-weight:700}
#map .map-caption{position:absolute;right:7px;bottom:5px;padding:3px 6px;background:rgba(255,255,255,.9);border:1px solid #bbb;font-size:9px;color:#555}
#map .map-scale{position:absolute;left:12px;bottom:12px;height:22px;font-size:9px;color:#333}
table{width:100%;border-collapse:collapse;font-size:12px}
th,td{border:1px solid #bbb;padding:6px;text-align:left} th{background:#eee}
.notice{margin:14px 0;padding:10px;background:#fff5cc;border-left:4px solid #c78f00;font-size:12px}
.actions{display:flex;gap:8px;margin:12px 0}.actions button{padding:8px 12px}
@media print{
  .actions{display:none}
  body{margin:7mm;font-size:11px}
  h1{font-size:24px}
  h2{font-size:18px;margin-top:18px}
  .meta{margin:12px 0;gap:3px 10px}
  .notice{margin:10px 0;padding:8px;font-size:10px}
  #map{height:300px;margin:8px 0}
  table{font-size:10px}
  th,td{padding:4px}
  h2,table{break-inside:avoid}
}
</style>
</head>
<body>
<h1>Gallatin County Sheriff's Office</h1>
<h2 style="margin-top:4px;border:0">Pursuit AVL After-Action Report</h2>
<div class="actions"><button onclick="window.print()">Print / Save PDF</button></div>
<div class="meta">
  <strong>Pursuit ID</strong><span>${pursuitEscapeHtml(meta.displayId || record.id)}</span>
  <strong>CAD / Incident</strong><span>${pursuitEscapeHtml(meta.incidentNumber || "Not entered")}</span>
  <strong>Status</strong><span>${pursuitEscapeHtml(meta.status || "unknown")}</span>
  <strong>Started</strong><span>${pursuitEscapeHtml(pursuitDisplayTime(meta.startedAt || meta.startedAtClient))}</span>
  <strong>Started by</strong><span>${pursuitEscapeHtml(meta.startedBy || "Unknown")} (${pursuitEscapeHtml(meta.startedByMode || "")})</span>
  <strong>Ended</strong><span>${pursuitEscapeHtml(meta.endedAt || meta.endedAtClient ? pursuitDisplayTime(meta.endedAt || meta.endedAtClient) : "Still active")}</span>
  <strong>Ended by</strong><span>${pursuitEscapeHtml(meta.endedBy || "—")}</span>
  <strong>Duration</strong><span>${pursuitEscapeHtml(duration)}</span>
</div>

<div class="notice">
GPS-derived speed, distance, heading, and route information are operational AVL records and are not certified radar/LIDAR or crash-reconstruction measurements. Missing segments can reflect GPS, browser, computer, or network interruptions. Dispatch sessions are view/control only and do not create vehicle breadcrumbs.
</div>

<h2>Route Diagram</h2>
<div id="map"></div>

<h2>Unit Summary</h2>
<table>
<thead><tr><th>Unit</th><th>Points</th><th>Distance</th><th>Max recorded GPS speed</th><th>Max speed time</th><th>First point</th><th>Last point</th></tr></thead>
<tbody>${summaryRows || '<tr><td colspan="7">No field-unit breadcrumbs were recorded for this pursuit.</td></tr>'}</tbody>
</table>

<h2>Event Timeline</h2>
<table>
<thead><tr><th>Time</th><th>Event</th><th>Recorded by</th><th>Notes</th></tr></thead>
<tbody>${eventRows || '<tr><td colspan="4">No timeline markers recorded.</td></tr>'}</tbody>
</table>

<p style="margin-top:28px;font-size:11px;color:#555">Generated from GCSO AVL pursuit record schema ${PURSUIT_SCHEMA_VERSION} on ${pursuitEscapeHtml(new Date().toLocaleString())}.</p>

<script>
const data=${safeJson};

(function renderReportMap(){
  const mapEl=document.getElementById("map");
  if(!mapEl) return;

  const allPoints=[];
  for(const u of data.units){
    for(const p of (u.points||[])){
      if(Number.isFinite(Number(p[0]))&&Number.isFinite(Number(p[1]))) allPoints.push([Number(p[0]),Number(p[1])]);
    }
  }
  for(const e of data.events){
    if(Number.isFinite(Number(e.lat))&&Number.isFinite(Number(e.lon))) allPoints.push([Number(e.lat),Number(e.lon)]);
  }

  if(!allPoints.length){
    mapEl.innerHTML='<div class="map-message">No field-unit GPS breadcrumbs were recorded, so there is no pursuit route to map.</div>';
    return;
  }

  const width=Math.max(320,mapEl.clientWidth||900);
  const height=Math.max(260,mapEl.clientHeight||520);
  const pad=44;

  function haversineLocal(a,b){
    const R=6371000;
    const toRad=d=>Number(d)*Math.PI/180;
    const lat1=toRad(a[0]), lat2=toRad(b[0]);
    const dLat=lat2-lat1;
    const dLon=toRad(Number(b[1])-Number(a[1]));
    const q=Math.sin(dLat/2)**2+Math.cos(lat1)*Math.cos(lat2)*Math.sin(dLon/2)**2;
    return 2*R*Math.asin(Math.sqrt(q));
  }

  let maxSeparationMeters=0;
  for(let i=0;i<allPoints.length;i++){
    for(let j=i+1;j<allPoints.length;j++){
      maxSeparationMeters=Math.max(maxSeparationMeters,haversineLocal(allPoints[i],allPoints[j]));
    }
  }

  function clampLat(lat){ return Math.max(-85.05112878,Math.min(85.05112878,lat)); }
  function worldPixel(lat,lon,z){
    const size=256*Math.pow(2,z);
    const x=(lon+180)/360*size;
    const rad=clampLat(lat)*Math.PI/180;
    const y=(1-Math.log(Math.tan(rad)+1/Math.cos(rad))/Math.PI)/2*size;
    return [x,y];
  }

  let zoom=18;
  let worldBounds=null;
  for(;zoom>=3;zoom--){
    const px=allPoints.map(p=>worldPixel(p[0],p[1],zoom));
    const xs=px.map(p=>p[0]), ys=px.map(p=>p[1]);
    const minX=Math.min.apply(null,xs), maxX=Math.max.apply(null,xs);
    const minY=Math.min.apply(null,ys), maxY=Math.max.apply(null,ys);
    worldBounds={minX,minY,maxX,maxY};
    if((maxX-minX)<=width-pad*2 && (maxY-minY)<=height-pad*2) break;
  }

  const centerX=(worldBounds.minX+worldBounds.maxX)/2;
  const centerY=(worldBounds.minY+worldBounds.maxY)/2;
  const originX=centerX-width/2;
  const originY=centerY-height/2;

  mapEl.innerHTML='<svg class="map-overlay" viewBox="0 0 '+width+' '+height+'" preserveAspectRatio="none"></svg><div class="map-north">N ↑</div><div class="map-scale"></div><div class="map-caption">Self-contained AVL route diagram • no external map service</div>';
  const svg=mapEl.querySelector(".map-overlay");
  const scaleEl=mapEl.querySelector(".map-scale");
  const ns="http://www.w3.org/2000/svg";

  // Light coordinate grid. This is intentionally self-contained so the
  // report remains printable even with no internet or blocked tile servers.
  for(let i=1;i<6;i++){
    const x=(width/6)*i;
    const y=(height/6)*i;

    const v=document.createElementNS(ns,"line");
    v.setAttribute("x1",x); v.setAttribute("y1","0");
    v.setAttribute("x2",x); v.setAttribute("y2",height);
    v.setAttribute("stroke","#d9dde2"); v.setAttribute("stroke-width","1");
    svg.appendChild(v);

    const h=document.createElementNS(ns,"line");
    h.setAttribute("x1","0"); h.setAttribute("y1",y);
    h.setAttribute("x2",width); h.setAttribute("y2",y);
    h.setAttribute("stroke","#d9dde2"); h.setAttribute("stroke-width","1");
    svg.appendChild(h);
  }

  function svgText(x,y,textValue,anchor){
    const t=document.createElementNS(ns,"text");
    t.setAttribute("x",x); t.setAttribute("y",y);
    t.setAttribute("font-size","10");
    t.setAttribute("font-family","Arial, sans-serif");
    t.setAttribute("fill","#555");
    t.setAttribute("text-anchor",anchor||"start");
    t.textContent=textValue;
    svg.appendChild(t);
    return t;
  }

  // Show geographic extent around the edge of the diagram.
  const lats=allPoints.map(p=>p[0]);
  const lons=allPoints.map(p=>p[1]);
  const minLat=Math.min.apply(null,lats), maxLat=Math.max.apply(null,lats);
  const minLon=Math.min.apply(null,lons), maxLon=Math.max.apply(null,lons);
  const stationaryTest=maxSeparationMeters<10;

  if(stationaryTest){
    const centerLat=((minLat+maxLat)/2).toFixed(6);
    const centerLon=((minLon+maxLon)/2).toFixed(6);
    svgText(width/2,28,"Stationary / very short movement test","middle");
    svgText(width/2,44,centerLat+", "+centerLon,"middle");
  }else{
    svgText(8,18,maxLat.toFixed(5)+"° N","start");
    svgText(8,height-8,minLat.toFixed(5)+"° N","start");
    svgText(8,height-24,minLon.toFixed(5)+"°","start");
    svgText(width-8,height-24,maxLon.toFixed(5)+"°","end");
  }

  // Approximate horizontal scale at the center latitude.
  const centerLat=(minLat+maxLat)/2;
  const metersPerPixel=(156543.03392*Math.cos(centerLat*Math.PI/180))/Math.pow(2,zoom);
  const targetPixels=Math.min(160,width*.22);
  const targetMeters=targetPixels*metersPerPixel;
  const niceMeters=targetMeters>=1609.344
    ? Math.max(1609.344,Math.round(targetMeters/1609.344)*1609.344)
    : Math.max(100,Math.round(targetMeters/100)*100);
  const scalePixels=Math.max(35,niceMeters/metersPerPixel);
  const scaleLabel=niceMeters>=1609.344
    ? (niceMeters/1609.344).toFixed(niceMeters>=3218.688?0:1)+" mi"
    : Math.round(niceMeters)+" m";
  if(scaleEl){
    if(stationaryTest){
      scaleEl.style.width="auto";
      scaleEl.style.borderBottom="0";
      scaleEl.innerHTML='<span style="position:absolute;left:0;bottom:0;white-space:nowrap">GPS point spread: '+maxSeparationMeters.toFixed(1)+' m</span>';
    }else{
      scaleEl.style.width=scalePixels+"px";
      scaleEl.style.borderBottom="3px solid #222";
      scaleEl.innerHTML='<span style="position:absolute;left:0;bottom:5px">'+scaleLabel+'</span>';
    }
  }

  function localPoint(lat,lon){
    const p=worldPixel(lat,lon,zoom);
    return [p[0]-originX,p[1]-originY];
  }

  function addCircle(x,y,r,fill,stroke,titleText){
    const c=document.createElementNS(ns,"circle");
    c.setAttribute("cx",x); c.setAttribute("cy",y); c.setAttribute("r",r);
    c.setAttribute("fill",fill); c.setAttribute("stroke",stroke); c.setAttribute("stroke-width","2");
    if(titleText){
      const t=document.createElementNS(ns,"title"); t.textContent=titleText; c.appendChild(t);
    }
    svg.appendChild(c);
  }

  for(const u of data.units){
    if(!u.points||!u.points.length) continue;
    const pts=u.points.map(p=>localPoint(Number(p[0]),Number(p[1])));
    const line=document.createElementNS(ns,"polyline");
    line.setAttribute("points",pts.map(p=>p[0].toFixed(1)+","+p[1].toFixed(1)).join(" "));
    line.setAttribute("fill","none");
    line.setAttribute("stroke","#fff");
    line.setAttribute("stroke-width","7");
    line.setAttribute("stroke-linejoin","round");
    line.setAttribute("stroke-linecap","round");
    line.setAttribute("opacity",".9");
    svg.appendChild(line);

    const colorLine=document.createElementNS(ns,"polyline");
    colorLine.setAttribute("points",pts.map(p=>p[0].toFixed(1)+","+p[1].toFixed(1)).join(" "));
    colorLine.setAttribute("fill","none");
    colorLine.setAttribute("stroke",u.color||"#d22");
    colorLine.setAttribute("stroke-width","4");
    colorLine.setAttribute("stroke-linejoin","round");
    colorLine.setAttribute("stroke-linecap","round");
    const title=document.createElementNS(ns,"title");
    title.textContent="Unit "+u.unitId;
    colorLine.appendChild(title);
    svg.appendChild(colorLine);

    const first=pts[0], last=pts[pts.length-1];
    addCircle(first[0],first[1],6,"#27a844","#fff","Unit "+u.unitId+" start");
    addCircle(last[0],last[1],6,"#c82333","#fff","Unit "+u.unitId+" end");
  }

  for(const e of data.events){
    const p=localPoint(Number(e.lat),Number(e.lon));
    addCircle(p[0],p[1],5,"#ffd54f","#222",(e.label||"Pursuit event")+" — "+(e.time||""));
  }
})();
<\/script>
</body>
</html>`;
}

let pursuitReportMapInstance = null;

function ensurePursuitReportViewStyles() {
  if (document.getElementById("pursuitReportViewStyles")) return;

  const style = document.createElement("style");
  style.id = "pursuitReportViewStyles";
  style.textContent = `
    #pursuitReportOverlay {
      position: fixed;
      inset: 0;
      z-index: 20000;
      overflow: auto;
      background: #fff;
      color: #111;
      font-family: Arial, sans-serif;
    }
    #pursuitReportOverlay .report-shell {
      width: min(1100px, calc(100% - 32px));
      margin: 0 auto;
      padding: 18px 0 36px;
    }
    #pursuitReportOverlay .report-actions {
      position: sticky;
      top: 0;
      z-index: 1001;
      display: flex;
      gap: 8px;
      padding: 10px 0;
      background: rgba(255,255,255,.96);
      border-bottom: 1px solid #bbb;
    }
    #pursuitReportOverlay .report-actions button {
      width: auto;
      padding: 8px 14px;
      margin: 0;
    }
    #pursuitReportOverlay h1 { margin: 18px 0 4px; }
    #pursuitReportOverlay h2 {
      margin-top: 24px;
      border-bottom: 2px solid #333;
      padding-bottom: 5px;
    }
    #pursuitReportOverlay .report-meta {
      display: grid;
      grid-template-columns: 180px 1fr;
      gap: 5px 12px;
      margin: 18px 0;
    }
    #pursuitReportOverlay .report-notice {
      margin: 14px 0;
      padding: 10px;
      background: #fff5cc;
      border-left: 4px solid #c78f00;
      font-size: 12px;
    }
    #pursuitReportMap {
      height: 520px;
      border: 1px solid #777;
      margin: 12px 0;
      background: #eee;
    }
    #pursuitReportOverlay table {
      width: 100%;
      border-collapse: collapse;
      font-size: 12px;
    }
    #pursuitReportOverlay th,
    #pursuitReportOverlay td {
      border: 1px solid #bbb;
      padding: 6px;
      text-align: left;
    }
    #pursuitReportOverlay th { background: #eee; }

    @media print {
      body.pursuit-report-printing > *:not(#pursuitReportOverlay) {
        display: none !important;
      }
      body.pursuit-report-printing #pursuitReportOverlay {
        position: static !important;
        overflow: visible !important;
      }
      body.pursuit-report-printing #pursuitReportOverlay .report-shell {
        width: 100% !important;
        padding: 0 !important;
      }
      body.pursuit-report-printing #pursuitReportOverlay .report-actions {
        display: none !important;
      }
      body.pursuit-report-printing #pursuitReportMap {
        height: 360px !important;
      }
      body.pursuit-report-printing #pursuitReportOverlay h1 {
        font-size: 24px;
      }
      body.pursuit-report-printing #pursuitReportOverlay h2 {
        font-size: 18px;
        margin-top: 16px;
      }
      body.pursuit-report-printing #pursuitReportOverlay .report-meta {
        margin: 10px 0;
        gap: 3px 10px;
      }
      body.pursuit-report-printing #pursuitReportOverlay .report-notice {
        margin: 8px 0;
        padding: 7px;
        font-size: 10px;
      }
      body.pursuit-report-printing #pursuitReportOverlay table {
        font-size: 10px;
      }
      body.pursuit-report-printing #pursuitReportOverlay th,
      body.pursuit-report-printing #pursuitReportOverlay td {
        padding: 4px;
      }
      body.pursuit-report-printing .leaflet-control-zoom {
        display: none !important;
      }
    }
  `;
  document.head.appendChild(style);
}

function closePursuitReportView() {
  if (pursuitReportMapInstance) {
    try { pursuitReportMapInstance.remove(); } catch (_) {}
    pursuitReportMapInstance = null;
  }
  const overlay = document.getElementById("pursuitReportOverlay");
  if (overlay) overlay.remove();
  document.body.classList.remove("pursuit-report-printing");
}

function printPursuitReportView() {
  document.body.classList.add("pursuit-report-printing");
  if (pursuitReportMapInstance) {
    setTimeout(() => pursuitReportMapInstance.invalidateSize(), 50);
  }
  setTimeout(() => window.print(), 250);
}

window.addEventListener("afterprint", () => {
  document.body.classList.remove("pursuit-report-printing");
  if (pursuitReportMapInstance) {
    setTimeout(() => pursuitReportMapInstance.invalidateSize(), 50);
  }
});

function buildPursuitReportViewMarkup(record) {
  const meta = record.meta || {};
  const units = normalizedPursuitUnits(record);
  const events = normalizedPursuitEvents(record);
  const start = Number(meta.startedAt || meta.startedAtClient || 0);
  const end = Number(meta.endedAt || meta.endedAtClient || Date.now());
  const duration = end && start ? pursuitFormatDuration(end - start) : "Unknown";

  const summaryRows = units.map(unit => {
    const summary = summarizePursuitUnit(unit);
    return `
      <tr>
        <td>${pursuitEscapeHtml(unit.unitId)}</td>
        <td>${summary.pointCount}</td>
        <td>${summary.distanceMiles.toFixed(2)} mi</td>
        <td>${summary.maxSpeedMph.toFixed(1)} mph</td>
        <td>${summary.maxSpeedPoint ? pursuitEscapeHtml(pursuitDisplayTime(summary.maxSpeedPoint.gpsTime || summary.maxSpeedPoint.clientTime)) : "—"}</td>
        <td>${summary.firstPoint ? pursuitEscapeHtml(pursuitDisplayTime(summary.firstPoint.gpsTime || summary.firstPoint.clientTime)) : "—"}</td>
        <td>${summary.lastPoint ? pursuitEscapeHtml(pursuitDisplayTime(summary.lastPoint.gpsTime || summary.lastPoint.clientTime)) : "—"}</td>
      </tr>`;
  }).join("");

  const eventRows = events.map(e => `
    <tr>
      <td>${pursuitEscapeHtml(pursuitDisplayTime(e.serverTime || e.clientTime))}</td>
      <td>${pursuitEscapeHtml(e.label || e.type || "Event")}</td>
      <td>${pursuitEscapeHtml(e.by || "")}</td>
      <td>${pursuitEscapeHtml(e.notes || "")}</td>
    </tr>`).join("");

  return `
    <div class="report-shell">
      <div class="report-actions">
        <button onclick="printPursuitReportView()">PRINT / SAVE PDF</button>
        <button onclick="closePursuitReportView()">CLOSE REPORT</button>
      </div>

      <h1>Gallatin County Sheriff's Office</h1>
      <h2 style="margin-top:4px;border:0">Pursuit AVL After-Action Report</h2>

      <div class="report-meta">
        <strong>Pursuit ID</strong><span>${pursuitEscapeHtml(meta.displayId || record.id)}</span>
        <strong>CAD / Incident</strong><span>${pursuitEscapeHtml(meta.incidentNumber || "Not entered")}</span>
        <strong>Status</strong><span>${pursuitEscapeHtml(meta.status || "unknown")}</span>
        <strong>Started</strong><span>${pursuitEscapeHtml(pursuitDisplayTime(meta.startedAt || meta.startedAtClient))}</span>
        <strong>Started by</strong><span>${pursuitEscapeHtml(meta.startedBy || "Unknown")} (${pursuitEscapeHtml(meta.startedByMode || "")})</span>
        <strong>Ended</strong><span>${pursuitEscapeHtml(meta.endedAt || meta.endedAtClient ? pursuitDisplayTime(meta.endedAt || meta.endedAtClient) : "Still active")}</span>
        <strong>Ended by</strong><span>${pursuitEscapeHtml(meta.endedBy || "—")}</span>
        <strong>Duration</strong><span>${pursuitEscapeHtml(duration)}</span>
      </div>

      <div class="report-notice">
        GPS-derived speed, distance, heading, and route information are operational AVL records and are not certified radar/LIDAR or crash-reconstruction measurements. Missing segments can reflect GPS, browser, computer, or network interruptions. Dispatch sessions are view/control only and do not create vehicle breadcrumbs.
      </div>

      <h2>Route Map</h2>
      <div id="pursuitReportMap"></div>

      <h2>Unit Summary</h2>
      <table>
        <thead>
          <tr><th>Unit</th><th>Points</th><th>Distance</th><th>Max recorded GPS speed</th><th>Max speed time</th><th>First point</th><th>Last point</th></tr>
        </thead>
        <tbody>${summaryRows || '<tr><td colspan="7">No field-unit breadcrumbs were recorded for this pursuit.</td></tr>'}</tbody>
      </table>

      <h2>Event Timeline</h2>
      <table>
        <thead><tr><th>Time</th><th>Event</th><th>Recorded by</th><th>Notes</th></tr></thead>
        <tbody>${eventRows || '<tr><td colspan="4">No timeline markers recorded.</td></tr>'}</tbody>
      </table>

      <p style="margin-top:24px;font-size:11px;color:#555">Generated from GCSO AVL pursuit record schema ${PURSUIT_SCHEMA_VERSION} on ${pursuitEscapeHtml(new Date().toLocaleString())}.</p>
    </div>`;
}

function renderPursuitReportLeafletMap(record) {
  const mapEl = document.getElementById("pursuitReportMap");
  if (!mapEl || typeof L === "undefined") return;

  const units = normalizedPursuitUnits(record);
  const events = normalizedPursuitEvents(record);
  pursuitReportMapInstance = L.map(mapEl, { zoomControl: true, preferCanvas: true });

  L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: "&copy; OpenStreetMap contributors"
  }).addTo(pursuitReportMapInstance);

  const bounds = L.latLngBounds([]);

  units.forEach(unit => {
    const points = unit.points
      .filter(p => isValidLatLon(Number(p.lat), Number(p.lon)))
      .map(p => [Number(p.lat), Number(p.lon)]);

    if (!points.length) return;

    const color = pursuitColorForUnit(unit.unitKey);
    L.polyline(points, {
      color: "#ffffff",
      weight: 7,
      opacity: 0.9,
      lineJoin: "round"
    }).addTo(pursuitReportMapInstance);

    L.polyline(points, {
      color,
      weight: 4,
      opacity: 0.95,
      lineJoin: "round"
    }).addTo(pursuitReportMapInstance)
      .bindTooltip(`Unit ${unit.unitId}`, { sticky: true });

    L.circleMarker(points[0], {
      radius: 6, color: "#fff", weight: 2, fillColor: "#27a844", fillOpacity: 1
    }).addTo(pursuitReportMapInstance).bindTooltip(`Unit ${unit.unitId} start`);

    L.circleMarker(points[points.length - 1], {
      radius: 6, color: "#fff", weight: 2, fillColor: "#c82333", fillOpacity: 1
    }).addTo(pursuitReportMapInstance).bindTooltip(`Unit ${unit.unitId} end`);

    points.forEach(p => bounds.extend(p));
  });

  events
    .filter(e => isValidLatLon(Number(e.lat), Number(e.lon)))
    .forEach(e => {
      const latLng = [Number(e.lat), Number(e.lon)];
      L.circleMarker(latLng, {
        radius: 5,
        color: "#222",
        weight: 2,
        fillColor: "#ffd54f",
        fillOpacity: 1
      }).addTo(pursuitReportMapInstance)
        .bindPopup(`<b>${pursuitEscapeHtml(e.label || e.type || "Pursuit event")}</b><br>${pursuitEscapeHtml(pursuitDisplayTime(e.serverTime || e.clientTime))}`);
      bounds.extend(latLng);
    });

  if (bounds.isValid()) {
    pursuitReportMapInstance.fitBounds(bounds, { padding: [35, 35], maxZoom: 17 });
  } else {
    pursuitReportMapInstance.setView([38.9, -84.5], 10);
  }

  setTimeout(() => pursuitReportMapInstance?.invalidateSize(), 100);
}

async function openPursuitReport() {
  try {
    const record = await loadPursuitRecord(selectedPursuitReportId());
    closePursuitReportView();
    ensurePursuitReportViewStyles();

    const overlay = document.createElement("div");
    overlay.id = "pursuitReportOverlay";
    overlay.innerHTML = buildPursuitReportViewMarkup(record);
    document.body.appendChild(overlay);

    renderPursuitReportLeafletMap(record);
  } catch (err) {
    alert(`Report failed: ${err?.message || err}`);
  }
}

async function downloadPursuitHtmlReport() {
  try {
    const record = await loadPursuitRecord(selectedPursuitReportId());
    downloadBlobFile(pursuitSafeFilename(record, "html"), buildReportHtml(record), "text/html;charset=utf-8");
  } catch (err) {
    alert(err?.message || err);
  }
}

// Global pursuit control listener. Every logged-in unit receives the same event.
pursuitActiveIdRef.on("value", snap => {
  onActivePursuitChanged(snap.val() || null);
});

// Keep the pursuit panel in sync with app.js login/logout without modifying
// the existing authentication/session code.
setInterval(updatePursuitPanelVisibility, 500);

// Maintain a short rolling GPS history even before pursuit activation. If a
// field unit is already in a cellular dead zone when pursuit mode starts, the
// stored points can be backfilled once that unit receives the activation.
setInterval(captureRollingPursuitFix, 500);
window.addEventListener("beforeunload", () => persistRollingPursuitFixes(true));

// Buffered pursuit breadcrumbs survive ordinary cellular dead zones and are
// retried after Firebase reconnects.
setInterval(flushPendingPursuitPoints, 3000);
setInterval(updatePursuitBufferStatus, 1000);

connectedRef.on("value", snap => {
  if (snap.val() === true) {
    setTimeout(flushPendingPursuitPoints, 1200);
    scheduleRecentPursuitLoad(400);
  }
});

updatePursuitPanelVisibility();
renderPursuitActiveState();
scheduleRecentPursuitLoad(800);
