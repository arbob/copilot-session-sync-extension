import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import type {
  CopilotSession,
  NormalizedRequest,
  RawCopilotSession,
  ResponsePart,
  SessionStoreIndex,
} from './types';

/**
 * Reads Copilot chat sessions from the local VS Code storage.
 *
 * Sessions are stored under:
 *   <userDataDir>/User/workspaceStorage/<workspaceId>/
 *     - state.vscdb  (SQLite DB with session index)
 *     - chatSessions/<sessionId>.json
 */
export class SessionReader {
  private userDataDir: string;

  constructor(userDataDirOverride?: string) {
    this.userDataDir = userDataDirOverride ?? SessionReader.detectUserDataDir();
  }

  // ─── Platform Detection ──────────────────────────────────────────────────

  static detectUserDataDir(): string {
    const platform = process.platform;
    const home = os.homedir();

    // Check for VS Code Insiders first, then stable
    const variants = ['Code - Insiders', 'Code'];

    for (const variant of variants) {
      let dir: string;
      switch (platform) {
        case 'linux':
          dir = path.join(home, '.config', variant);
          break;
        case 'darwin':
          dir = path.join(home, 'Library', 'Application Support', variant);
          break;
        case 'win32':
          dir = path.join(process.env.APPDATA ?? path.join(home, 'AppData', 'Roaming'), variant);
          break;
        default:
          throw new Error(`Unsupported platform: ${platform}`);
      }
      if (fs.existsSync(dir)) {
        return dir;
      }
    }

    // Default to stable path even if it doesn't exist yet
    switch (platform) {
      case 'linux':
        return path.join(home, '.config', 'Code');
      case 'darwin':
        return path.join(home, 'Library', 'Application Support', 'Code');
      case 'win32':
        return path.join(process.env.APPDATA ?? path.join(home, 'AppData', 'Roaming'), 'Code');
      default:
        throw new Error(`Unsupported platform: ${platform}`);
    }
  }

  // ─── Workspace Discovery ─────────────────────────────────────────────────

  private get workspaceStorageDir(): string {
    return path.join(this.userDataDir, 'User', 'workspaceStorage');
  }

  /**
   * List all workspace IDs that contain chat sessions.
   */
  async listWorkspaceIds(): Promise<string[]> {
    const storageDir = this.workspaceStorageDir;
    if (!fs.existsSync(storageDir)) {
      return [];
    }

    const entries = await fs.promises.readdir(storageDir, { withFileTypes: true });
    const workspaceIds: string[] = [];

    for (const entry of entries) {
      if (!entry.isDirectory()) {continue;}
      // Check if this workspace has chat sessions
      const chatDir = path.join(storageDir, entry.name, 'chatSessions');
      if (fs.existsSync(chatDir)) {
        workspaceIds.push(entry.name);
      }
    }

    return workspaceIds;
  }

  /**
   * Read the workspace.json to get the actual workspace path.
   */
  async getWorkspacePath(workspaceId: string): Promise<string> {
    const wsJsonPath = path.join(this.workspaceStorageDir, workspaceId, 'workspace.json');
    try {
      const content = await fs.promises.readFile(wsJsonPath, 'utf-8');
      const wsData = JSON.parse(content);
      // workspace.json has a "folder" or "workspace" field with a URI
      const uri: string = wsData.folder ?? wsData.workspace ?? '';
      // Convert file:// URI to path
      if (uri.startsWith('file://')) {
        return decodeURIComponent(uri.replace('file://', ''));
      }
      return uri || `unknown-workspace-${workspaceId}`;
    } catch {
      return `unknown-workspace-${workspaceId}`;
    }
  }

  // ─── Session Index (SQLite) ───────────────────────────────────────────────

  /**
   * Read the session index from state.vscdb (SQLite database).
   * Falls back to scanning the chatSessions directory if SQLite read fails.
   */
  async getSessionIndex(workspaceId: string): Promise<string[]> {
    const chatDir = path.join(this.workspaceStorageDir, workspaceId, 'chatSessions');

    // Try SQLite first
    try {
      const dbPath = path.join(this.workspaceStorageDir, workspaceId, 'state.vscdb');
      if (fs.existsSync(dbPath)) {
        const sessionIds = await this.readSessionIndexFromDb(dbPath);
        if (sessionIds.length > 0) {
          return sessionIds;
        }
      }
    } catch (err) {
      // SQLite read failed, fall back to directory scan
      console.warn(`[Copilot Session Sync] SQLite read failed for ${workspaceId}, falling back to directory scan:`, err);
    }

    // Fallback: scan chatSessions directory
    return this.scanChatSessionsDir(chatDir);
  }

  private async readSessionIndexFromDb(dbPath: string): Promise<string[]> {
    try {
      // Dynamic import of better-sqlite3
      const Database = require('better-sqlite3');
      const db = new Database(dbPath, { readonly: true, fileMustExist: true });

      try {
        const row = db.prepare(
          "SELECT value FROM ItemTable WHERE key = 'chat.ChatSessionStore.index'"
        ).get() as { value: string } | undefined;

        if (!row?.value) {
          return [];
        }

        const index: SessionStoreIndex = JSON.parse(row.value);
        return (index.entries ?? []).map((e) => e.sessionId).filter(Boolean);
      } finally {
        db.close();
      }
    } catch (err) {
      console.warn('[Copilot Session Sync] Could not read state.vscdb:', err);
      return [];
    }
  }

  private async scanChatSessionsDir(chatDir: string): Promise<string[]> {
    if (!fs.existsSync(chatDir)) {
      return [];
    }

    const files = await fs.promises.readdir(chatDir);
    return files
      .filter((f) => f.endsWith('.json'))
      .map((f) => f.replace('.json', ''));
  }

  // ─── Session Reading ──────────────────────────────────────────────────────

  /**
   * Read a single session file and normalize it.
   */
  async readSession(workspaceId: string, sessionId: string): Promise<CopilotSession | null> {
    const sessionPath = path.join(
      this.workspaceStorageDir,
      workspaceId,
      'chatSessions',
      `${sessionId}.json`
    );

    try {
      const content = await fs.promises.readFile(sessionPath, 'utf-8');
      const raw: RawCopilotSession = JSON.parse(content);
      const workspacePath = await this.getWorkspacePath(workspaceId);

      return this.normalizeSession(sessionId, workspaceId, workspacePath, raw);
    } catch (err) {
      console.warn(`[Copilot Session Sync] Failed to read session ${sessionId}:`, err);
      return null;
    }
  }

  /**
   * Read all sessions from all workspaces.
   */
  async readAllSessions(excludedWorkspaces: string[] = []): Promise<CopilotSession[]> {
    const workspaceIds = await this.listWorkspaceIds();
    const sessions: CopilotSession[] = [];

    for (const wsId of workspaceIds) {
      const wsPath = await this.getWorkspacePath(wsId);

      // Check if this workspace is excluded
      if (excludedWorkspaces.some((excluded) => wsPath.startsWith(excluded))) {
        continue;
      }

      const sessionIds = await this.getSessionIndex(wsId);
      for (const sessionId of sessionIds) {
        const session = await this.readSession(wsId, sessionId);
        if (session) {
          sessions.push(session);
        }
      }
    }

    return sessions;
  }

  /**
   * Read all sessions, filtered by max age in days.
   */
  async readRecentSessions(
    maxAgeDays: number,
    excludedWorkspaces: string[] = []
  ): Promise<CopilotSession[]> {
    const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;
    const all = await this.readAllSessions(excludedWorkspaces);
    return all.filter((s) => s.lastMessageDate >= cutoff);
  }

  // ─── Write Session (for importing from remote) ────────────────────────────

  /**
   * Write a session to the local chat sessions directory.
   * Used when pulling new sessions from the remote.
   */
  async writeSession(session: CopilotSession): Promise<void> {
    const chatDir = path.join(
      this.workspaceStorageDir,
      session.workspaceId,
      'chatSessions'
    );

    // Ensure the directory exists
    await fs.promises.mkdir(chatDir, { recursive: true });

    // Convert back to raw format
    const raw: RawCopilotSession = {
      customTitle: session.customTitle,
      creationDate: session.creationDate,
      lastMessageDate: session.lastMessageDate,
      requests: session.requests.map((r) => ({
        message: { text: r.message },
        timestamp: r.timestamp,
        response: r.response,
      })),
    };

    const sessionPath = path.join(chatDir, `${session.id}.json`);
    await fs.promises.writeFile(sessionPath, JSON.stringify(raw, null, 2), 'utf-8');
  }

  /**
   * Update the session index in state.vscdb to include a new session.
   */
  async addToSessionIndex(workspaceId: string, sessionId: string): Promise<void> {
    const dbPath = path.join(this.workspaceStorageDir, workspaceId, 'state.vscdb');

    try {
      const Database = require('better-sqlite3');
      const db = new Database(dbPath);

      try {
        const row = db.prepare(
          "SELECT value FROM ItemTable WHERE key = 'chat.ChatSessionStore.index'"
        ).get() as { value: string } | undefined;

        let index: SessionStoreIndex = { entries: [] };
        if (row?.value) {
          index = JSON.parse(row.value);
        }

        // Check if session already in index
        if (!index.entries.some((e) => e.sessionId === sessionId)) {
          index.entries.push({ sessionId, isActive: false });

          db.prepare(
            "INSERT OR REPLACE INTO ItemTable (key, value) VALUES ('chat.ChatSessionStore.index', ?)"
          ).run(JSON.stringify(index));
        }
      } finally {
        db.close();
      }
    } catch (err) {
      console.warn(`[Copilot Session Sync] Failed to update session index for ${workspaceId}:`, err);
    }
  }

  // ─── Normalization ────────────────────────────────────────────────────────

  private normalizeSession(
    id: string,
    workspaceId: string,
    workspacePath: string,
    raw: RawCopilotSession
  ): CopilotSession {
    return {
      id,
      workspaceId,
      workspacePath,
      customTitle: raw.customTitle ?? 'Untitled Session',
      creationDate: raw.creationDate ?? 0,
      lastMessageDate: raw.lastMessageDate ?? 0,
      requests: (raw.requests ?? []).map((r) => this.normalizeRequest(r)),
    };
  }

  private normalizeRequest(raw: {
    message: { text: string };
    timestamp: number;
    response: ResponsePart[] | string;
  }): NormalizedRequest {
    let response: ResponsePart[];

    if (typeof raw.response === 'string') {
      // Legacy format: flat string
      response = [{ kind: 'markdownContent', value: raw.response }];
    } else if (Array.isArray(raw.response)) {
      response = raw.response.map((part) => {
        if (typeof part === 'string') {
          return { kind: 'markdownContent', value: part };
        }
        return {
          kind: part.kind ?? 'markdownContent',
          value: typeof part.value === 'string' ? part.value : JSON.stringify(part.value),
        };
      });
    } else {
      response = [{ kind: 'markdownContent', value: String(raw.response ?? '') }];
    }

    return {
      message: raw.message?.text ?? '',
      timestamp: raw.timestamp ?? 0,
      response,
    };
  }
}
