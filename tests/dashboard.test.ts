import { describe, expect, it } from 'vitest';
import type { Env } from '../src/env';
import worker from '../src/index';

const env = {
  DASHBOARD_PASSWORD: 'dashboard-secret',
} as Env;

function request(path: string, init?: RequestInit): Request {
  return new Request(`https://example.com${path}`, init);
}

describe('GET /dashboard', () => {
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
    expect(html).toContain('name="user_id"');
    expect(html).toContain('name="query"');
    expect(html).toContain('type="submit"');
    expect(html).toContain('/dashboard/api/search');
    expect(html).toContain("status.textContent = 'Searching...'");
    expect(html).toContain('catch (error)');
    expect(html).toContain("'Request failed'");
    expect(html).not.toContain('name="api_key"');
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
});

describe('dashboard login', () => {
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
