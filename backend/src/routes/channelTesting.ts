import { Hono } from 'hono';
import { supabase } from '../db';
import { authMiddleware } from '../middleware/auth';
import { getCircuitDiagnostics } from '../utils/circuitBreaker';
import { probeUpstreamHealth } from '../utils/healthProber';
import { runKeyPing, getProviderEndpoint, DEFAULT_TEST_MODELS, TestResult } from '../utils/modelHealing';

// Re-export for compatibility across the codebase
export { runKeyPing, getProviderEndpoint, DEFAULT_TEST_MODELS, TestResult };

const channelTesting = new Hono();

channelTesting.use('*', authMiddleware);

/**
 * POST /channels/test/:id — Test single upstream key with verified model awareness
 */
channelTesting.post('/test/:id', async (c) => {
    const { id } = c.req.param();
    const { data: key, error } = await supabase
        .from('upstream_keys')
        .select('*')
        .eq('id', id)
        .single();

    if (error || !key) {
        return c.json({ error: 'Upstream key not found' }, 404);
    }

    const body = await c.req.json().catch(() => ({}));
    let candidateModels: string[] | undefined = body?.model ? [body.model] : undefined;

    if (!candidateModels || candidateModels.length === 0) {
        const { data: gkm } = await supabase
            .from('gateway_key_models')
            .select('model_name')
            .eq('upstream_key_id', id);
        if (gkm && gkm.length > 0) {
            candidateModels = gkm.map((m: any) => m.model_name).filter(Boolean);
        }
    }

    const result = await runKeyPing(key, candidateModels);
    return c.json(result);
});

/**
 * POST /channels/test-project/:projectId — Test all keys in project using project-assigned models
 */
channelTesting.post('/test-project/:projectId', async (c) => {
    const { projectId } = c.req.param();
    const { data: keys, error } = await supabase
        .from('upstream_keys')
        .select('*')
        .eq('project_id', projectId);

    if (error) return c.json({ error: error.message }, 500);
    if (!keys || keys.length === 0) return c.json({ results: [], count: 0 });

    // Fetch configured models for all gateway keys in this project
    const { data: gatewayKeys } = await supabase
        .from('gateway_keys')
        .select('id, gateway_key_models(model_name, upstream_key_id)')
        .eq('project_id', projectId);

    const modelsByKey: Record<string, string[]> = {};
    (gatewayKeys || []).forEach((gk: any) => {
        (gk.gateway_key_models || []).forEach((m: any) => {
            if (m.upstream_key_id && m.model_name) {
                if (!modelsByKey[m.upstream_key_id]) modelsByKey[m.upstream_key_id] = [];
                modelsByKey[m.upstream_key_id].push(m.model_name);
            }
        });
    });

    const body = await c.req.json().catch(() => ({}));
    const forcedModel = body?.model;

    // Execute pings with project-aware models
    const results = await Promise.all((keys || []).map((k: any) => {
        const candidateModels = forcedModel ? [forcedModel] : modelsByKey[k.id];
        return runKeyPing(k, candidateModels);
    }));
    return c.json({
        projectId,
        count: results.length,
        healthyCount: results.filter(r => r.ok).length,
        results,
    });
});

channelTesting.get('/circuits', (c) => {
    return c.json({ circuits: getCircuitDiagnostics() });
});

channelTesting.post('/probe', async (c) => {
    const results = await probeUpstreamHealth();
    return c.json(results);
});

export default channelTesting;
