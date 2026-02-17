# Copilot Session Sync

Sync your GitHub Copilot chat sessions across all your devices, securely and automatically.

## Features

- **Cross-device sync** — Access your Copilot chat history from any computer signed into the same GitHub account
- **AES-256 encryption** — All session data is encrypted with your personal passphrase before leaving your machine
- **Private GitHub repo** — Sessions are stored in an auto-created private repository under your GitHub account
- **Automatic sync** — Pulls on startup and pushes periodically (configurable interval)
- **Per-workspace control** — Exclude specific workspaces from syncing
- **Conflict resolution** — Last-write-wins with automatic backups of overwritten versions

## Getting Started

1. Install this extension from the VS Code Marketplace
2. The extension activates automatically on startup
3. Sign in to GitHub when prompted (requires `repo` scope)
4. Create an encryption passphrase (must be the same on all your devices)
5. Your Copilot chat sessions will begin syncing automatically

### On a second device

1. Install the extension
2. Sign in with the **same GitHub account**
3. Enter the **same passphrase** you used on your first device
4. Your sessions will be pulled from the remote repository

## Commands

| Command | Description |
|---|---|
| `Copilot Session Sync: Sync Now` | Trigger an immediate sync |
| `Copilot Session Sync: Set Encryption Passphrase` | Change your encryption passphrase |
| `Copilot Session Sync: Toggle Sync for This Workspace` | Exclude or include the current workspace |
| `Copilot Session Sync: View Sync Status` | Show sync status, last sync time, and session count |
| `Copilot Session Sync: Reset Sync State` | Clear local sync state (does not delete remote data) |

## Settings

| Setting | Default | Description |
|---|---|---|
| `copilotSessionSync.enabled` | `true` | Enable or disable sync |
| `copilotSessionSync.syncIntervalMinutes` | `5` | Sync interval in minutes |
| `copilotSessionSync.excludedWorkspaces` | `[]` | Workspace paths to exclude from sync |
| `copilotSessionSync.maxSessionAgeDays` | `90` | Only sync sessions newer than this many days |
| `copilotSessionSync.repoName` | `copilot-session-sync` | Name of the private GitHub repo for storage |

## How It Works

1. **Reading sessions**: The extension reads Copilot chat session JSON files from VS Code's local storage directory
2. **Encryption**: Each session is encrypted with AES-256-GCM using a key derived from your passphrase (PBKDF2, 100k iterations, SHA-512)
3. **Storage**: Encrypted sessions are pushed to a private GitHub repository created under your account
4. **Sync**: On startup and periodically, the extension compares local and remote session timestamps and syncs the newer version
5. **Conflict handling**: When the same session is modified on two devices, the newer version wins and the older is backed up

## Privacy & Security

- **Your passphrase never leaves your device** — only encrypted data is uploaded
- **The GitHub repo is private** — only accessible to your GitHub account
- **AES-256-GCM** authenticated encryption prevents tampering
- **No telemetry** — the extension collects no usage data
- **You can delete the repo at any time** to remove all synced data

## Requirements

- VS Code 1.85.0 or later
- A GitHub account with Copilot access
- Desktop VS Code (not VS Code Web)

## Known Limitations

- Copilot chat session storage format is undocumented and may change with VS Code updates
- VS Code Web is not supported (no file system access to local sessions)
- Very large sessions (>1 MB) may require extra API calls
- The extension reads from VS Code's internal storage, which is not a public API

## License

MIT
