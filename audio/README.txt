GCSO AVL optional event sounds

Folders:
  gps-start/   Random clip when a user deliberately presses Start GPS.
  gps-stop/    Random clip when a user deliberately presses Stop GPS.
  developer/   Clip when an admin opens the Developer / Session Info + Audit panel.

The sound lists are configured near the top of app.js in AVL_SOUND_FILES.
Automatic GPS retries, reconnects, logout/session cleanup, and background recovery do NOT play sounds.
Audio playback is optional and cannot block GPS or AVL operation if a file is missing or the browser refuses playback.
