import express from 'express';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { loadConfig, googleRedirectUri } from './config.js';
import { openDatabase, pruneExpired } from './db.js';
import { PantryStore } from './pantry.js';
import { OAuthStore } from './oauth/store.js';
import { createOAuthRouter, requireBearerAuth } from './oauth/router.js';
import { createPantryMcpServer } from './mcp/server.js';

const config = loadConfig();
const db = openDatabase(config.dataDir);
const pantry = new PantryStore(db);
const oauthStore = new OAuthStore(db);

const app = express();
app.set('trust proxy', true);
app.use(express.json({ limit: '4mb' }));
app.use(express.urlencoded({ extended: true }));

app.use((req, _res, next) => {
  if (config.logLevel === 'debug' || req.path !== '/healthz') {
    console.log(`[http] ${req.method} ${req.path}`);
  }
  next();
});

app.get('/healthz', (_req, res) => res.json({ status: 'ok' }));

app.get('/', (_req, res) => {
  res.type('html').send(`<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Pantry Inventory MCP</title>
<style>body{font:16px/1.6 system-ui,sans-serif;margin:0;padding:3rem 1.25rem;background:#faf9f7;color:#1f1d1b}
main{max-width:34rem;margin:0 auto}h1{font-size:1.4rem;margin:0 0 .5rem}
code{background:#ecebe8;padding:.15rem .4rem;border-radius:.25rem;font-size:.9em}
p{color:#4a4642}</style></head><body><main>
<h1>Pantry Inventory MCP</h1>
<p>A Model Context Protocol server that tracks pantry stock and its history.</p>
<p>Add it to an MCP client as a custom connector using <code>${config.publicUrl}/mcp</code>.
Sign-in is Google OAuth, restricted to an allowlist.</p>
</main></body></html>`);
});

app.use(createOAuthRouter(config, oauthStore));

// Stateless transport: every request gets a fresh server instance, so there is no
// cross-request session state to lose when Fly stops or restarts the machine.
app.post('/mcp', requireBearerAuth(config, oauthStore), async (req, res) => {
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  const server = createPantryMcpServer(pantry, req.identity!.user_email);

  res.on('close', () => {
    void transport.close();
    void server.close();
  });

  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (error) {
    console.error('[mcp] request failed:', error);
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: '2.0',
        error: { code: -32603, message: 'Internal server error' },
        id: null
      });
    }
  }
});

// Server-initiated streams and explicit session teardown only mean something in
// stateful mode; say so rather than failing opaquely.
for (const method of ['get', 'delete'] as const) {
  app[method]('/mcp', requireBearerAuth(config, oauthStore), (_req, res) => {
    res.status(405).json({
      jsonrpc: '2.0',
      error: { code: -32000, message: 'This server is stateless; use POST /mcp.' },
      id: null
    });
  });
}

app.use((_req, res) => res.status(404).json({ error: 'not_found' }));

setInterval(() => {
  try {
    pruneExpired(db);
  } catch (error) {
    console.error('[maintenance] prune failed:', error);
  }
}, 15 * 60 * 1000).unref();

const server = app.listen(config.port, '0.0.0.0', () => {
  console.log(`[startup] pantry MCP listening on :${config.port}`);
  console.log(`[startup] public url        ${config.publicUrl}`);
  console.log(`[startup] mcp endpoint      ${config.publicUrl}/mcp`);
  console.log(`[startup] google redirect   ${googleRedirectUri(config)}`);
  console.log(`[startup] allowlisted       ${config.allowedEmails.length} email(s)`);
  if (config.allowedEmails.length === 0) {
    console.warn('[startup] ALLOWED_EMAILS is empty — every sign-in will be rejected.');
  }
});

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    console.log(`[shutdown] ${signal} received`);
    server.close(() => {
      db.close();
      process.exit(0);
    });
  });
}
