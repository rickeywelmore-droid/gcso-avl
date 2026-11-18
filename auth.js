//////////////////////////////////////////////////////
// GCSO AVL FIREBASE AUTHENTICATION LAYER
// v1.3.0-auth1 — 2026-11-17
//////////////////////////////////////////////////////

const avlAuth = firebase.auth();
const avlProfilesRef = db.ref("profiles");

let avlAuthBusy = false;
let avlAuthRestoring = false;
let avlAuthSigningOut = false;

function authSetStatus(message, state = "") {
  const el = document.getElementById("loginStatus");
  if (!el) return;
  el.textContent = message || "";
  el.style.color = state === "bad" ? "#ff8e88" : state === "good" ? "#85d99d" : "#bbb";
}

function authSetBusy(busy) {
  avlAuthBusy = !!busy;
  const button = document.getElementById("loginButton");
  if (!button) return;
  button.disabled = avlAuthBusy;
  button.textContent = avlAuthBusy ? "Signing In..." : "Enter System";
}

function normalizeAvlProfile(raw) {
  const p = raw && typeof raw === "object" ? raw : {};
  return {
    enabled: p.enabled === true,
    displayName: String(p.displayName || "").trim(),
    unitId: String(p.unitId || "").trim(),
    canUnit: p.canUnit === true,
    canDispatch: p.canDispatch === true,
    admin: p.admin === true
  };
}

async function loadAvlProfile(user) {
  if (!user?.uid) throw new Error("Firebase user identity is unavailable.");
  const snapshot = await avlProfilesRef.child(user.uid).once("value");
  if (!snapshot.exists()) {
    throw new Error("This Firebase account does not have an AVL profile.");
  }
  return normalizeAvlProfile(snapshot.val());
}

function validateAvlProfileMode(profile, mode) {
  if (!profile.enabled) return "This AVL account is disabled.";

  if (mode === "dispatch") {
    if (!profile.canDispatch) return "This account is not authorized for Dispatch mode.";
    if (!isValidDispatchName(profile.displayName)) {
      return "This account does not have a valid dispatcher display name.";
    }
    return "";
  }

  if (!profile.canUnit) return "This account is not authorized for Unit mode.";
  if (!profile.unitId) return "This account does not have an assigned Unit ID.";
  return "";
}

async function startFirebaseAuthenticatedAvlSession(user, profile, requestedMode, restored) {
  const mode = requestedMode === "dispatch" ? "dispatch" : "unit";
  const error = validateAvlProfileMode(profile, mode);
  if (error) throw new Error(error);

  const id = mode === "dispatch" ? profile.displayName : profile.unitId;

  currentUnitId = id;
  userMode = mode;
  userRole = profile.admin ? "admin" : "user";
  currentSessionKey = getSessionKey(userMode, currentUnitId);
  sessionLoginTime = restored
    ? (parseInt(localStorage.getItem("avl_sessionLoginTime"), 10) || Date.now())
    : Date.now();

  localStorage.setItem("avl_unitId", currentUnitId);
  localStorage.setItem("avl_mode", userMode);
  localStorage.setItem("avl_role", userRole);
  localStorage.setItem("avl_sessionLoginTime", String(sessionLoginTime));
  localStorage.removeItem("avl_temp_access");
  localStorage.removeItem("avl_requestedMode");

  const unitIdEl = document.getElementById("unitId");
  const loginScreen = document.getElementById("loginScreen");
  const passwordEl = document.getElementById("loginPassword");

  if (unitIdEl) unitIdEl.value = currentUnitId;
  if (loginScreen) loginScreen.style.display = "none";
  if (passwordEl) passwordEl.value = "";

  applyModeUi();
  startUnitRosterSubscription();
  if (typeof startPursuitFirebaseSubscriptions === "function") {
    startPursuitFirebaseSubscriptions();
  }
  startPresenceHeartbeat();
  watchOwnDispatchSession();
  startDispatchIdleMonitor();

  const verb = restored ? "Session restored" : "Logged in";
  setStatus(`${verb} as ${currentUnitId} (${userMode}${userRole === "admin" ? ", admin" : ""})`, "good");
  authSetStatus("");
  addDiagnosticEvent(`${verb}: ${currentUnitId} (${userMode}, Firebase Auth)`);

  writeAuditEvent(restored ? "session_restored" : "login",
    `${verb} for ${currentUnitId} (${userMode}${userRole === "admin" ? ", admin" : ""}) using Firebase Authentication`, {
      source: restored ? "automatic" : "user",
      severity: "info",
      includeLocation: userMode !== "dispatch",
      lookupStoredLocation: true,
      reason: `Firebase UID ${user.uid}`
    }
  );
}

async function firebaseAuthLogin() {
  if (avlAuthBusy) return;

  const emailEl = document.getElementById("loginEmail");
  const passwordEl = document.getElementById("loginPassword");
  const modeEl = document.getElementById("loginMode");

  const email = String(emailEl?.value || "").trim();
  const password = String(passwordEl?.value || "");
  const mode = modeEl?.value === "dispatch" ? "dispatch" : "unit";

  if (!email) return authSetStatus("Enter your account email.", "bad");
  if (!password) return authSetStatus("Enter your password.", "bad");

  authSetBusy(true);
  authSetStatus("Authenticating...", "");
  localStorage.setItem("avl_requestedMode", mode);
  localStorage.setItem("avl_loginEmail", email);

  try {
    const credential = await avlAuth.signInWithEmailAndPassword(email, password);
    const profile = await loadAvlProfile(credential.user);
    await startFirebaseAuthenticatedAvlSession(credential.user, profile, mode, false);
  } catch (err) {
    const code = String(err?.code || "");
    let friendly = err?.message || "AVL sign-in failed.";

    if (code === "auth/invalid-credential" || code === "auth/wrong-password" || code === "auth/user-not-found") {
      friendly = "Incorrect email or password.";
    } else if (code === "auth/too-many-requests") {
      friendly = "Too many failed sign-in attempts. Try again later.";
    }

    authSetStatus(friendly, "bad");
    localStorage.removeItem("avl_requestedMode");

    try {
      avlAuthSigningOut = true;
      await avlAuth.signOut();
    } catch (_) {
    } finally {
      avlAuthSigningOut = false;
    }
  } finally {
    authSetBusy(false);
  }
}

async function firebaseAuthLogout() {
  if (avlAuthSigningOut) return;

  stopUnitRosterSubscription();
  if (typeof stopPursuitFirebaseSubscriptions === "function") {
    stopPursuitFirebaseSubscriptions();
  }

  const legacyLogout = window.__gcsoLegacyLogout;
  if (typeof legacyLogout === "function") {
    await legacyLogout();
  }

  try {
    avlAuthSigningOut = true;
    await avlAuth.signOut();
  } finally {
    avlAuthSigningOut = false;
  }

  authSetStatus("Signed out.", "");
}

async function restoreFirebaseAuthSession(user) {
  if (!user || currentUnitId || avlAuthRestoring) return;
  avlAuthRestoring = true;

  try {
    const profile = await loadAvlProfile(user);
    let mode = localStorage.getItem("avl_requestedMode") || localStorage.getItem("avl_mode");
    if (mode !== "dispatch" && mode !== "unit") {
      mode = profile.canUnit ? "unit" : "dispatch";
    }
    await startFirebaseAuthenticatedAvlSession(user, profile, mode, true);
  } catch (err) {
    authSetStatus(err?.message || "Unable to restore authenticated AVL session.", "bad");

    try {
      avlAuthSigningOut = true;
      await avlAuth.signOut();
    } catch (_) {
    } finally {
      avlAuthSigningOut = false;
    }
  } finally {
    avlAuthRestoring = false;
  }
}

function initializeFirebaseAuthUi() {
  const emailEl = document.getElementById("loginEmail");
  const passwordEl = document.getElementById("loginPassword");

  const savedEmail = localStorage.getItem("avl_loginEmail");
  if (emailEl && savedEmail) emailEl.value = savedEmail;

  if (emailEl) {
    emailEl.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        firebaseAuthLogin();
      }
    });
  }

  // app.js already wires Enter on the password field to login().
  // login() is replaced below, so the existing handler continues to work.
  if (passwordEl) passwordEl.placeholder = "Password";

  window.__gcsoLegacyLogout = window.logout;
  window.login = firebaseAuthLogin;
  window.logout = firebaseAuthLogout;

  avlAuth.onAuthStateChanged((user) => {
    if (avlAuthSigningOut || avlAuthBusy) return;

    if (user) {
      restoreFirebaseAuthSession(user);
      return;
    }

    if (!currentUnitId) {
      const loginScreen = document.getElementById("loginScreen");
      if (loginScreen) loginScreen.style.display = "flex";
    }
  });
}

initializeFirebaseAuthUi();
