import { Hono } from 'hono';
import { authMiddleware } from '../middleware/auth';
import {
    getEngineConfig,
    updateEngineConfig,
    executeManagerLLM,
    autoCalibrateFreeTiers
} from '../utils/engineBridge';
import {
    getAllRateLimitStates,
    updateCustomLimits,
    getOrCreateKeyState
} from '../utils/freeTierGuardian';
import { supabase } from '../db';
import { adviseFusionPresets, validateAndSelectActivePreset } from '../utils/aiModelAdvisor';

const engineRoutes = new Hono();

// Auth required for engine configuration and management
engineRoutes.use('*', authMiddleware);

/**
 * GET /engine/config — Retrieve current engine configuration (masked)
 */
engineRoutes.get('/config', async (c) => {
    return c.json(getEngineConfig(true));
});

/**
 * POST /engine/config — Update engine settings (TypeSafe Jev + Manager LLM)
 */
engineRoutes.post('/config', async (c) => {
    const body = await c.req.json();
    const updated = updateEngineConfig(body);
    return c.json({ success: true, config: updated });
});

/**
 * POST /engine/test/typesafe — Test live connection to TypeSafe AI (Jev)
 */
engineRoutes.post('/test/typesafe', async (c) => {
    const rawConfig = getEngineConfig(false);
    const body = await c.req.json().catch(() => ({}));
    const apiKey = body.typesafeApiKey || rawConfig.typesafeApiKey;
    const endpoint = body.typesafeEndpoint || rawConfig.typesafeEndpoint || 'https://openrouter.ai/api/alpha/decisions';
    const model = body.typesafeModel || rawConfig.typesafeModel || '~typesafe/jev-latest';

    if (!apiKey) {
        return c.json({ ok: false, error: 'TypeSafe API Key is required for testing' }, 400);
    }

    const start = Date.now();
    try {
        const isOpenRouter = endpoint.includes('openrouter.ai') || endpoint.includes('/decisions');
        const testPayload = isOpenRouter ? {
            model,
            state: {
                prompt: 'Healthcheck ping from TierMax Gateway',
                estimated_tokens: 10
            },
            questions: {
                status: {
                    type: 'choice',
                    instructions: 'Service operational status',
                    criteria: {
                        healthy: 'Service is online and functioning normally',
                        degraded: 'Service is unavailable or impaired'
                    }
                }
            }
        } : {
            model,
            state: {
                test: true,
                message: 'Healthcheck ping from TierMax Gateway'
            },
            questions: {
                ping: {
                    type: 'choice',
                    options: ['pong', 'ok'],
                    question: 'Is the service operational?'
                }
            }
        };

        const res = await fetch(endpoint, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${apiKey}`,
            },
            body: JSON.stringify(testPayload),
        });

        const latencyMs = Date.now() - start;
        if (res.ok) {
            const data: any = await res.json();
            return c.json({
                ok: true,
                latencyMs,
                status: res.status,
                endpoint,
                model,
                message: 'Successfully connected to TypeSafe AI (Jev System One)',
                response: data,
            });
        } else {
            const errData = await res.json().catch(() => ({}));
            return c.json({
                ok: false,
                latencyMs,
                status: res.status,
                error: errData?.error?.message || res.statusText || 'Failed to connect to TypeSafe AI',
            }, res.status as any);
        }
    } catch (err: any) {
        return c.json({
            ok: false,
            latencyMs: Date.now() - start,
            error: err.message,
        }, 500);
    }
});

/**
 * POST /engine/test/manager — Test live connection to Manager LLM
 */
engineRoutes.post('/test/manager', async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const prompt = body.prompt || 'Respond with only "TierMax Management Engine Online" and current system timestamp.';
    const res = await executeManagerLLM(prompt, 'You are an internal healthcheck assistant.', {
        apiKey: body.managerApiKey || body.apiKey,
        baseUrl: body.managerBaseUrl || body.baseUrl,
        model: body.managerModel || body.model,
        provider: body.managerProvider || body.provider,
        upstreamKeyId: body.managerUpstreamKeyId || body.upstreamKeyId,
        temperature: body.managerTemperature ?? body.temperature,
    });

    if (res.success) {
        return c.json({
            ok: true,
            latencyMs: res.latencyMs,
            reply: res.content,
            message: 'Successfully connected to Manager LLM',
        });
    } else {
        return c.json({
            ok: false,
            latencyMs: res.latencyMs,
            error: res.error,
        }, 502);
    }
});

/**
 * POST /engine/calibrate — Auto-calibrate Free Tier limits for project keys
 */
engineRoutes.post('/calibrate', async (c) => {
    const { projectId } = await c.req.json().catch(() => ({ projectId: null }));

    let query = supabase.from('upstream_keys').select('id, provider, billing_type');
    if (projectId) {
        query = query.eq('project_id', projectId);
    }
    const { data: keys, error } = await query;
    if (error) return c.json({ error: error.message }, 500);

    const activeKeys = (keys || []).map((k: any) => ({
        id: k.id,
        provider: k.provider,
        billing_type: k.billing_type || 'free',
    }));

    if (activeKeys.length === 0) {
        return c.json({ error: 'No upstream keys found to calibrate' }, 404);
    }

    const calibration = await autoCalibrateFreeTiers(activeKeys);

    if (calibration.success && Array.isArray(calibration.recommendations)) {
        // Apply calibrated limits to in-memory guardian
        calibration.recommendations.forEach((rec: any) => {
            if (rec.id) {
                const keyMeta = activeKeys.find((k: any) => k.id === rec.id);
                updateCustomLimits(rec.id, {
                    rpm: rec.recommended_rpm,
                    tpm: rec.recommended_tpm,
                    rpd: rec.recommended_rpd,
                }, keyMeta?.provider, keyMeta?.billing_type);
            }
        });
    }

    return c.json(calibration);
});

/**
 * GET /engine/guardian/states — Snapshot of active rate limit metrics for all keys
 */
engineRoutes.get('/guardian/states', async (c) => {
    return c.json(getAllRateLimitStates());
});

/**
 * POST /engine/guardian/limits — Update limits manually for a key
 */
engineRoutes.post('/guardian/limits', async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const upstreamKeyId = body.upstreamKeyId || body.keyId;
    const rpm = body.rpm ?? body.limits?.requestsPerMinute ?? body.limits?.rpm;
    const tpm = body.tpm ?? body.limits?.tokensPerMinute ?? body.limits?.tpm;
    const rpd = body.rpd ?? body.limits?.requestsPerDay ?? body.limits?.rpd;
    const tpd = body.tpd ?? body.limits?.tokensPerDay ?? body.limits?.tpd;
    const provider = body.provider;
    const billing_type = body.billing_type;

    if (!upstreamKeyId) {
        return c.json({ error: 'upstreamKeyId or keyId is required' }, 400);
    }

    // Ensure initialized
    getOrCreateKeyState(upstreamKeyId, provider || 'google', billing_type || 'free');

    const updated = updateCustomLimits(upstreamKeyId, { rpm, tpm, rpd, tpd });
    return c.json({ success: true, updated });
});

/**
 * GET /engine/fusion-advisor — Fetch real-time frontier AI advisor recommendations
 * POST /engine/fusion-advisor — Fetch with forceRefresh flag
 */
engineRoutes.get('/fusion-advisor', async (c) => {
    try {
        const forceRefresh = c.req.query('refresh') === 'true';
        const advisor = await adviseFusionPresets(forceRefresh);
        return c.json(advisor);
    } catch (err: any) {
        return c.json({ ok: false, error: err.message }, 500);
    }
});

engineRoutes.post('/fusion-advisor', async (c) => {
    try {
        const body = await c.req.json().catch(() => ({}));
        const forceRefresh = body?.forceRefresh === true || body?.refresh === true;
        const advisor = await adviseFusionPresets(forceRefresh);
        return c.json(advisor);
    } catch (err: any) {
        return c.json({ ok: false, error: err.message }, 500);
    }
});

/**
 * POST /engine/apply-fusion-preset — Validate and auto-apply intelligent fusion trio
 */
engineRoutes.post('/apply-fusion-preset', async (c) => {
    try {
        const body = await c.req.json().catch(() => ({}));
        const tier = (body?.tier === 'paid' ? 'paid' : body?.tier === 'free_training' ? 'free_training' : 'free') as 'free' | 'free_training' | 'paid';
        const mode = (body?.mode || 'frontier') as 'reasoning' | 'speed' | 'frontier';
        const version = body?.version as 'v1_gold' | 'v2_silver' | 'v3_bronze' | undefined;
        const autoFallback = body?.autoFallback !== false;

        const selection = await validateAndSelectActivePreset(tier, mode, version, autoFallback);

        const appliedConfig = updateEngineConfig({
            fusionDefaultModels: [selection.preset.draft_a, selection.preset.draft_b, selection.preset.draft_c],
            fusionDefaultJudge: selection.preset.judge,
            fusionSlotProjects: selection.preset.slotProjects || ['', '', '', ''],
        });

        return c.json({
            success: true,
            applied: {
                tier,
                mode,
                versionUsed: selection.versionUsed,
                testedOk: selection.testedOk,
                errorReason: selection.errorReason,
                preset: selection.preset,
                models: [selection.preset.draft_a, selection.preset.draft_b, selection.preset.draft_c],
                judge: selection.preset.judge,
                slotProjects: selection.preset.slotProjects,
                rationale: selection.preset.rationale,
            },
            config: appliedConfig,
        });
    } catch (err: any) {
        return c.json({ success: false, error: err.message }, 500);
    }
});

export default engineRoutes;
