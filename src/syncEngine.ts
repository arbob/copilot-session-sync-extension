import * as vscode from 'vscode';
import * as crypto from 'crypto';
import { SessionReader } from './sessionReader';
import { Encryption } from './encryption';
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

  /**
   * Get or create a unique device identifier for this VS Code installation.
   */
  private getDeviceId(): string {
    let deviceId = this.context.globalState.get<string>('deviceId');
    if (!deviceId) {
      deviceId = `device-${crypto.randomBytes(8).toString('hex')}`;
      this.context.globalState.update('deviceId', deviceId);
    }
    return deviceId;
  }

  // ─── Passphrase Management ────────────────────────────────────────────────

  /**
   * Set the encryption passphrase.
   */
  async setPassphrase(passphrase: string): Promise<void> {
    this.passphrase = passphrase;
    await this.context.secrets.store('syncPassphrase', passphrase);
  }

  /**
   * Load the passphrase from secure storage.
   */
  async loadPassphrase(): Promise<boolean> {
    const stored = await this.context.secrets.get('syncPassphrase');
    if (stored) {
      this.passphrase = stored;
      return true;
    }
    return false;
  }

  /**
   * Prompt the user to enter or set up a passphrase.
   */
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
      // Confirm passphrase
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

  /**
   * Show a dialog prompting the user to connect their GitHub account,
   * then authenticate. Retries if the user initially declines.
   */
  private async authenticateWithPrompt(): Promise<boolean> {
    // Check if already authenticated silently first
    try {
      const silentSession = await this.githubRepo.authenticateSilent();
      if (silentSession) {
        return true;
      }
    } catch {
      // Not authenticated yet — proceed to prompt
    }

    // Show connect dialog
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
        `GitHub authentication failed: ${err instanceof Error ? err.message : String(err)}`,
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

  /**
   * Prompt for passphrase and verify against the remote token.
   * Retries up to 3 times on mismatch before giving up.
   */
  private async promptAndVerifyPassphrase(verificationToken: string): Promise<boolean> {
    const maxAttempts = 3;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const success = await this.promptForPassphrase(false);
      if (!success) {
        return false; // User cancelled
      }

      if (Encryption.verifyPassphrase(this.passphrase!, verificationToken)) {
        this.log('Passphrase verified successfully.');
        return true;
      }

      // Wrong passphrase
      this.passphrase = null;
      await this.context.secrets.delete('syncPassphrase');

      if (attempt < maxAttempts) {
        const retry = await vscode.window.showErrorMessage(
          `Incorrect passphrase (attempt ${attempt}/${maxAttempts}). It does not match the passphrase used on your other device.`,
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

  /**
   * Initialize the sync engine: authenticate, ensure repo, load passphrase.
   */
  async initialize(): Promise<boolean> {
    try {
      this.log('Initializing sync engine...');

      // 1. Authenticate with GitHub
      const authenticated = await this.authenticateWithPrompt();
      if (!authenticated) {
        this.updateStatus('setup-required');
        return false;
      }
      this.log(`Authenticated as ${this.githubRepo.getOwner()}`);

      // 2. Ensure the sync repo exists
      await this.githubRepo.ensureRepo();
      this.log(`Sync repo ready: ${this.githubRepo.getOwner()}/${this.githubRepo.getRepoName()}`);

      // 3. Store repo info for cross-device discovery
      this.context.globalState.update('syncRepoOwner', this.githubRepo.getOwner());
      this.context.globalState.update('syncRepoName', this.githubRepo.getRepoName());
      this.context.globalState.setKeysForSync(['syncRepoOwner', 'syncRepoName']);

      // 4. Load or set up passphrase
      const hasPassphrase = await this.loadPassphrase();

      if (!hasPassphrase) {
        // Check if a verification token exists in the repo (another device set up first)
        const verificationToken = await this.githubRepo.getFileContent('verification.token');

        if (verificationToken) {
          // Another device has already set up — prompt for existing passphrase with retry
          this.log('Existing sync setup found. Prompting for passphrase...');
          const verified = await this.promptAndVerifyPassphrase(verificationToken);
          if (!verified) {
            this.updateStatus('setup-required');
            return false;
          }
        } else {
          // First-time setup — create passphrase
          this.log('First-time setup. Prompting for new passphrase...');
          const success = await this.promptForPassphrase(true);
          if (!success) {
            this.updateStatus('setup-required');
            return false;
          }

          // Store the verification token in the repo
          const token = Encryption.createVerificationToken(this.passphrase!);
          await this.githubRepo.putFile(
            'verification.token',
            token,
            'chore: Add passphrase verification token'
          );
          this.log('Verification token stored in repo.');
        }
      } else {
        // Verify stored passphrase against remote token (if exists)
        const verificationToken = await this.githubRepo.getFileContent('verification.token');
        if (verificationToken && !Encryption.verifyPassphrase(this.passphrase!, verificationToken)) {
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
   * Perform a full sync: pull from remote, then push local changes.
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
      // Re-authenticate in case token expired
      await this.githubRepo.authenticate();

      // 1. Pull remote changes
      await this.pullFromRemote();

      // 2. Push local changes
      await this.pushToRemote();

      // Update sync state
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

    // 1. Get the remote manifest
    const manifest = await this.getRemoteManifest();
    if (!manifest) {
      this.log('No remote manifest found — nothing to pull.');
      return;
    }

    // 2. Get local sessions
    const config = vscode.workspace.getConfiguration('copilotSessionSync');
    const maxAgeDays = config.get<number>('maxSessionAgeDays', 90);
    const excludedWorkspaces = config.get<string[]>('excludedWorkspaces', []);
    const localSessions = await this.sessionReader.readRecentSessions(maxAgeDays, excludedWorkspaces);

    const localMap = new Map<string, CopilotSession>();
    for (const session of localSessions) {
      localMap.set(session.id, session);
    }

    const remoteMap = new Map<string, SyncManifestEntry>();
    for (const [id, entry] of Object.entries(manifest.entries)) {
      remoteMap.set(id, entry);
    }

    // 3. Compute local hashes
    const localHashes = new Map<string, string>();
    for (const [id, session] of localMap) {
      const content = JSON.stringify(session);
      localHashes.set(id, Encryption.hashContent(content));
    }

    // 4. Resolve conflicts
    const actions = ConflictResolver.resolveAll(localMap, remoteMap, localHashes);

    // 5. Execute pull actions
    let pullCount = 0;
    for (const [sessionId, action] of actions) {
      if (action.action === 'pull' || action.action === 'new-remote') {
        try {
          await this.pullSession(sessionId, manifest.entries[sessionId]);
          pullCount++;
          this.log(`Pulled session: ${action.reason}`);
        } catch (err) {
          this.logError(`Failed to pull session ${sessionId}`, err);
        }
      }
    }

    this.log(`Pull complete: ${pullCount} sessions pulled.`);
  }

  /**
   * Pull a single session from the remote.
   */
  private async pullSession(sessionId: string, entry: SyncManifestEntry): Promise<void> {
    const encryptedContent = await this.githubRepo.getFileContent(`sessions/${sessionId}.enc`);
    if (!encryptedContent) {
      this.log(`Session file not found in repo: sessions/${sessionId}.enc`);
      return;
    }

    // Decrypt
    const decrypted = Encryption.decryptFromString(encryptedContent, this.passphrase!);
    const session: CopilotSession = JSON.parse(decrypted);

    // Write to local storage
    await this.sessionReader.writeSession(session);

    // Update session index in state.vscdb
    await this.sessionReader.addToSessionIndex(session.workspaceId, sessionId);
  }

  /**
   * Push local sessions that are newer than the remote versions.
   */
  private async pushToRemote(): Promise<void> {
    this.log('Pushing to remote...');

    // 1. Get configuration
    const config = vscode.workspace.getConfiguration('copilotSessionSync');
    const maxAgeDays = config.get<number>('maxSessionAgeDays', 90);
    const excludedWorkspaces = config.get<string[]>('excludedWorkspaces', []);

    // 2. Get local sessions
    const localSessions = await this.sessionReader.readRecentSessions(maxAgeDays, excludedWorkspaces);

    if (localSessions.length === 0) {
      this.log('No local sessions to push.');
      return;
    }

    // 3. Get current remote manifest
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

    const localMap = new Map<string, CopilotSession>();
    for (const session of localSessions) {
      localMap.set(session.id, session);
    }

    const remoteMap = new Map<string, SyncManifestEntry>();
    for (const [id, entry] of Object.entries(manifest.entries)) {
      remoteMap.set(id, entry);
    }

    // 4. Compute local hashes
    const localHashes = new Map<string, string>();
    for (const [id, session] of localMap) {
      const content = JSON.stringify(session);
      localHashes.set(id, Encryption.hashContent(content));
    }

    // 5. Resolve conflicts
    const actions = ConflictResolver.resolveAll(localMap, remoteMap, localHashes);

    // 6. Collect files to push
    const filesToPush: { path: string; content: string }[] = [];
    const backupFiles: { path: string; content: string }[] = [];

    for (const [sessionId, action] of actions) {
      if (action.action === 'push' || action.action === 'new-local') {
        const session = localMap.get(sessionId)!;
        const content = JSON.stringify(session);
        const encrypted = Encryption.encryptToString(content, this.passphrase!);
        const contentHash = Encryption.hashContent(content);

        // If overwriting an existing remote session, back it up
        if (action.action === 'push' && remoteMap.has(sessionId)) {
          const existingContent = await this.githubRepo.getFileContent(`sessions/${sessionId}.enc`);
          if (existingContent) {
            backupFiles.push({
              path: ConflictResolver.backupPath(sessionId),
              content: existingContent,
            });
          }
        }

        filesToPush.push({
          path: `sessions/${sessionId}.enc`,
          content: encrypted,
        });

        // Update manifest entry
        manifest.entries[sessionId] = {
          sessionId,
          workspaceId: session.workspaceId,
          workspacePath: session.workspacePath,
          customTitle: session.customTitle,
          lastMessageDate: session.lastMessageDate,
          creationDate: session.creationDate,
          sha: contentHash,
          deviceId: this.getDeviceId(),
          updatedAt: Date.now(),
        };
      }
    }

    if (filesToPush.length === 0 && backupFiles.length === 0) {
      this.log('No changes to push.');
      return;
    }

    // 7. Update manifest
    manifest.lastSyncTimestamp = Date.now();
    manifest.deviceId = this.getDeviceId();

    const manifestEncrypted = Encryption.encryptToString(
      JSON.stringify(manifest),
      this.passphrase!
    );

    filesToPush.push({
      path: 'manifest.json',
      content: manifestEncrypted,
    });

    // Add backup files
    filesToPush.push(...backupFiles);

    // 8. Batch commit
    const pushCount = filesToPush.length - 1 - backupFiles.length; // exclude manifest and backups
    try {
      await this.githubRepo.batchCommit(
        filesToPush,
        [],
        `sync: Push ${pushCount} session(s) from ${this.getDeviceId()}`
      );
      this.log(`Push complete: ${pushCount} sessions pushed.`);
    } catch (err) {
      // If batch commit fails (e.g., repo is empty), fall back to individual puts
      this.log('Batch commit failed, falling back to individual file operations...');
      for (const file of filesToPush) {
        await this.githubRepo.putFile(
          file.path,
          file.content,
          `sync: Update ${file.path}`
        );
      }
      this.log(`Push complete (individual): ${pushCount} sessions pushed.`);
    }

    this._status.sessionCount = Object.keys(manifest.entries).length;
  }

  // ─── Manifest Management ─────────────────────────────────────────────────

  private async getRemoteManifest(): Promise<SyncManifest | null> {
    const content = await this.githubRepo.getFileContent('manifest.json');
    if (!content) {
      return null;
    }

    try {
      const decrypted = Encryption.decryptFromString(content, this.passphrase!);
      return JSON.parse(decrypted) as SyncManifest;
    } catch (err) {
      this.logError('Failed to decrypt remote manifest', err);
      return null;
    }
  }

  // ─── Periodic Sync ───────────────────────────────────────────────────────

  /**
   * Start periodic sync at the configured interval.
   */
  startPeriodicSync(): void {
    this.stopPeriodicSync();

    const config = vscode.workspace.getConfiguration('copilotSessionSync');
    const intervalMinutes = config.get<number>('syncIntervalMinutes', 5);
    const intervalMs = intervalMinutes * 60 * 1000;

    this.log(`Starting periodic sync every ${intervalMinutes} minutes.`);

    this.syncTimer = setInterval(async () => {
      try {
        await this.sync();
      } catch (err) {
        this.logError('Periodic sync failed', err);
      }
    }, intervalMs);

    // Register for cleanup
    this.context.subscriptions.push({
      dispose: () => this.stopPeriodicSync(),
    });
  }

  /**
   * Stop the periodic sync timer.
   */
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

  /**
   * Reset all local sync state. Does NOT delete the remote repo.
   */
  async resetSyncState(): Promise<void> {
    this.passphrase = null;
    await this.context.secrets.delete('syncPassphrase');
    await this.context.globalState.update('syncState', undefined);
    await this.context.globalState.update('deviceId', undefined);
    this.stopPeriodicSync();
    this.updateStatus('setup-required');
    this.log('Sync state reset.');
  }

  // ─── Logging ──────────────────────────────────────────────────────────────

  private log(message: string): void {
    const timestamp = new Date().toISOString();
    this.outputChannel.appendLine(`[${timestamp}] ${message}`);
  }

  private logError(message: string, err: unknown): void {
    const timestamp = new Date().toISOString();
    const errorStr = err instanceof Error ? err.message : String(err);
    this.outputChannel.appendLine(`[${timestamp}] ERROR: ${message}: ${errorStr}`);
  }

  // ─── Dispose ──────────────────────────────────────────────────────────────

  dispose(): void {
    this.stopPeriodicSync();
    this._onStatusChange.dispose();
  }
}
