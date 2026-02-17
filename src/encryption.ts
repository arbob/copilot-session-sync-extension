import * as crypto from 'crypto';
import type { EncryptedPayload } from './types';

/**
 * AES-256-GCM encryption/decryption using a user-provided passphrase.
 *
 * Scheme:
 *   - Key derivation: PBKDF2 with SHA-512, 100k iterations, random 16-byte salt
 *   - Encryption: AES-256-GCM with random 12-byte IV
 *   - Output: JSON object containing base64-encoded salt, IV, and ciphertext+authTag
 */
export class Encryption {
  private static readonly ALGORITHM = 'aes-256-gcm';
  private static readonly KEY_LENGTH = 32; // 256 bits
  private static readonly IV_LENGTH = 12; // 96 bits for GCM
  private static readonly SALT_LENGTH = 16; // 128 bits
  private static readonly PBKDF2_ITERATIONS = 100_000;
  private static readonly PBKDF2_DIGEST = 'sha512';
  private static readonly AUTH_TAG_LENGTH = 16; // 128-bit auth tag
  private static readonly CURRENT_VERSION = 1;

  /**
   * Derive a 256-bit key from the passphrase using PBKDF2.
   */
  private static deriveKey(passphrase: string, salt: Buffer): Buffer {
    return crypto.pbkdf2Sync(
      passphrase,
      salt,
      Encryption.PBKDF2_ITERATIONS,
      Encryption.KEY_LENGTH,
      Encryption.PBKDF2_DIGEST
    );
  }

  /**
   * Encrypt plaintext data with the user's passphrase.
   *
   * @param data - The string data to encrypt (typically JSON-stringified session)
   * @param passphrase - The user's encryption passphrase
   * @returns An EncryptedPayload containing salt, IV, and ciphertext (all base64)
   */
  static encrypt(data: string, passphrase: string): EncryptedPayload {
    const salt = crypto.randomBytes(Encryption.SALT_LENGTH);
    const iv = crypto.randomBytes(Encryption.IV_LENGTH);
    const key = Encryption.deriveKey(passphrase, salt);

    const cipher = crypto.createCipheriv(Encryption.ALGORITHM, key, iv, {
      authTagLength: Encryption.AUTH_TAG_LENGTH,
    });

    const encrypted = Buffer.concat([
      cipher.update(data, 'utf-8'),
      cipher.final(),
    ]);

    const authTag = cipher.getAuthTag();

    // Concatenate ciphertext + auth tag
    const ciphertextWithTag = Buffer.concat([encrypted, authTag]);

    return {
      salt: salt.toString('base64'),
      iv: iv.toString('base64'),
      ciphertext: ciphertextWithTag.toString('base64'),
      version: Encryption.CURRENT_VERSION,
    };
  }

  /**
   * Decrypt an EncryptedPayload back to plaintext.
   *
   * @param payload - The encrypted payload (salt, IV, ciphertext)
   * @param passphrase - The user's encryption passphrase
   * @returns The decrypted string data
   * @throws Error if the passphrase is wrong or data is corrupted
   */
  static decrypt(payload: EncryptedPayload, passphrase: string): string {
    if (payload.version !== Encryption.CURRENT_VERSION) {
      throw new Error(`Unsupported encryption version: ${payload.version}`);
    }

    const salt = Buffer.from(payload.salt, 'base64');
    const iv = Buffer.from(payload.iv, 'base64');
    const ciphertextWithTag = Buffer.from(payload.ciphertext, 'base64');

    // Split ciphertext and auth tag
    const ciphertext = ciphertextWithTag.subarray(0, ciphertextWithTag.length - Encryption.AUTH_TAG_LENGTH);
    const authTag = ciphertextWithTag.subarray(ciphertextWithTag.length - Encryption.AUTH_TAG_LENGTH);

    const key = Encryption.deriveKey(passphrase, salt);

    const decipher = crypto.createDecipheriv(Encryption.ALGORITHM, key, iv, {
      authTagLength: Encryption.AUTH_TAG_LENGTH,
    });
    decipher.setAuthTag(authTag);

    try {
      const decrypted = Buffer.concat([
        decipher.update(ciphertext),
        decipher.final(),
      ]);
      return decrypted.toString('utf-8');
    } catch {
      throw new Error('Decryption failed — wrong passphrase or corrupted data.');
    }
  }

  /**
   * Encrypt data and return as a single base64 string (for storage in GitHub).
   */
  static encryptToString(data: string, passphrase: string): string {
    const payload = Encryption.encrypt(data, passphrase);
    return Buffer.from(JSON.stringify(payload)).toString('base64');
  }

  /**
   * Decrypt a base64-encoded encrypted payload string.
   */
  static decryptFromString(encoded: string, passphrase: string): string {
    const payloadJson = Buffer.from(encoded, 'base64').toString('utf-8');
    const payload: EncryptedPayload = JSON.parse(payloadJson);
    return Encryption.decrypt(payload, passphrase);
  }

  /**
   * Generate a verification token for the passphrase.
   * Stored in the repo so other devices can check if the entered passphrase is correct
   * before attempting to decrypt all sessions.
   */
  static createVerificationToken(passphrase: string): string {
    const knownPlaintext = 'copilot-session-sync-verification-v1';
    return Encryption.encryptToString(knownPlaintext, passphrase);
  }

  /**
   * Verify that a passphrase matches the stored verification token.
   */
  static verifyPassphrase(passphrase: string, verificationToken: string): boolean {
    try {
      const decrypted = Encryption.decryptFromString(verificationToken, passphrase);
      return decrypted === 'copilot-session-sync-verification-v1';
    } catch {
      return false;
    }
  }

  /**
   * Compute a SHA-256 hash of session content (for change detection).
   */
  static hashContent(content: string): string {
    return crypto.createHash('sha256').update(content).digest('hex');
  }
}
