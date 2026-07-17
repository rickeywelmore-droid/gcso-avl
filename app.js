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

// Temporary client-side access gate. This is a convenience barrier, not strong security.
const USER_PASSWORD = "GCSO123";
const ADMIN_PASSWORD = "GCSOADMIN123";
const APP_VERSION = "1.0.0-split-reconnect";

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
let presenceTimer = null;
let latestUnits = {};
let latestSessions = {};
let renderUnitListTimer = null;
let sessionLoginTime = null;
let userRole = "user";
let selectedRosterUnitId = null;
let firebaseConnected = false;
let lastPendingFix = null;
let lastPendingUnitId = null;
let lastSuccessfulWriteTime = 0;
let lastFirebaseConnectionChange = Date.now();
let developerPanelVisible = false;

const SESSION_STALE_MS = 2 * 60 * 1000; // logged-in heartbeat grace period

// A unit should only show OFFLINE after no GPS data has been received for this long.
const UNIT_OFFLINE_MS = 15 * 60 * 1000; // 15 minutes
let unitListRenderTimer = null;
let latestUnitsSnapshot = {};

//////////////////////////////////////////////////////
// LOGIN / SESSION
//////////////////////////////////////////////////////



function updateLoginPlaceholder() {
  const loginInput = document.getElementById("loginUnitId");
  const loginMode = document.getElementById("loginMode");
  if (!loginInput || !loginMode) return;
  loginInput.placeholder = loginMode.value === "dispatch" ? "Dispatcher Name" : "Unit ID";
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
  if (unitIdInput) unitIdInput.placeholder = userMode === "dispatch" ? "Dispatch Name" : "Unit ID";

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
  presenceTimer = setInterval(publishPresence, 30000);
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

function configureDisconnectCleanup() {
  if (!currentUnitId) return;

  currentSessionKey = currentSessionKey || getSessionKey(userMode, currentUnitId);

  // IMPORTANT:
  // Do NOT use Firebase onDisconnect().remove() here.
  // In rural/low-cell areas, Firebase can disconnect even though the AVL page,
  // laptop, and GPS receiver are still running locally. If we delete on network
  // loss, dispatch loses the unit from the map during ordinary coverage drops.
  //
  // Instead:
  // - Normal browser/tab close calls removeCurrentSessionNow().
  // - Log Off removes the unit immediately.
  // - Internet loss keeps the last GPS point visible and heartbeat becomes stale.
}

function publishPresence() {
  if (!currentUnitId) return;

  currentSessionKey = currentSessionKey || getSessionKey(userMode, currentUnitId);
  configureDisconnectCleanup();

  sessionsRef.child(currentSessionKey).set({
    id: currentUnitId,
    displayName: currentUnitId,
    mode: userMode || "unit",
    loggedIn: true,
    lastSeen: Date.now(),
    loginTime: sessionLoginTime || Date.now()
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

  if (remove && keyToRemove) {
    await sessionsRef.child(keyToRemove).remove().catch(() => {});
  }

  currentSessionKey = null;
}

function restoreLogin() {
  const savedId = localStorage.getItem("avl_unitId");
  const savedMode = localStorage.getItem("avl_mode");
  const savedAccess = localStorage.getItem("avl_temp_access");
  const savedRole = localStorage.getItem("avl_role");

  if (!savedId || savedAccess !== "granted") return;

  currentUnitId = savedId;
  userMode = savedMode || "unit";
  userRole = savedRole === "admin" ? "admin" : "user";
  currentSessionKey = getSessionKey(userMode, currentUnitId);
  sessionLoginTime = parseInt(localStorage.getItem("avl_sessionLoginTime"), 10) || Date.now();
  localStorage.setItem("avl_sessionLoginTime", String(sessionLoginTime));

  document.getElementById("unitId").value = savedId;
  document.getElementById("loginScreen").style.display = "none";

  applyModeUi();
  startPresenceHeartbeat();
  setStatus(`Session restored for ${savedId}`, "good");
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

function login() {
  const modeEl = document.getElementById("loginMode");
  const passwordEl = document.getElementById("loginPassword");
  const mode = modeEl ? modeEl.value : "unit";
  const id = getTypedLoginId();
  const password = passwordEl ? passwordEl.value : "";

  if (!id) return alert(mode === "dispatch" ? "Enter dispatcher name" : "Enter Unit ID");

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
  setStatus(`Logged in as ${id} (${mode}${userRole === "admin" ? ", admin" : ""})`, "good");
}

async function logout() {
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

  localStorage.removeItem("avl_unitId");
  localStorage.removeItem("avl_mode");
  localStorage.removeItem("avl_sessionLoginTime");
  localStorage.removeItem("avl_role");
  localStorage.removeItem("avl_temp_access");

  document.getElementById("unitId").value = "";
  document.getElementById("loginScreen").style.display = "flex";
  applyModeUi();

  setStatus("Logged out", "warn");
}

updateLoginPlaceholder();
restoreLogin();
//////////////////////////////////////////////////////
// WAKE LOCK / BACKGROUND SAFEGUARDS
//////////////////////////////////////////////////////

let wakeLock = null;

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

window.addEventListener("pagehide", () => {
  removeCurrentSessionNow();
});

window.addEventListener("beforeunload", () => {
  removeCurrentSessionNow();
});


//////////////////////////////////////////////////////
// NETWORK / FIREBASE RECONNECTION
//////////////////////////////////////////////////////

restorePendingFix();

connectedRef.on("value", async (snap) => {
  firebaseConnected = snap.val() === true;
  lastFirebaseConnectionChange = Date.now();

  if (firebaseConnected) {
    setNetworkStatus("ONLINE", "good");
    if (currentUnitId) publishPresence();
    await flushPendingFix();
  } else {
    setNetworkStatus("FIREBASE DISCONNECTED — GPS WILL KEEP RUNNING", "warn");
  }

  updateDeveloperInfo();
});

window.addEventListener("offline", () => {
  setNetworkStatus("INTERNET LOST — SAVING LATEST FIX", "warn");
  updateDeveloperInfo();
});

window.addEventListener("online", async () => {
  setNetworkStatus("RECONNECTING...", "warn");
  if (currentUnitId) publishPresence();
  await flushPendingFix();
  updateDeveloperInfo();
});

setInterval(() => {
  updateDeveloperInfo();
  if (firebaseConnected && lastPendingFix) flushPendingFix();
}, 10000);

//////////////////////////////////////////////////////
// SERIAL STATE
//////////////////////////////////////////////////////

let serialPort = null;
let serialReader = null;
let serialKeepReading = false;
let serialBuffer = "";
let serialAutoMode = false;
let serialReconnectTimer = null;
let currentSerialLabel = "External USB GPS";
let currentSerialBaud = null;

let lastValidFixTime = 0;
let lastFix = null;

const SERIAL_BAUD_RATES = [9600, 4800, 38400, 115200];
const GPS_PROBE_MS = 2500;
const GPS_RESCAN_MS = 3000;

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

  el.innerText =
    `Version: ${APP_VERSION}
` +
    `Role: ${userRole}
` +
    `Mode: ${userMode || "not logged in"}
` +
    `Firebase: ${firebaseConnected ? "CONNECTED" : "DISCONNECTED"}
` +
    `Browser network: ${navigator.onLine ? "ONLINE" : "OFFLINE"}
` +
    `Last GPS: ${lastGps}
` +
    `Last Firebase write: ${lastWrite}
` +
    `Pending fix: ${lastPendingFix ? "YES" : "NO"}
` +
    `Serial: ${serialPort ? `CONNECTED @ ${currentSerialBaud || "?"}` : "DISCONNECTED"}
` +
    `Wake lock: ${wakeLock ? "ACTIVE" : "INACTIVE"}
` +
    `Selected unit: ${selectedRosterUnitId || "None"}`;
}

function getSerialPortLabel(port) {
  const info = port && port.getInfo ? port.getInfo() : {};

  if (info.usbVendorId || info.usbProductId) {
    const vid = info.usbVendorId ? info.usbVendorId.toString(16).toUpperCase().padStart(4, "0") : "????";
    const pid = info.usbProductId ? info.usbProductId.toString(16).toUpperCase().padStart(4, "0") : "????";
    return `USB GPS VID:${vid} PID:${pid}`;
  }

  return "External USB GPS";
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

  setStatus(`${reason}. Auto-detect will retry...`, "warn");

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
    setStatus("Choose the external GPS receiver one time. After that, Auto Detect can reuse it.", "warn");
    await navigator.serial.requestPort();
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

  try {
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

    setStatus(`Auto-detect scanning ${ports.length} serial device(s)...`, "warn");

    const found = await findNmeaGpsPort(ports);

    if (!found) {
      scheduleSerialRescan("No valid NMEA GPS stream found");
      return;
    }

    serialPort = found.port;
    currentSerialBaud = found.baudRate;
    currentSerialLabel = getSerialPortLabel(serialPort);
    localStorage.setItem("avl_lastGpsSignature", getSerialPortSignature(serialPort));
    localStorage.setItem("avl_lastBaudRate", String(currentSerialBaud));
    const baudSelect = document.getElementById("baudRate");
    if (baudSelect) baudSelect.value = String(currentSerialBaud);

    await serialPort.open({
      baudRate: currentSerialBaud,
      dataBits: 8,
      stopBits: 1,
      parity: "none",
      flowControl: "none"
    });

    serialKeepReading = true;
    setStatus(`External GPS locked: ${currentSerialLabel} @ ${currentSerialBaud} baud`, "good");
    setFixDetails(
      `GPS Source: External USB GPS\n` +
      `Device: ${currentSerialLabel}\n` +
      `Baud: ${currentSerialBaud}\n` +
      `Fix: waiting for valid RMC or GGA...`
    );

    readSerialLoop();

  } catch (err) {
    console.error(err);
    setStatus("External GPS auto-detect failed: " + err.message, "bad");
    scheduleSerialRescan("External GPS error");
  }
}

async function findNmeaGpsPort(ports) {
  const baudCandidates = getBaudCandidates();

  for (const port of ports) {
    for (const baudRate of baudCandidates) {
      setStatus(`Checking ${getSerialPortLabel(port)} @ ${baudRate} baud...`, "warn");

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

    if (manual) setStatus("External GPS disconnected", "warn");

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
      serialReader = serialPort.readable.getReader();

      try {
        while (serialKeepReading) {
          const { value, done } = await serialReader.read();

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
        serialReader.releaseLock();
        serialReader = null;
      }
    }
  } catch (err) {
    console.error(err);
    setStatus("External GPS read error: " + err.message, "bad");
  } finally {
    if (serialAutoMode) {
      try {
        if (serialPort) await serialPort.close().catch(() => {});
      } catch (_) {}
      serialPort = null;
      scheduleSerialRescan("External GPS lost");
    }
  }
}

//////////////////////////////////////////////////////
// NMEA HANDLER
//////////////////////////////////////////////////////

function handleNMEA(sentence) {
  setRawNmea(sentence);

  if (!sentence.startsWith("$")) return;

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

  const satellites = parseInt(parts[7], 10) || 0;
  const hdop = parseFloat(parts[8]) || null;

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
  publishPresence();

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
  const last = session && session.lastSeen ? session.lastSeen : 0;
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
    // Always show units that still have GPS data. A stale/missing session usually
    // means connection lost, not that the GPS point should disappear.
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
    if (!data[id]) {
      map.removeLayer(markers[id]);
      delete markers[id];
    }
  });

  // Keep map markers for any unit that still has coordinates.
  Object.keys(data).forEach((id) => {
    const u = data[id];
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
      if (mode === "Unit") {
        selectedRosterUnitId = id;
        const selectedLabel = document.getElementById("selectedUnitLabel");
        if (selectedLabel) selectedLabel.textContent = `Selected unit: ${id}`;
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

    publishPresence();
    publishUnitData(id, data);
    updateMap(id, data);

    setStatus("Browser GPS active", "good");

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
  if (!id) {
    alert("Select a unit from the roster first");
    return;
  }

  if (!confirm(`Remove Unit ${id} from AVL?`)) return;

  if (browserWatchId !== null && id === currentUnitId) {
    navigator.geolocation.clearWatch(browserWatchId);
    browserWatchId = null;
  }

  if (id === currentUnitId) {
    await disconnectSerialGPS();
  }

  await sessionsRef.child(getSessionKey("unit", id)).remove().catch(() => {});
  await unitsRef.child(id).remove();

  if (markers[id]) {
    map.removeLayer(markers[id]);
    delete markers[id];
  }

  if (id === currentUnitId) currentUnitId = null;

  selectedRosterUnitId = null;
  const selectedLabel = document.getElementById("selectedUnitLabel");
  if (selectedLabel) selectedLabel.textContent = "Selected unit: None";

  setStatus(`Unit ${id} removed`, "warn");
  setFixDetails(`Unit ${id} removed by admin.`);
  updateDeveloperInfo();
}

// Backward-compatible alias for old Remove Unit button behavior.
function removeUnit() {
  forceRemoveUnit();
}
