import * as vscode from 'vscode';
import * as crypto from 'crypto';
import * as path from 'path';
import { SessionReader, type SessionMetadata } from './sessionReader';
import { Encryption, CachedEncryptor } from './encryption';
import { GitHubRepo } from './githubRepo';
import { ConflictResolver, type ConflictAction } from './conflictResolver';
import type {
  CopilotSession,
  LocalSyncState,
  SyncManifest,
  SyncManifestEntry,
  SyncStatus,
  SyncStatusInfo,
} from './types';

/** Cached hash entry stored in globalState */
interface CachedHashEntry {
  /** SHA-256 hash of the raw file content */
  hash: string;
  /** File mtime when hash was computed (epoch ms) */
  mtimeMs: number;
  /** File size when hash was computed */
  sizeBytes: number;
}

/**
 * Orchestrates the sync process between local Copilot chat sessions
 * and the remote GitHub repository.
 */
export class SyncEngine {
  private sessionReader: SessionReader;
  private githubRepo: GitHubRepo;
  private context: vscode.ExtensionContext;
  private passphrase: string | null = null;
  private syncTimer: NodeJS.Timeout | null = null;
  private _status: SyncStatusInfo = {
    status: 'setup-required',
    lastSyncTime: null,
    sessionCount: 0,
  };

  private readonly outputChannel: vscode.OutputChannel;

  // Event emitter for status changes
  private _onStatusChange = new vscode.EventEmitter<SyncStatusInfo>();
  readonly onStatusChange = this._onStatusChange.event;

  constructor(context: vscode.ExtensionContext) {
    this.context = context;
    this.sessionReader = new SessionReader();
    this.outputChannel = vscode.window.createOutputChannel('Copilot Session Sync');
    context.subscriptions.push(this.outputChannel);

    const repoName = vscode.workspace
      .getConfiguration('copilotSessionSync')
      .get<string>('repoName', 'copilot-session-sync');
    this.githubRepo = new GitHubRepo(repoName);
  }

  // ─── Device ID ────────────────────────────────────────────────────────────

  private getDeviceId(): string {
    let deviceId = this.context.globalState.get<string>('deviceId');
    if (!deviceId) {
      deviceId = 'device-' + crypto.randomBytes(8).toString('hex');
      this.context.globalState.update('deviceId', deviceId);
    }
    return deviceId;
  }

  // ─── Local Hash Cache ─────────────────────────────────────────────────────

  private getHashCache(): Record<string, CachedHashEntry> {
    return this.context.globalState.get<Record<string, CachedHashEntry>>('sessionHashCache') ?? {};
  }

  private async saveHashCache(cache: Record<string, CachedHashEntry>): Promise<void> {
    await this.context.globalState.update('sessionHashCache', cache);
  }

  /**
   * Get the content hash for a session, using the cache if mtime+size haven't changed.
   * If the cache is stale, reads the file and computes a fresh hash.
   */
  private async getContentHash(
    meta: SessionMetadata,
    hashCache: Record<string, CachedHashEntry>
  ): Promise<{ hash: string; needsRead: boolean }> {
    const cached = hashCache[meta.id];
    if (cached && cached.mtimeMs === meta.mtimeMs && cached.sizeBytes === meta.sizeBytes) {
      // File hasn't changed since we last hashed it
      return { hash: cached.hash, needsRead: false };
    }

    // File changed or not cached yet — read content and hash it
    const content = await this.sessionReader.readSessionContent(meta.workspaceId, meta.id);
    if (!content) {
      return { hash: '', needsRead: false };
    }

    const hash = Encryption.hashContent(content);
    hashCache[meta.id] = { hash, mtimeMs: meta.mtimeMs, sizeBytes: meta.sizeBytes };
    return { hash, needsRead: true };
  }

  // ─── Passphrase Management ────────────────────────────────────────────────

  async setPassphrase(passphrase: string): Promise<void> {
    this.passphrase = passphrase;
    await this.context.secrets.store('syncPassphrase', passphrase);
  }

  async loadPassphrase(): Promise<boolean> {
    const stored = await this.context.secrets.get('syncPassphrase');
    if (stored) {
      this.passphrase = stored;
      return true;
    }
    return false;
  }

  async promptForPassphrase(isNewSetup: boolean): Promise<boolean> {
    const passphrase = await vscode.window.showInputBox({
      prompt: isNewSetup
        ? 'Create an encryption passphrase for syncing Copilot sessions. You will need this on all your devices.'
        : 'Enter your Copilot Session Sync encryption passphrase.',
      password: true,
      placeHolder: 'Enter passphrase...',
      validateInput: (value) => {
        if (!value || value.length < 8) {
          return 'Passphrase must be at least 8 characters.';
        }
        return null;
      },
    });

    if (!passphrase) {
      return false;
    }

    if (isNewSetup) {
      const confirm = await vscode.window.showInputBox({
        prompt: 'Confirm your encryption passphrase.',
        password: true,
        placeHolder: 'Re-enter passphrase...',
      });

      if (confirm !== passphrase) {
        vscode.window.showErrorMessage('Passphrases do not match.');
        return false;
      }
    }

    await this.setPassphrase(passphrase);
    return true;
  }

  // ─── GitHub Authentication with Dialog ────────────────────────────────────

  private async authenticateWithPrompt(): Promise<boolean> {
    try {
      const silentSession = await this.githubRepo.authenticateSilent();
      if (silentSession) {
        return true;
      }
    } catch {
      // Not authenticated yet
    }

    const connect = await vscode.window.showInformationMessage(
      'Copilot Session Sync needs to connect to your GitHub account to sync chat sessions across devices.',
      { modal: true, detail: 'This will create a private repository under your GitHub account to store encrypted session data.' },
      'Connect to GitHub',
      'Cancel'
    );

    if (connect !== 'Connect to GitHub') {
      return false;
    }

    try {
      await this.githubRepo.authenticate();
      return true;
    } catch (err) {
      const retry = await vscode.window.showErrorMessage(
        'GitHub authentication failed: ' + (err instanceof Error ? err.message : String(err)),
        'Try Again',
        'Cancel'
      );
      if (retry === 'Try Again') {
        return this.authenticateWithPrompt();
      }
      return false;
    }
  }

  // ─── Passphrase Verification with Retry ──────────────────────────────────

  private async promptAndVerifyPassphrase(verificationToken: string): Promise<boolean> {
    const maxAttempts = 3;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const success = await this.promptForPassphrase(false);
      if (!success) {
        return false;
      }

      if (Encryption.verifyPassphrase(this.passphrase!, verificationToken)) {
        this.log('Passphrase verified successfully.');
        return true;
      }

      this.passphrase = null;
      await this.context.secrets.delete('syncPassphrase');

      if (attempt < maxAttempts) {
        const retry = await vscode.window.showErrorMessage(
          'Incorrect passphrase (attempt ' + attempt + '/' + maxAttempts + '). It does not match the passphrase used on your other device.',
          'Try Again',
          'Cancel'
        );
        if (retry !== 'Try Again') {
          return false;
        }
      } else {
        vscode.window.showErrorMessage(
          'Incorrect passphrase. Maximum attempts reached. You can try again later via "Copilot Session Sync: Sync Now".'
        );
      }
    }

    return false;
  }

  // ─── Initialization ──────────────────────────────────────────────────────

  async initialize(): Promise<boolean> {
    try {
      this.log('Initializing sync engine...');

      const authenticated = await this.authenticateWithPrompt();
      if (!authenticated) {
        this.updateStatus('setup-required');
        return false;
      }
      this.log('Authenticated as ' + this.githubRepo.getOwner());

      await this.githubRepo.ensureRepo();
      this.log('Sync repo ready: ' + this.githubRepo.getOwner() + '/' + this.githubRepo.getRepoName());

      this.context.globalState.update('syncRepoOwner', this.githubRepo.getOwner());
      this.context.globalState.update('syncRepoName', this.githubRepo.getRepoName());
      this.context.globalState.setKeysForSync(['syncRepoOwner', 'syncRepoName']);

      const hasPassphrase = await this.loadPassphrase();

      if (!hasPassphrase) {
        const verificationToken = await this.githubRepo.getFileContent('verification.token');

        if (verificationToken) {
          this.log('Existing sync setup found. Prompting for passphrase...');
          const verified = await this.promptAndVerifyPassphrase(verificationToken);
          if (!verified) {
            this.updateStatus('setup-required');
            return false;
          }
        } else {
          this.log('First-time setup. Prompting for new passphrase...');
          const success = await this.promptForPassphrase(true);
          if (!success) {
            this.updateStatus('setup-required');
            return false;
          }

          const token = Encryption.createVerificationToken(this.passphrase!);
          await this.githubRepo.putFile(
            'verification.token',
            token,
            'chore: Add passphrase verification token'
          );
          this.log('Verification token stored in repo.');
        }
      } else {
        const verificationToken = await this.githubRepo.getFileContent('verification.token');
        if (verificationToken && (!this.passphrase || !Encryption.verifyPassphrase(this.passphrase, verificationToken))) {
          vscode.window.showWarningMessage(
            'Stored passphrase no longer matches the remote verification. Please re-enter your passphrase.'
          );
          this.passphrase = null;
          await this.context.secrets.delete('syncPassphrase');
          const verified = await this.promptAndVerifyPassphrase(verificationToken);
          if (!verified) {
            this.updateStatus('setup-required');
            return false;
          }
        }
      }

      this.updateStatus('idle');
      this.log('Sync engine initialized successfully.');
      return true;
    } catch (err) {
      this.logError('Initialization failed', err);
      this.updateStatus('error', String(err));
      return false;
    }
  }

  // ─── Sync Operations ─────────────────────────────────────────────────────

  /**
   * Perform a full sync with progress reporting.
   */
  async sync(): Promise<void> {
    const config = vscode.workspace.getConfiguration('copilotSessionSync');
    if (!config.get<boolean>('enabled', true)) {
      this.updateStatus('disabled');
      return;
    }

    if (!this.passphrase) {
      this.updateStatus('setup-required');
      return;
    }

    if (this._status.status === 'syncing') {
      this.log('Sync already in progress, skipping.');
      return;
    }

    this.updateStatus('syncing');
    this.log('Starting sync...');

    try {
      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Window,
          title: 'Copilot Sync',
          cancellable: false,
        },
        async (progress) => {
          // Re-authenticate in case token expired
          await this.githubRepo.authenticate();

          progress.report({ message: 'Pulling remote changes...' });
          await this.pullFromRemote();

          progress.report({ message: 'Pushing local changes...' });
          await this.pushToRemote(progress);

          progress.report({ message: 'Done' });
        }
      );

      const syncState: LocalSyncState = {
        lastSyncTimestamp: Date.now(),
        deviceId: this.getDeviceId(),
        repoOwner: this.githubRepo.getOwner(),
        repoName: this.githubRepo.getRepoName(),
        sessionHashes: {},
      };
      await this.context.globalState.update('syncState', syncState);

      this.updateStatus('idle');
      this.log('Sync completed successfully.');
    } catch (err) {
      this.logError('Sync failed', err);
      this.updateStatus('error', String(err));
    }
  }

  /**
   * Pull sessions from the remote repo that are newer than local versions.
   */
  private async pullFromRemote(): Promise<void> {
    this.log('Pulling from remote...');

    // Determine the current workspace storage ID — all pulled sessions go here
    const currentWsId = this.getCurrentWorkspaceStorageId();
    if (!currentWsId) {
      this.log('No workspace open — cannot pull sessions.');
      return;
    }

    const manifest = await this.getRemoteManifest();
    if (!manifest) {
      this.log('No remote manifest found — nothing to pull.');
      return;
    }

    const config = vscode.workspace.getConfiguration('copilotSessionSync');
    const maxAgeDays = config.get<number>('maxSessionAgeDays', 90);

    // Read metadata from ALL workspaces (no exclusions)
    const localMetadata = await this.sessionReader.readRecentSessionMetadata(maxAgeDays);

    // Build maps
    const localMetaMap = new Map<string, SessionMetadata>();
    for (const meta of localMetadata) {
      localMetaMap.set(meta.id, meta);
    }

    const remoteMap = new Map<string, SyncManifestEntry>();
    for (const [id, entry] of Object.entries(manifest.entries)) {
      remoteMap.set(id, entry);
    }

    // Compute local hashes using the cache (avoids re-reading unchanged files)
    const hashCache = this.getHashCache();
    const localHashes = new Map<string, string>();
    const localMap = new Map<string, CopilotSession>();

    for (const [id, meta] of localMetaMap) {
      const { hash } = await this.getContentHash(meta, hashCache);
      if (hash) {
        localHashes.set(id, hash);
        // Build a lightweight CopilotSession for conflict resolution (no rawContent yet)
        localMap.set(id, {
          id: meta.id,
          workspaceId: meta.workspaceId,
          workspacePath: meta.workspacePath,
          fileExtension: meta.fileExtension,
          rawContent: '', // not needed for conflict resolution
          customTitle: meta.customTitle,
          creationDate: meta.creationDate,
          lastMessageDate: meta.lastMessageDate,
        });
      }
    }

    await this.saveHashCache(hashCache);

    // Resolve conflicts
    const actions = ConflictResolver.resolveAll(localMap, remoteMap, localHashes);

    // Execute pull actions
    let pullCount = 0;
    for (const [sessionId, action] of actions) {
      if (action.action === 'pull' || action.action === 'new-remote') {
        try {
          await this.pullSession(sessionId, manifest.entries[sessionId], currentWsId);
          pullCount++;
          this.log('Pulled session: ' + action.reason);
        } catch (err) {
          this.logError('Failed to pull session ' + sessionId, err);
        }
      }
    }

    this.log('Pull complete: ' + pullCount + ' sessions pulled.');
  }

  /**
   * Get the current workspace storage ID from the extension's storageUri.
   * storageUri path: .../workspaceStorage/<wsId>/<extensionId>/
   */
  private getCurrentWorkspaceStorageId(): string | null {
    const storageUri = this.context.storageUri;
    if (!storageUri) {
      return null;
    }
    // storageUri.fsPath = .../workspaceStorage/<wsId>/<extensionId>
    const parentDir = path.dirname(storageUri.fsPath);
    return path.basename(parentDir);
  }

  /**
   * Pull a single session from the remote into the current workspace.
   * All sessions are written to the current workspace — no per-workspace mapping.
   */
  private async pullSession(sessionId: string, entry: SyncManifestEntry, currentWsId: string): Promise<void> {
    const encryptedContent = await this.githubRepo.getFileContent('sessions/' + sessionId + '.enc');
    if (!encryptedContent) {
      this.log('Session file not found in repo: sessions/' + sessionId + '.enc');
      return;
    }

    const decrypted = Encryption.decryptFromString(encryptedContent, this.passphrase!);
    const payload = JSON.parse(decrypted);

    if (!payload.rawContent) {
      this.log('Skipping session ' + sessionId + ': old format (pre-v0.2.0). Re-push from original device.');
      return;
    }

    const session: CopilotSession = {
      id: sessionId,
      workspaceId: currentWsId,
      workspacePath: payload.workspacePath ?? entry.workspacePath,
      fileExtension: payload.fileExtension ?? entry.fileExtension ?? '.jsonl',
      rawContent: payload.rawContent,
      customTitle: payload.customTitle ?? entry.customTitle ?? 'Synced Session',
      creationDate: payload.creationDate ?? entry.creationDate ?? 0,
      lastMessageDate: payload.lastMessageDate ?? entry.lastMessageDate ?? 0,
    };

    this.log('Writing session "' + session.customTitle + '" to current workspace: ' + currentWsId);

    await this.sessionReader.writeSession(session);
    await this.sessionReader.addToSessionIndex(currentWsId, session);
  }

  /**
   * Push local sessions that are newer than the remote versions.
   * Uses cached hashes, lazy content loading, and batch encryption.
   */
  private async pushToRemote(
    progress?: vscode.Progress<{ message?: string; increment?: number }>
  ): Promise<void> {
    this.log('Pushing to remote...');

    const config = vscode.workspace.getConfiguration('copilotSessionSync');
    const maxAgeDays = config.get<number>('maxSessionAgeDays', 90);
    const maxSizeMB = config.get<number>('maxSessionSizeMB', 50);
    const maxSizeBytes = maxSizeMB * 1024 * 1024;

    // 1. Read only metadata from ALL workspaces (fast — no file content loaded)
    const allMetadata = await this.sessionReader.readRecentSessionMetadata(maxAgeDays);

    // Filter out oversized sessions
    const metadata = allMetadata.filter((m) => {
      if (m.sizeBytes > maxSizeBytes) {
        this.log('Skipping oversized session ' + m.id + ' (' + (m.sizeBytes / 1024 / 1024).toFixed(1) + ' MB > ' + maxSizeMB + ' MB limit)');
        return false;
      }
      return true;
    });

    if (metadata.length === 0) {
      this.log('No local sessions to push.');
      return;
    }

    // 2. Get remote manifest
    let manifest = await this.getRemoteManifest();
    const isNewManifest = !manifest;
    if (!manifest) {
      manifest = {
        version: 1,
        deviceId: this.getDeviceId(),
        lastSyncTimestamp: Date.now(),
        entries: {},
      };
    }

    const remoteMap = new Map<string, SyncManifestEntry>();
    for (const [id, entry] of Object.entries(manifest.entries)) {
      remoteMap.set(id, entry);
    }

    // 3. Use cached hashes to find which sessions actually changed
    const hashCache = this.getHashCache();
    const changedSessions: { meta: SessionMetadata; hash: string }[] = [];
    const localHashes = new Map<string, string>();
    const localMap = new Map<string, CopilotSession>();

    this.log('Checking ' + metadata.length + ' sessions for changes...');

    for (const meta of metadata) {
      const { hash } = await this.getContentHash(meta, hashCache);
      if (!hash) { continue; }

      localHashes.set(meta.id, hash);
      localMap.set(meta.id, {
        id: meta.id,
        workspaceId: meta.workspaceId,
        workspacePath: meta.workspacePath,
        fileExtension: meta.fileExtension,
        rawContent: '', // placeholder — loaded lazily below only for sessions that need pushing
        customTitle: meta.customTitle,
        creationDate: meta.creationDate,
        lastMessageDate: meta.lastMessageDate,
      });
    }

    await this.saveHashCache(hashCache);

    // 4. Resolve conflicts
    const actions = ConflictResolver.resolveAll(localMap, remoteMap, localHashes);

    // 5. Identify sessions that need pushing
    const toPush: { sessionId: string; meta: SessionMetadata; hash: string; action: ConflictAction }[] = [];
    for (const [sessionId, action] of actions) {
      if (action.action === 'push' || action.action === 'new-local') {
        const meta = metadata.find((m) => m.id === sessionId);
        const hash = localHashes.get(sessionId);
        if (meta && hash) {
          toPush.push({ sessionId, meta, hash, action });
        }
      }
    }

    if (toPush.length === 0) {
      this.log('No changes to push.');
      return;
    }

    this.log(toPush.length + ' session(s) need pushing. Loading content and encrypting...');

    // 6. Create a cached encryptor (derives PBKDF2 key ONCE)
    const encryptor = Encryption.createCachedEncryptor(this.passphrase!);

    // 7. Load content lazily and encrypt only changed sessions
    const filesToPush: { path: string; content: string }[] = [];
    const backupFiles: { path: string; content: string }[] = [];
    let encryptedCount = 0;

    for (const { sessionId, meta, hash, action } of toPush) {
      // Report progress
      encryptedCount++;
      if (progress) {
        progress.report({
          message: 'Encrypting ' + encryptedCount + '/' + toPush.length + '...',
        });
      }

      // Lazy-load raw content
      const rawContent = await this.sessionReader.readSessionContent(meta.workspaceId, sessionId);
      if (!rawContent) {
        this.logError('Could not read content for session ' + sessionId, 'file not found');
        continue;
      }

      // Build and encrypt payload
      const payload = JSON.stringify({
        rawContent,
        fileExtension: meta.fileExtension,
        workspacePath: meta.workspacePath,
        customTitle: meta.customTitle,
        creationDate: meta.creationDate,
        lastMessageDate: meta.lastMessageDate,
      });
      const encrypted = encryptor.encryptToString(payload);

      // Back up existing remote session if overwriting
      if (action.action === 'push' && remoteMap.has(sessionId)) {
        try {
          const existingContent = await this.githubRepo.getFileContent('sessions/' + sessionId + '.enc');
          if (existingContent) {
            backupFiles.push({
              path: ConflictResolver.backupPath(sessionId),
              content: existingContent,
            });
          }
        } catch {
          // Best effort backup
        }
      }

      filesToPush.push({
        path: 'sessions/' + sessionId + '.enc',
        content: encrypted,
      });

      // Update manifest entry
      manifest.entries[sessionId] = {
        sessionId,
        workspaceId: meta.workspaceId,
        workspacePath: meta.workspacePath,
        fileExtension: meta.fileExtension,
        customTitle: meta.customTitle,
        lastMessageDate: meta.lastMessageDate,
        creationDate: meta.creationDate,
        sha: hash,
        deviceId: this.getDeviceId(),
        updatedAt: Date.now(),
      };
    }

    if (filesToPush.length === 0) {
      this.log('No files to push after content loading.');
      return;
    }

    // 8. Update and encrypt manifest (uses the cached encryptor too)
    manifest.lastSyncTimestamp = Date.now();
    manifest.deviceId = this.getDeviceId();

    const manifestEncrypted = encryptor.encryptToString(JSON.stringify(manifest));

    filesToPush.push({
      path: 'manifest.json',
      content: manifestEncrypted,
    });

    filesToPush.push(...backupFiles);

    // 9. Batch commit to GitHub
    const pushCount = filesToPush.length - 1 - backupFiles.length;
    if (progress) {
      progress.report({ message: 'Uploading ' + pushCount + ' session(s)...' });
    }

    try {
      await this.githubRepo.batchCommit(
        filesToPush,
        [],
        'sync: Push ' + pushCount + ' session(s) from ' + this.getDeviceId()
      );
      this.log('Push complete: ' + pushCount + ' sessions pushed.');
    } catch (err) {
      this.log('Batch commit failed, falling back to individual file operations...');
      for (const file of filesToPush) {
        await this.githubRepo.putFile(
          file.path,
          file.content,
          'sync: Update ' + file.path
        );
      }
      this.log('Push complete (individual): ' + pushCount + ' sessions pushed.');
    }

    this._status.sessionCount = Object.keys(manifest.entries).length;
  }

  // ─── Manifest Management ─────────────────────────────────────────────────

  private async getRemoteManifest(): Promise<SyncManifest | null> {
    if (!this.passphrase) {
      return null;
    }

    const content = await this.githubRepo.getFileContent('manifest.json');
    if (!content) {
      return null;
    }

    try {
      const decrypted = Encryption.decryptFromString(content, this.passphrase);
      return JSON.parse(decrypted) as SyncManifest;
    } catch (err) {
      this.logError('Failed to decrypt remote manifest', err);
      return null;
    }
  }

  // ─── Periodic Sync ───────────────────────────────────────────────────────

  startPeriodicSync(): void {
    this.stopPeriodicSync();

    const config = vscode.workspace.getConfiguration('copilotSessionSync');
    const intervalMinutes = config.get<number>('syncIntervalMinutes', 5);
    const intervalMs = intervalMinutes * 60 * 1000;

    this.log('Starting periodic sync every ' + intervalMinutes + ' minutes.');

    this.syncTimer = setInterval(async () => {
      try {
        await this.sync();
      } catch (err) {
        this.logError('Periodic sync failed', err);
      }
    }, intervalMs);

    this.context.subscriptions.push({
      dispose: () => this.stopPeriodicSync(),
    });
  }

  stopPeriodicSync(): void {
    if (this.syncTimer) {
      clearInterval(this.syncTimer);
      this.syncTimer = null;
    }
  }

  // ─── Status Management ───────────────────────────────────────────────────

  get status(): SyncStatusInfo {
    return { ...this._status };
  }

  private updateStatus(status: SyncStatus, errorMessage?: string): void {
    this._status.status = status;
    if (status === 'idle') {
      this._status.lastSyncTime = Date.now();
      this._status.errorMessage = undefined;
    }
    if (errorMessage) {
      this._status.errorMessage = errorMessage;
    }
    this._onStatusChange.fire(this._status);
  }

  // ─── Reset ────────────────────────────────────────────────────────────────

  async resetSyncState(): Promise<void> {
    this.passphrase = null;
    await this.context.secrets.delete('syncPassphrase');
    await this.context.globalState.update('syncState', undefined);
    await this.context.globalState.update('sessionHashCache', undefined);
    await this.context.globalState.update('deviceId', undefined);
    this.stopPeriodicSync();
    this.updateStatus('setup-required');
    this.log('Sync state reset.');
  }

  // ─── Logging ──────────────────────────────────────────────────────────────

  private log(message: string): void {
    const timestamp = new Date().toISOString();
    this.outputChannel.appendLine('[' + timestamp + '] ' + message);
  }

  private logError(message: string, err: unknown): void {
    const timestamp = new Date().toISOString();
    const errorStr = err instanceof Error ? err.message : String(err);
    this.outputChannel.appendLine('[' + timestamp + '] ERROR: ' + message + ': ' + errorStr);
  }

  // ─── Dispose ──────────────────────────────────────────────────────────────

  dispose(): void {
    this.stopPeriodicSync();
    this._onStatusChange.dispose();
  }
}
