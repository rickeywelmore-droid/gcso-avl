# Changelog

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
