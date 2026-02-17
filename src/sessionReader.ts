import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import type {
  CopilotSession,
  SessionIndexEntry,
  SessionStoreIndex,
} from './types';

/**
 * Reads and writes Copilot chat sessions from/to VS Code's local storage.
 *
 * Sessions are stored under:
 *   <userDataDir>/User/workspaceStorage/<workspaceId>/
 *     - state.vscdb  (SQLite DB with session index)
 *     - chatSessions/<sessionId>.json   (old format — single JSON object)
 *     - chatSessions/<sessionId>.jsonl  (new format — append-only JSONL log)
 *
 * Files are treated as opaque blobs — we never parse or re-serialize session
 * content. This preserves both the old `.json` and new `.jsonl` formats exactly.
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
      if (!entry.isDirectory()) { continue; }
      const chatDir = path.join(storageDir, entry.name, 'chatSessions');
      if (fs.existsSync(chatDir)) {
        workspaceIds.push(entry.name);
      }
    }

    return workspaceIds;
  }

  /**
   * Read the workspace.json to get the actual workspace folder path.
   */
  async getWorkspacePath(workspaceId: string): Promise<string> {
    const wsJsonPath = path.join(this.workspaceStorageDir, workspaceId, 'workspace.json');
    try {
      const content = await fs.promises.readFile(wsJsonPath, 'utf-8');
      const wsData = JSON.parse(content);
      const uri: string = wsData.folder ?? wsData.workspace ?? '';
      if (uri.startsWith('file://')) {
        return decodeURIComponent(uri.replace('file://', ''));
      }
      return uri || `unknown-workspace-${workspaceId}`;
    } catch {
      return `unknown-workspace-${workspaceId}`;
    }
  }

  /**
   * Build a map of workspace path → local workspace ID.
   */
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

  /**
   * Find the local workspace ID for a given workspace path.
   */
  async findLocalWorkspaceId(workspacePath: string): Promise<string | null> {
    const pathMap = await this.buildWorkspacePathMap();

    // Exact match
    if (pathMap.has(workspacePath)) {
      return pathMap.get(workspacePath)!;
    }

    // Try matching by folder name for cross-platform compatibility
    const targetFolderName = path.basename(workspacePath);
    for (const [wsPath, wsId] of pathMap) {
      if (path.basename(wsPath) === targetFolderName) {
        return wsId;
      }
    }

    return null;
  }

  /**
   * Get the workspace ID of the currently open workspace in VS Code.
   */
  async getCurrentWorkspaceId(): Promise<string | null> {
    const vscode = require('vscode');
    const workspaceFolders = vscode.workspace?.workspaceFolders;
    if (!workspaceFolders || workspaceFolders.length === 0) {
      return null;
    }

    const currentPath = workspaceFolders[0].uri.fsPath;
    return this.findLocalWorkspaceId(currentPath);
  }

  // ─── Session File Discovery ───────────────────────────────────────────────

  /**
   * Scan the chatSessions directory for both .json and .jsonl files.
   */
  private async scanChatSessionFiles(chatDir: string): Promise<{ id: string; ext: string }[]> {
    if (!fs.existsSync(chatDir)) {
      return [];
    }

    const files = await fs.promises.readdir(chatDir);
    const results: { id: string; ext: string }[] = [];

    for (const f of files) {
      if (f.endsWith('.jsonl')) {
        results.push({ id: f.replace('.jsonl', ''), ext: '.jsonl' });
      } else if (f.endsWith('.json')) {
        results.push({ id: f.replace('.json', ''), ext: '.json' });
      }
    }

    return results;
  }

  // ─── Session Index (SQLite) ───────────────────────────────────────────────

  /**
   * Read the session index from state.vscdb.
   * Returns entries as a dict keyed by session ID.
   */
  private async readSessionIndexFromDb(dbPath: string): Promise<Record<string, SessionIndexEntry>> {
    try {
      const Database = require('better-sqlite3');
      const db = new Database(dbPath, { readonly: true, fileMustExist: true });

      try {
        const row = db.prepare(
          "SELECT value FROM ItemTable WHERE key = 'chat.ChatSessionStore.index'"
        ).get() as { value: string } | undefined;

        if (!row?.value) {
          return {};
        }

        const index = JSON.parse(row.value);

        // Handle both old format (array) and new format (dict)
        if (Array.isArray(index.entries)) {
          const result: Record<string, SessionIndexEntry> = {};
          for (const e of index.entries) {
            if (e.sessionId) {
              result[e.sessionId] = {
                sessionId: e.sessionId,
                title: e.title ?? 'Untitled',
                lastMessageDate: 0,
                timing: { created: 0, lastRequestStarted: 0, lastRequestEnded: 0 },
                initialLocation: 'panel',
                hasPendingEdits: false,
                isEmpty: false,
                isExternal: false,
                lastResponseState: 0,
              };
            }
          }
          return result;
        }

        // New format: entries is a Record<string, SessionIndexEntry>
        return index.entries ?? {};
      } finally {
        db.close();
      }
    } catch (err) {
      console.warn('[Copilot Session Sync] Could not read state.vscdb:', err);
      return {};
    }
  }

  // ─── Session Reading ──────────────────────────────────────────────────────

  /**
   * Read a single session file as raw content (opaque blob).
   */
  async readSession(
    workspaceId: string,
    sessionId: string,
    fileExt: string,
    indexEntry?: SessionIndexEntry
  ): Promise<CopilotSession | null> {
    const sessionPath = path.join(
      this.workspaceStorageDir,
      workspaceId,
      'chatSessions',
      `${sessionId}${fileExt}`
    );

    try {
      const rawContent = await fs.promises.readFile(sessionPath, 'utf-8');
      const workspacePath = await this.getWorkspacePath(workspaceId);

      // Extract metadata from the index if available
      let title = 'Untitled';
      let creationDate = 0;
      let lastMessageDate = 0;

      if (indexEntry) {
        title = indexEntry.title || 'Untitled';
        lastMessageDate = indexEntry.lastMessageDate || 0;
        creationDate = indexEntry.timing?.created || 0;
      } else {
        // Try to extract minimal metadata from the file content
        const meta = this.extractMetadataFromFile(rawContent, fileExt);
        title = meta.title;
        creationDate = meta.creationDate;
        lastMessageDate = meta.lastMessageDate;
      }

      return {
        id: sessionId,
        workspaceId,
        workspacePath,
        fileExtension: fileExt,
        rawContent,
        customTitle: title,
        creationDate,
        lastMessageDate,
      };
    } catch (err) {
      console.warn(`[Copilot Session Sync] Failed to read session ${sessionId}:`, err);
      return null;
    }
  }

  /**
   * Extract minimal metadata from a session file without full parsing.
   */
  private extractMetadataFromFile(
    content: string,
    ext: string
  ): { title: string; creationDate: number; lastMessageDate: number } {
    try {
      if (ext === '.jsonl') {
        // JSONL: first line is kind:0 with initial state in "v"
        const firstNewline = content.indexOf('\n');
        const firstLine = firstNewline > 0 ? content.substring(0, firstNewline) : content;
        const obj = JSON.parse(firstLine);
        if (obj.kind === 0 && obj.v) {
          return {
            title: obj.v.customTitle ?? 'Untitled',
            creationDate: obj.v.creationDate ?? 0,
            lastMessageDate: obj.v.lastMessageDate ?? obj.v.creationDate ?? 0,
          };
        }
      } else {
        // JSON: parse the full object
        const obj = JSON.parse(content);
        return {
          title: obj.customTitle ?? 'Untitled',
          creationDate: obj.creationDate ?? 0,
          lastMessageDate: obj.lastMessageDate ?? 0,
        };
      }
    } catch {
      // Ignore parse errors
    }

    return { title: 'Untitled', creationDate: 0, lastMessageDate: 0 };
  }

  /**
   * Read all sessions from all workspaces as raw blobs.
   */
  async readAllSessions(excludedWorkspaces: string[] = []): Promise<CopilotSession[]> {
    const workspaceIds = await this.listWorkspaceIds();
    const sessions: CopilotSession[] = [];

    for (const wsId of workspaceIds) {
      const wsPath = await this.getWorkspacePath(wsId);

      // Check if excluded
      if (excludedWorkspaces.some((excluded) => wsPath.startsWith(excluded))) {
        continue;
      }

      // Try to read the index from state.vscdb for metadata
      const dbPath = path.join(this.workspaceStorageDir, wsId, 'state.vscdb');
      let indexEntries: Record<string, SessionIndexEntry> = {};
      try {
        if (fs.existsSync(dbPath)) {
          indexEntries = await this.readSessionIndexFromDb(dbPath);
        }
      } catch {
        // Fall back to file-level metadata extraction
      }

      // Scan the chatSessions directory for actual files
      const chatDir = path.join(this.workspaceStorageDir, wsId, 'chatSessions');
      const files = await this.scanChatSessionFiles(chatDir);

      for (const { id, ext } of files) {
        const session = await this.readSession(wsId, id, ext, indexEntries[id]);
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
    return all.filter((s) => {
      // If we have no date info, include the session
      if (s.lastMessageDate === 0 && s.creationDate === 0) {
        return true;
      }
      return (s.lastMessageDate || s.creationDate) >= cutoff;
    });
  }

  // ─── Write Session (for importing from remote) ────────────────────────────

  /**
   * Write a session's raw content to the local chatSessions directory.
   */
  async writeSession(session: CopilotSession): Promise<void> {
    const chatDir = path.join(
      this.workspaceStorageDir,
      session.workspaceId,
      'chatSessions'
    );

    // Ensure the directory exists
    await fs.promises.mkdir(chatDir, { recursive: true });

    const sessionPath = path.join(chatDir, `${session.id}${session.fileExtension}`);
    await fs.promises.writeFile(sessionPath, session.rawContent, 'utf-8');
  }

  /**
   * Update the session index in state.vscdb to include a new session.
   * Uses the real VS Code format: {version: 1, entries: {id: {...}}}
   */
  async addToSessionIndex(workspaceId: string, session: CopilotSession): Promise<void> {
    const dbPath = path.join(this.workspaceStorageDir, workspaceId, 'state.vscdb');

    try {
      const Database = require('better-sqlite3');
      const db = new Database(dbPath);

      try {
        const row = db.prepare(
          "SELECT value FROM ItemTable WHERE key = 'chat.ChatSessionStore.index'"
        ).get() as { value: string } | undefined;

        let index: SessionStoreIndex = { version: 1, entries: {} };
        if (row?.value) {
          const parsed = JSON.parse(row.value);
          if (Array.isArray(parsed.entries)) {
            // Migrate old array format to new dict format
            index = { version: 1, entries: {} };
          } else {
            index = parsed;
          }
        }

        const now = Date.now();

        // Add or update the entry using the real VS Code format
        index.entries[session.id] = {
          sessionId: session.id,
          title: session.customTitle || 'Synced Session',
          lastMessageDate: session.lastMessageDate || now,
          timing: {
            created: session.creationDate || now,
            lastRequestStarted: session.lastMessageDate || now,
            lastRequestEnded: session.lastMessageDate || now,
          },
          initialLocation: 'panel',
          hasPendingEdits: false,
          isEmpty: false,
          isExternal: false,
          lastResponseState: 2,
        };

        db.prepare(
          "INSERT OR REPLACE INTO ItemTable (key, value) VALUES ('chat.ChatSessionStore.index', ?)"
        ).run(JSON.stringify(index));
      } finally {
        db.close();
      }
    } catch (err) {
      console.warn(`[Copilot Session Sync] Failed to update session index for ${workspaceId}:`, err);
    }
  }
}
