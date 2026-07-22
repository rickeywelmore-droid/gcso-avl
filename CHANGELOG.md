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
