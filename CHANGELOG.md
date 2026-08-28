# GCSO AVL Changelog

## 1.1.12 — One-Year Audit + Shift GPS Lock (2026-08-28)
- Extended audit retention from five days to 365 days.
- Replaced whole-database audit loading with timestamp-indexed date queries limited to 31 days at a time.
- Added a seven-day default view, unit/severity/source filters, and 100-event pagination.
- Added monthly JSON and CSV audit exports.
- Added a lightweight audit-storage estimate with a warning at approximately 750 MB of the 1 GB database allowance.
- Added indexed cleanup of events older than one year without downloading the full audit tree.
- Added a persistent ten-hour manual GPS-disconnect lock beginning with the receiver's first valid fix.
- Lock countdown survives refresh, hot-undocking, and redocking; active locks trigger automatic receiver recovery after reopening AVL.
- Manual disconnect attempts during the lock are denied and audited; administrators retain a confirmed, audited override.
- Logout or unit logoff during an active lock routes ordinary users through the planned-closure reason workflow.
- Added required planned-closure reasons, including Windows update/restart, end of shift, maintenance, equipment problem, emergency, and free-text Other.
- Added a browser leave warning for unexplained window closure.
- A computer that returns after an unexplained closure must supply a retrospective reason before GPS controls resume.
- Updated Firebase rules add timestamp indexes, protect audit events from modification or early deletion, and enable audit metrics.

## 1.1.11 — Hot-Undock GPS Recovery (2026-08-24)
- Added Web Serial device-removal and device-return handling for FZ-55 hot-undocking and redocking.
- Cleanly invalidates stale reader/port objects so an old read loop cannot close a newly re-enumerated receiver.
- Added a 2.5-second Windows USB-enumeration settling period after a serial device returns.
- Auto Detect now queues one fresh scan when another retry is already probing, preventing competing attempts from fighting over the same port.
- Prioritizes the returning in-memory port, the last successful authorized port, and then the last matching USB signature; USB VID/PID is only a preference hint.
- Every candidate must still produce checksum-valid RMC or GGA NMEA before it is accepted as the GPS receiver.
- A single Auto Detect press continues retrying if the docked receiver has not appeared in Windows yet, without reopening an unnecessary permission picker.
- Added audit events for USB GPS removal and serial-device return/validation.
- Added an immediate receiver check when Chrome becomes visible after sleep or undocking.
- Firebase rules are unchanged.

## 1.1.10 — Manual GPS Start Location (2026-08-01)
- Tied the **Auto Detect External GPS** button request to the receiver's first fresh valid GPS fix.
- Added a clearly labeled ACTION event: **GPS STREAM STARTED HERE**.
- The start event records the fresh coordinates, time from button press to first fix, and an **Open Last GPS in Google Maps** link.
- Manual starts remain visible when the audit filter is set to ACTION or User.
- Automatic receiver recovery is logged separately as an INFO/Automatic event so it cannot be mistaken for a deputy pressing the start button.
- Browser GPS fallback starts now use the same ACTION-level location behavior.
- Firebase rules are unchanged.

## 1.1.9 — Lifecycle Location Audit (2026-08-01)
- Added last-known latitude, longitude, fix timestamp, and GPS source to unit lifecycle audit events.
- Location snapshots are recorded for login, restored sessions, logout/logoff, GPS connection and first valid fix, Firebase/network reconnection, and administrator removal.
- Added a Firebase `onDisconnect` audit record for unexpected session loss caused by a browser close, crash, sleep, power loss, or coverage loss.
- Clearly distinguishes explicit logout/logoff from an unexpected connection loss.
- Added an **Open Last GPS in Google Maps** link to qualifying audit entries; it opens in a separate tab.
- Added a local pending-audit queue so lifecycle events created while offline upload after Firebase reconnects.
- Coordinates remain event snapshots only; continuous breadcrumb/location history was not added.
- Firebase rules are unchanged.

## 1.1.8 — Receiver Health + Recovery Watchdogs (2026-07-31)
- Added a live External GPS Health panel with receiver identity, USB port ID, baud, connection phase, NMEA sentence type, packet age, fix quality, satellites, HDOP, and Firebase publishing state.
- Added the same receiver telemetry to unit heartbeats so an admin can diagnose a selected remote unit.
- Added a 12-second NMEA stream watchdog that restarts a serial receiver which remains open but stops sending data.
- Increased the GPS auto-detect probe window from 2.5 seconds to 5 seconds and retained last-working receiver/baud priority.
- Added explicit connection phases and a receiver-busy/release diagnostic for ports still held by another application.
- Added a Firebase recovery watchdog, heartbeat-confirmed connection state, latest-fix republish after reconnection, and contradiction handling for stale `firebaseConnected: false` values.
- Added receiver telemetry to audit events and a Copy Diagnostics button.
- Preserved the five-day operational audit trail and existing Firebase rules.

## 1.1.7 — Audit Trail 2.0 (2026-07-25)
- Added INFO, WARNING, and ACTION event levels.
- Separated user, admin, system, and automatic-recovery events.
- Added button label, control location, target unit, public IP, app version, browser, platform, session ID, and device ID to audit details.
- Added admin filters for unit/user, event level, and actor/source.
- Added time since last GPS fix to relevant records without storing coordinates or movement history.
- Preserved five-day client-side retention.


## 1.1.6 — 2026-07-25
- Added five-day operational audit trail grouped by unit/user.
- Added admin-only audit viewer and unit filter.
- Logs button presses, login/logout, GPS serial connect/disconnect, unexpected GPS loss, and network/Firebase changes.
- Added client-side removal of audit events older than five days when an admin opens the panel.
- Does not store location breadcrumbs or historical coordinates.


## 1.1.5 — 2026-07-22
- Added a persistent anonymous Device ID for each browser installation.
- Expanded presence identity with session ID, app version, build date, browser, platform, public IP, time zone, screen size, language, user agent, login time, and heartbeat age.
- Expanded the admin diagnostics panel for selected roster sessions.
- Added client-side cleanup for the legacy invalid `dispatch__` record.
- Included a safe Firebase Rules patch that permanently denies writes to `sessions/dispatch__` without replacing the rest of the database rules.

## 1.1.4 — 2026-07-22
- Added dispatcher-only inactivity monitoring.
- Added a five-minute timeout warning with a live countdown.
- Added subtle two-tone warning and logout sounds using browser audio.
- Added Stay Logged In and Logout Now controls.
- Dispatcher sessions automatically log out after 60 minutes without interaction.
- Unit sessions are not affected by dispatcher inactivity rules.

# GCSO AVL Changelog

## 1.1.3 — 2026-07-22
- Centralized application configuration at the top of `app.js`.
- Added visible application version and build date.
- Added dispatcher-name validation at login, saved-session restore, and every presence heartbeat.
- Rejects names without real letters, including `.` and numeric/symbol-only entries.
- Improved Unit/Dispatch login placeholders.
- Updated cache-busting reference to `app.js?v=1.1.3`.
- Preserved startup-order fix for serial GPS, diagnostics, and restored sessions.

## 1.1.2
- Corrected startup initialization order for `lastFix`, serial state, diagnostics, and restored login.

## 1.1.1
- Added invalid dispatcher-session protection and JavaScript cache busting.

## 1.1.0
- Added admin diagnostics, session IDs, connection information, and temporary access roles.
