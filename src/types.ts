// ─── Copilot Chat Session Types ──────────────────────────────────────────────

/** A single message part in a Copilot response */
export interface ResponsePart {
  kind: 'markdownContent' | 'thinking' | 'codeBlock' | 'inlineReference' | string;
  value: string;
}

/** A single request/response pair within a session */
export interface SessionRequest {
  message: { text: string };
  timestamp: number;
  response: ResponsePart[] | string; // old format uses string, new uses array
}

/** A full Copilot chat session as stored on disk */
export interface RawCopilotSession {
  customTitle?: string;
  creationDate: number;
  lastMessageDate: number;
  requests: SessionRequest[];
}

/** Normalized session used internally by the extension */
export interface CopilotSession {
  id: string;
  workspaceId: string;
  workspacePath: string;
  customTitle: string;
  creationDate: number;
  lastMessageDate: number;
  requests: NormalizedRequest[];
}

/** Normalized request with response always as an array */
export interface NormalizedRequest {
  message: string;
  timestamp: number;
  response: ResponsePart[];
}

// ─── Sync Manifest Types ────────────────────────────────────────────────────

/** Entry in the remote sync manifest */
export interface SyncManifestEntry {
  sessionId: string;
  workspaceId: string;
  workspacePath: string;
  customTitle: string;
  lastMessageDate: number;
  creationDate: number;
  sha: string; // GitHub blob SHA for the encrypted file
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

/** An entry in the VS Code chat session store index */
export interface SessionIndexEntry {
  odpiId?: string;
  sessionId: string;
  isActive?: boolean;
}

/** The session store index value from state.vscdb */
export interface SessionStoreIndex {
  entries: SessionIndexEntry[];
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
