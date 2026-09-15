import type { Config } from '../config.js';
import { googleRedirectUri } from '../config.js';

const GOOGLE_AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';

export interface GoogleIdentity {
  sub: string;
  email: string;
  emailVerified: boolean;
  name?: string;
}

export function buildGoogleAuthorizeUrl(config: Config, state: string): string {
  const url = new URL(GOOGLE_AUTH_ENDPOINT);
  url.searchParams.set('client_id', config.googleClientId);
  url.searchParams.set('redirect_uri', googleRedirectUri(config));
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', 'openid email profile');
  url.searchParams.set('state', state);
  // Always show the chooser: a shared device should not silently reuse a session.
  url.searchParams.set('prompt', 'select_account');
  return url.toString();
}

/**
 * Exchange the Google authorization code for an id_token and read the identity out of it.
 *
 * The id_token arrives over a direct, TLS-authenticated, client-authenticated call to
 * Google's token endpoint, so per OIDC Core 3.1.3.7 the signature need not be re-verified
 * here — there is no untrusted hop for a forged token to enter through.
 */
export async function exchangeGoogleCode(config: Config, code: string): Promise<GoogleIdentity> {
  const response = await fetch(GOOGLE_TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: config.googleClientId,
      client_secret: config.googleClientSecret,
      redirect_uri: googleRedirectUri(config),
      grant_type: 'authorization_code'
    })
  });

  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`Google token exchange failed (${response.status}): ${detail.slice(0, 500)}`);
  }

  const payload = (await response.json()) as { id_token?: string };
  if (!payload.id_token) {
    throw new Error('Google token response did not include an id_token.');
  }

  const claims = decodeJwtPayload(payload.id_token);

  if (claims.aud !== config.googleClientId) {
    throw new Error('Google id_token audience does not match the configured client id.');
  }
  if (claims.iss !== 'https://accounts.google.com' && claims.iss !== 'accounts.google.com') {
    throw new Error('Google id_token issuer is not Google.');
  }
  if (typeof claims.exp === 'number' && claims.exp * 1000 < Date.now()) {
    throw new Error('Google id_token has already expired.');
  }
  if (!claims.sub || !claims.email) {
    throw new Error('Google id_token is missing sub or email.');
  }

  return {
    sub: String(claims.sub),
    email: String(claims.email),
    emailVerified: claims.email_verified === true || claims.email_verified === 'true',
    name: claims.name ? String(claims.name) : undefined
  };
}

function decodeJwtPayload(jwt: string): Record<string, unknown> {
  const parts = jwt.split('.');
  if (parts.length !== 3) throw new Error('Malformed id_token.');
  return JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')) as Record<string, unknown>;
}
