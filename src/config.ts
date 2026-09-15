const DEFAULT_GOOGLE_CLIENT_ID = '88880879927-bp3hcalrh905sc2d94mgtfjc3f124o90.apps.googleusercontent.com';

function required(name: string, value: string | undefined): string {
  if (!value || value.trim() === '') {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value.trim();
}

function stripTrailingSlash(url: string): string {
  return url.replace(/\/+$/, '');
}

/**
 * Comma or whitespace separated list of Google account emails permitted to sign in.
 * Comparison is case-insensitive. An empty list locks everybody out on purpose —
 * we would rather fail closed than expose the pantry to any Google account.
 */
function parseAllowlist(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(/[,\s]+/)
    .map(entry => entry.trim().toLowerCase())
    .filter(entry => entry.length > 0);
}

export interface Config {
  port: number;
  publicUrl: string;
  dataDir: string;
  googleClientId: string;
  googleClientSecret: string;
  allowedEmails: string[];
  /** Lifetime of an issued MCP access token, in seconds. */
  accessTokenTtlSeconds: number;
  /** Lifetime of an authorization code, in seconds. */
  authCodeTtlSeconds: number;
  logLevel: 'debug' | 'info';
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const publicUrl = stripTrailingSlash(
    env.PUBLIC_URL?.trim() || `http://localhost:${env.PORT ?? '8080'}`
  );

  return {
    port: Number.parseInt(env.PORT ?? '8080', 10),
    publicUrl,
    dataDir: env.DATA_DIR?.trim() || '/data',
    googleClientId: env.GOOGLE_CLIENT_ID?.trim() || DEFAULT_GOOGLE_CLIENT_ID,
    googleClientSecret: required('GOOGLE_OAUTH_SECRET', env.GOOGLE_OAUTH_SECRET),
    allowedEmails: parseAllowlist(env.ALLOWED_EMAILS),
    accessTokenTtlSeconds: Number.parseInt(env.ACCESS_TOKEN_TTL ?? '2592000', 10),
    authCodeTtlSeconds: 300,
    logLevel: env.LOG_LEVEL === 'debug' ? 'debug' : 'info'
  };
}

export function googleRedirectUri(config: Config): string {
  return `${config.publicUrl}/auth/google/callback`;
}
