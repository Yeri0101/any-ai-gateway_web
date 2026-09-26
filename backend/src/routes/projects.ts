import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { supabase } from '../db';
import { authMiddleware } from '../middleware/auth';
import { pauseProvider } from '../utils/limitTracker';
import { getProjectHistory, repairProjectChannels, autoDiscoverAndSyncProjectModels, autoDiscoverAndSyncAllProjects } from '../utils/modelHealing';
import { dashboardEvents } from '../utils/dashboardEvents';
import { getCacheStats } from '../utils/semanticCache';
import { estimateLogCost } from '../utils/pricingHelper';

const projects = new Hono();

// Apply auth middleware to all project routes
projects.use('*', authMiddleware);

projects.get('/dashboard-overview', async (c) => {
    try {
        const [projectsRes, logsRes, upstreamKeysRes] = await Promise.all([
            supabase
                .from('projects')
                .select('*, gateway_keys(id, key_name, api_key)')
                .order('created_at', { ascending: false }),
            supabase
                .from('request_logs')
                .select('project_id, gateway_key_id, upstream_key_id, provider, model, latency_ms, total_tokens, prompt_tokens, completion_tokens, total_cost_usd, created_at')
                .order('created_at', { ascending: false })
                .limit(2000),
            supabase
                .from('upstream_keys')
                .select('id, billing_type'),
        ]);

        if (projectsRes.error) return c.json({ error: projectsRes.error.message }, 500);

        const projectsData = projectsRes.data || [];
        const logs = logsRes.data || [];
        const upstreamKeys = upstreamKeysRes.data || [];

        const billingTypeMap = new Map(upstreamKeys.map((k: any) => [k.id, k.billing_type || 'paid']));
        const projectNameMap = new Map(projectsData.map((p: any) => [p.id, p.name]));

        const gwProjectMap = new Map();
        projectsData.forEach((p: any) => {
            (p.gateway_keys || []).forEach((gk: any) => gwProjectMap.set(gk.id, p.id));
        });

        let totalTokens = 0;
        let actualCostUsd = 0;
        let estimatedSavingsUsd = 0;
        const latencyMap: Record<string, { sum: number; count: number }> = {};

        for (const log of logs) {
            totalTokens += (log.total_tokens || 0);
            const cost = estimateLogCost(log);
            const isCache = log.provider === 'cache';
            const bType = isCache ? 'free' : (log.upstream_key_id ? billingTypeMap.get(log.upstream_key_id) || 'paid' : 'paid');
            if (bType === 'free') {
                estimatedSavingsUsd += cost;
            } else {
                actualCostUsd += cost;
            }

            const projId = log.project_id || gwProjectMap.get(log.gateway_key_id);
            if (projId && log.latency_ms != null) {
                if (!latencyMap[projId]) latencyMap[projId] = { sum: 0, count: 0 };
                latencyMap[projId].sum += log.latency_ms;
                latencyMap[projId].count++;
            }
        }

        const sanitizedProjects = projectsData.map((project: any) => {
            const keys = (project.gateway_keys || []).map((gk: any) => {
                const key = gk.api_key || '';
                const key_preview = key.length > 9 ? `${key.slice(0, 4)}...${key.slice(-5)}` : `${key.slice(0, 4)}...`;
                const { api_key: _removed, ...rest } = gk;
                return { ...rest, key_preview };
            });
            const agg = latencyMap[project.id];
            const avg_latency_ms = agg ? Math.round(agg.sum / agg.count) : null;
            return { ...project, gateway_keys: keys, avg_latency_ms };
        });

        const recentCalls = logs
            .filter((log: any) => !!log.created_at)
            .map((log: any) => {
                const projId = log.project_id || gwProjectMap.get(log.gateway_key_id);
                return {
                    project_id: projId,
                    project_name: projId ? (projectNameMap.get(projId) || 'Proyecto') : 'Proyecto',
                    model: log.model || '—',
                    provider: log.provider || null,
                    latency_ms: log.latency_ms ?? null,
                    total_tokens: log.total_tokens ?? 0,
                    cost_usd: estimateLogCost(log),
                    created_at: log.created_at,
                };
            })
            .slice(0, 3);

        const cacheStats = getCacheStats();

        return c.json({
            projects: sanitizedProjects,
            recentCalls,
            usageMetrics: {
                totalTokens,
                actualCostUsd: Number(actualCostUsd.toFixed(6)),
                estimatedSavingsUsd: Number(estimatedSavingsUsd.toFixed(6)),
            },
            cacheStats,
        });
    } catch (err: any) {
        return c.json({ error: err.message || 'Failed to fetch dashboard overview' }, 500);
    }
});

projects.get('/realtime-stream', async (c) => {
    return streamSSE(c, async (stream) => {
        await stream.writeSSE({
            data: JSON.stringify({ type: 'connected', ts: Date.now() }),
            event: 'connected',
        });

        const onNewRequest = async (entry: any) => {
            try {
                await stream.writeSSE({
                    data: JSON.stringify({ type: 'new_request', entry }),
                    event: 'new_request',
                });
            } catch {
                // Client aborted
            }
        };

        dashboardEvents.on('new_request', onNewRequest);

        const pingInterval = setInterval(async () => {
            try {
                await stream.writeSSE({
                    data: JSON.stringify({ type: 'ping' }),
                    event: 'ping',
                });
            } catch {
                clearInterval(pingInterval);
            }
        }, 15000);

        stream.onAbort(() => {
            clearInterval(pingInterval);
            dashboardEvents.off('new_request', onNewRequest);
        });

        while (!stream.aborted) {
            await stream.sleep(1000);
        }
    });
});

projects.get('/recent-calls', async (c) => {
    const { data: recentLogs, error: logsError } = await supabase
        .from('request_logs')
        .select('project_id, gateway_key_id, provider, model, latency_ms, total_tokens, created_at')
        .order('created_at', { ascending: false })
        .limit(12);

    if (logsError) return c.json({ error: logsError.message }, 500);

    const directProjectIds = (recentLogs || []).map((log: any) => log.project_id).filter(Boolean);
    const gatewayKeyIds = [...new Set((recentLogs || []).map((log: any) => log.gateway_key_id).filter(Boolean))];

    const { data: gatewayKeysData, error: gatewayKeysError } = gatewayKeyIds.length === 0
        ? { data: [], error: null }
        : await supabase
            .from('gateway_keys')
            .select('id, project_id')
            .in('id', gatewayKeyIds);

    if (gatewayKeysError) return c.json({ error: gatewayKeysError.message }, 500);

    const projectIdByGatewayKeyId = new Map((gatewayKeysData || []).map((gatewayKey: any) => [gatewayKey.id, gatewayKey.project_id]));
    const allProjectIds = [...new Set([
        ...directProjectIds,
        ...(gatewayKeysData || []).map((gatewayKey: any) => gatewayKey.project_id).filter(Boolean),
    ])];

    const { data: projectsData, error: projectsError } = allProjectIds.length === 0
        ? { data: [], error: null }
        : await supabase
            .from('projects')
            .select('id, name')
            .in('id', allProjectIds);

    if (projectsError) return c.json({ error: projectsError.message }, 500);

    const projectNameById = new Map((projectsData || []).map((project: any) => [project.id, project.name]));

    const normalizedLogs = (recentLogs || [])
        .map((log: any) => {
            const resolvedProjectId = log.project_id || projectIdByGatewayKeyId.get(log.gateway_key_id) || null;
            return {
                project_id: resolvedProjectId,
                project_name: resolvedProjectId ? (projectNameById.get(resolvedProjectId) || 'Proyecto desconocido') : 'Proyecto desconocido',
                model: log.model || 'Modelo desconocido',
                provider: log.provider || null,
                latency_ms: log.latency_ms ?? null,
                total_tokens: log.total_tokens ?? 0,
                created_at: log.created_at,
            };
        })
        .filter((log: any) => log.project_id || log.model !== 'Modelo desconocido')
        .slice(0, 3);

    return c.json(normalizedLogs);
});

projects.post('/:id/pause-all', async (c) => {
    const { id } = c.req.param();
    const { data: keys, error } = await supabase.from('upstream_keys').select('id').eq('project_id', id);
    if (error) return c.json({ error: error.message }, 500);

    const safeKeys = keys || [];
    safeKeys.forEach((k: any) => pauseProvider(k.id));
    return c.json({ success: true, count: safeKeys.length });
});

projects.get('/', async (c) => {
    const [{ data, error }, { data: logs, error: logsError }] = await Promise.all([
        supabase
            .from('projects')
            .select('*, gateway_keys(id, key_name, api_key)')
            .order('created_at', { ascending: false }),
        supabase
            .from('request_logs')
            .select('project_id, latency_ms')
            .order('created_at', { ascending: false })
            .limit(2000)
    ]);

    if (error) return c.json({ error: error.message }, 500);
    if (logsError) return c.json({ error: logsError.message }, 500);

    // Aggregate avg latency per project
    const latencyMap: Record<string, { sum: number; count: number }> = {};
    for (const log of (logs || [])) {
        if (!log.project_id || log.latency_ms == null) continue;
        if (!latencyMap[log.project_id]) latencyMap[log.project_id] = { sum: 0, count: 0 };
        latencyMap[log.project_id].sum += log.latency_ms;
        latencyMap[log.project_id].count++;
    }

    const sanitized = (data || []).map((project: any) => {
        const keys = (project.gateway_keys || []).map((gk: any) => {
            const key: string = gk.api_key || '';
            const key_preview = key.length > 9
                ? `${key.slice(0, 4)}...${key.slice(-5)}`
                : `${key.slice(0, 4)}...`;
            const { api_key: _removed, ...rest } = gk;
            return { ...rest, key_preview };
        });
        const agg = latencyMap[project.id];
        const avg_latency_ms = agg ? Math.round(agg.sum / agg.count) : null;
        return { ...project, gateway_keys: keys, avg_latency_ms };
    });

    return c.json(sanitized);
});

projects.post('/', async (c) => {
    const { name } = await c.req.json();
    const { data, error } = await supabase.from('projects').insert([{ name }]).select().single();
    if (error) return c.json({ error: error.message }, 500);
    return c.json(data, 201);
});

projects.delete('/:id', async (c) => {
    const { id } = c.req.param();
    const { error } = await supabase.from('projects').delete().eq('id', id);
    if (error) return c.json({ error: error.message }, 500);
    return c.json({ success: true });
});

projects.patch('/:id', async (c) => {
    const { id } = c.req.param();
    const body = await c.req.json();
    const updates: Record<string, any> = {};
    if (body.name !== undefined) updates.name = body.name;
    if (body.color !== undefined) updates.color = body.color;
    if (body.budget_usd !== undefined) {
        updates.budget_usd = body.budget_usd === null || body.budget_usd === '' ? null : Number(body.budget_usd);
    }
    if (body.budget_alert_threshold_pct !== undefined) {
        updates.budget_alert_threshold_pct = body.budget_alert_threshold_pct === null || body.budget_alert_threshold_pct === ''
            ? 80
            : Number(body.budget_alert_threshold_pct);
    }
    if (Object.keys(updates).length === 0) return c.json({ error: 'Nothing to update' }, 400);
    const { data, error } = await supabase.from('projects').update(updates).eq('id', id).select();
    if (error) return c.json({ error: error.message }, 500);
    if (!data || data.length === 0) return c.json({ error: 'Project not found' }, 404);
    return c.json(data[0]);
});

projects.get('/:id/models', async (c) => {
    const { id } = c.req.param();

    const [{ data: gwKeys, error: gwError }, { data: upstreamList }] = await Promise.all([
        supabase
            .from('gateway_keys')
            .select('id, key_name, gateway_key_models(model_name, upstream_key_id)')
            .eq('project_id', id),
        supabase
            .from('upstream_keys')
            .select('id, provider')
            .eq('project_id', id)
    ]);

    if (gwError) return c.json({ error: gwError.message }, 500);

    const modelSet = new Set<string>();
    const modelsByKey: Record<string, string[]> = {};

    (gwKeys || []).forEach((gk: any) => {
        const keyModels = (gk.gateway_key_models || [])
            .map((m: any) => m.model_name)
            .filter(Boolean);
        modelsByKey[gk.id] = keyModels;
        keyModels.forEach((m: string) => modelSet.add(m));
    });

    return c.json({
        project_id: id,
        models: Array.from(modelSet),
        models_by_key: modelsByKey,
        upstream_providers: (upstreamList || []).map((u: any) => u.provider),
    });
});

/**
 * GET /api/projects/:id/history — Project model changelog & auto-healing audit trail
 */
projects.get('/:id/history', async (c) => {
    const { id } = c.req.param();
    const history = getProjectHistory(id);

    return c.json({
        project_id: id,
        total_events: history.length,
        events: history,
    });
});

/**
 * POST /api/projects/:id/repair — Active health scanner & Reparador agent
 */
projects.post('/:id/repair', async (c) => {
    const { id } = c.req.param();
    try {
        const report = await repairProjectChannels(id);
        return c.json({
            ok: true,
            report,
        });
    } catch (err: any) {
        return c.json({ ok: false, error: err.message }, 500);
    }
});

/**
 * POST /api/projects/:id/auto-discover-models — Live probe validation & auto-healing sync for single project
 */
projects.post('/:id/auto-discover-models', async (c) => {
    const { id } = c.req.param();
    try {
        const report = await autoDiscoverAndSyncProjectModels(id);
        return c.json({
            ok: true,
            report,
        });
    } catch (err: any) {
        return c.json({ ok: false, error: err.message }, 500);
    }
});

/**
 * POST /api/projects/auto-heal-all-models — Global live probe validation & auto-healing sync across ALL projects
 */
projects.post('/auto-heal-all-models', async (c) => {
    try {
        const report = await autoDiscoverAndSyncAllProjects();
        return c.json({
            ok: true,
            report,
        });
    } catch (err: any) {
        return c.json({ ok: false, error: err.message }, 500);
    }
});

export default projects;
