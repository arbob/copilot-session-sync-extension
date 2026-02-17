import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import type {
  CopilotSession,
  SessionStoreIndex,
} from './types';

/**
 * Minimal metadata about a session — no raw content loaded.
 * Used for change-detection without reading full file bodies.
 */
export interface SessionMetadata {
  id: string;
  workspaceId: string;
  workspacePath: string;
  fileExtension: string;
  /** File modification time (epoch ms) */
  mtimeMs: number;
  /** File size in bytes */
  sizeBytes: number;
  /** Full path to the session file on disk */
  filePath: string;
  /** Extracted from minimal parse or file name */
  customTitle: string;
  creationDate: number;
  lastMessageDate: number;
}

/**
 * Reads Copilot chat sessions from the local VS Code storage.
 *
 * Sessions are stored under:
 *   <userDataDir>/User/workspaceStorage/<workspaceId>/chatSessions/
 *     - <sessionId>.json   (legacy single-object format)
 *     - <sessionId>.jsonl  (append-only log format — kind 0/1/2 entries)
 *
 * Files are treated as **opaque blobs**: we never parse/re-serialize them
 * to avoid corrupting the append-only log structure.
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

  async listWorkspaceIds(): Promise<string[]> {
    const storageDir = this.workspaceStorageDir;
    if (!fs.existsSync(storageDir)) {
      return [];
    }

    const entries = await fs.promises.readdir(storageDir, { withFileTypes: true });
    const workspaceIds: string[] = [];

    for (const entry of entries) {
      if (!entry.isDirectory()) { continue; }
      const chatDir = path.join(storageDir, entry.name, 'chatSessions');
      if (fs.existsSync(chatDir)) {
        workspaceIds.push(entry.name);
      }
    }

    return workspaceIds;
  }

  async getWorkspacePath(workspaceId: string): Promise<string> {
    const wsJsonPath = path.join(this.workspaceStorageDir, workspaceId, 'workspace.json');
    try {
      const content = await fs.promises.readFile(wsJsonPath, 'utf-8');
      const wsData = JSON.parse(content);
      const uri: string = wsData.folder ?? wsData.workspace ?? '';
      if (uri.startsWith('file://')) {
        return decodeURIComponent(uri.replace('file://', ''));
      }
      return uri || 'unknown-workspace-' + workspaceId;
    } catch {
      return 'unknown-workspace-' + workspaceId;
    }
  }

  async buildWorkspacePathMap(): Promise<Map<string, string>> {
    const storageDir = this.workspaceStorageDir;
    const pathMap = new Map<string, string>();

    if (!fs.existsSync(storageDir)) {
      return pathMap;
    }

    const entries = await fs.promises.readdir(storageDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) { continue; }
      const wsPath = await this.getWorkspacePath(entry.name);
      if (!wsPath.startsWith('unknown-workspace-')) {
        pathMap.set(wsPath, entry.name);
      }
    }

    return pathMap;
  }

  async findLocalWorkspaceId(workspacePath: string): Promise<string | null> {
    const pathMap = await this.buildWorkspacePathMap();

    if (pathMap.has(workspacePath)) {
      return pathMap.get(workspacePath)!;
    }

    const targetFolderName = path.basename(workspacePath);
    for (const [wsPath, wsId] of pathMap) {
      if (path.basename(wsPath) === targetFolderName) {
        return wsId;
      }
    }

    return null;
  }

  async getCurrentWorkspaceId(): Promise<string | null> {
    const workspaceFolders = require('vscode').workspace?.workspaceFolders;
    if (!workspaceFolders || workspaceFolders.length === 0) {
      return null;
    }
    const currentPath = workspaceFolders[0].uri.fsPath;
    return this.findLocalWorkspaceId(currentPath);
  }

  // ─── Session Index (SQLite) ───────────────────────────────────────────────

  async getSessionIndex(workspaceId: string): Promise<string[]> {
    const chatDir = path.join(this.workspaceStorageDir, workspaceId, 'chatSessions');

    try {
      const dbPath = path.join(this.workspaceStorageDir, workspaceId, 'state.vscdb');
      if (fs.existsSync(dbPath)) {
        const sessionIds = await this.readSessionIndexFromDb(dbPath);
        if (sessionIds.length > 0) {
          return sessionIds;
        }
      }
    } catch (err) {
      console.warn('[Copilot Session Sync] SQLite read failed for ' + workspaceId + ':', err);
    }

    return this.scanChatSessionFiles(chatDir);
  }

  private async readSessionIndexFromDb(dbPath: string): Promise<string[]> {
    try {
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

        // Handle dict format: entries is Record<string, SessionIndexEntry>
        if (index.entries && typeof index.entries === 'object' && !Array.isArray(index.entries)) {
          return Object.keys(index.entries);
        }

        // Handle old array format for backwards compat
        if (Array.isArray(index.entries)) {
          return (index.entries as any[]).map((e: any) => e.sessionId).filter(Boolean);
        }

        return [];
      } finally {
        db.close();
      }
    } catch (err) {
      console.warn('[Copilot Session Sync] Could not read state.vscdb:', err);
      return [];
    }
  }

  private async scanChatSessionFiles(chatDir: string): Promise<string[]> {
    if (!fs.existsSync(chatDir)) {
      return [];
    }

    const files = await fs.promises.readdir(chatDir);
    return files
      .filter((f) => f.endsWith('.json') || f.endsWith('.jsonl'))
      .map((f) => f.replace(/\.(json|jsonl)$/, ''));
  }

  private resolveSessionFilePath(workspaceId: string, sessionId: string): { filePath: string; ext: string } | null {
    const chatDir = path.join(this.workspaceStorageDir, workspaceId, 'chatSessions');
    for (const ext of ['.jsonl', '.json']) {
      const filePath = path.join(chatDir, sessionId + ext);
      if (fs.existsSync(filePath)) {
        return { filePath, ext };
      }
    }
    return null;
  }

  // ─── Session Reading (Opaque Blob) ────────────────────────────────────────

  /**
   * Read metadata about a session without loading its raw content.
   * Used for fast change-detection (compare mtime + size against cached hashes).
   */
  async readSessionMetadata(workspaceId: string, sessionId: string): Promise<SessionMetadata | null> {
    const resolved = this.resolveSessionFilePath(workspaceId, sessionId);
    if (!resolved) {
      return null;
    }

    try {
      const stat = await fs.promises.stat(resolved.filePath);
      const workspacePath = await this.getWorkspacePath(workspaceId);
      const meta = this.extractMinimalMetadata(resolved.filePath, resolved.ext);

      return {
        id: sessionId,
        workspaceId,
        workspacePath,
        fileExtension: resolved.ext,
        mtimeMs: stat.mtimeMs,
        sizeBytes: stat.size,
        filePath: resolved.filePath,
        customTitle: meta.customTitle,
        creationDate: meta.creationDate,
        lastMessageDate: meta.lastMessageDate,
      };
    } catch (err) {
      console.warn('[Copilot Session Sync] Failed to stat session ' + sessionId + ':', err);
      return null;
    }
  }

  /**
   * Read the raw content of a specific session file.
   */
  async readSessionContent(workspaceId: string, sessionId: string): Promise<string | null> {
    const resolved = this.resolveSessionFilePath(workspaceId, sessionId);
    if (!resolved) {
      return null;
    }
    try {
      return await fs.promises.readFile(resolved.filePath, 'utf-8');
    } catch {
      return null;
    }
  }

  /**
   * Read a single session as an opaque blob (metadata + raw content).
   */
  async readSession(workspaceId: string, sessionId: string): Promise<CopilotSession | null> {
    const resolved = this.resolveSessionFilePath(workspaceId, sessionId);
    if (!resolved) {
      return null;
    }

    try {
      const [content, workspacePath] = await Promise.all([
        fs.promises.readFile(resolved.filePath, 'utf-8'),
        this.getWorkspacePath(workspaceId),
      ]);

      const meta = this.extractMinimalMetadata(resolved.filePath, resolved.ext);

      return {
        id: sessionId,
        workspaceId,
        workspacePath,
        fileExtension: resolved.ext,
        rawContent: content,
        customTitle: meta.customTitle,
        creationDate: meta.creationDate,
        lastMessageDate: meta.lastMessageDate,
      };
    } catch (err) {
      console.warn('[Copilot Session Sync] Failed to read session ' + sessionId + ':', err);
      return null;
    }
  }

  /**
   * Read all sessions from all workspaces as opaque blobs.
   */
  async readAllSessions(excludedWorkspaces: string[] = []): Promise<CopilotSession[]> {
    const workspaceIds = await this.listWorkspaceIds();
    const sessions: CopilotSession[] = [];

    for (const wsId of workspaceIds) {
      const wsPath = await this.getWorkspacePath(wsId);
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
   * Read all session metadata (no raw content) from all workspaces.
   * Much faster than readAllSessions for change-detection.
   */
  async readAllSessionMetadata(excludedWorkspaces: string[] = []): Promise<SessionMetadata[]> {
    const workspaceIds = await this.listWorkspaceIds();
    const metadataList: SessionMetadata[] = [];

    for (const wsId of workspaceIds) {
      const wsPath = await this.getWorkspacePath(wsId);
      if (excludedWorkspaces.some((excluded) => wsPath.startsWith(excluded))) {
        continue;
      }

      const sessionIds = await this.getSessionIndex(wsId);
      for (const sessionId of sessionIds) {
        const meta = await this.readSessionMetadata(wsId, sessionId);
        if (meta) {
          metadataList.push(meta);
        }
      }
    }

    return metadataList;
  }

  async readRecentSessions(
    maxAgeDays: number,
    excludedWorkspaces: string[] = []
  ): Promise<CopilotSession[]> {
    const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;
    const all = await this.readAllSessions(excludedWorkspaces);
    return all.filter((s) => s.lastMessageDate >= cutoff);
  }

  async readRecentSessionMetadata(
    maxAgeDays: number,
    excludedWorkspaces: string[] = []
  ): Promise<SessionMetadata[]> {
    const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;
    const all = await this.readAllSessionMetadata(excludedWorkspaces);
    return all.filter((m) => m.lastMessageDate >= cutoff);
  }

  // ─── Write Session (for importing from remote) ────────────────────────────

  async writeSession(session: CopilotSession): Promise<void> {
    const chatDir = path.join(
      this.workspaceStorageDir,
      session.workspaceId,
      'chatSessions'
    );

    await fs.promises.mkdir(chatDir, { recursive: true });

    const ext = session.fileExtension || '.jsonl';
    const sessionPath = path.join(chatDir, session.id + ext);
    await fs.promises.writeFile(sessionPath, session.rawContent, 'utf-8');
  }

  /**
   * Build the vscode-chat-session resource URI for a session.
   * Format: vscode-chat-session://local/{base64(sessionId)}
   */
  private sessionResourceUri(sessionId: string): string {
    const encoded = Buffer.from(sessionId, 'utf-8').toString('base64');
    return `vscode-chat-session://local/${encoded}`;
  }

  /**
   * Update ALL session indices in state.vscdb so VS Code's chat panel shows the session.
   *
   * Three keys must be updated:
   * 1. chat.ChatSessionStore.index — dict of session metadata (used by session store)
   * 2. agentSessions.model.cache  — array of session models (used by the chat panel UI)
   * 3. agentSessions.state.cache  — array of read-state entries (marks sessions as unread/read)
   */
  async addToSessionIndex(workspaceId: string, session: CopilotSession): Promise<void> {
    const dbPath = path.join(this.workspaceStorageDir, workspaceId, 'state.vscdb');

    try {
      const Database = require('better-sqlite3');
      const db = new Database(dbPath);

      try {
        // ── 1. Update chat.ChatSessionStore.index ────────────────────────

        const row = db.prepare(
          "SELECT value FROM ItemTable WHERE key = 'chat.ChatSessionStore.index'"
        ).get() as { value: string } | undefined;

        let index: SessionStoreIndex = { version: 1, entries: {} };
        if (row?.value) {
          try {
            index = JSON.parse(row.value);
          } catch {
            // Corrupted index — start fresh
          }
        }

        if (!index.entries || typeof index.entries !== 'object' || Array.isArray(index.entries)) {
          index.entries = {};
        }

        if (!index.entries[session.id]) {
          index.entries[session.id] = {
            sessionId: session.id,
            title: session.customTitle,
            lastMessageDate: session.lastMessageDate,
            timing: {
              created: session.creationDate,
              lastRequestStarted: session.lastMessageDate,
              lastRequestEnded: session.lastMessageDate,
            },
            initialLocation: 'panel',
            hasPendingEdits: false,
            isEmpty: false,
            isExternal: false,
            lastResponseState: 1,
          };

          db.prepare(
            "INSERT OR REPLACE INTO ItemTable (key, value) VALUES ('chat.ChatSessionStore.index', ?)"
          ).run(JSON.stringify(index));
        }

        // ── 2. Update agentSessions.model.cache ─────────────────────────

        const resourceUri = this.sessionResourceUri(session.id);

        const modelRow = db.prepare(
          "SELECT value FROM ItemTable WHERE key = 'agentSessions.model.cache'"
        ).get() as { value: string } | undefined;

        let modelCache: any[] = [];
        if (modelRow?.value) {
          try {
            const parsed = JSON.parse(modelRow.value);
            if (Array.isArray(parsed)) {
              modelCache = parsed;
            }
          } catch {
            // Corrupted — start fresh
          }
        }

        // Check if this session already exists in the model cache
        const modelExists = modelCache.some(
          (entry: any) => entry.resource === resourceUri
        );

        if (!modelExists) {
          modelCache.push({
            providerType: 'local',
            providerLabel: 'Local',
            resource: resourceUri,
            icon: 'vm',
            label: session.customTitle,
            status: 1,
            timing: {
              created: session.creationDate,
              lastRequestStarted: session.lastMessageDate,
              lastRequestEnded: session.lastMessageDate,
            },
          });

          db.prepare(
            "INSERT OR REPLACE INTO ItemTable (key, value) VALUES ('agentSessions.model.cache', ?)"
          ).run(JSON.stringify(modelCache));
        }

        // ── 3. Update agentSessions.state.cache ─────────────────────────

        const stateRow = db.prepare(
          "SELECT value FROM ItemTable WHERE key = 'agentSessions.state.cache'"
        ).get() as { value: string } | undefined;

        let stateCache: any[] = [];
        if (stateRow?.value) {
          try {
            const parsed = JSON.parse(stateRow.value);
            if (Array.isArray(parsed)) {
              stateCache = parsed;
            }
          } catch {
            // Corrupted — start fresh
          }
        }

        const stateExists = stateCache.some(
          (entry: any) => entry.resource === resourceUri
        );

        if (!stateExists) {
          stateCache.push({
            resource: resourceUri,
            archived: false,
            read: Date.now(),
          });

          db.prepare(
            "INSERT OR REPLACE INTO ItemTable (key, value) VALUES ('agentSessions.state.cache', ?)"
          ).run(JSON.stringify(stateCache));
        }
      } finally {
        db.close();
      }
    } catch (err) {
      console.warn('[Copilot Session Sync] Failed to update session index for ' + workspaceId + ':', err);
    }
  }

  // ─── Minimal Metadata Extraction ──────────────────────────────────────────

  private extractMinimalMetadata(
    filePath: string,
    ext: string
  ): { customTitle: string; creationDate: number; lastMessageDate: number } {
    const defaults = { customTitle: 'Untitled Session', creationDate: 0, lastMessageDate: 0 };

    try {
      if (ext === '.jsonl') {
        const fd = fs.openSync(filePath, 'r');
        try {
          const buf = Buffer.alloc(8192);
          const bytesRead = fs.readSync(fd, buf, 0, buf.length, 0);
          const chunk = buf.toString('utf-8', 0, bytesRead);
          const firstNewline = chunk.indexOf('\n');
          const firstLine = firstNewline >= 0 ? chunk.substring(0, firstNewline) : chunk;

          if (firstLine.trim()) {
            const entry = JSON.parse(firstLine);
            if (entry.kind === 0 && entry.value) {
              return {
                customTitle: entry.value.customTitle ?? defaults.customTitle,
                creationDate: entry.value.creationDate ?? defaults.creationDate,
                lastMessageDate: entry.value.lastMessageDate ?? defaults.lastMessageDate,
              };
            }
          }
        } finally {
          fs.closeSync(fd);
        }
      } else {
        const content = fs.readFileSync(filePath, 'utf-8');
        const raw = JSON.parse(content);
        return {
          customTitle: raw.customTitle ?? defaults.customTitle,
          creationDate: raw.creationDate ?? defaults.creationDate,
          lastMessageDate: raw.lastMessageDate ?? defaults.lastMessageDate,
        };
      }
    } catch {
      // Metadata extraction is best-effort
    }

    return defaults;
  }
}
