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
  const speedMps = Number(fix.speed || 0);
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
  };
  ref.on("value", handler);
  pursuitActiveMetaListener = { ref, handler };
}

function onActivePursuitChanged(nextId) {
  const oldId = pursuitActiveId;
  pursuitActiveId = nextId || null;

  if (pursuitActiveId) {
    subscribePursuitMeta(pursuitActiveId);
    attachPursuitTrails(pursuitActiveId);
    startLocalPursuitRecording();
    showPursuitMessage("Pursuit mode active — breadcrumb recording enabled.", "good");
  } else {
    stopLocalPursuitRecording();
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
<link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css">
<style>
body{font-family:Arial,sans-serif;margin:24px;color:#111}
h1{margin:0 0 4px} h2{margin-top:26px;border-bottom:2px solid #333;padding-bottom:5px}
.meta{display:grid;grid-template-columns:180px 1fr;gap:5px 12px;margin:18px 0}
#map{height:520px;border:1px solid #777;margin:12px 0}
table{width:100%;border-collapse:collapse;font-size:12px}
th,td{border:1px solid #bbb;padding:6px;text-align:left} th{background:#eee}
.notice{margin:14px 0;padding:10px;background:#fff5cc;border-left:4px solid #c78f00;font-size:12px}
.actions{display:flex;gap:8px;margin:12px 0}.actions button{padding:8px 12px}
@media print{.actions{display:none}body{margin:10mm}#map{height:420px}}
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
GPS-derived speed, distance, heading, and route information are operational AVL records and are not certified radar/LIDAR or crash-reconstruction measurements. Missing segments can reflect GPS, browser, computer, or network interruptions.
</div>

<h2>Route Map</h2>
<div id="map"></div>

<h2>Unit Summary</h2>
<table>
<thead><tr><th>Unit</th><th>Points</th><th>Distance</th><th>Max recorded GPS speed</th><th>Max speed time</th><th>First point</th><th>Last point</th></tr></thead>
<tbody>${summaryRows || '<tr><td colspan="7">No unit breadcrumbs recorded.</td></tr>'}</tbody>
</table>

<h2>Event Timeline</h2>
<table>
<thead><tr><th>Time</th><th>Event</th><th>Recorded by</th><th>Notes</th></tr></thead>
<tbody>${eventRows || '<tr><td colspan="4">No timeline markers recorded.</td></tr>'}</tbody>
</table>

<p style="margin-top:28px;font-size:11px;color:#555">Generated from GCSO AVL pursuit record schema ${PURSUIT_SCHEMA_VERSION} on ${pursuitEscapeHtml(new Date().toLocaleString())}.</p>

<script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"><\/script>
<script>
const data=${safeJson};
const map=L.map("map").setView([38.9,-84.5],10);
L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png",{maxZoom:19,attribution:"&copy; OpenStreetMap contributors"}).addTo(map);
const bounds=[];
for(const u of data.units){
  if(!u.points.length) continue;