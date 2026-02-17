import * as assert from 'assert';
import { Encryption } from '../encryption';
import { ConflictResolver } from '../conflictResolver';
import type { CopilotSession, SyncManifestEntry } from '../types';

// ─── Encryption Tests ───────────────────────────────────────────────────────

describe('Encryption', () => {
  const passphrase = 'test-passphrase-12345678';

  it('should encrypt and decrypt round-trip', () => {
    const plaintext = 'Hello, World! This is a test session.';
    const encrypted = Encryption.encrypt(plaintext, passphrase);

    assert.ok(encrypted.salt);
    assert.ok(encrypted.iv);
    assert.ok(encrypted.ciphertext);
    assert.strictEqual(encrypted.version, 1);

    const decrypted = Encryption.decrypt(encrypted, passphrase);
    assert.strictEqual(decrypted, plaintext);
  });

  it('should encrypt and decrypt large JSON data', () => {
    const session = {
      id: 'test-session-1',
      title: 'Test Session',
      requests: Array.from({ length: 50 }, (_, i) => ({
        message: `Question ${i}: How do I implement feature ${i}?`,
        timestamp: Date.now() + i * 1000,
        response: `Answer ${i}: Here is how you implement feature ${i}...`.repeat(20),
      })),
    };

    const plaintext = JSON.stringify(session);
    const encrypted = Encryption.encryptToString(plaintext, passphrase);
    const decrypted = Encryption.decryptFromString(encrypted, passphrase);

    assert.strictEqual(decrypted, plaintext);
    assert.deepStrictEqual(JSON.parse(decrypted), session);
  });

  it('should fail with wrong passphrase', () => {
    const plaintext = 'Secret data';
    const encrypted = Encryption.encrypt(plaintext, passphrase);

    assert.throws(
      () => Encryption.decrypt(encrypted, 'wrong-passphrase'),
      /Decryption failed/
    );
  });

  it('should produce different ciphertexts for same plaintext (random salt/IV)', () => {
    const plaintext = 'Same data';
    const enc1 = Encryption.encrypt(plaintext, passphrase);
    const enc2 = Encryption.encrypt(plaintext, passphrase);

    assert.notStrictEqual(enc1.salt, enc2.salt);
    assert.notStrictEqual(enc1.iv, enc2.iv);
    assert.notStrictEqual(enc1.ciphertext, enc2.ciphertext);

    // Both should decrypt to the same value
    assert.strictEqual(Encryption.decrypt(enc1, passphrase), plaintext);
    assert.strictEqual(Encryption.decrypt(enc2, passphrase), plaintext);
  });

  it('should create and verify passphrase verification tokens', () => {
    const token = Encryption.createVerificationToken(passphrase);
    assert.ok(token);

    assert.strictEqual(Encryption.verifyPassphrase(passphrase, token), true);
    assert.strictEqual(Encryption.verifyPassphrase('wrong-pass-12345', token), false);
  });

  it('should produce consistent hashes', () => {
    const content = 'test content for hashing';
    const hash1 = Encryption.hashContent(content);
    const hash2 = Encryption.hashContent(content);

    assert.strictEqual(hash1, hash2);
    assert.strictEqual(hash1.length, 64); // SHA-256 hex is 64 chars
  });

  it('should produce different hashes for different content', () => {
    const hash1 = Encryption.hashContent('content A');
    const hash2 = Encryption.hashContent('content B');

    assert.notStrictEqual(hash1, hash2);
  });
});

// ─── Conflict Resolver Tests ────────────────────────────────────────────────

describe('ConflictResolver', () => {
  function makeSession(overrides: Partial<CopilotSession> = {}): CopilotSession {
    return {
      id: 'session-1',
      workspaceId: 'ws-1',
      workspacePath: '/home/user/project',
      fileExtension: '.jsonl',
      rawContent: '{"kind":0,"v":{}}',
      customTitle: 'Test Session',
      creationDate: 1000,
      lastMessageDate: 2000,
      ...overrides,
    };
  }

  function makeManifestEntry(
    overrides: Partial<SyncManifestEntry> = {}
  ): SyncManifestEntry {
    return {
      sessionId: 'session-1',
      workspaceId: 'ws-1',
      workspacePath: '/home/user/project',
      fileExtension: '.jsonl',
      customTitle: 'Test Session',
      lastMessageDate: 2000,
      creationDate: 1000,
      sha: 'abc123',
      deviceId: 'device-1',
      updatedAt: 3000,
      ...overrides,
    };
  }

  it('should return new-local when session only exists locally', () => {
    const result = ConflictResolver.resolve(makeSession(), null);
    assert.strictEqual(result.action, 'new-local');
  });

  it('should return new-remote when session only exists remotely', () => {
    const result = ConflictResolver.resolve(null, makeManifestEntry());
    assert.strictEqual(result.action, 'new-remote');
  });

  it('should return push when local is newer', () => {
    const local = makeSession({ lastMessageDate: 3000 });
    const remote = makeManifestEntry({ lastMessageDate: 2000 });
    const result = ConflictResolver.resolve(local, remote, 'different-hash');
    assert.strictEqual(result.action, 'push');
  });

  it('should return pull when remote is newer', () => {
    const local = makeSession({ lastMessageDate: 2000 });
    const remote = makeManifestEntry({ lastMessageDate: 3000 });
    const result = ConflictResolver.resolve(local, remote, 'different-hash');
    assert.strictEqual(result.action, 'pull');
  });

  it('should return skip when content hash matches', () => {
    const local = makeSession({ lastMessageDate: 2000 });
    const remote = makeManifestEntry({ lastMessageDate: 2000, sha: 'same-hash' });
    const result = ConflictResolver.resolve(local, remote, 'same-hash');
    assert.strictEqual(result.action, 'skip');
  });

  it('should return skip when both are null', () => {
    const result = ConflictResolver.resolve(null, null);
    assert.strictEqual(result.action, 'skip');
  });

  it('should generate backup paths with timestamp', () => {
    const path = ConflictResolver.backupPath('session-123');
    assert.ok(path.startsWith('sessions/backups/session-123.backup-'));
    assert.ok(path.endsWith('.enc'));
  });

  it('should resolveAll across multiple sessions', () => {
    const localSessions = new Map<string, CopilotSession>([
      ['s1', makeSession({ id: 's1', lastMessageDate: 3000 })],
      ['s2', makeSession({ id: 's2', lastMessageDate: 1000 })],
      ['s3', makeSession({ id: 's3', lastMessageDate: 2000 })],
    ]);

    const remoteEntries = new Map<string, SyncManifestEntry>([
      ['s1', makeManifestEntry({ sessionId: 's1', lastMessageDate: 2000 })],
      ['s2', makeManifestEntry({ sessionId: 's2', lastMessageDate: 2000 })],
      ['s4', makeManifestEntry({ sessionId: 's4', lastMessageDate: 1000 })],
    ]);

    const localHashes = new Map<string, string>([
      ['s1', 'hash-s1'],
      ['s2', 'hash-s2'],
      ['s3', 'hash-s3'],
    ]);

    const results = ConflictResolver.resolveAll(localSessions, remoteEntries, localHashes);

    assert.strictEqual(results.get('s1')?.action, 'push');       // local newer
    assert.strictEqual(results.get('s2')?.action, 'pull');        // remote newer
    assert.strictEqual(results.get('s3')?.action, 'new-local');   // only local
    assert.strictEqual(results.get('s4')?.action, 'new-remote');  // only remote
  });
});
