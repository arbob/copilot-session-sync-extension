import * as vscode from 'vscode';
import { SyncEngine } from './syncEngine';
import type { SyncStatusInfo } from './types';

let syncEngine: SyncEngine;
let statusBarItem: vscode.StatusBarItem;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const outputChannel = vscode.window.createOutputChannel('Copilot Session Sync');
  context.subscriptions.push(outputChannel);
  outputChannel.appendLine('Copilot Session Sync extension activating...');

  // ─── Create sync engine ─────────────────────────────────────────────────
  syncEngine = new SyncEngine(context);
  context.subscriptions.push({ dispose: () => syncEngine.dispose() });

  // ─── Status bar ─────────────────────────────────────────────────────────
  statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusBarItem.command = 'copilot-session-sync.viewSyncStatus';
  context.subscriptions.push(statusBarItem);
  updateStatusBar({ status: 'setup-required', lastSyncTime: null, sessionCount: 0 });
  statusBarItem.show();

  // Listen for status changes
  syncEngine.onStatusChange((info) => updateStatusBar(info));

  // ─── Register commands ──────────────────────────────────────────────────
  context.subscriptions.push(
    vscode.commands.registerCommand('copilot-session-sync.syncNow', async () => {
      try {
        if (syncEngine.status.status === 'setup-required') {
          const initialized = await syncEngine.initialize();
          if (!initialized) {
            return;
          }
        }
        await syncEngine.sync();
        vscode.window.showInformationMessage('Copilot Session Sync: Sync completed.');
      } catch (err) {
        vscode.window.showErrorMessage(
          `Copilot Session Sync: Sync failed — ${err instanceof Error ? err.message : String(err)}`
        );
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('copilot-session-sync.setPassphrase', async () => {
      const success = await syncEngine.promptForPassphrase(false);
      if (success) {
        vscode.window.showInformationMessage('Copilot Session Sync: Passphrase updated.');
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('copilot-session-sync.viewSyncStatus', () => {
      const info = syncEngine.status;
      const lines: string[] = [
        `Status: ${info.status}`,
        `Last sync: ${info.lastSyncTime ? new Date(info.lastSyncTime).toLocaleString() : 'Never'}`,
        `Sessions synced: ${info.sessionCount}`,
      ];
      if (info.errorMessage) {
        lines.push(`Error: ${info.errorMessage}`);
      }

      vscode.window.showInformationMessage(lines.join(' | '), 'Sync Now', 'Open Log').then(
        (selection) => {
          if (selection === 'Sync Now') {
            vscode.commands.executeCommand('copilot-session-sync.syncNow');
          } else if (selection === 'Open Log') {
            outputChannel.show();
          }
        }
      );
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('copilot-session-sync.resetSync', async () => {
      const confirm = await vscode.window.showWarningMessage(
        'This will reset all local sync state. You will need to re-enter your passphrase. Continue?',
        { modal: true },
        'Reset'
      );

      if (confirm === 'Reset') {
        await syncEngine.resetSyncState();
        vscode.window.showInformationMessage('Copilot Session Sync: Sync state reset.');
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('copilot-session-sync.reindexSessions', async () => {
      const confirm = await vscode.window.showInformationMessage(
        'This will reindex all synced session files and reload VS Code to show them. Continue?',
        { modal: true },
        'Reindex & Reload'
      );

      if (confirm === 'Reindex & Reload') {
        try {
          const count = await syncEngine.reindexCurrentWorkspace();
          outputChannel.appendLine(`Reindexed ${count} sessions. Reloading window...`);
          // Give a brief moment for the database write to complete
          await new Promise(resolve => setTimeout(resolve, 500));
          await vscode.commands.executeCommand('workbench.action.reloadWindow');
        } catch (err) {
          vscode.window.showErrorMessage(
            `Reindex failed: ${err instanceof Error ? err.message : String(err)}`
          );
        }
      }
    })
  );

  // ─── Auto-initialize and start sync ────────────────────────────────────
  const config = vscode.workspace.getConfiguration('copilotSessionSync');
  if (config.get<boolean>('enabled', true)) {
    // Delay initialization slightly to avoid blocking VS Code startup
    setTimeout(async () => {
      try {
        const initialized = await syncEngine.initialize();
        if (initialized) {
          // Initial sync
          await syncEngine.sync();
          // Start periodic sync
          syncEngine.startPeriodicSync();
        }
      } catch (err) {
        outputChannel.appendLine(
          `Initialization error: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }, 5000); // 5 second delay after activation
  }

  // ─── Configuration change listener ────────────────────────────────────
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('copilotSessionSync')) {
        const newConfig = vscode.workspace.getConfiguration('copilotSessionSync');
        if (!newConfig.get<boolean>('enabled', true)) {
          syncEngine.stopPeriodicSync();
          updateStatusBar({ ...syncEngine.status, status: 'disabled' });
        } else {
          syncEngine.startPeriodicSync();
        }
      }
    })
  );

  outputChannel.appendLine('Copilot Session Sync extension activated.');
}

export function deactivate(): void {
  if (syncEngine) {
    // Only attempt final sync if engine is in a ready state
    if (syncEngine.status.status === 'idle') {
      syncEngine.sync().catch(() => {
        // Best effort — can't do much if this fails during shutdown
      });
    }
    syncEngine.dispose();
  }
}

// ─── Status Bar ─────────────────────────────────────────────────────────────

function updateStatusBar(info: SyncStatusInfo): void {
  switch (info.status) {
    case 'syncing':
      statusBarItem.text = '$(sync~spin) Copilot Sync';
      statusBarItem.tooltip = 'Copilot Session Sync: Syncing...';
      statusBarItem.backgroundColor = undefined;
      break;
    case 'idle':
      statusBarItem.text = '$(check) Copilot Sync';
      statusBarItem.tooltip = `Copilot Session Sync: Last sync ${info.lastSyncTime ? new Date(info.lastSyncTime).toLocaleTimeString() : 'never'
        } | ${info.sessionCount} sessions`;
      statusBarItem.backgroundColor = undefined;
      break;
    case 'error':
      statusBarItem.text = '$(error) Copilot Sync';
      statusBarItem.tooltip = `Copilot Session Sync: Error — ${info.errorMessage ?? 'Unknown'}`;
      statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
      break;
    case 'disabled':
      statusBarItem.text = '$(circle-slash) Copilot Sync';
      statusBarItem.tooltip = 'Copilot Session Sync: Disabled';
      statusBarItem.backgroundColor = undefined;
      break;
    case 'setup-required':
      statusBarItem.text = '$(key) Copilot Sync';
      statusBarItem.tooltip = 'Copilot Session Sync: Setup required — click to configure';
      statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
      break;
  }
}
