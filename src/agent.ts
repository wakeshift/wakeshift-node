import { createPublicKey, verify as verifySignature, type KeyObject } from "node:crypto";

// Sign in with Wakeshift, for an app whose users sign in with their
// Wakeshift accounts (manifest accounts: "wakeshift"): MCP clients sign in
// at Wakeshift and send the app an access token; the app verifies it
// (verifyAccessToken) and exchanges it for one it can act with (an Agent).
// The same as the Go SDK's App.Verify, App.Exchange and Agent.

/** A verified access token's claims. */
export interface Claims {
  iss: string;
  sub: string;
  aud: string;
  client_id?: string;
  exp: number;
  /** The person's workspace. */
  wakeshift_tenant: string;
  /** The agent the person signed in. */
  wakeshift_agent: string;
}

/**
 * The app acting for one signed-in agent, through a token exchanged for the
 * agent's own (so inside the consent its person gave). Pass it to
 * serveEvents' agent option, or to an event's subscribe and unsubscribe.
 */
export class Agent {
  /** Wakeshift.exchange makes these: use it rather than this constructor. */
  constructor(
    /** The person's workspace. */
    readonly workspace: string,
    /** The agent's ID in that workspace. */
    readonly id: string,
    /** @internal The exchanged token: never log or send it anywhere but Wakeshift. */
    readonly token: string,
    /** When the exchanged token expires. */
    readonly expiresAt: Date,
  ) {}

  /**
   * The agent as a personal event's subscriber: its workspace and ID
   * ("<workspace>/<id>"). Emit to it with { to: agent.user() }.
   */
  user(): string {
    return this.workspace + "/" + this.id;
  }

  toJSON(): { workspace: string; id: string } {
    return { workspace: this.workspace, id: this.id }; // never the token
  }
}

// ── Access-token verification (compact JWS, EdDSA, typ at+jwt) ──────────

/** @internal Wakeshift's signing keys, fetched from its JWKS. */
export class Keys {
  private keys = new Map<string, KeyObject>();
  private fetchedAt = 0;
  private triedAt = 0;
  private inflight: Promise<void> | null = null;

  constructor(
    private readonly core: string,
    private readonly fetchFn: typeof fetch,
    private readonly timeoutMs: number,
  ) {}

  /** The key kid names: fetched when unknown or over an hour old, at most once a minute. A failed fetch keeps the keys it had. */
  async get(kid: string): Promise<KeyObject | undefined> {
    const k = this.keys.get(kid);
    const fresh = Date.now() - this.fetchedAt < 3_600_000;
    const tried = Date.now() - this.triedAt < 60_000;
    if ((k && fresh) || tried) return k;
    if (!this.inflight) {
      this.triedAt = Date.now();
      this.inflight = this.fetch().finally(() => {
        this.inflight = null;
      });
    }
    await this.inflight;
    return this.keys.get(kid);
  }

  private async fetch(): Promise<void> {
    try {
      const resp = await this.fetchFn(this.core + "/oauth/jwks", { signal: AbortSignal.timeout(this.timeoutMs) });
      if (!resp.ok) return;
      const set = (await resp.json()) as { keys?: { kid?: string; crv?: string; x?: string }[] };
      const next = new Map<string, KeyObject>();
      for (const j of set.keys ?? []) {
        if (j.crv !== "Ed25519" || typeof j.kid !== "string" || typeof j.x !== "string") continue;
        const raw = Buffer.from(j.x, "base64url");
        if (raw.length !== 32) continue;
        next.set(j.kid, createPublicKey({ key: Buffer.concat([SPKI_ED25519, raw]), format: "der", type: "spki" }));
      }
      if (next.size > 0) {
        this.keys = next;
        this.fetchedAt = Date.now();
      }
    } catch {
      // keep the keys we had
    }
  }
}

// SubjectPublicKeyInfo for an Ed25519 key, before its 32 bytes (RFC 8410).
const SPKI_ED25519 = Buffer.from("302a300506032b6570032100", "hex");

/**
 * @internal Verifies an access token an MCP client sent: signed by Wakeshift
 * (keys from its JWKS), typ at+jwt, issued by core for resource (the app's
 * MCP URL), not expired. Throws on anything else, with a short reason.
 */
export async function verifyAccessToken(keys: Keys, token: string, core: string, resource: string, now = Date.now()): Promise<Claims> {
  const parts = token.split(".");
  if (parts.length !== 3) throw new Error("invalid token");
  let header: { alg?: string; typ?: string; kid?: string };
  let claims: Claims;
  try {
    header = JSON.parse(Buffer.from(parts[0]!, "base64url").toString("utf8"));
    claims = JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf8"));
  } catch {
    throw new Error("invalid token");
  }
  if (header.alg !== "EdDSA" || header.typ !== "at+jwt" || typeof header.kid !== "string") throw new Error("invalid token");
  const key = await keys.get(header.kid);
  if (!key) throw new Error("invalid token");
  let ok = false;
  try {
    ok = verifySignature(null, Buffer.from(parts[0] + "." + parts[1]), key, Buffer.from(parts[2]!, "base64url"));
  } catch {
    // a signature of the wrong length, say
  }
  if (!ok) throw new Error("invalid token");
  if (claims.iss !== core) throw new Error("token from another issuer");
  if (claims.aud !== resource) throw new Error("token for another app");
  if (typeof claims.exp !== "number" || Math.floor(now / 1000) >= claims.exp) throw new Error("token expired");
  return claims;
}
