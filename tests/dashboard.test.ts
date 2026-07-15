import { describe, expect, it } from 'vitest';
import { graphResponseMatchesSelection } from '../src/dashboard/page';
import type { Env } from '../src/env';
import worker from '../src/index';

const env = {
  DASHBOARD_PASSWORD: 'dashboard-secret',
} as Env;
const readOnlyEnv = {
  DASHBOARD_PASSWORD: 'dashboard-secret',
  DASHBOARD_READ_ONLY: 'true',
} as Env;

function request(path: string, init?: RequestInit): Request {
  return new Request(`https://example.com${path}`, init);
}

describe('graphResponseMatchesSelection', () => {
  it('rejects an old graph response after the entity selection changes', () => {
    expect(graphResponseMatchesSelection('user', 'old-user', 'user', 'new-user')).toBe(false);
    expect(graphResponseMatchesSelection('user', 'new-user', 'user', 'new-user')).toBe(true);
  });
});

describe('GET /dashboard', () => {
  it('renders read-only controls and synchronized graph guidance in the remote preview', async () => {
    const response = await worker.fetch(request('/dashboard', {
      headers: { 'x-dashboard-password': 'dashboard-secret' },
    }), readOnlyEnv);
    const html = await response.text();

    expect(response.status).toBe(200);
    expect(html).toContain('Remote read-only preview');
    expect(html).toContain('const readonly = true;');
    expect(html).toContain("document.getElementById('alias-button').disabled = true;");
    expect(html).toContain("document.getElementById('deduplicate-button').disabled = true;");
    expect(html).toContain("document.querySelectorAll('#import-form input, #import-form select, #import-form textarea, #import-form button')");
    expect(html).toContain("if (state.currentView === 'graph') await loadGraph();");
    expect(html).toContain('Select the corresponding user entity to view its graph.');
    expect(html).toContain('id="graph-status" class="muted" aria-live="polite"');
  });

  it('returns an Unauthorized login form when the dashboard password header is missing or wrong', async () => {
    for (const init of [undefined, { headers: { 'x-dashboard-password': 'wrong-password' } }]) {
      const response = await worker.fetch(request('/dashboard', init), env);

      expect(response.status).toBe(401);
      expect(response.headers.get('Content-Type')).toContain('text/html');
      await expect(response.text()).resolves.toContain('action="/dashboard/login"');
    }
  });

  it('does not accept the configured password from the query string', async () => {
    for (const path of ['/dashboard?password=wrong-password', '/dashboard?password=dashboard-secret']) {
      const response = await worker.fetch(request(path), env);

      expect(response.status).toBe(401);
      await expect(response.text()).resolves.toContain('action="/dashboard/login"');
    }
  });

  it('accepts the configured password from the dashboard password header', async () => {
    const response = await worker.fetch(request('/dashboard', {
      headers: { 'x-dashboard-password': 'dashboard-secret' },
    }), env);

    expect(response.status).toBe(200);
  });

  it('renders the title and dashboard-managed memory search controls through the default worker fetch handler', async () => {
    const response = await worker.fetch(request('/dashboard', {
      headers: { 'x-dashboard-password': 'dashboard-secret' },
    }), env);
    const html = await response.text();

    expect(html).toContain('<title>Mem0 Edge Dashboard</title>');
    expect(html).toContain('name="entity_id"');
    expect(html).toContain('name="query"');
    expect(html).toContain('type="submit"');
    expect(html).toContain('/dashboard/api/search');
    expect(html).toContain("status.textContent = 'Searching...'");
    expect(html).toContain('catch (error)');
    expect(html).toContain("'Request failed'");
    expect(html).not.toContain('name="api_key"');
    expect(html).not.toContain('Remote read-only preview');
    expect(html).toContain('const readonly = false;');
  });

  it('renders the operator navigation and dashboard data endpoints', async () => {
    const response = await worker.fetch(request('/dashboard', {
      headers: { 'x-dashboard-password': 'dashboard-secret' },
    }), env);
    const html = await response.text();

    expect(html).toContain('data-view="search"');
    expect(html).toContain('data-view="memories"');
    expect(html).toContain('data-view="graph"');
    expect(html).toContain('/dashboard/api/users');
    expect(html).toContain('/dashboard/api/memories');
    expect(html).toContain('/dashboard/api/graph');
  });

  it('renders the Cytoscape graph runtime instead of the manual SVG renderer', async () => {
    const response = await worker.fetch(request('/dashboard', {
      headers: { 'x-dashboard-password': 'dashboard-secret' },
    }), env);
    const html = await response.text();

    expect(html).toContain('https://cdn.jsdelivr.net/npm/cytoscape@3.34.0/dist/cytoscape.min.js');
    expect(html).toContain('integrity="sha384-K+k+ywfDuvV9dwg+bwsVE0WGkrTnqFamaER+ydBgMFQTtlI0jdI9no9AjkQHwh/T"');
    expect(html).toContain('crossorigin="anonymous"');
    expect(html).toContain('function graphElements(body)');
    expect(html).toContain('cytoscape({');
    expect(html).toContain("'text-wrap': 'wrap'");
    expect(html).toContain("'shape': 'round-rectangle'");
    expect(html).toContain('const graphEntityType = state.entityType; const graphEntityId = state.entityId;');
    expect(html).toContain('function graphResponseMatchesSelection(requestedEntityType, requestedEntityId, currentEntityType, currentEntityId)');
    expect(html).toContain('if (!graphResponseMatchesSelection(graphEntityType, graphEntityId, state.entityType, state.entityId)) return;');
    expect(html).not.toContain("createElementNS('http://www.w3.org/2000/svg'");
  });

  it('pins the desktop navigation and renders memory detail panels inline', async () => {
    const response = await worker.fetch(request('/dashboard', {
      headers: { 'x-dashboard-password': 'dashboard-secret' },
    }), env);
    const html = await response.text();

    expect(html).toContain('position: fixed');
    expect(html).toContain('padding-left: 208px');
    expect(html).toContain('memory-summary');
    expect(html).toContain('memory-detail');
    expect(html).toContain('row.append(summary, detail)');
  });

  it('renders the Mem0 import view and its client-side import contract', async () => {
    const response = await worker.fetch(request('/dashboard', {
      headers: { 'x-dashboard-password': 'dashboard-secret' },
    }), env);
    const html = await response.text();

    expect(html).toContain('data-view="import"');
    expect(html).toContain('name="target_entity_type"');
    expect(html).toContain('name="target_user_id"');
    expect(html).toContain('name="export_json"');
    expect(html).toContain('RawMemoryMigrationExport');
    expect(html).toContain('/dashboard/api/imports/mem0');
    expect(html).toContain('queued');
  });

  it('renders exact-text deduplication navigation and its confirmed dashboard API contract', async () => {
    const response = await worker.fetch(request('/dashboard', {
      headers: { 'x-dashboard-password': 'dashboard-secret' },
    }), env);
    const html = await response.text();

    expect(html).toContain('data-view="deduplicate"');
    expect(html.indexOf('data-view="deduplicate"')).toBeGreaterThan(html.indexOf('data-view="memories"'));
    expect(html).toContain('Deduplicate memories');
    expect(html).toContain('id="deduplication-status"');
    expect(html).toContain('id="deduplication-summary"');
    expect(html).toMatch(/id="deduplicate-button"[^>]*disabled/);
    expect(html).toContain('/dashboard/api/deduplication?entity_type=');
    expect(html).toContain("window.confirm('Remove ' + deduplication.removable_memories");
    expect(html).toContain("method: 'POST'");
    expect(html).toContain('confirm: true');
    expect(html).toContain('const entityType = state.entityType; const entityId = state.entityId;');
    expect(html).toContain('if (entityType !== state.entityType || entityId !== state.entityId) return;');
    expect(html).toContain('function invalidateDeduplication()');
    expect(html).toContain('invalidateDeduplication(); await loadMemories(true);');
    expect(html).toContain('grid-template-columns: repeat(2, minmax(0, 1fr))');
    expect(html).toContain('grid-auto-flow: row');
    expect(html).toContain('.nav button { width: 100%; }');
    expect(html).toContain('.logout { width: 100%;');
  });
});

describe('dashboard login', () => {
  it('omits Secure for local HTTP login sessions while retaining it for HTTPS', async () => {
    const localLogin = await worker.fetch(new Request('http://127.0.0.1/dashboard/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'password=dashboard-secret',
    }), env);
    const httpsLogin = await worker.fetch(request('/dashboard/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'password=dashboard-secret',
    }), env);

    const localCookie = localLogin.headers.get('Set-Cookie')!;
    expect(localLogin.status).toBe(303);
    expect(localCookie).toMatch(/^dashboard-session=/);
    expect(localCookie).not.toContain('Secure');
    expect(httpsLogin.status).toBe(303);
    expect(httpsLogin.headers.get('Set-Cookie')).toContain('Secure');

    const localDashboard = await worker.fetch(new Request('http://127.0.0.1/dashboard', {
      headers: { Cookie: localCookie.split(';', 1)[0] },
    }), env);
    const localApi = await worker.fetch(new Request('http://127.0.0.1/dashboard/api/users', {
      headers: { Cookie: localCookie.split(';', 1)[0] },
    }), env);
    const localLogout = await worker.fetch(new Request('http://127.0.0.1/dashboard/logout', {
      method: 'POST',
    }), env);

    expect(localDashboard.status).toBe(200);
    expect(localApi.status).not.toBe(401);
    expect(localLogout.status).toBe(303);
    expect(localLogout.headers.get('Set-Cookie')).toMatch(/^dashboard-session=;/);
    expect(localLogout.headers.get('Set-Cookie')).not.toContain('Secure');
  });

  it('issues an HttpOnly secure session cookie that enables a browser follow-up request', async () => {
    const login = await worker.fetch(request('/dashboard/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'password=dashboard-secret',
    }), env);
    const setCookie = login.headers.get('Set-Cookie');

    expect(login.status).toBe(303);
    expect(login.headers.get('Location')).toBe('/dashboard');
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('Secure');
    expect(setCookie).toContain('SameSite=Strict');
    expect(setCookie).not.toContain('dashboard-secret');

    const dashboard = await worker.fetch(request('/dashboard', {
      headers: { Cookie: setCookie!.split(';', 1)[0] },
    }), env);

    expect(dashboard.status).toBe(200);
    await expect(dashboard.text()).resolves.toContain('Mem0 Edge Dashboard');
  });

  it('returns 401 for an invalid login', async () => {
    const response = await worker.fetch(request('/dashboard/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'password=wrong-password',
    }), env);

    expect(response.status).toBe(401);
    await expect(response.text()).resolves.toContain('action="/dashboard/login"');
  });

  it('rejects a session cookie with a tampered signature', async () => {
    const login = await worker.fetch(request('/dashboard/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'password=dashboard-secret',
    }), env);
    const [name, value] = login.headers.get('Set-Cookie')!.split(';', 1)[0].split('=');
    const [expiresAt, signature] = value.split('.');
    const tamperedSignature = `${signature.slice(0, -1)}${signature.endsWith('A') ? 'B' : 'A'}`;

    const response = await worker.fetch(request('/dashboard', {
      headers: { Cookie: `${name}=${expiresAt}.${tamperedSignature}` },
    }), env);

    expect(response.status).toBe(401);
    await expect(response.text()).resolves.toContain('action="/dashboard/login"');
  });

  it('rejects an expired session cookie', async () => {
    const login = await worker.fetch(request('/dashboard/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'password=dashboard-secret',
    }), env);
    const [name, value] = login.headers.get('Set-Cookie')!.split(';', 1)[0].split('=');
    const [, signature] = value.split('.');

    const response = await worker.fetch(request('/dashboard', {
      headers: { Cookie: `${name}=1.${signature}` },
    }), env);

    expect(response.status).toBe(401);
    await expect(response.text()).resolves.toContain('action="/dashboard/login"');
  });

  it('clears the session cookie on logout', async () => {
    const response = await worker.fetch(request('/dashboard/logout', { method: 'POST' }), env);

    expect(response.status).toBe(303);
    expect(response.headers.get('Set-Cookie')).toContain('Max-Age=0');
  });
});
