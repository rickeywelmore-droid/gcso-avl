# GCSO AVL Changelog

## 1.1.9 — Map Theme Test (2026-09-22)
- Separated the interface dark mode from the basemap theme so each can be selected independently.
- Added Light, Dark, and High Contrast map themes with the selected map theme remembered per device.
- Replaced the old CSS-inverted dark OpenStreetMap view with CARTO Dark Matter, avoiding the inverted-road problem that made rural roads nearly disappear.
- Added a brighter High Contrast rural/night mode that increases road and label visibility without altering AVL unit markers.
- Added cache-busting for both JavaScript and CSS so map-style changes load immediately after deployment.

## 1.1.8 — Serial Recovery & Reconnect Hardening (2026-09-22)
- Added self-resynchronizing NMEA framing and parser-buffer reset on serial reconnect.
- Added serial packet/NMEA watchdogs that distinguish a stalled serial stream from healthy NMEA with no position fix.
- Added automatic staged recovery: parser-only resync first, then automatic serial reconnect if bytes stop arriving.
- Increased GPS probe window to five seconds and retained preferred receiver/baud priority.
- Added External GPS Health panel with receiver, baud, stream state, packet age, NMEA type/age, fix age, parser resync count, Firebase state, and browser-GPS state.
- Added serial event history and Copy Diagnostics to the admin developer panel.
- Added serial health fields to presence diagnostics so admins can inspect remote units.
- Prevented stale presence/GPS writes from being queued while Firebase is offline; only the newest GPS fix is retained for reconnect.
- Added Firebase transport recovery when the browser is online but Realtime Database remains disconnected.
- Republish the newest recent GPS fix when Firebase connectivity returns.

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
