import type { CopilotSession, SyncManifestEntry } from './types';

/**
 * Determines what action to take when local and remote sessions differ.
 *
 * Strategy: Last-write-wins based on lastMessageDate.
 * Before overwriting, the losing version is backed up.
 */

export type ConflictAction =
  | { action: 'push'; reason: string }      // local is newer → push to remote
  | { action: 'pull'; reason: string }       // remote is newer → pull to local
  | { action: 'skip'; reason: string }       // no change needed
  | { action: 'new-local'; reason: string }  // exists only locally → push
  | { action: 'new-remote'; reason: string }; // exists only remotely → pull

export class ConflictResolver {
  /**
   * Determine the sync action for a single session.
   *
   * @param local - The local session (null if only exists remotely)
   * @param remote - The remote manifest entry (null if only exists locally)
   * @param localContentHash - SHA-256 hash of the local session content
   */
  static resolve(
    local: CopilotSession | null,
    remote: SyncManifestEntry | null,
    localContentHash?: string
  ): ConflictAction {
    // Case 1: Only exists locally
    if (local && !remote) {
      return {
        action: 'new-local',
        reason: `New local session "${local.customTitle}" — will push to remote.`,
      };
    }

    // Case 2: Only exists remotely
    if (!local && remote) {
      return {
        action: 'new-remote',
        reason: `New remote session "${remote.customTitle}" — will pull to local.`,
      };
    }

    // Case 3: Exists both locally and remotely
    if (local && remote) {
      // If content hash matches the last synced version, no change needed
      if (localContentHash && localContentHash === remote.sha) {
        return {
          action: 'skip',
          reason: `Session "${local.customTitle}" is up to date.`,
        };
      }

      // Compare timestamps — newer wins
      const localTime = local.lastMessageDate;
      const remoteTime = remote.lastMessageDate;

      if (localTime > remoteTime) {
        return {
          action: 'push',
          reason: `Local session "${local.customTitle}" is newer (local: ${new Date(localTime).toISOString()}, remote: ${new Date(remoteTime).toISOString()}).`,
        };
      }

      if (remoteTime > localTime) {
        return {
          action: 'pull',
          reason: `Remote session "${local.customTitle}" is newer (remote: ${new Date(remoteTime).toISOString()}, local: ${new Date(localTime).toISOString()}).`,
        };
      }

      // Same timestamp — check content hash
      if (localContentHash && localContentHash !== remote.sha) {
        // Same timestamp but different content — push local (arbitrary choice)
        return {
          action: 'push',
          reason: `Session "${local.customTitle}" has same timestamp but different content — pushing local version.`,
        };
      }

      return {
        action: 'skip',
        reason: `Session "${local.customTitle}" is identical on both sides.`,
      };
    }

    // Should not reach here, but handle gracefully
    return {
      action: 'skip',
      reason: 'No session data available.',
    };
  }

  /**
   * Resolve conflicts for all sessions at once.
   *
   * @param localSessions - Map of sessionId → CopilotSession
   * @param remoteEntries - Map of sessionId → SyncManifestEntry
   * @param localHashes - Map of sessionId → content hash
   */
  static resolveAll(
    localSessions: Map<string, CopilotSession>,
    remoteEntries: Map<string, SyncManifestEntry>,
    localHashes: Map<string, string>
  ): Map<string, ConflictAction> {
    const results = new Map<string, ConflictAction>();

    // All unique session IDs from both sides
    const allIds = new Set([...localSessions.keys(), ...remoteEntries.keys()]);

    for (const id of allIds) {
      const local = localSessions.get(id) ?? null;
      const remote = remoteEntries.get(id) ?? null;
      const hash = localHashes.get(id);

      results.set(id, ConflictResolver.resolve(local, remote, hash));
    }

    return results;
  }

  /**
   * Generate a backup filename for a session being overwritten.
   */
  static backupPath(sessionId: string): string {
    const timestamp = Date.now();
    return `sessions/backups/${sessionId}.backup-${timestamp}.enc`;
  }
}
