import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';
import * as dotenv from 'dotenv';
import * as dns from 'node:dns';

// Fix for Node.js fetch() timeout on Windows with Google APIs IPv6 
dns.setDefaultResultOrder('ipv4first');

// Enterprise Process Resilience: Prevent unhandled rejections from crashing the gateway
process.on('unhandledRejection', (reason: any) => {
    console.error('[UnhandledRejection Caught]', reason?.message || reason);
});
process.on('uncaughtException', (err: any) => {
    console.error('[UncaughtException Caught]', err?.message || err);
});

import { supabase, dbType, isLocalDb } from './db';
import { serveStatic } from '@hono/node-server/serve-static';
import * as fs from 'fs';
import * as path from 'path';

import projectsRoute from './routes/projects';
import upstreamKeysRoute from './routes/upstreamKeys';
import gatewayKeysRoute from './routes/gatewayKeys';
import v1Route from './routes/v1';
import analyticsRoute from './routes/analytics';
import batchRoute from './routes/batch';
import pricingRoute from './routes/pricing';
import engineRoutes from './routes/engineConfig';
import channelTesting from './routes/channelTesting';
import { aaaAdminRoutes, AAASuite } from './aaa';
import { authMiddleware } from './middleware/auth';
import { hashPassword, verifyPassword, signAdminToken } from './utils/authSecurity';

dotenv.config({ override: true });

const app = new Hono();

app.use('*', logger());
app.use('*', cors());

// Initialize Enterprise AAA Suite (AuthN, AuthZ, Auditing)
const aaaSuite = AAASuite.getInstance();
aaaSuite.init().then(() => {
    console.log('[TierMax AAA] Enterprise Authentication, Authorization & Accounting initialized.');
}).catch((err) => {
    console.warn('[TierMax AAA] Initialization warning:', err.message);
});

app.route('/api/projects', projectsRoute);
app.route('/api/providers', upstreamKeysRoute);
app.route('/api/gateway-keys', gatewayKeysRoute);
app.route('/api/analytics', analyticsRoute);
app.route('/api/batch', batchRoute);
app.route('/api/pricing', pricingRoute);
app.route('/api/engine', engineRoutes);
app.route('/api/channels', channelTesting);
app.route('/api/aaa', aaaAdminRoutes);
app.route('/v1', v1Route);
// Compatibility aliases for clients setting baseUrl with/without /v1
app.route('/v1/v1', v1Route);
app.all('/messages', (c) => v1Route.fetch(c.req.raw));

app.get('/', (c) => {
    return c.json({ message: 'OpenClaw API Gateway Running' });
});

app.get('/api/system/info', (c) => {
    return c.json({
        status: 'ok',
        db_type: dbType,
        is_local: isLocalDb,
        version: '2.5.0',
    });
});

// ── Public health + metrics endpoint (no auth required) ─────────────────────
// Consumed by Mission Control /infra page for passive observability.
// All data comes from the existing `request_logs` table in Supabase/SQLite.
const GATEWAY_START = Date.now();
app.get('/health', async (c) => {
    const since24h  = new Date(Date.now() - 86_400_000).toISOString();
    const since30d   = new Date(Date.now() - 30 * 86_400_000).toISOString();

    // Parallel queries — best effort, errors return empty gracefully
    const [providersRes, logsRes, recentRes, logs30dRes] = await Promise.all([
        // Active upstream providers
        supabase.from('upstream_keys').select('id, provider').eq('is_active', true),

        // 24h aggregated stats from request_logs
        supabase.from('request_logs')
            .select('model, provider, latency_ms, total_tokens, status_code, error_message')
            .gte('created_at', since24h)
            .limit(1000),

        // Last 10 requests for the recent table
        supabase.from('request_logs')
            .select('model, provider, latency_ms, total_tokens, status_code, created_at')
            .order('created_at', { ascending: false })
            .limit(10),

        // 30-day token totals (for cost calculator)
        supabase.from('request_logs')
            .select('total_tokens, status_code')
            .gte('created_at', since30d)
            .limit(5000),
    ]);

    const logs    = logsRes.data    || [];
    const recent  = recentRes.data  || [];
    const logs30d = logs30dRes.data || [];

    // Aggregate latency + tokens
    const successLogs = logs.filter((l: any) => l.status_code === 200);
    const allLatencies = successLogs.map((l: any) => l.latency_ms as number).sort((a: number, b: number) => a - b);
    const avgLatency = allLatencies.length ? Math.round(allLatencies.reduce((s: number, v: number) => s + v, 0) / allLatencies.length) : null;
    const p95Latency = allLatencies.length ? allLatencies[Math.floor(allLatencies.length * 0.95)] ?? null : null;
    const totalTokens = logs.reduce((s: number, l: any) => s + (l.total_tokens || 0), 0);

    // Per-model breakdown
    const byModel: Record<string, { model: string; provider: string; requests: number; avg_latency: number | null; total_tokens: number; errors: number }> = {};
    for (const l of logs as any[]) {
        const key = l.model || 'unknown';
        if (!byModel[key]) byModel[key] = { model: key, provider: l.provider, requests: 0, avg_latency: null, total_tokens: 0, errors: 0 };
        byModel[key].requests++;
        byModel[key].total_tokens += l.total_tokens || 0;
        if (l.status_code !== 200) byModel[key].errors++;
    }
    // Compute per-model avg latency
    for (const m of Object.values(byModel)) {
        const lats = (logs as any[]).filter((l: any) => l.model === m.model && l.status_code === 200).map((l: any) => l.latency_ms as number);
        m.avg_latency = lats.length ? Math.round(lats.reduce((s: number, v: number) => s + v, 0) / lats.length) : null;
    }

    // Per-provider breakdown
    const byProvider: Record<string, { requests: number; errors: number; total_tokens: number }> = {};
    for (const l of logs as any[]) {
        const p = l.provider || 'unknown';
        if (!byProvider[p]) byProvider[p] = { requests: 0, errors: 0, total_tokens: 0 };
        byProvider[p].requests++;
        byProvider[p].total_tokens += l.total_tokens || 0;
        if (l.status_code !== 200) byProvider[p].errors++;
    }

    return c.json({
        status:        'ok',
        uptime:        Math.floor((Date.now() - GATEWAY_START) / 1000),
        providers:     (providersRes.data || []).map((p: any) => ({ provider: p.provider, health: 'active' })),
        // 24-hour metrics window
        metrics_24h: {
            total_requests: logs.length,
            success_requests: successLogs.length,
            error_requests: logs.length - successLogs.length,
            avg_latency_ms:  avgLatency,
            p95_latency_ms:  p95Latency,
            total_tokens:    totalTokens,
            by_model:        Object.values(byModel).sort((a, b) => b.requests - a.requests),
            by_provider:     Object.entries(byProvider).map(([provider, s]) => ({ provider, ...s })).sort((a, b) => b.requests - a.requests),
        },
        // 30-day window for cost estimation
        metrics_30d: {
            total_requests:  logs30d.length,
            success_requests: (logs30d as any[]).filter((l: any) => l.status_code === 200).length,
            total_tokens:    (logs30d as any[]).reduce((s: number, l: any) => s + (l.total_tokens || 0), 0),
        },
        recent_requests: recent.map((r: any) => ({
            model:             r.model,
            provider:          r.provider,
            latency_ms:        r.latency_ms,
            prompt_tokens:     r.prompt_tokens ?? 0,
            completion_tokens: r.completion_tokens ?? 0,
            total_tokens:      r.total_tokens,
            status_code:       r.status_code,
            ts:                r.created_at ?? r.inserted_at ?? null,
        })),
        ts: Date.now(),
        db_type: dbType,
        is_local: isLocalDb,
    });
});


app.post('/api/auth/login', async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const username = typeof body.username === 'string' ? body.username.trim() : '';
    const password = typeof body.password === 'string' ? body.password : '';

    if (!username || !password) {
        return c.json({ error: 'Username and password are required' }, 400);
    }

    const { data, error } = await supabase
        .from('admins')
        .select('*')
        .eq('username', username)
        .single();

    if (error || !data) {
        return c.json({ error: 'Invalid credentials' }, 401);
    }

    const storedHash = data.password_hash || data.password || '';
    if (!verifyPassword(password, storedHash)) {
        return c.json({ error: 'Invalid credentials' }, 401);
    }

    // Auto-migrate legacy plaintext password to secure salted scrypt hash
    if (!storedHash.startsWith('scrypt:')) {
        const secureHash = hashPassword(password);
        const updatePayload: Record<string, any> = { password_hash: secureHash };
        if ('password' in data) {
            updatePayload.password = null;
        }
        await supabase
            .from('admins')
            .update(updatePayload)
            .eq('id', data.id);
    }

    // Issue a cryptographically signed JWT with 24h expiration
    const token = await signAdminToken({ id: data.id, username: data.username });
    return c.json({ token, user: data.username });
});

// -----------------------------------------------------------------------------
// UPDATE CREDENTIALS ENDPOINT
// PUT /api/auth/credentials
// Allows administrators to securely replace their current username and/or password.
// Security: Protected by authMiddleware and verifies 'currentPassword' before updates.
// -----------------------------------------------------------------------------
app.put('/api/auth/credentials', authMiddleware, async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const currentUsername = typeof body.currentUsername === 'string' ? body.currentUsername.trim() : '';
    const currentPassword = typeof body.currentPassword === 'string' ? body.currentPassword : '';
    const newUsername = typeof body.newUsername === 'string' ? body.newUsername.trim() : '';
    const newPassword = typeof body.newPassword === 'string' ? body.newPassword : '';

    if (!currentUsername || !currentPassword) {
        return c.json({ error: 'Current username and password are required' }, 400);
    }

    const { data, error } = await supabase
        .from('admins')
        .select('*')
        .eq('username', currentUsername)
        .single();

    if (error || !data) {
        return c.json({ error: 'Invalid current credentials' }, 401);
    }

    const storedHash = data.password_hash || data.password || '';
    if (!verifyPassword(currentPassword, storedHash)) {
        return c.json({ error: 'Invalid current credentials' }, 401);
    }

    const updates: any = {};
    if (newUsername) updates.username = newUsername;
    if (newPassword) {
        if (newPassword.length < 4) {
            return c.json({ error: 'New password must be at least 4 characters' }, 400);
        }
        updates.password_hash = hashPassword(newPassword);
        if ('password' in data) {
            updates.password = null; // Clear any legacy plaintext password field
        }
    }

    if (Object.keys(updates).length === 0) {
        return c.json({ error: 'No new credentials provided' }, 400);
    }

    const { error: updateError } = await supabase
        .from('admins')
        .update(updates)
        .eq('id', data.id);

    if (updateError) {
        return c.json({ error: updateError.message }, 500);
    }

    return c.json({ success: true, newUsername: updates.username || currentUsername });
});

// Static frontend serving if built dist exists (production / Docker mode)
const possibleDist = [
    path.resolve(process.cwd(), '../frontend/dist'),
    path.resolve(process.cwd(), './frontend/dist'),
    path.resolve(process.cwd(), './frontend_dist'),
    path.resolve(process.cwd(), './public'),
];
const distPath = possibleDist.find(p => fs.existsSync(p) && fs.existsSync(path.join(p, 'index.html')));

if (distPath) {
    console.log(`[TierMax] Serving static frontend dashboard from: ${distPath}`);
    app.use('/*', serveStatic({ root: path.relative(process.cwd(), distPath) }));
    app.get('*', (c) => {
        const indexPath = path.join(distPath, 'index.html');
        return c.html(fs.readFileSync(indexPath, 'utf-8'));
    });
}

const port = parseInt(process.env.PORT || '3000');
console.log(`Server is running on port ${port}`);

// Initialize background health prober (first run at 20s, then every 3 mins)
import('./utils/healthProber').then(({ probeUpstreamHealth }) => {
    setTimeout(() => {
        probeUpstreamHealth().catch(() => {});
        setInterval(() => {
            probeUpstreamHealth().catch(() => {});
        }, 180_000);
    }, 20_000);
});

serve({
    fetch: app.fetch,
    port
});
