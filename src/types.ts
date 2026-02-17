// ─── Copilot Chat Session Types ──────────────────────────────────────────────

/**
 * A Copilot chat session carrying its raw file content.
 * Session files are treated as opaque blobs — we never parse/re-serialize them.
 * This preserves both the old `.json` format and the new `.jsonl` (append-only log) format.
 */
export interface CopilotSession {
  id: string;
  workspaceId: string;
  workspacePath: string;
  /** File extension including the dot, e.g. '.json' or '.jsonl' */
  fileExtension: string;
  /** The raw file content read from disk — written back as-is on the target device */
  rawContent: string;
  customTitle: string;
  creationDate: number;
  lastMessageDate: number;
}

// ─── Sync Manifest Types ────────────────────────────────────────────────────

/** Entry in the remote sync manifest */
export interface SyncManifestEntry {
  sessionId: string;
  workspaceId: string;
  workspacePath: string;
  /** File extension including the dot, e.g. '.json' or '.jsonl' */
  fileExtension: string;
  customTitle: string;
  lastMessageDate: number;
  creationDate: number;
  sha: string; // content hash of the raw session file
  deviceId: string; // which device last pushed this
  updatedAt: number; // timestamp of last sync
}

/** The full sync manifest stored in the repo */
export interface SyncManifest {
  version: number;
  deviceId: string;
  lastSyncTimestamp: number;
  entries: Record<string, SyncManifestEntry>; // keyed by sessionId
}

// ─── Session Index (from state.vscdb) ────────────────────────────────────────

/** An entry in the VS Code chat session store index (matches real format) */
export interface SessionIndexEntry {
  sessionId: string;
  title: string;
  lastMessageDate: number;
  timing: {
    created: number;
    lastRequestStarted: number;
    lastRequestEnded: number;
  };
  initialLocation: string;
  hasPendingEdits: boolean;
  isEmpty: boolean;
  isExternal: boolean;
  lastResponseState: number;
}

/** The session store index value from state.vscdb (matches real format) */
export interface SessionStoreIndex {
  version: number;
  entries: Record<string, SessionIndexEntry>;
}

// ─── GitHub API Types ────────────────────────────────────────────────────────

/** GitHub repo metadata (subset) */
export interface GitHubRepoInfo {
  name: string;
  full_name: string;
  private: boolean;
  default_branch: string;
}

/** GitHub file content response */
export interface GitHubFileContent {
  name: string;
  path: string;
  sha: string;
  size: number;
  content: string; // base64 encoded
  encoding: string;
}

/** GitHub tree entry for batch commits */
export interface GitTreeEntry {
  path: string;
  mode: '100644' | '100755' | '040000' | '160000' | '120000';
  type: 'blob' | 'tree' | 'commit';
  sha?: string;
  content?: string;
}

// ─── Extension State Types ──────────────────────────────────────────────────

/** Local sync state stored in globalState */
export interface LocalSyncState {
  lastSyncTimestamp: number;
  deviceId: string;
  repoOwner: string;
  repoName: string;
  sessionHashes: Record<string, string>; // sessionId -> hash of last synced content
}

/** Sync status for the UI */
export type SyncStatus = 'idle' | 'syncing' | 'error' | 'disabled' | 'setup-required';

export interface SyncStatusInfo {
  status: SyncStatus;
  lastSyncTime: number | null;
  sessionCount: number;
  errorMessage?: string;
}

// ─── Encryption Types ───────────────────────────────────────────────────────

export interface EncryptedPayload {
  /** base64-encoded salt */
  salt: string;
  /** base64-encoded IV */
  iv: string;
  /** base64-encoded ciphertext + auth tag */
  ciphertext: string;
  /** version of encryption scheme */
  version: number;
}
