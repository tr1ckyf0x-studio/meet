import { createCipheriv, createDecipheriv, randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";

// Random tokens are handed out once; only their SHA-256 is stored (sessions, magic links, OAuth states).

export function newToken(bytes = 32): string {
  return Buffer.from(crypto.getRandomValues(new Uint8Array(bytes))).toString("base64url");
}

export function newId(): string {
  return newToken(12); // 16 chars of [A-Za-z0-9_-]
}

export function sha256(s: string): string {
  return new Bun.CryptoHasher("sha256").update(s).digest("hex");
}

export function pkceChallenge(verifier: string): string {
  return Buffer.from(new Bun.CryptoHasher("sha256").update(verifier).digest()).toString("base64url");
}

export function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/**
 * The key that encrypts calendar credentials at rest. Generated on first start next to the database, so a
 * copy of the database file alone (e.g. a backup) does not reveal passwords, tokens or secret ICS links.
 */
export function loadKey(path: string): Buffer {
  if (existsSync(path)) {
    const k = Buffer.from(readFileSync(path, "utf8").trim(), "base64");
    if (k.length !== 32) throw new Error(`${path} does not hold a 32-byte key`);
    return k;
  }
  const k = randomBytes(32);
  writeFileSync(path, k.toString("base64") + "\n", { mode: 0o600, flag: "wx" });
  chmodSync(path, 0o600);
  return k;
}

export class Sealer {
  constructor(private readonly key: Buffer) {}

  seal(value: unknown): Uint8Array {
    const iv = randomBytes(12);
    const c = createCipheriv("aes-256-gcm", this.key, iv);
    const body = Buffer.concat([c.update(JSON.stringify(value), "utf8"), c.final()]);
    return new Uint8Array(Buffer.concat([Buffer.from([1]), iv, c.getAuthTag(), body]));
  }

  open<T>(blob: Uint8Array): T {
    const b = Buffer.from(blob);
    if (b[0] !== 1 || b.length < 29) throw new Error("bad sealed value");
    const d = createDecipheriv("aes-256-gcm", this.key, b.subarray(1, 13));
    d.setAuthTag(b.subarray(13, 29));
    return JSON.parse(Buffer.concat([d.update(b.subarray(29)), d.final()]).toString("utf8")) as T;
  }
}
