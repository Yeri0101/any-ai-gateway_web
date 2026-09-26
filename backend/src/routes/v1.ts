import { Hono } from 'hono';
import { stream } from 'hono/streaming';
import { supabase } from '../db';
import { gatewayAuth } from '../middleware/gatewayAuth';
import { providerStates, updateProviderCalls, markProviderError, checkAndRecoverProvider } from '../utils/limitTracker';
import { callPuterAI, callPuterAIStream } from '../utils/puterClient';
import { buildCacheKey, getCached, setCached } from '../utils/semanticCache';
import { isProviderSlow, recordLatency, markProviderSlow, LATENCY_ABORT_TIMEOUT_MS } from '../utils/latencyGuard';
import { classifyRequest, filterCandidatesByTier, estimateTokenCount } from '../utils/smartRouter';
import { anthropicToOpenAI, openAIToAnthropic, AnthropicSSETransformer, AnthropicRequest } from '../utils/anthropicAdapter';
import { executeFusion } from '../utils/fusionEngine';
import { executeCompletionEngine } from '../utils/completionEngine';
import { KNOWN_MODEL_MIGRATIONS, getProjectHistory } from '../utils/modelHealing';
import { notifyNewRequest } from '../utils/dashboardEvents';


type Variables = {
    gatewayKey: any;
};

type UsageBreakdown = {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
};

export type PricingMatch = {
    provider: string;
    model_name: string;
    input_price_per_1m: number;
    output_price_per_1m: number;
};

const v1 = new Hono<{ Variables: Variables }>();

v1.use('*', gatewayAuth);

/**
 * GET /v1/models — OpenAI-compatible model discovery endpoint with alias & migration metadata
 */
v1.get('/models', async (c) => {
    const gatewayKey = c.get('gatewayKey');
    const allowedModels = gatewayKey?.gateway_key_models || [];
    const modelList = allowedModels.map((m: any) => {
        // Find which deprecated models map to this active model
        const replaces = Object.entries(KNOWN_MODEL_MIGRATIONS)
            .filter(([_, mig]) => mig.replacement === m.model_name)
            .map(([dep]) => dep);

        return {
            id: m.model_name,
            object: 'model',
            created: Math.floor(Date.now() / 1000),
            owned_by: 'tiermax',
            permission: [],
            root: m.model_name,
            parent: null,
            replaces: replaces.length > 0 ? replaces : undefined,
        };
    });

    // Always include virtual meta-models
    const virtualModels = [
        { id: 'fusion', desc: 'Virtual Consensus Fusion (Default active in Dashboard)' },
        { id: 'fusion-reasoning', desc: 'Virtual Consensus Fusion (🧠 Reasoning Trio)' },
        { id: 'fusion-speed', desc: 'Virtual Consensus Fusion (⚡ Speed & Free)' },
        { id: 'fusion-frontier', desc: 'Virtual Consensus Fusion (🌐 Frontier Mix)' },
        { id: 'openclaw/fusion', desc: 'OpenClaw Virtual Fusion Alias' }
    ];
    for (const vm of virtualModels) {
        modelList.push({
            id: vm.id,
            object: 'model',
            created: Math.floor(Date.now() / 1000),
            owned_by: 'tiermax-consensus',
            permission: [],
            root: vm.id,
            parent: null,
            replaces: undefined,
        });
    }

    if (modelList.length === 1) {
        modelList.push(
            { id: 'gemini-2.5-flash', object: 'model', created: Math.floor(Date.now() / 1000), owned_by: 'tiermax', permission: [], root: 'gemini-2.5-flash', parent: null },
            { id: 'llama-3.3-70b-versatile', object: 'model', created: Math.floor(Date.now() / 1000), owned_by: 'tiermax', permission: [], root: 'llama-3.3-70b-versatile', parent: null }
        );
    }
    return c.json({ object: 'list', data: modelList });
});

/**
 * GET /v1/diagnose — Agent introspection endpoint: reveals active models, deprecations, and healing events
 */
v1.get('/diagnose', async (c) => {
    const gatewayKey = c.get('gatewayKey');
    const projectId = gatewayKey?.project_id;
    const history = projectId ? getProjectHistory(projectId) : [];
    const allowedModels = (gatewayKey?.gateway_key_models || []).map((m: any) => m.model_name);

    return c.json({
        status: 'healthy',
        project_id: projectId,
        gateway_key: gatewayKey.key_name || gatewayKey.id,
        active_models: allowedModels,
        virtual_models: ['fusion'],
        deprecated_aliases_supported: Object.keys(KNOWN_MODEL_MIGRATIONS).length,
        recent_healings: history.filter(h => h.eventType === 'auto_healed').slice(0, 10),
    });
});

// In-memory counter for round-robin load balancing
const modelCounters: Record<string, number> = {};
function normalizeUsage(usage: any, fallbackPromptTokens = 0): UsageBreakdown {
    const prompt_tokens = Number(usage?.prompt_tokens ?? usage?.input_tokens ?? fallbackPromptTokens ?? 0) || 0;
    const completion_tokens = Number(usage?.completion_tokens ?? usage?.output_tokens ?? 0) || 0;
    const total_tokens = Number(usage?.total_tokens ?? (prompt_tokens + completion_tokens)) || 0;

    return {
        prompt_tokens,
        completion_tokens,
        total_tokens: Math.max(total_tokens, prompt_tokens + completion_tokens),
    };
}

function sanitizeErrorMessage(msg?: string | null): string | null {
    if (!msg) return null;
    return msg
        .replace(/([?&]key=)[^&\s]+/gi, '$1[REDACTED]')
        .replace(/(Bearer\s+)[A-Za-z0-9_\-\.]{10,}/gi, '$1[REDACTED]')
        .replace(/(x-api-key['"]?\s*[:=]\s*['"]?)[A-Za-z0-9_\-\.]{10,}/gi, '$1[REDACTED]');
}

async function insertRequestLog(entry: {
    project_id: string;
    gateway_key_id: string;
    upstream_key_id: string | null;
    provider: string | null;
    model: string;
    status_code: number;
    latency_ms: number;
    total_tokens: number;
    prompt_tokens: number;
    completion_tokens: number;
    input_cost_usd?: number;
    output_cost_usd?: number;
    total_cost_usd?: number;
    pricing_provider?: string | null;
    pricing_model_name?: string | null;
    pricing_input_per_1m?: number | null;
    pricing_output_per_1m?: number | null;
    error_message?: string | null;
}) {
    const sanitizedEntry = {
        ...entry,
        error_message: sanitizeErrorMessage(entry.error_message),
    };
    const { error: logErr } = await supabase.from('request_logs').insert([sanitizedEntry]);
    if (logErr) {
        const timestamp = new Date().toISOString();
        console.error(`[${timestamp}] Logging failed:`, logErr);
    }
    notifyNewRequest(sanitizedEntry);
}

async function getPricingForModel(model: string, provider: string | null): Promise<PricingMatch | null> {
    const { data, error } = await supabase
        .from('model_pricing')
        .select('provider, model_name, input_price_per_1m, output_price_per_1m, is_active')
        .eq('model_name', model)
        .eq('is_active', true)
        .in('provider', provider ? [provider, '*'] : ['*']);

    if (error) {
        const timestamp = new Date().toISOString();
        console.error(`[${timestamp}] Pricing lookup failed:`, error);
        return null;
    }

    if (!data || data.length === 0) return null;

    const exact = provider ? data.find((row: any) => row.provider === provider) : null;
    const fallback = data.find((row: any) => row.provider === '*');
    const match = exact || fallback;
    if (!match) return null;

    return {
        provider: match.provider,
        model_name: match.model_name,
        input_price_per_1m: Number(match.input_price_per_1m || 0),
        output_price_per_1m: Number(match.output_price_per_1m || 0),
    };
}

function roundUsd(value: number): number {
    return Number(value.toFixed(8));
}

async function buildCostFields(model: string, provider: string | null, promptTokens: number, completionTokens: number) {
    const pricing = await getPricingForModel(model, provider);
    if (!pricing) {
        return {
            input_cost_usd: 0,
            output_cost_usd: 0,
            total_cost_usd: 0,
            pricing_provider: null,
            pricing_model_name: null,
            pricing_input_per_1m: null,
            pricing_output_per_1m: null,
        };
    }

    const input_cost_usd = roundUsd((promptTokens / 1_000_000) * pricing.input_price_per_1m);
    const output_cost_usd = roundUsd((completionTokens / 1_000_000) * pricing.output_price_per_1m);
    const total_cost_usd = roundUsd(input_cost_usd + output_cost_usd);

    return {
        input_cost_usd,
        output_cost_usd,
        total_cost_usd,
        pricing_provider: pricing.provider,
        pricing_model_name: pricing.model_name,
        pricing_input_per_1m: pricing.input_price_per_1m,
        pricing_output_per_1m: pricing.output_price_per_1m,
    };
}

interface CachedProjectBudget {
    budgetUsd: number | null;
    alertThresholdPct: number;
    spentUsd: number;
    lastChecked: number;
}
const projectBudgetCache = new Map<string, CachedProjectBudget>();
const PROJECT_BUDGET_TTL_MS = 60_000; // 60s cache for budget configuration

export function recordProjectSpend(projectId: string, costUsd: number) {
    const cached = projectBudgetCache.get(projectId);
    if (cached) {
        cached.spentUsd += costUsd;
    }
}

async function enforceProjectBudget(c: any, gatewayKey: any) {
    const projectId = gatewayKey?.project_id;
    if (!projectId) return null;

    let cached = projectBudgetCache.get(projectId);
    const now = Date.now();

    if (!cached || (now - cached.lastChecked) > PROJECT_BUDGET_TTL_MS) {
        const { data: project, error: projectError } = await supabase
            .from('projects')
            .select('id, name, budget_usd, budget_alert_threshold_pct')
            .eq('id', projectId)
            .single();

        if (projectError || !project) {
            return c.json({ error: { message: 'Project not found for gateway key', type: 'server_error' } }, 500);
        }

        const budgetUsd = project.budget_usd == null ? null : Number(project.budget_usd);
        const alertThresholdPct = Number(project.budget_alert_threshold_pct ?? 80);

        let spentUsd = 0;
        if (budgetUsd != null) {
            const { data: spendRows } = await supabase
                .from('request_logs')
                .select('total_cost_usd')
                .eq('project_id', projectId);
            spentUsd = Number((spendRows || []).reduce((sum: number, row: any) => sum + Number(row.total_cost_usd || 0), 0).toFixed(6));
        }

        cached = { budgetUsd, alertThresholdPct, spentUsd, lastChecked: now };
        projectBudgetCache.set(projectId, cached);
    }

    if (cached.budgetUsd == null) return null;

    if (cached.spentUsd >= cached.budgetUsd) {
        return c.json({
            error: {
                message: `Project budget exceeded. Spent $${cached.spentUsd.toFixed(4)} of $${cached.budgetUsd.toFixed(2)}.`,
                type: 'budget_exceeded_error',
            }
        }, 402);
    }

    c.set('projectBudget', {
        budget_usd: cached.budgetUsd,
        spent_usd: cached.spentUsd,
        alert_threshold_pct: cached.alertThresholdPct,
    });

    return null;
}

v1.post('/chat/completions', async (c) => {
    const gatewayKey = c.get('gatewayKey');
    const allowedModels = gatewayKey.gateway_key_models || [];

    const budgetBlock = await enforceProjectBudget(c, gatewayKey);
    if (budgetBlock) return budgetBlock;

    try {
        const body = await c.req.json();
        let requestedModel: string = body.model || '';

        // `:buf` suffix on the model name → force non-streaming (legacy support)
        if (requestedModel.endsWith(':buf')) {
            requestedModel = requestedModel.slice(0, -4);
            body.model = requestedModel;
            body.stream = false;
        }

        // Gateway key name contains [buf] → force non-streaming for ALL models on this key.
        // Create a key named e.g. "ZettaCore Tasks [buf]" and assign it to task agents.
        // This way model changes never break buffered mode — it's tied to the key, not the model.
        if (gatewayKey.key_name?.includes('[buf]')) {
            body.stream = false;
        }

        // --- Virtual Multi-Model Fusion Endpoint ---
        const isFusionModel = requestedModel === 'fusion' ||
            requestedModel === 'openclaw/fusion' ||
            requestedModel.endsWith('/fusion') ||
            requestedModel.startsWith('fusion:') ||
            requestedModel.startsWith('openclaw/fusion:') ||
            requestedModel.includes('/fusion:') ||
            requestedModel.startsWith('fusion-') ||
            requestedModel.startsWith('openclaw/fusion-') ||
            requestedModel.startsWith('fusion/') ||
            requestedModel.startsWith('openclaw/fusion/');

        if (isFusionModel) {
            if (body.stream) {
                c.header('Content-Type', 'text/event-stream; charset=utf-8');
                c.header('Cache-Control', 'no-cache, no-transform');
                c.header('Connection', 'keep-alive');
                c.header('X-Accel-Buffering', 'no');

                return stream(c, async (s) => {
                    try {
                        await executeFusion({
                            body,
                            gatewayKey,
                            executeChatCompletion: async ({ body: subBody, isInternalCall }) => {
                                if (isInternalCall) {
                                    const res = await executeCompletionEngine({ body: subBody, gatewayKey, isInternalCall: true });
                                    if (!res || !res.ok || !res.data) {
                                        throw new Error(res?.error?.message || `Completion engine failed for model ${subBody.model}`);
                                    }
                                    return res.data;
                                }
                                const streamRes = await executeCompletionEngine({
                                    body: subBody,
                                    gatewayKey,
                                    isInternalCall: true,
                                    returnRawStream: true,
                                });
                                if (streamRes.ok && streamRes.rawResponse?.body) {
                                    const reader = streamRes.rawResponse.body.getReader();
                                    while (true) {
                                        const { done, value } = await reader.read();
                                        if (done) break;
                                        await s.write(value);
                                    }
                                } else if (subBody.fallbackDraftContent) {
                                    console.warn(`[Fusion] Judge stream failed (${streamRes.error?.message || 'unknown'}). Streaming winning draft directly.`);
                                    const chunkId = `chatcmpl-fusion-${Date.now()}`;
                                    const chunk = {
                                        id: chunkId,
                                        object: 'chat.completion.chunk',
                                        created: Math.floor(Date.now() / 1000),
                                        model: subBody.model,
                                        choices: [{
                                            index: 0,
                                            delta: { content: subBody.fallbackDraftContent, role: 'assistant' },
                                            finish_reason: 'stop'
                                        }]
                                    };
                                    await s.write(new TextEncoder().encode(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`));
                                } else {
                                    throw new Error(streamRes.error?.message || `Judge model (${subBody.model}) failed to stream response`);
                                }
                            }
                        });
                    } catch (err: any) {
                        const errEvent = `data: ${JSON.stringify({ error: { message: err.message, type: 'fusion_error' } })}\n\ndata: [DONE]\n\n`;
                        await s.write(new TextEncoder().encode(errEvent));
                    }
                });
            } else {
                const fusionResult = await executeFusion({
                    body,
                    gatewayKey,
                    executeChatCompletion: async ({ body: subBody, isInternalCall }) => {
                        const res = await executeCompletionEngine({ body: subBody, gatewayKey, isInternalCall: true });
                        if (!res || !res.ok || !res.data) {
                            throw new Error(res?.error?.message || `Completion engine failed for model ${subBody.model}`);
                        }
                        return res.data;
                    }
                });
                return c.json(fusionResult.finalResponse || {
                    id: `chatcmpl-fusion-${Date.now()}`,
                    object: 'chat.completion',
                    created: Math.floor(Date.now() / 1000),
                    model: body.model || 'fusion',
                    choices: [{
                        index: 0,
                        message: { role: 'assistant', content: 'Fusion response completed.' },
                        finish_reason: 'stop'
                    }]
                });
            }
        }

        return await executeCompletionEngine({ body, gatewayKey, c });

    } catch (err: any) {
        return c.json({ error: { message: err.message, type: "internal_server_error" } }, 500);
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /v1/messages — Anthropic Wire Format Protocol Translator
// Supports Claude Code, @anthropic-ai/sdk, Aider, and custom Anthropic clients.
// Translates Anthropic requests to internal format, balances via round-robin,
// and streams/responds in 100% compliant Anthropic SSE / JSON format.
// ─────────────────────────────────────────────────────────────────────────────
v1.post('/messages', async (c) => {
    const gatewayKey = c.get('gatewayKey');
    const budgetBlock = await enforceProjectBudget(c, gatewayKey);
    if (budgetBlock) return budgetBlock;

    try {
        const anthropicBody: AnthropicRequest = await c.req.json();
        const requestedModel = anthropicBody.model || '';

        // 1. Virtual Multi-Model Fusion via Anthropic wire format
        const isFusionModel = requestedModel === 'fusion' ||
            requestedModel === 'openclaw/fusion' ||
            requestedModel.endsWith('/fusion') ||
            requestedModel.startsWith('fusion:') ||
            requestedModel.startsWith('openclaw/fusion:') ||
            requestedModel.includes('/fusion:') ||
            requestedModel.startsWith('fusion-') ||
            requestedModel.startsWith('openclaw/fusion-') ||
            requestedModel.startsWith('fusion/') ||
            requestedModel.startsWith('openclaw/fusion/');

        if (isFusionModel) {
            const openAIBody = anthropicToOpenAI(anthropicBody);

            if (anthropicBody.stream) {
                c.header('Content-Type', 'text/event-stream; charset=utf-8');
                c.header('Cache-Control', 'no-cache, no-transform');
                c.header('Connection', 'keep-alive');
                c.header('X-Accel-Buffering', 'no');

                const transformer = new AnthropicSSETransformer(requestedModel);

                return stream(c, async (s) => {
                    await s.write(new TextEncoder().encode(transformer.getStartEvents()));

                    try {
                        await executeFusion({
                            body: openAIBody,
                            gatewayKey,
                            executeChatCompletion: async ({ body: subBody, isInternalCall }) => {
                                if (isInternalCall) {
                                    const res = await executeCompletionEngine({ body: subBody, gatewayKey, isInternalCall: true });
                                    if (!res || !res.ok || !res.data) {
                                        throw new Error(res?.error?.message || `Completion engine failed for model ${subBody.model}`);
                                    }
                                    return res.data;
                                }
                                const streamRes = await executeCompletionEngine({
                                    body: subBody,
                                    gatewayKey,
                                    isInternalCall: true,
                                    returnRawStream: true,
                                });
                                if (streamRes.rawResponse?.body) {
                                    const reader = streamRes.rawResponse.body.getReader();
                                    const decoder = new TextDecoder();
                                    while (true) {
                                        const { done, value } = await reader.read();
                                        if (done) break;
                                        const chunkText = decoder.decode(value, { stream: true });
                                        const anthropicEvents = transformer.processChunk(chunkText);
                                        if (anthropicEvents) {
                                            await s.write(new TextEncoder().encode(anthropicEvents));
                                        }
                                    }
                                }
                            }
                        });
                        const endEvents = transformer.getEndEvents('end_turn');
                        if (endEvents) {
                            await s.write(new TextEncoder().encode(endEvents));
                        }
                    } catch (fusionErr: any) {
                        const errEvents = transformer.getEndEvents('end_turn');
                        await s.write(new TextEncoder().encode(errEvents));
                    }
                });
            } else {
                const fusionResult = await executeFusion({
                    body: openAIBody,
                    gatewayKey,
                    executeChatCompletion: async ({ body: subBody, isInternalCall }) => {
                        const res = await executeCompletionEngine({ body: subBody, gatewayKey, isInternalCall: true });
                        if (!res || !res.ok || !res.data) {
                            throw new Error(res?.error?.message || `Completion engine failed for model ${subBody.model}`);
                        }
                        return res.data;
                    }
                });

                const anthropicRes = openAIToAnthropic(fusionResult.finalResponse, requestedModel);
                return c.json(anthropicRes);
            }
        }

        // 2. Standard single-model Anthropic request
        const openAIBody = anthropicToOpenAI(anthropicBody);

        // Fallback model resolution if exact model not configured on gateway key
        const allowedModels = gatewayKey.gateway_key_models || [];
        const hasExact = allowedModels.some((m: any) => m.model_name === requestedModel);
        if (!hasExact && allowedModels.length > 0) {
            const fallbackModel = allowedModels[0].model_name;
            console.log(`[AnthropicAdapter] Model '${requestedModel}' not on key, routing to '${fallbackModel}'`);
            openAIBody.model = fallbackModel;
        }

        if (anthropicBody.stream) {
            c.header('Content-Type', 'text/event-stream; charset=utf-8');
            c.header('Cache-Control', 'no-cache, no-transform');
            c.header('Connection', 'keep-alive');
            c.header('X-Accel-Buffering', 'no');

            const transformer = new AnthropicSSETransformer(requestedModel);

            return stream(c, async (s) => {
                const streamRes = await executeCompletionEngine({
                    body: openAIBody,
                    gatewayKey,
                    returnRawStream: true,
                });

                if (!streamRes || !streamRes.rawResponse?.body) {
                    const errEvent = `event: error\ndata: ${JSON.stringify({ type: 'error', error: { type: 'api_error', message: streamRes?.error?.message || 'Upstream failed to stream' } })}\n\n`;
                    await s.write(new TextEncoder().encode(errEvent));
                    return;
                }

                await s.write(new TextEncoder().encode(transformer.getStartEvents()));

                const reader = streamRes.rawResponse.body.getReader();
                const decoder = new TextDecoder();

                try {
                    while (true) {
                        const { done, value } = await reader.read();
                        if (done) break;
                        const chunkText = decoder.decode(value, { stream: true });
                        const anthropicEvents = transformer.processChunk(chunkText);
                        if (anthropicEvents) {
                            await s.write(new TextEncoder().encode(anthropicEvents));
                        }
                    }
                    const endEvents = transformer.getEndEvents('end_turn');
                    if (endEvents) {
                        await s.write(new TextEncoder().encode(endEvents));
                    }
                } catch (streamErr: any) {
                    console.error('[AnthropicAdapter] Stream reading error:', streamErr);
                }
            });
        } else {
            const compRes = await executeCompletionEngine({
                body: openAIBody,
                gatewayKey,
                isInternalCall: true,
            });

            if (!compRes.ok || compRes.error) {
                return c.json({
                    type: 'error',
                    error: {
                        type: compRes.error?.type || 'api_error',
                        message: compRes.error?.message || 'Upstream request failed'
                    }
                }, (compRes.status as any) || 500);
            }

            const anthropicRes = openAIToAnthropic(compRes.data, requestedModel);
            return c.json(anthropicRes);
        }
    } catch (err: any) {
        return c.json({
            type: 'error',
            error: {
                type: 'internal_server_error',
                message: err.message || 'Internal server error'
            }
        }, 500);
    }
});

// Counter for Brave Search round-robin
const braveCounters: Record<string, number> = {};

// Gateway proxy for Brave Web Search
v1.get('/brave/search', async (c) => {
    const gatewayKey = c.get('gatewayKey');
    const budgetBlock = await enforceProjectBudget(c, gatewayKey);
    if (budgetBlock) return budgetBlock;
    const { q, count, offset, country, search_lang, ui_lang, safesearch, freshness, extra_snippets, enable_rich_callback } = c.req.query();

    if (!q) {
        return c.json({ error: "Missing 'q' parameter for search" }, 400);
    }

    try {
        const { data: keys, error } = await supabase
            .from('upstream_keys')
            .select('*')
            .eq('project_id', gatewayKey.project_id)
            .eq('provider', 'brave');

        if (error || !keys || keys.length === 0) {
            return c.json({ error: "No Brave Search keys configured for this project" }, 404);
        }

        // Filter healthy keys
        const healthyKeys = (keys || []).filter((k: any) => {
            const st = providerStates[k.id];
            return !st || st.status === 'healthy';
        });

        if (healthyKeys.length === 0) {
            return c.json({ error: "All configured Brave Search keys are currently exhausted or paused." }, 429);
        }

        const projectId = gatewayKey.project_id;
        if (braveCounters[projectId] === undefined) braveCounters[projectId] = 0;

        const keyIndex = braveCounters[projectId] % healthyKeys.length;
        braveCounters[projectId]++;
        const selectedKey = healthyKeys[keyIndex];

        // Build URL
        const url = new URL('https://api.search.brave.com/res/v1/web/search');
        url.searchParams.append('q', q);
        if (count) url.searchParams.append('count', count);
        if (offset) url.searchParams.append('offset', offset);
        if (country) url.searchParams.append('country', country);
        if (search_lang) url.searchParams.append('search_lang', search_lang);
        if (ui_lang) url.searchParams.append('ui_lang', ui_lang);
        if (safesearch) url.searchParams.append('safesearch', safesearch);
        if (freshness) url.searchParams.append('freshness', freshness);
        if (extra_snippets) url.searchParams.append('extra_snippets', extra_snippets);
        if (enable_rich_callback) url.searchParams.append('enable_rich_callback', enable_rich_callback);

        const startTime = Date.now();
        const response = await fetch(url.toString(), {
            method: 'GET',
            headers: {
                'Accept': 'application/json',
                'Accept-Encoding': 'gzip, deflate, br',
                'X-Subscription-Token': selectedKey.api_key
            }
        });

        const status = response.status;
        let data: any;

        try {
            data = await response.json();
        } catch (e) {
            data = await response.text();
        }

        if (status === 429) {
            // Mark provider as paused
            markProviderError(selectedKey.id, 'rate_limited', 'Brave Search API Rate limit exceeded');
            return c.json({ error: "Brave Search API Rate limit exceeded. Try again." }, 429);
        }

        if (!response.ok) {
            return c.json({ error: data }, status as any);
        }

        // Track usage (assuming 1 request = 1 call, tokens are not applicable here)
        updateProviderCalls(selectedKey.id, 0);

        // Add metadata for debugging
        if (typeof data === 'object' && data !== null) {
            data._openclaw_metadata = {
                provider: 'brave',
                upstream_key_id: selectedKey.id,
                latency_ms: Date.now() - startTime
            };
        }

        return c.json(data, status as any);

    } catch (err: any) {
        return c.json({ error: { message: err.message, type: "internal_server_error" } }, 500);
    }
});

// Gateway proxy for Brave Local POIs
v1.get('/brave/local/pois', async (c) => {
    const gatewayKey = c.get('gatewayKey');
    const budgetBlock = await enforceProjectBudget(c, gatewayKey);
    if (budgetBlock) return budgetBlock;
    const ids = c.req.queries('ids'); // expects ?ids=123&ids=456

    if (!ids || ids.length === 0) {
        return c.json({ error: "Missing 'ids' parameter" }, 400);
    }

    try {
        const { data: keys, error } = await supabase
            .from('upstream_keys')
            .select('*')
            .eq('project_id', gatewayKey.project_id)
            .eq('provider', 'brave');

        if (error || !keys || keys.length === 0) return c.json({ error: "No Brave Search keys configured" }, 404);

        const healthyKeys = (keys || []).filter((k: any) => !providerStates[k.id] || providerStates[k.id].status === 'healthy');
        if (healthyKeys.length === 0) return c.json({ error: "All keys exhausted" }, 429);

        const projectId = gatewayKey.project_id;
        if (braveCounters[projectId] === undefined) braveCounters[projectId] = 0;
        const selectedKey = healthyKeys[braveCounters[projectId]++ % healthyKeys.length];

        const url = new URL('https://api.search.brave.com/res/v1/local/pois');
        ids.forEach(id => url.searchParams.append('ids', id));

        const response = await fetch(url.toString(), {
            method: 'GET',
            headers: {
                'Accept': 'application/json',
                'X-Subscription-Token': selectedKey.api_key
            }
        });

        const data = await (response.ok ? response.json() : response.text());

        if (response.status === 429) markProviderError(selectedKey.id, 'rate_limited', 'Brave Search Local API Rate limit exceeded');
        if (response.ok) updateProviderCalls(selectedKey.id, 0);

        return c.json(data, response.status as any);
    } catch (err: any) {
        return c.json({ error: err.message }, 500);
    }
});

// Gateway proxy for Brave Local Descriptions (AI-generated location summaries)
v1.get('/brave/local/descriptions', async (c) => {
    const gatewayKey = c.get('gatewayKey');
    const budgetBlock = await enforceProjectBudget(c, gatewayKey);
    if (budgetBlock) return budgetBlock;
    const ids = c.req.queries('ids');

    if (!ids || ids.length === 0) return c.json({ error: "Missing 'ids' parameter" }, 400);

    try {
        const { data: keys, error } = await supabase
            .from('upstream_keys')
            .select('*')
            .eq('project_id', gatewayKey.project_id)
            .eq('provider', 'brave');

        if (error || !keys || keys.length === 0) return c.json({ error: "No Brave Search keys configured" }, 404);

        const healthyKeys = (keys || []).filter((k: any) => !providerStates[k.id] || providerStates[k.id].status === 'healthy');
        if (healthyKeys.length === 0) return c.json({ error: "All keys exhausted" }, 429);

        const projectId = gatewayKey.project_id;
        if (braveCounters[projectId] === undefined) braveCounters[projectId] = 0;
        const selectedKey = healthyKeys[braveCounters[projectId]++ % healthyKeys.length];

        const url = new URL('https://api.search.brave.com/res/v1/local/descriptions');
        ids.forEach(id => url.searchParams.append('ids', id));

        const response = await fetch(url.toString(), {
            method: 'GET',
            headers: {
                'Accept': 'application/json',
                'X-Subscription-Token': selectedKey.api_key
            }
        });

        const data = await (response.ok ? response.json() : response.text());

        if (response.status === 429) markProviderError(selectedKey.id, 'rate_limited', 'Brave Local Descriptions Rate limit exceeded');
        if (response.ok) updateProviderCalls(selectedKey.id, 0);

        return c.json(data, response.status as any);
    } catch (err: any) {
        return c.json({ error: err.message }, 500);
    }
});


// ─────────────────────────────────────────────────────────────────────────────
// /v1/embeddings — Proxy to Google Gemini Embeddings API
// OpenAI-compatible interface → Gemini API format
// Uses gateway_key_models routing (same as chat/completions)
// Add "gemini-embedding-2-preview" to your project's model list to enable
// ─────────────────────────────────────────────────────────────────────────────
const embeddingCounters: Record<string, number> = {};

v1.post('/embeddings', async (c) => {
    const gatewayKey = c.get('gatewayKey');
    const allowedModels = gatewayKey.gateway_key_models || [];
    const budgetBlock = await enforceProjectBudget(c, gatewayKey);
    if (budgetBlock) return budgetBlock;

    try {
        const body = await c.req.json();
        const requestedModel: string = body.model || 'gemini-embedding-2-preview';
        const input: string | string[] = body.input;

        if (!input) {
            return c.json({ error: { message: "Missing 'input' field", type: "invalid_request_error" } }, 400);
        }

        // Use same model routing as chat/completions
        const allowed = allowedModels.filter((m: any) => m.model_name === requestedModel);

        if (allowed.length === 0) {
            return c.json({ error: { message: `Model ${requestedModel} is not available for this API key. Add it to your project's model list.`, type: "invalid_request_error" } }, 403);
        }

        // Filter healthy upstream keys
        const nonPausedAllowed = allowed.filter((m: any) => checkAndRecoverProvider(m.upstream_key_id) !== 'paused');
        const healthyAllowed = nonPausedAllowed.filter((m: any) => checkAndRecoverProvider(m.upstream_key_id) === 'healthy');
        const candidates = healthyAllowed.length > 0 ? healthyAllowed : nonPausedAllowed;

        if (candidates.length === 0) {
            return c.json({ error: { message: `All upstream keys for ${requestedModel} are paused or unavailable.`, type: "server_error" } }, 503);
        }

        // Normalize input to array
        const inputs: string[] = Array.isArray(input) ? input : [input];

        // Round-robin rotation across upstream keys to start at a different offset each time
        const counterKey = `embed:${gatewayKey.id}:${requestedModel}`;
        if (embeddingCounters[counterKey] === undefined) embeddingCounters[counterKey] = 0;
        const startIndex = embeddingCounters[counterKey]++;

        let finalResponse = null;
        let finalStatus = 500;
        let finalErrorMsg = "All upstream candidates failed";

        for (let i = 0; i < candidates.length; i++) {
            const selectedMapping = candidates[(startIndex + i) % candidates.length];

            // Fetch upstream key details
            const { data: upstream, error } = await supabase
                .from('upstream_keys')
                .select('*')
                .eq('id', selectedMapping.upstream_key_id)
                .single();

            if (error || !upstream) {
                const ts = new Date().toISOString();
                console.error(`[${ts}] [Embeddings] Upstream key ${selectedMapping.upstream_key_id} not found in DB`);
                continue;
            }

            // Call Gemini batchEmbedContents API
            const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${requestedModel}:batchEmbedContents?key=${upstream.api_key}`;
            const geminiBody = {
                requests: inputs.map((text: string) => ({
                    model: `models/${requestedModel}`,
                    content: { parts: [{ text }] }
                }))
            };

            const startTime = Date.now();
            try {
                const response = await fetch(geminiUrl, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(geminiBody)
                });

                if (!response.ok) {
                    const errData = await response.json().catch(() => ({}));
                    const errMsg = errData.error?.message || response.statusText;
                    const isRateLimit = response.status === 429;
                    markProviderError(upstream.id, isRateLimit ? 'rate_limited' : 'error', errMsg);
                    const ts = new Date().toISOString();
                    console.error(`[${ts}] [Embeddings] ${upstream.provider} error ${response.status} (key ${upstream.id.substring(0, 8)}): ${errMsg}`);
                    finalStatus = response.status;
                    finalErrorMsg = errMsg;
                    continue; // try next candidate
                }

                const geminiData: any = await response.json();
                const promptTokens = inputs.reduce((acc: number, t: string) => acc + Math.ceil(t.length / 4), 0);
                updateProviderCalls(upstream.id, promptTokens);

                const latencyMs = Date.now() - startTime;
                const ts = new Date().toISOString();
                console.log(`[${ts}] [Embeddings] model=${requestedModel} inputs=${inputs.length} latency=${latencyMs}ms upstream=${upstream.id.substring(0, 8)}...`);

                const costFields = await buildCostFields(requestedModel, upstream.provider, promptTokens, 0);
                insertRequestLog({
                    project_id: gatewayKey.project_id,
                    gateway_key_id: gatewayKey.id,
                    upstream_key_id: upstream.id,
                    provider: upstream.provider,
                    model: requestedModel,
                    status_code: 200,
                    latency_ms: latencyMs,
                    total_tokens: promptTokens,
                    prompt_tokens: promptTokens,
                    completion_tokens: 0,
                    ...costFields,
                    error_message: null,
                }).catch(() => { });

                // Convert Gemini → OpenAI format
                const embeddings = (geminiData.embeddings || []).map((emb: any, index: number) => ({
                    object: 'embedding',
                    index,
                    embedding: emb.values
                }));

                finalResponse = {
                    object: 'list',
                    data: embeddings,
                    model: requestedModel,
                    usage: {
                        prompt_tokens: promptTokens,
                        completion_tokens: 0,
                        total_tokens: promptTokens
                    }
                };
                finalStatus = 200;
                break; // success, break the loop
            } catch (err: any) {
                const ts = new Date().toISOString();
                console.error(`[${ts}] [Embeddings] Fetch error for key ${upstream.id.substring(0, 8)}: ${err.message}`);
                markProviderError(upstream.id, 'error', err.message);
                finalStatus = 500;
                finalErrorMsg = err.message;
                continue; // try next candidate
            }
        }

        if (finalResponse) {
            return c.json(finalResponse, finalStatus as any);
        } else {
            return c.json({ error: { message: finalErrorMsg, type: "api_error" } }, finalStatus as any);
        }

    } catch (err: any) {
        return c.json({ error: { message: err.message, type: "internal_server_error" } }, 500);
    }
});

// ─── POST /v1/audio/transcriptions ──────────────────────────────────────────
// Proxies speech-to-text (Whisper) requests to the upstream provider.
// Accepts multipart/form-data with an audio file + model field.
v1.post('/audio/transcriptions', async (c) => {
    const gatewayKey = c.get('gatewayKey');
    const allowedModels = gatewayKey.gateway_key_models || [];
    const startTime = Date.now();

    try {
        const formData = await c.req.formData();
        const requestedModel = (formData.get('model') as string) || 'whisper-large-v3';

        // Find a matching upstream key for this model
        const candidates = allowedModels.filter((m: any) => m.model_name === requestedModel);
        if (candidates.length === 0) {
            return c.json({ error: { message: `Model "${requestedModel}" not found in gateway key.`, type: 'invalid_request_error' } }, 400);
        }

        const selectedMapping = candidates[0];
        const { data: upstream } = await supabase
            .from('upstream_keys')
            .select('id, provider, api_key')
            .eq('id', selectedMapping.upstream_key_id)
            .single();

        if (!upstream) {
            return c.json({ error: { message: 'Upstream provider not found.', type: 'server_error' } }, 500);
        }

        // Build upstream model name (alias translation)
        const upstreamModel = selectedMapping.upstream_model_name || requestedModel;

        // Determine transcription URL per provider
        let transcriptionUrl = '';
        if (upstream.provider === 'groq') transcriptionUrl = 'https://api.groq.com/openai/v1/audio/transcriptions';
        else if (upstream.provider === 'openai') transcriptionUrl = 'https://api.openai.com/v1/audio/transcriptions';
        else if (upstream.provider === 'openrouter') transcriptionUrl = 'https://openrouter.ai/api/v1/audio/transcriptions';
        else {
            return c.json({ error: { message: `Provider "${upstream.provider}" does not support audio transcriptions.`, type: 'invalid_request_error' } }, 400);
        }

        // Forward the multipart form-data to the upstream
        const forwardForm = new FormData();
        forwardForm.set('model', upstreamModel);
        const audioFile = formData.get('file');
        if (audioFile) forwardForm.set('file', audioFile as Blob);
        const lang = formData.get('language');
        if (lang) forwardForm.set('language', lang as string);
        const prompt = formData.get('prompt');
        if (prompt) forwardForm.set('prompt', prompt as string);
        const fmt = formData.get('response_format');
        if (fmt) forwardForm.set('response_format', fmt as string);

        const upstreamRes = await fetch(transcriptionUrl, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${upstream.api_key}` },
            body: forwardForm,
        });

        const latencyMs = Date.now() - startTime;
        const responseText = await upstreamRes.text();

        // Log the request
        insertRequestLog({
            project_id: gatewayKey.project_id,
            gateway_key_id: gatewayKey.id,
            upstream_key_id: upstream.id,
            provider: upstream.provider,
            model: requestedModel,
            status_code: upstreamRes.status,
            latency_ms: latencyMs,
            total_tokens: 0,
            prompt_tokens: 0,
            completion_tokens: 0,
        });

        if (!upstreamRes.ok) {
            let errBody: any = { error: { message: responseText, type: 'upstream_error' } };
            try { errBody = JSON.parse(responseText); } catch { /* keep text */ }
            return c.json({ ...errBody, _openclaw_metadata: { provider: upstream.provider, upstream_key_id: upstream.id } }, upstreamRes.status as any);
        }

        // Return JSON or plain text depending on response_format
        const contentType = upstreamRes.headers.get('content-type') || '';
        if (contentType.includes('application/json')) {
            try {
                const json = JSON.parse(responseText);
                return c.json({ ...json, _openclaw_metadata: { provider: upstream.provider, upstream_key_id: upstream.id } });
            } catch { /* fall through */ }
        }
        // Plain text transcript
        return c.json({ text: responseText, _openclaw_metadata: { provider: upstream.provider, upstream_key_id: upstream.id } });

    } catch (err: any) {
        return c.json({ error: { message: err.message, type: 'internal_server_error' } }, 500);
    }
});

// ─── POST /v1/audio/speech ──────────────────────────────────────────────────
// Proxies text-to-speech requests to the upstream provider.
// Accepts JSON: { model, input, voice, response_format, speed }
// Returns audio binary (mp3/opus/wav) forwarded from upstream.
v1.post('/audio/speech', async (c) => {
    const gatewayKey = c.get('gatewayKey');
    const allowedModels = gatewayKey.gateway_key_models || [];
    const startTime = Date.now();

    try {
        const body = await c.req.json();
        const requestedModel: string = body.model || '';

        const candidates = allowedModels.filter((m: any) => m.model_name === requestedModel);
        if (candidates.length === 0) {
            return c.json({ error: { message: `Model "${requestedModel}" not found in gateway key.`, type: 'invalid_request_error' } }, 400);
        }

        const selectedMapping = candidates[0];
        const { data: upstream } = await supabase
            .from('upstream_keys')
            .select('id, provider, api_key')
            .eq('id', selectedMapping.upstream_key_id)
            .single();

        if (!upstream) {
            return c.json({ error: { message: 'Upstream provider not found.', type: 'server_error' } }, 500);
        }

        const upstreamModel = selectedMapping.upstream_model_name || requestedModel;

        // Determine TTS URL per provider
        let speechUrl = '';
        if (upstream.provider === 'openai') speechUrl = 'https://api.openai.com/v1/audio/speech';
        else if (upstream.provider === 'groq') speechUrl = 'https://api.groq.com/openai/v1/audio/speech';
        else if (upstream.provider === 'mistral') speechUrl = 'https://api.mistral.ai/v1/audio/speech';
        else if (upstream.provider === 'openrouter') speechUrl = 'https://openrouter.ai/api/v1/audio/speech';
        else {
            return c.json({ error: { message: `Provider "${upstream.provider}" does not support text-to-speech.`, type: 'invalid_request_error' } }, 400);
        }

        const forwardBody = { ...body, model: upstreamModel };

        const upstreamRes = await fetch(speechUrl, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${upstream.api_key}`, 'Content-Type': 'application/json' },
            body: JSON.stringify(forwardBody),
        });

        const latencyMs = Date.now() - startTime;

        insertRequestLog({
            project_id: gatewayKey.project_id,
            gateway_key_id: gatewayKey.id,
            upstream_key_id: upstream.id,
            provider: upstream.provider,
            model: requestedModel,
            status_code: upstreamRes.status,
            latency_ms: latencyMs,
            total_tokens: 0,
            prompt_tokens: 0,
            completion_tokens: 0,
        });

        if (!upstreamRes.ok) {
            const errText = await upstreamRes.text();
            let errBody: any = { error: { message: errText, type: 'upstream_error' } };
            try { errBody = JSON.parse(errText); } catch { /* keep text */ }
            return c.json({ ...errBody, _openclaw_metadata: { provider: upstream.provider, upstream_key_id: upstream.id } }, upstreamRes.status as any);
        }

        // Stream binary audio back to client
        const audioBuffer = await upstreamRes.arrayBuffer();
        const contentType = upstreamRes.headers.get('content-type') || 'audio/mpeg';
        return new Response(audioBuffer, {
            status: 200,
            headers: {
                'Content-Type': contentType,
                'X-OpenClaw-Provider': upstream.provider,
            },
        });

    } catch (err: any) {
        return c.json({ error: { message: err.message, type: 'internal_server_error' } }, 500);
    }
});

export default v1;

