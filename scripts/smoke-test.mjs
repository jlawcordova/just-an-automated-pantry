/**
 * End-to-end smoke test: boots the server against a throwaway database, exercises the
 * OAuth surface, then drives every MCP tool over HTTP with a directly minted token.
 *
 * Run with: node --experimental-sqlite scripts/smoke-test.mjs
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

const PORT = 8137;
const BASE = `http://127.0.0.1:${PORT}`;
const dataDir = mkdtempSync(join(tmpdir(), 'pantry-smoke-'));

let passed = 0;
const failures = [];

function check(name, condition, detail) {
  if (condition) {
    passed += 1;
    console.log(`  ok   ${name}`);
  } else {
    failures.push(name);
    console.log(`  FAIL ${name}${detail ? ` — ${JSON.stringify(detail)}` : ''}`);
  }
}

function section(title) {
  console.log(`\n${title}`);
}

const child = spawn(process.execPath, ['--experimental-sqlite', 'dist/index.js'], {
  env: {
    ...process.env,
    PORT: String(PORT),
    PUBLIC_URL: BASE,
    DATA_DIR: dataDir,
    GOOGLE_OAUTH_SECRET: 'smoke-test-secret',
    ALLOWED_EMAILS: 'hello@jlawcordova.com'
  },
  stdio: ['ignore', 'pipe', 'pipe']
});
const serverLog = [];
child.stdout.on('data', d => serverLog.push(d.toString()));
child.stderr.on('data', d => serverLog.push(d.toString()));

async function waitForServer() {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const res = await fetch(`${BASE}/healthz`);
      if (res.ok) return;
    } catch { /* not up yet */ }
    await new Promise(r => setTimeout(r, 250));
  }
  throw new Error(`Server never became healthy.\n${serverLog.join('')}`);
}

/** Streamable HTTP replies either as JSON or as a one-shot SSE stream. */
async function readMcpBody(res) {
  const text = await res.text();
  if ((res.headers.get('content-type') ?? '').includes('text/event-stream')) {
    const line = text.split('\n').find(l => l.startsWith('data:'));
    return line ? JSON.parse(line.slice(5).trim()) : null;
  }
  return text ? JSON.parse(text) : null;
}

let rpcId = 0;
async function callTool(token, name, args) {
  rpcId += 1;
  const res = await fetch(`${BASE}/mcp`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream'
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: rpcId, method: 'tools/call', params: { name, arguments: args } })
  });
  const body = await readMcpBody(res);
  if (body?.error) throw new Error(`${name} -> ${JSON.stringify(body.error)}`);
  const content = body?.result?.content?.[0]?.text;
  return { isError: body?.result?.isError === true, data: content ? JSON.parse(content) : null };
}

try {
  await waitForServer();

  // ---------------------------------------------------------------- discovery
  section('OAuth discovery');
  const prm = await (await fetch(`${BASE}/.well-known/oauth-protected-resource`)).json();
  check('protected-resource metadata names the MCP resource', prm.resource === `${BASE}/mcp`, prm);
  check('protected-resource metadata points at this issuer', prm.authorization_servers?.[0] === BASE, prm);

  const suffixed = await fetch(`${BASE}/.well-known/oauth-protected-resource/mcp`);
  check('resource metadata also served on the path-suffixed form', suffixed.status === 200);

  const asm = await (await fetch(`${BASE}/.well-known/oauth-authorization-server`)).json();
  check('AS metadata advertises the endpoints', asm.authorization_endpoint === `${BASE}/authorize` && asm.token_endpoint === `${BASE}/token` && asm.registration_endpoint === `${BASE}/register`, asm);
  check('AS metadata requires S256 PKCE only', JSON.stringify(asm.code_challenge_methods_supported) === '["S256"]', asm);

  // ------------------------------------------------------------ registration
  section('Dynamic client registration');
  const regRes = await fetch(`${BASE}/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ client_name: 'Smoke Test', redirect_uris: ['https://claude.ai/api/mcp/auth_callback'] })
  });
  const client = await regRes.json();
  check('registration returns 201 with a client_id', regRes.status === 201 && typeof client.client_id === 'string', client);
  check('public client gets no secret', client.client_secret === undefined, client);

  const badReg = await fetch(`${BASE}/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ redirect_uris: ['http://evil.example.com/cb'] })
  });
  check('non-loopback http redirect_uri is rejected', badReg.status === 400);

  // --------------------------------------------------------------- authorize
  section('Authorization endpoint');
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  const authUrl = `${BASE}/authorize?response_type=code&client_id=${client.client_id}` +
    `&redirect_uri=${encodeURIComponent('https://claude.ai/api/mcp/auth_callback')}` +
    `&code_challenge=${challenge}&code_challenge_method=S256&state=xyz`;
  const authRes = await fetch(authUrl, { redirect: 'manual' });
  const location = authRes.headers.get('location') ?? '';
  check('authorize redirects to Google', authRes.status === 302 && location.startsWith('https://accounts.google.com/o/oauth2/v2/auth'), location.slice(0, 120));
  check('Google redirect carries the configured client id', location.includes('88880879927-bp3hcalrh905sc2d94mgtfjc3f124o90'), location.slice(0, 200));

  const unregistered = await fetch(
    `${BASE}/authorize?response_type=code&client_id=${client.client_id}` +
    `&redirect_uri=${encodeURIComponent('https://attacker.example/cb')}&code_challenge=${challenge}&code_challenge_method=S256`,
    { redirect: 'manual' }
  );
  check('unregistered redirect_uri is refused (no open redirect)', unregistered.status === 400);

  const noPkce = await fetch(
    `${BASE}/authorize?response_type=code&client_id=${client.client_id}` +
    `&redirect_uri=${encodeURIComponent('https://claude.ai/api/mcp/auth_callback')}`,
    { redirect: 'manual' }
  );
  check('missing PKCE is refused', (noPkce.headers.get('location') ?? '').includes('error=invalid_request'));

  // ---------------------------------------------------------- bearer required
  section('MCP endpoint auth');
  const anon = await fetch(`${BASE}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' })
  });
  check('unauthenticated MCP call is 401', anon.status === 401);
  check('401 advertises resource metadata for discovery',
    (anon.headers.get('www-authenticate') ?? '').includes('resource_metadata='), anon.headers.get('www-authenticate'));

  const badToken = await fetch(`${BASE}/mcp`, {
    method: 'POST',
    headers: { authorization: 'Bearer nope', 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' })
  });
  check('invalid token is 401', badToken.status === 401);

  // Mint a token straight into the store — the Google leg cannot run offline.
  const token = randomBytes(32).toString('base64url');
  const db = new DatabaseSync(join(dataDir, 'pantry.sqlite'));
  db.prepare(
    `INSERT INTO oauth_tokens (token_hash, kind, client_id, user_sub, user_email, scope, expires_at, created_at)
     VALUES (?, 'access', ?, 'smoke-sub', 'hello@jlawcordova.com', 'pantry', ?, ?)`
  ).run(createHash('sha256').update(token).digest('hex'), client.client_id, Date.now() + 3600_000, Date.now());
  db.close();

  // ------------------------------------------------------------------- tools
  section('MCP protocol');
  const initRes = await fetch(`${BASE}/mcp`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({
      jsonrpc: '2.0', id: 100, method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'smoke', version: '1' } }
    })
  });
  const initBody = await readMcpBody(initRes);
  check('initialize succeeds', initBody?.result?.serverInfo?.name === 'pantry-inventory', initBody?.result?.serverInfo);
  check('server sends usage instructions', typeof initBody?.result?.instructions === 'string' && initBody.result.instructions.length > 50);

  const listRes = await fetch(`${BASE}/mcp`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 101, method: 'tools/list' })
  });
  const tools = (await readMcpBody(listRes))?.result?.tools ?? [];
  const names = tools.map(t => t.name).sort();
  const expected = ['adjust_pantry_stock', 'get_item_history', 'get_low_stock_items', 'get_pantry_state',
    'get_price_history', 'list_items', 'list_locations', 'record_pantry_snapshot', 'record_prices', 'upsert_item'].sort();
  check('all ten tools are exposed', JSON.stringify(names) === JSON.stringify(expected), names);
  check('stateless mode: tools/list works without a session id', listRes.headers.get('mcp-session-id') === null);

  section('Pantry behaviour');
  const photoBatch = randomUUID();
  const snapshot = await callTool(token, 'record_pantry_snapshot', {
    location: 'pantry',
    source: 'photo',
    batch_id: photoBatch,
    entries: [
      { product_name: 'Diced Tomatoes', brand: "Hunt's", quantity: 4, unit: 'can' },
      { product_name: 'Spaghetti', brand: 'Barilla', quantity: 2, unit: 'box' },
      { product_name: 'Olive Oil', brand: 'Bertolli', quantity: 1, unit: 'bottle' }
    ]
  });
  check('snapshot creates three items', snapshot.data.applied.length === 3, snapshot.data);
  check('snapshot records quantity_before of 0 for new stock', snapshot.data.applied.every(a => a.quantity_before === 0));

  const replay = await callTool(token, 'record_pantry_snapshot', {
    location: 'pantry', source: 'photo', batch_id: photoBatch,
    entries: [{ product_name: 'Diced Tomatoes', brand: "Hunt's", quantity: 4, unit: 'can' }]
  });
  check('replaying a batch_id is idempotent, not additive', replay.data.replayed === true && replay.data.applied.length === 3, replay.data);

  const state1 = await callTool(token, 'get_pantry_state', {});
  check('state lists the three stocked items', state1.data.item_count === 3, state1.data);
  check('state reports the tomato count', state1.data.items.find(i => i.product_name === 'Diced Tomatoes')?.quantity === 4);

  const eaten = await callTool(token, 'adjust_pantry_stock', {
    source: 'consumption', note: 'pasta night',
    entries: [{ product_name: 'Diced Tomatoes', brand: "Hunt's", delta: -2 }]
  });
  check('consumption applies a negative delta', eaten.data.applied[0].quantity_after === 2, eaten.data);

  const overdraw = await callTool(token, 'adjust_pantry_stock', {
    entries: [{ product_name: 'Olive Oil', brand: 'Bertolli', delta: -5 }]
  });
  check('stock is clamped at zero, never negative', overdraw.data.applied[0].quantity_after === 0 && overdraw.data.applied[0].clamped_at_zero === true, overdraw.data);

  const thresholds = await callTool(token, 'upsert_item', {
    product_name: 'Diced Tomatoes', brand: "Hunt's", min_quantity: 3, target_quantity: 8
  });
  check('upsert edits rather than duplicates an existing item', thresholds.data.created === false, thresholds.data);

  const low = await callTool(token, 'get_low_stock_items', {});
  check('low stock picks up the item under threshold', low.data.items.length === 1 && low.data.items[0].product_name === 'Diced Tomatoes', low.data);
  check('low stock suggests an order quantity from the target', low.data.items[0].suggested_order_quantity === 6, low.data.items[0]);

  const history = await callTool(token, 'get_item_history', { product_name: 'Diced Tomatoes', brand: "Hunt's" });
  check('history has both the snapshot and the consumption', history.data.events.length === 2, history.data.summary);
  check('history totals the decrease', history.data.summary.total_decrease === 2, history.data.summary);
  check('history reports current quantity', history.data.current_quantity === 2, history.data);

  const prices = await callTool(token, 'record_prices', {
    store: 'SM Supermarket', currency: 'PHP', observed_on: '2026-09-01',
    entries: [{ product_name: 'Diced Tomatoes', brand: "Hunt's", price: 52.5 }]
  });
  check('price observation is recorded', prices.data.recorded[0].price === 52.5, prices.data);

  await callTool(token, 'record_prices', {
    store: 'SM Supermarket', currency: 'PHP', observed_on: '2026-09-14',
    entries: [{ product_name: 'Diced Tomatoes', brand: "Hunt's", price: 61 }]
  });
  const priceHistory = await callTool(token, 'get_price_history', { product_name: 'Diced Tomatoes', brand: "Hunt's" });
  check('price history tracks both observations', priceHistory.data.summary.observations === 2, priceHistory.data.summary);
  check('price history computes min and max', priceHistory.data.summary.min === 52.5 && priceHistory.data.summary.max === 61, priceHistory.data.summary);

  section('Ambiguity and error handling');
  await callTool(token, 'upsert_item', { product_name: 'Spaghetti', brand: 'San Remo', unit: 'box' });
  const ambiguous = await callTool(token, 'get_item_history', { product_name: 'Spaghetti' });
  check('a name matching two brands is refused, not guessed', ambiguous.isError === true, ambiguous.data);
  check('the refusal lists the candidate brands', Array.isArray(ambiguous.data.candidates) && ambiguous.data.candidates.length === 2, ambiguous.data);

  const strict = await callTool(token, 'adjust_pantry_stock', {
    create_missing_items: false,
    entries: [{ product_name: 'Nonexistent Thing', delta: 1 }]
  });
  check('create_missing_items: false refuses unknown products', strict.isError === true, strict.data);

  section('Whole-shelf snapshot');
  await callTool(token, 'record_pantry_snapshot', {
    location: 'fridge', entries: [{ product_name: 'Milk', brand: 'Nestle', quantity: 2, unit: 'carton' }]
  });
  await callTool(token, 'record_pantry_snapshot', {
    location: 'fridge', entries: [{ product_name: 'Butter', brand: 'Anchor', quantity: 1, unit: 'pack' }]
  });
  const sweep = await callTool(token, 'record_pantry_snapshot', {
    location: 'fridge', mark_missing_as_zero: true,
    entries: [{ product_name: 'Milk', brand: 'Nestle', quantity: 1, unit: 'carton' }]
  });
  check('mark_missing_as_zero clears what is no longer on the shelf',
    sweep.data.zeroed_because_absent.length === 1 && sweep.data.zeroed_because_absent[0].product_name === 'Butter', sweep.data);
  check('mark_missing_as_zero leaves other locations alone',
    (await callTool(token, 'get_pantry_state', { location: 'pantry' })).data.item_count === 2);

  const locations = await callTool(token, 'list_locations', {});
  check('both locations are listed', locations.data.locations.length === 2, locations.data);

  section(`\n${passed} passed, ${failures.length} failed`);
  if (failures.length > 0) {
    console.log('Failed checks:');
    for (const f of failures) console.log(`  - ${f}`);
  }
} catch (error) {
  console.error('\nSmoke test crashed:', error);
  console.error(serverLog.join(''));
  process.exitCode = 1;
} finally {
  child.kill('SIGTERM');
  rmSync(dataDir, { recursive: true, force: true });
}

if (failures.length > 0) process.exitCode = 1;
