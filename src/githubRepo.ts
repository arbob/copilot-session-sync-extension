import * as vscode from 'vscode';
import type { GitHubFileContent, GitHubRepoInfo, GitTreeEntry } from './types';

/**
 * GitHub repository backend for storing encrypted Copilot sessions.
 *
 * Uses the GitHub REST API via VS Code's built-in authentication provider.
 * All data is stored in a private repository under the user's account.
 */
export class GitHubRepo {
  private token: string = '';
  private owner: string = '';
  private repoName: string;
  private defaultBranch: string = 'main';

  private static readonly API_BASE = 'https://api.github.com';
  private static readonly USER_AGENT = 'copilot-session-sync-vscode';

  constructor(repoName: string = 'copilot-session-sync') {
    this.repoName = repoName;
  }

  // ─── Authentication ───────────────────────────────────────────────────────

  /**
   * Try to authenticate silently (without prompting the user).
   * Returns the session if already signed in, null otherwise.
   */
  async authenticateSilent(): Promise<{ owner: string; token: string } | null> {
    const session = await vscode.authentication.getSession('github', ['repo'], {
      createIfNone: false,
    });

    if (!session) {
      return null;
    }

    this.token = session.accessToken;
    this.owner = session.account.label;

    return { owner: this.owner, token: this.token };
  }

  /**
   * Authenticate with GitHub using VS Code's built-in authentication provider.
   * Requests 'repo' scope to create/read/write private repositories.
   */
  async authenticate(): Promise<{ owner: string; token: string }> {
    const session = await vscode.authentication.getSession('github', ['repo'], {
      createIfNone: true,
    });

    if (!session) {
      throw new Error('GitHub authentication failed. Please sign in to GitHub.');
    }

    this.token = session.accessToken;
    this.owner = session.account.label;

    return { owner: this.owner, token: this.token };
  }

  /**
   * Get the authenticated user's login name.
   */
  getOwner(): string {
    return this.owner;
  }

  getRepoName(): string {
    return this.repoName;
  }

  // ─── HTTP Helpers ─────────────────────────────────────────────────────────

  private async request<T>(
    method: string,
    endpoint: string,
    body?: unknown,
    acceptHeader?: string
  ): Promise<{ data: T; status: number }> {
    if (!this.token) {
      throw new Error('Not authenticated. Call authenticate() first.');
    }

    const url = endpoint.startsWith('http')
      ? endpoint
      : `${GitHubRepo.API_BASE}${endpoint}`;

    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.token}`,
      'User-Agent': GitHubRepo.USER_AGENT,
      Accept: acceptHeader ?? 'application/vnd.github.v3+json',
    };

    if (body) {
      headers['Content-Type'] = 'application/json';
    }

    const response = await fetch(url, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });

    let data: T;
    const contentType = response.headers.get('content-type') ?? '';
    if (contentType.includes('application/json')) {
      data = (await response.json()) as T;
    } else {
      data = (await response.text()) as unknown as T;
    }

    if (!response.ok && response.status !== 404) {
      const msg = typeof data === 'object' && data !== null && 'message' in data
        ? (data as { message: string }).message
        : `HTTP ${response.status}`;
      throw new Error(`GitHub API error: ${msg} (${method} ${endpoint})`);
    }

    return { data, status: response.status };
  }

  // ─── Repository Management ────────────────────────────────────────────────

  /**
   * Check if the sync repo exists.
   */
  async repoExists(): Promise<boolean> {
    const { status } = await this.request<GitHubRepoInfo>(
      'GET',
      `/repos/${this.owner}/${this.repoName}`
    );
    return status === 200;
  }

  /**
   * Create the private sync repository.
   */
  async createRepo(): Promise<GitHubRepoInfo> {
    const { data } = await this.request<GitHubRepoInfo>('POST', '/user/repos', {
      name: this.repoName,
      private: true,
      description:
        'Encrypted Copilot chat session sync — managed by Copilot Session Sync extension. Do not edit manually.',
      auto_init: true,
    });

    this.defaultBranch = data.default_branch ?? 'main';
    return data;
  }

  /**
   * Ensure the sync repo exists, creating it if necessary.
   */
  async ensureRepo(): Promise<void> {
    const exists = await this.repoExists();
    if (!exists) {
      const repo = await this.createRepo();
      this.defaultBranch = repo.default_branch ?? 'main';
    } else {
      // Fetch repo info to get the default branch
      const { data } = await this.request<GitHubRepoInfo>(
        'GET',
        `/repos/${this.owner}/${this.repoName}`
      );
      this.defaultBranch = data.default_branch ?? 'main';
    }
  }

  // ─── File Operations ─────────────────────────────────────────────────────

  /**
   * Get a file's content from the repo.
   * Returns null if the file doesn't exist.
   */
  async getFile(filePath: string): Promise<GitHubFileContent | null> {
    const { data, status } = await this.request<GitHubFileContent>(
      'GET',
      `/repos/${this.owner}/${this.repoName}/contents/${filePath}`
    );

    if (status === 404) {
      return null;
    }

    return data;
  }

  /**
   * Get a file's content decoded from base64.
   * Returns null if the file doesn't exist.
   */
  async getFileContent(filePath: string): Promise<string | null> {
    const file = await this.getFile(filePath);
    if (!file) {
      return null;
    }
    return Buffer.from(file.content, 'base64').toString('utf-8');
  }

  /**
   * Create or update a single file in the repo.
   */
  async putFile(filePath: string, content: string, message: string): Promise<string> {
    // Check if file exists to get its SHA (required for updates)
    const existing = await this.getFile(filePath);
    const sha = existing?.sha;

    const body: Record<string, string> = {
      message,
      content: Buffer.from(content).toString('base64'),
    };
    if (sha) {
      body.sha = sha;
    }

    const { data } = await this.request<{ content: { sha: string } }>(
      'PUT',
      `/repos/${this.owner}/${this.repoName}/contents/${filePath}`,
      body
    );

    return data.content.sha;
  }

  /**
   * Delete a file from the repo.
   */
  async deleteFile(filePath: string, message: string): Promise<void> {
    const existing = await this.getFile(filePath);
    if (!existing) {
      return; // File doesn't exist, nothing to delete
    }

    await this.request(
      'DELETE',
      `/repos/${this.owner}/${this.repoName}/contents/${filePath}`,
      {
        message,
        sha: existing.sha,
      }
    );
  }

  // ─── Batch Commit (Git Tree API) ──────────────────────────────────────────

  /**
   * Create a batch commit with multiple file changes in a single commit.
   * This is more efficient than individual file operations.
   *
   * @param files - Array of { path, content } to create/update
   * @param deletePaths - Array of file paths to delete
   * @param message - Commit message
   */
  async batchCommit(
    files: { path: string; content: string }[],
    deletePaths: string[],
    message: string
  ): Promise<string> {
    if (files.length === 0 && deletePaths.length === 0) {
      return '';
    }

    // 1. Get the latest commit SHA on the default branch
    const { data: refData } = await this.request<{ object: { sha: string } }>(
      'GET',
      `/repos/${this.owner}/${this.repoName}/git/ref/heads/${this.defaultBranch}`
    );
    const latestCommitSha = refData.object.sha;

    // 2. Get the tree SHA of the latest commit
    const { data: commitData } = await this.request<{ tree: { sha: string } }>(
      'GET',
      `/repos/${this.owner}/${this.repoName}/git/commits/${latestCommitSha}`
    );
    const baseTreeSha = commitData.tree.sha;

    // 3. Build tree entries
    const treeEntries: GitTreeEntry[] = [];

    // Files to create/update — use inline content for smaller files,
    // create blobs for larger ones
    for (const file of files) {
      if (file.content.length < 500_000) {
        // Inline content (< 500KB)
        treeEntries.push({
          path: file.path,
          mode: '100644',
          type: 'blob',
          content: file.content,
        });
      } else {
        // Create a blob for large files
        const { data: blobData } = await this.request<{ sha: string }>(
          'POST',
          `/repos/${this.owner}/${this.repoName}/git/blobs`,
          {
            content: Buffer.from(file.content).toString('base64'),
            encoding: 'base64',
          }
        );
        treeEntries.push({
          path: file.path,
          mode: '100644',
          type: 'blob',
          sha: blobData.sha,
        });
      }
    }

    // Files to delete — set sha to null (GitHub API convention)
    for (const delPath of deletePaths) {
      treeEntries.push({
        path: delPath,
        mode: '100644',
        type: 'blob',
        sha: undefined, // null sha deletes the file
      });
    }

    // 4. Create the new tree
    const { data: treeData } = await this.request<{ sha: string }>(
      'POST',
      `/repos/${this.owner}/${this.repoName}/git/trees`,
      {
        base_tree: baseTreeSha,
        tree: treeEntries,
      }
    );

    // 5. Create a new commit
    const { data: newCommit } = await this.request<{ sha: string }>(
      'POST',
      `/repos/${this.owner}/${this.repoName}/git/commits`,
      {
        message,
        tree: treeData.sha,
        parents: [latestCommitSha],
      }
    );

    // 6. Update the branch reference
    await this.request(
      'PATCH',
      `/repos/${this.owner}/${this.repoName}/git/refs/heads/${this.defaultBranch}`,
      {
        sha: newCommit.sha,
      }
    );

    return newCommit.sha;
  }

  // ─── Directory Listing ────────────────────────────────────────────────────

  /**
   * List files in a directory in the repo.
   * Returns an array of file paths.
   */
  async listFiles(dirPath: string): Promise<string[]> {
    const { data, status } = await this.request<
      Array<{ name: string; path: string; type: string }>
    >('GET', `/repos/${this.owner}/${this.repoName}/contents/${dirPath}`);

    if (status === 404) {
      return [];
    }

    if (!Array.isArray(data)) {
      return [];
    }

    return data
      .filter((item) => item.type === 'file')
      .map((item) => item.path);
  }

  /**
   * Get rate limit status.
   */
  async getRateLimit(): Promise<{ remaining: number; limit: number; reset: number }> {
    const { data } = await this.request<{
      rate: { remaining: number; limit: number; reset: number };
    }>('GET', '/rate_limit');
    return data.rate;
  }
}
