import { Router, type Request, type Response, type NextFunction } from 'express';
import type { Config } from '../config.js';
import { OAuthStore, verifyPkce, constantTimeEquals, type TokenIdentity } from './store.js';
import { buildGoogleAuthorizeUrl, exchangeGoogleCode } from './google.js';

export const MCP_SCOPE = 'pantry';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      identity?: TokenIdentity;
    }
  }
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, ch =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]!
  );
}

function page(title: string, body: string): string {
  return `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
  body { font: 16px/1.5 system-ui, sans-serif; margin: 0; padding: 2.5rem 1.25rem;
         background: #faf9f7; color: #1f1d1b; }
  main { max-width: 32rem; margin: 0 auto; }
  h1 { font-size: 1.35rem; margin: 0 0 .75rem; }
  p { margin: 0 0 .75rem; color: #4a4642; }
  code { background: #ecebe8; padding: .1rem .35rem; border-radius: .25rem; font-size: .9em; }
</style></head><body><main>${body}</main></body></html>`;
}

function redirectWithError(res: Response, redirectUri: string, state: string | null, error: string, description: string): void {
  const url = new URL(redirectUri);
  url.searchParams.set('error', error);
  url.searchParams.set('error_description', description);
  if (state) url.searchParams.set('state', state);
  res.redirect(url.toString());
}

/**
 * The MCP server is its own OAuth 2.1 authorization server and federates the actual
 * sign-in to Google. Claude needs an AS that supports dynamic client registration and
 * RFC 9728 resource metadata; Google supports neither, so it sits upstream as the
 * identity provider only.
 */
export function createOAuthRouter(config: Config, store: OAuthStore): Router {
  const router = Router();
  const issuer = config.publicUrl;
  const resourceUrl = `${issuer}/mcp`;

  const protectedResourceMetadata = {
    resource: resourceUrl,
    authorization_servers: [issuer],
    scopes_supported: [MCP_SCOPE],
    bearer_methods_supported: ['header'],
    resource_name: 'Pantry Inventory MCP'
  };

  const authorizationServerMetadata = {
    issuer,
    authorization_endpoint: `${issuer}/authorize`,
    token_endpoint: `${issuer}/token`,
    registration_endpoint: `${issuer}/register`,
    revocation_endpoint: `${issuer}/revoke`,
    scopes_supported: [MCP_SCOPE],
    response_types_supported: ['code'],
    response_modes_supported: ['query'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    token_endpoint_auth_methods_supported: ['none', 'client_secret_post', 'client_secret_basic'],
    code_challenge_methods_supported: ['S256']
  };

  // RFC 9728 allows the metadata to hang off the resource path as well as the root;
  // clients differ on which they probe, so serve both.
  for (const path of ['/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/mcp']) {
    router.get(path, (_req, res) => res.json(protectedResourceMetadata));
  }
  for (const path of [
    '/.well-known/oauth-authorization-server',
    '/.well-known/oauth-authorization-server/mcp',
    '/.well-known/openid-configuration'
  ]) {
    router.get(path, (_req, res) => res.json(authorizationServerMetadata));
  }

  // ------------------------------------------------- dynamic client registration

  router.post('/register', (req, res) => {
    const body = req.body ?? {};
    const redirectUris: unknown = body.redirect_uris;

    if (!Array.isArray(redirectUris) || redirectUris.length === 0) {
      return res.status(400).json({
        error: 'invalid_redirect_uri',
        error_description: 'redirect_uris must be a non-empty array.'
      });
    }

    for (const uri of redirectUris) {
      if (typeof uri !== 'string') {
        return res.status(400).json({ error: 'invalid_redirect_uri', error_description: 'redirect_uris must be strings.' });
      }
      let parsed: URL;
      try {
        parsed = new URL(uri);
      } catch {
        return res.status(400).json({ error: 'invalid_redirect_uri', error_description: `Not a valid URL: ${uri}` });
      }
      const isLoopback = parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1' || parsed.hostname === '::1';
      // OAuth 2.1: https everywhere, with loopback http kept for native/dev clients.
      if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && isLoopback)) {
        return res.status(400).json({
          error: 'invalid_redirect_uri',
          error_description: `redirect_uri must use https (or http on loopback): ${uri}`
        });
      }
    }

    const client = store.registerClient({
      client_name: typeof body.client_name === 'string' ? body.client_name : undefined,
      redirect_uris: redirectUris as string[],
      token_endpoint_auth_method:
        typeof body.token_endpoint_auth_method === 'string' ? body.token_endpoint_auth_method : 'none',
      grant_types: Array.isArray(body.grant_types) ? body.grant_types : undefined,
      response_types: Array.isArray(body.response_types) ? body.response_types : undefined,
      scope: typeof body.scope === 'string' ? body.scope : MCP_SCOPE
    });

    return res.status(201).json({
      client_id: client.client_id,
      ...(client.client_secret ? { client_secret: client.client_secret } : {}),
      client_id_issued_at: client.client_id_issued_at,
      client_secret_expires_at: client.client_secret_expires_at,
      client_name: client.client_name,
      redirect_uris: client.redirect_uris,
      grant_types: client.grant_types,
      response_types: client.response_types,
      token_endpoint_auth_method: client.token_endpoint_auth_method,
      scope: client.scope
    });
  });

  // ------------------------------------------------------------------ authorize

  router.get('/authorize', (req, res) => {
    const q = req.query as Record<string, string | undefined>;
    const clientId = q.client_id;
    const redirectUri = q.redirect_uri;

    if (!clientId || !redirectUri) {
      return res.status(400).send(page('Invalid request', '<h1>Invalid request</h1><p>Missing <code>client_id</code> or <code>redirect_uri</code>.</p>'));
    }

    const client = store.getClient(clientId);
    if (!client) {
      return res.status(400).send(page('Unknown client', '<h1>Unknown client</h1><p>This client is not registered with the pantry server.</p>'));
    }
    // Never redirect to an address the client did not pre-register — that is the
    // open-redirect hole every OAuth AS has to close.
    if (!client.redirect_uris.includes(redirectUri)) {
      return res.status(400).send(page('Invalid redirect URI', '<h1>Invalid redirect URI</h1><p>This redirect URI is not registered for this client.</p>'));
    }

    const state = q.state ?? null;

    if (q.response_type !== 'code') {
      return redirectWithError(res, redirectUri, state, 'unsupported_response_type', 'Only response_type=code is supported.');
    }
    if (!q.code_challenge) {
      return redirectWithError(res, redirectUri, state, 'invalid_request', 'PKCE is required: send code_challenge.');
    }
    if ((q.code_challenge_method ?? 'plain') !== 'S256') {
      return redirectWithError(res, redirectUri, state, 'invalid_request', 'code_challenge_method must be S256.');
    }

    const pendingState = store.createPendingAuthorization({
      client_id: clientId,
      redirect_uri: redirectUri,
      client_state: state,
      code_challenge: q.code_challenge,
      code_challenge_method: 'S256',
      scope: q.scope ?? MCP_SCOPE,
      resource: q.resource ?? null
    });

    return res.redirect(buildGoogleAuthorizeUrl(config, pendingState));
  });

  // ------------------------------------------------------------ Google callback

  router.get('/auth/google/callback', async (req, res) => {
    const q = req.query as Record<string, string | undefined>;

    if (!q.state) {
      return res.status(400).send(page('Sign-in failed', '<h1>Sign-in failed</h1><p>Missing state parameter.</p>'));
    }

    const pending = store.consumePendingAuthorization(q.state);
    if (!pending) {
      return res
        .status(400)
        .send(page('Sign-in expired', '<h1>Sign-in expired</h1><p>This login link has already been used or has expired. Start the connection again from your Claude client.</p>'));
    }

    if (q.error) {
      return redirectWithError(res, pending.redirect_uri, pending.client_state, q.error, q.error_description ?? 'Google sign-in was cancelled.');
    }
    if (!q.code) {
      return redirectWithError(res, pending.redirect_uri, pending.client_state, 'invalid_request', 'Google did not return an authorization code.');
    }

    let identity;
    try {
      identity = await exchangeGoogleCode(config, q.code);
    } catch (error) {
      console.error('[oauth] Google token exchange failed:', error);
      return redirectWithError(res, pending.redirect_uri, pending.client_state, 'server_error', 'Could not complete Google sign-in.');
    }

    if (!identity.emailVerified) {
      return res
        .status(403)
        .send(page('Email not verified', `<h1>Email not verified</h1><p>Google reports <code>${escapeHtml(identity.email)}</code> as unverified, so it cannot be used to sign in.</p>`));
    }

    // Fail closed: an empty allowlist admits nobody rather than everybody.
    if (!config.allowedEmails.includes(identity.email.toLowerCase())) {
      console.warn(`[oauth] rejected sign-in for ${identity.email} (not on allowlist)`);
      return res
        .status(403)
        .send(page('Access denied', `<h1>Access denied</h1><p><code>${escapeHtml(identity.email)}</code> is not on the allowlist for this pantry.</p><p>Add it to the <code>ALLOWED_EMAILS</code> secret on the Fly app and try again.</p>`));
    }

    const code = store.createAuthorizationCode({
      client_id: pending.client_id,
      redirect_uri: pending.redirect_uri,
      code_challenge: pending.code_challenge,
      code_challenge_method: pending.code_challenge_method,
      scope: pending.scope,
      user_sub: identity.sub,
      user_email: identity.email.toLowerCase(),
      ttlSeconds: config.authCodeTtlSeconds
    });

    const target = new URL(pending.redirect_uri);
    target.searchParams.set('code', code);
    if (pending.client_state) target.searchParams.set('state', pending.client_state);
    return res.redirect(target.toString());
  });

  // ---------------------------------------------------------------------- token

  router.post('/token', (req, res) => {
    const body = (req.body ?? {}) as Record<string, string | undefined>;

    // Client credentials may arrive in the body or as HTTP Basic.
    let clientId = body.client_id;
    let clientSecret = body.client_secret;
    const authHeader = req.headers.authorization;
    if (authHeader?.startsWith('Basic ')) {
      const decoded = Buffer.from(authHeader.slice(6), 'base64').toString('utf8');
      const separator = decoded.indexOf(':');
      if (separator > -1) {
        clientId = decodeURIComponent(decoded.slice(0, separator));
        clientSecret = decodeURIComponent(decoded.slice(separator + 1));
      }
    }

    if (!clientId) {
      return res.status(400).json({ error: 'invalid_client', error_description: 'client_id is required.' });
    }
    const client = store.getClient(clientId);
    if (!client) {
      return res.status(401).json({ error: 'invalid_client', error_description: 'Unknown client.' });
    }
    if (client.client_secret) {
      if (!clientSecret || !constantTimeEquals(clientSecret, client.client_secret)) {
        return res.status(401).json({ error: 'invalid_client', error_description: 'Client authentication failed.' });
      }
    }

    if (body.grant_type === 'authorization_code') {
      if (!body.code) {
        return res.status(400).json({ error: 'invalid_request', error_description: 'code is required.' });
      }
      if (!body.code_verifier) {
        return res.status(400).json({ error: 'invalid_request', error_description: 'code_verifier is required.' });
      }

      const consumed = store.consumeAuthorizationCode(body.code);
      if (!consumed.ok) {
        return res.status(400).json({ error: 'invalid_grant', error_description: consumed.reason });
      }
      const grant = consumed.value;

      if (grant.client_id !== clientId) {
        return res.status(400).json({ error: 'invalid_grant', error_description: 'Code was issued to a different client.' });
      }
      if (body.redirect_uri && body.redirect_uri !== grant.redirect_uri) {
        return res.status(400).json({ error: 'invalid_grant', error_description: 'redirect_uri does not match the authorization request.' });
      }
      if (!verifyPkce(body.code_verifier, grant.code_challenge, grant.code_challenge_method)) {
        return res.status(400).json({ error: 'invalid_grant', error_description: 'PKCE verification failed.' });
      }

      const tokens = store.issueTokens(
        { client_id: clientId, user_sub: grant.user_sub, user_email: grant.user_email, scope: grant.scope },
        config.accessTokenTtlSeconds
      );
      return res.json({ token_type: 'Bearer', scope: grant.scope ?? MCP_SCOPE, ...tokens });
    }

    if (body.grant_type === 'refresh_token') {
      if (!body.refresh_token) {
        return res.status(400).json({ error: 'invalid_request', error_description: 'refresh_token is required.' });
      }
      const identity = store.consumeRefreshToken(body.refresh_token);
      if (!identity || identity.client_id !== clientId) {
        return res.status(400).json({ error: 'invalid_grant', error_description: 'Refresh token is not valid.' });
      }
      const tokens = store.issueTokens(identity, config.accessTokenTtlSeconds);
      return res.json({ token_type: 'Bearer', scope: identity.scope ?? MCP_SCOPE, ...tokens });
    }

    return res.status(400).json({
      error: 'unsupported_grant_type',
      error_description: 'Supported grant types: authorization_code, refresh_token.'
    });
  });

  router.post('/revoke', (req, res) => {
    const body = (req.body ?? {}) as Record<string, string | undefined>;
    if (body.token) store.revokeToken(body.token);
    return res.status(200).json({});
  });

  return router;
}

/**
 * Bearer auth for /mcp. On failure it points the client at the resource metadata
 * document, which is how an MCP client discovers where to go and log in.
 */
export function requireBearerAuth(config: Config, store: OAuthStore) {
  const challenge =
    `Bearer realm="pantry", resource_metadata="${config.publicUrl}/.well-known/oauth-protected-resource"`;

  return (req: Request, res: Response, next: NextFunction): void => {
    const header = req.headers.authorization;
    if (!header?.startsWith('Bearer ')) {
      res.setHeader('WWW-Authenticate', challenge);
      res.status(401).json({ error: 'unauthorized', error_description: 'A Bearer access token is required.' });
      return;
    }

    const identity = store.lookupAccessToken(header.slice(7).trim());
    if (!identity) {
      res.setHeader('WWW-Authenticate', `${challenge}, error="invalid_token"`);
      res.status(401).json({ error: 'invalid_token', error_description: 'Access token is invalid or expired.' });
      return;
    }

    req.identity = identity;
    next();
  };
}
