import type { DatabaseSync } from 'node:sqlite';
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';

export interface OAuthClient {
  client_id: string;
  client_secret: string | null;
  client_name: string | null;
  redirect_uris: string[];
  token_endpoint_auth_method: string;
  grant_types: string[];
  response_types: string[];
  scope: string | null;
}

export interface PendingAuthorization {
  state: string;
  client_id: string;
  redirect_uri: string;
  client_state: string | null;
  code_challenge: string;
  code_challenge_method: string;
  scope: string | null;
  resource: string | null;
}

export interface TokenIdentity {
  client_id: string;
  user_sub: string;
  user_email: string;
  scope: string | null;
}

function token(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function constantTimeEquals(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

export class OAuthStore {
  constructor(private readonly db: DatabaseSync) {}

  // ------------------------------------------------------------------ clients

  registerClient(input: {
    client_name?: string;
    redirect_uris: string[];
    token_endpoint_auth_method?: string;
    grant_types?: string[];
    response_types?: string[];
    scope?: string;
  }): OAuthClient & { client_secret_expires_at: number; client_id_issued_at: number } {
    const clientId = randomUUID();
    const authMethod = input.token_endpoint_auth_method ?? 'none';
    // Public clients (PKCE-only, the shape Claude uses) get no secret at all.
    const clientSecret = authMethod === 'none' ? null : token(32);
    const issuedAt = Math.floor(Date.now() / 1000);

    const record: OAuthClient = {
      client_id: clientId,
      client_secret: clientSecret,
      client_name: input.client_name ?? null,
      redirect_uris: input.redirect_uris,
      token_endpoint_auth_method: authMethod,
      grant_types: input.grant_types ?? ['authorization_code', 'refresh_token'],
      response_types: input.response_types ?? ['code'],
      scope: input.scope ?? null
    };

    this.db
      .prepare(
        `INSERT INTO oauth_clients
           (client_id, client_secret, client_name, redirect_uris,
            token_endpoint_auth_method, grant_types, response_types, scope, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        record.client_id,
        record.client_secret,
        record.client_name,
        JSON.stringify(record.redirect_uris),
        record.token_endpoint_auth_method,
        JSON.stringify(record.grant_types),
        JSON.stringify(record.response_types),
        record.scope,
        Date.now()
      );

    return { ...record, client_id_issued_at: issuedAt, client_secret_expires_at: 0 };
  }

  getClient(clientId: string): OAuthClient | undefined {
    const row = this.db
      .prepare('SELECT * FROM oauth_clients WHERE client_id = ?')
      .get(clientId) as Record<string, string> | undefined;
    if (!row) return undefined;
    return {
      client_id: row.client_id,
      client_secret: row.client_secret ?? null,
      client_name: row.client_name ?? null,
      redirect_uris: JSON.parse(row.redirect_uris),
      token_endpoint_auth_method: row.token_endpoint_auth_method,
      grant_types: JSON.parse(row.grant_types),
      response_types: JSON.parse(row.response_types),
      scope: row.scope ?? null
    };
  }

  // ---------------------------------------------- pending Google round-trip

  createPendingAuthorization(input: Omit<PendingAuthorization, 'state'>): string {
    const state = token(24);
    this.db
      .prepare(
        `INSERT INTO oauth_authorizations
           (state, client_id, redirect_uri, client_state, code_challenge,
            code_challenge_method, scope, resource, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        state, input.client_id, input.redirect_uri, input.client_state,
        input.code_challenge, input.code_challenge_method, input.scope, input.resource, Date.now()
      );
    return state;
  }

  /** Single use: the pending row is removed as it is read, so a replayed Google callback fails. */
  consumePendingAuthorization(state: string): PendingAuthorization | undefined {
    const row = this.db
      .prepare('SELECT * FROM oauth_authorizations WHERE state = ?')
      .get(state) as PendingAuthorization | undefined;
    if (!row) return undefined;
    this.db.prepare('DELETE FROM oauth_authorizations WHERE state = ?').run(state);
    return row;
  }

  // ------------------------------------------------------- authorization code

  createAuthorizationCode(input: {
    client_id: string;
    redirect_uri: string;
    code_challenge: string;
    code_challenge_method: string;
    scope: string | null;
    user_sub: string;
    user_email: string;
    ttlSeconds: number;
  }): string {
    const code = token(32);
    this.db
      .prepare(
        `INSERT INTO oauth_codes
           (code, client_id, redirect_uri, code_challenge, code_challenge_method,
            scope, user_sub, user_email, expires_at, consumed)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`
      )
      .run(
        code, input.client_id, input.redirect_uri, input.code_challenge,
        input.code_challenge_method, input.scope, input.user_sub, input.user_email,
        Date.now() + input.ttlSeconds * 1000
      );
    return code;
  }

  consumeAuthorizationCode(code: string):
    | { ok: true; value: { client_id: string; redirect_uri: string; code_challenge: string;
        code_challenge_method: string; scope: string | null; user_sub: string; user_email: string } }
    | { ok: false; reason: string } {
    const row = this.db.prepare('SELECT * FROM oauth_codes WHERE code = ?').get(code) as
      | Record<string, string | number>
      | undefined;
    if (!row) return { ok: false, reason: 'unknown authorization code' };

    this.db.prepare('DELETE FROM oauth_codes WHERE code = ?').run(code);

    if (row.consumed === 1) return { ok: false, reason: 'authorization code already used' };
    if ((row.expires_at as number) < Date.now()) return { ok: false, reason: 'authorization code expired' };

    return {
      ok: true,
      value: {
        client_id: row.client_id as string,
        redirect_uri: row.redirect_uri as string,
        code_challenge: row.code_challenge as string,
        code_challenge_method: row.code_challenge_method as string,
        scope: (row.scope as string) ?? null,
        user_sub: row.user_sub as string,
        user_email: row.user_email as string
      }
    };
  }

  // -------------------------------------------------------------------- tokens

  issueTokens(identity: TokenIdentity, accessTtlSeconds: number): {
    access_token: string; refresh_token: string; expires_in: number;
  } {
    const accessToken = token(32);
    const refreshToken = token(32);
    const now = Date.now();

    const insert = this.db.prepare(
      `INSERT INTO oauth_tokens
         (token_hash, kind, client_id, user_sub, user_email, scope, expires_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    );
    insert.run(
      hash(accessToken), 'access', identity.client_id, identity.user_sub,
      identity.user_email, identity.scope, now + accessTtlSeconds * 1000, now
    );
    insert.run(
      hash(refreshToken), 'refresh', identity.client_id, identity.user_sub,
      identity.user_email, identity.scope, null, now
    );

    return { access_token: accessToken, refresh_token: refreshToken, expires_in: accessTtlSeconds };
  }

  lookupAccessToken(bearer: string): TokenIdentity | undefined {
    const row = this.db
      .prepare("SELECT * FROM oauth_tokens WHERE token_hash = ? AND kind = 'access'")
      .get(hash(bearer)) as Record<string, string | number> | undefined;
    if (!row) return undefined;
    if (row.expires_at !== null && (row.expires_at as number) < Date.now()) {
      this.db.prepare('DELETE FROM oauth_tokens WHERE token_hash = ?').run(row.token_hash as string);
      return undefined;
    }
    return {
      client_id: row.client_id as string,
      user_sub: row.user_sub as string,
      user_email: row.user_email as string,
      scope: (row.scope as string) ?? null
    };
  }

  /** Refresh tokens rotate: the presented one is destroyed as a new pair is minted. */
  consumeRefreshToken(refreshToken: string): TokenIdentity | undefined {
    const tokenHash = hash(refreshToken);
    const row = this.db
      .prepare("SELECT * FROM oauth_tokens WHERE token_hash = ? AND kind = 'refresh'")
      .get(tokenHash) as Record<string, string | number> | undefined;
    if (!row) return undefined;
    this.db.prepare('DELETE FROM oauth_tokens WHERE token_hash = ?').run(tokenHash);
    return {
      client_id: row.client_id as string,
      user_sub: row.user_sub as string,
      user_email: row.user_email as string,
      scope: (row.scope as string) ?? null
    };
  }

  revokeToken(value: string): void {
    this.db.prepare('DELETE FROM oauth_tokens WHERE token_hash = ?').run(hash(value));
  }
}

export function verifyPkce(verifier: string, challenge: string, method: string): boolean {
  if (method !== 'S256') return false;
  const computed = createHash('sha256').update(verifier).digest('base64url');
  return constantTimeEquals(computed, challenge);
}
