---
name: codex-permission-notifier
description: Configure local notifications for Codex terminal permission prompts. Use when the user wants Codex to alert them when a terminal session is waiting at prompts such as "Would you like to run the following command?", "Yes, proceed", or other approval menus, especially while multiple Codex terminals are running.
---

# Codex Permission Notifier

## Overview

Help the user set up permission-prompt notifications for Codex terminal sessions. A skill cannot listen to terminals by itself, so use the bundled watcher scripts to monitor a transcript/log and send a macOS notification when a Codex approval prompt appears.

## Recommended Setup

Use the wrapper for new sessions:

```bash
DOCUMENTACION/skills/codex-permission-notifier/scripts/run-with-notifier.sh codex
```

This starts the requested command under `script(1)`, writes a live transcript to `~/.codex/permission-notifier/`, and runs a watcher in the background. When Codex prints a permission menu, the watcher sends a macOS notification.

If the user wants to monitor an existing log file:

```bash
DOCUMENTACION/skills/codex-permission-notifier/scripts/watch-permission-log.sh /path/to/session.log
```

## Scripts

- `scripts/run-with-notifier.sh`: Wraps a command in a terminal transcript and starts the watcher.
- `scripts/watch-permission-log.sh`: Tails a transcript or log and detects Codex permission prompt patterns.
- `scripts/notify-macos.sh`: Sends the macOS notification using `osascript`.

## Operational Notes

- This works best for sessions launched through `run-with-notifier.sh`.
- Existing unwrapped terminals cannot be read retroactively unless they already write to a log.
- The watcher debounces repeat prompts for 90 seconds by default. Override with `CODEX_PERMISSION_NOTIFY_DEBOUNCE_SECONDS`.
- Logs go to `~/.codex/permission-notifier/` by default. Override with `CODEX_PERMISSION_NOTIFY_LOG_DIR`.
- Set `CODEX_PERMISSION_NOTIFY_DRY_RUN=1` to test detection without sending a GUI notification.
- macOS may ask for notification permissions the first time `osascript` posts an alert.

## Trigger Patterns

Notify when a transcript includes any of these phrases:

- `Would you like to run the following command?`
- `Yes, proceed`
- `No, and tell Codex what to do differently`
- `Press enter to confirm or esc to cancel`

When possible, include the visible command and reason in the notification body.

## Safety

Do not auto-approve permission prompts. The notification only tells the human that Codex is waiting.
