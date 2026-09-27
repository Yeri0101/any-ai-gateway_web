import { stream } from 'hono/streaming';
import { supabase } from '../db';
import { providerStates, updateProviderCalls, markProviderError, checkAndRecoverProvider } from './limitTracker';
import { callPuterAI, callPuterAIStream } from './puterClient';
import { buildCacheKey, getCached, setCached, setCachedStream, estimateStreamUsage, recordTokensSaved } from './semanticCache';
import { pruneContext } from './contextPruner';
import { isProviderSlow, recordLatency, markProviderSlow, LATENCY_ABORT_TIMEOUT_MS } from './latencyGuard';
import { classifyRequest, filterCandidatesByTier, estimateTokenCount } from './smartRouter';
import {
    checkRateLimitCapacity,
    recordRateLimitConsumption,
    ingestRateLimitHeaders,
    markRateLimitExceeded,
    getOrCreateKeyState,
    prioritizeCandidatesByRound,
    recordKeyUsedInRound,
    calculateQuotaResetTime,
    handleEarlyUpstreamAnomaly
} from './freeTierGuardian';
import { consultSystemOne, getEngineConfig } from './engineBridge';
import { resolveModelOrHeal, HealingResult } from './modelHealing';
import { notifyNewRequest } from './dashboardEvents';
import { canPassCircuit, recordCircuitSuccess, recordCircuitFailure } from './circuitBreaker';
import { dispatchAlert } from './alertDispatcher';
import { getFallbackMarketPricing, getModelLookupCandidates, calculateTokenCost } from './pricingHelper';

export type UsageBreakdown = {
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

export interface CompletionEngineOptions {
    body: any;
    gatewayKey: any;
    c?: any;
    returnRawStream?: boolean;
    isInternalCall?: boolean;
    _hasFallenBack?: boolean;
}

// Fallback hierarchy for models when daily quota is exhausted or provider is congested
export const MODEL_FALLBACK_CHAINS: Record<string, string[]> = {
    'gemini-3.8-flash': ['gemini-3.7-flash', 'gemini-3.6-flash', 'gemini-3.5-flash', 'gemini-3.5-flash-lite'],
    'gemini-3.7-flash': ['gemini-3.6-flash', 'gemini-3.5-flash', 'gemini-3.5-flash-lite'],
    'gemini-3.6-flash': ['gemini-3.5-flash', 'gemini-3.5-flash-lite'],
    'gemini-3.5-flash': ['gemini-3.5-flash-lite'],
};

export interface CompletionEngineResult {
    ok: boolean;
    data?: any;
    rawResponse?: Response;
    status: number;
    error?: any;
    provider?: string | null;
    upstreamKeyId?: string | null;
    routingTier?: string;
    isCacheHit?: boolean;
}

// In-memory counter for round-robin load balancing
export const modelCounters: Record<string, number> = {};

export function normalizeUsage(usage: any, fallbackPromptTokens = 0): UsageBreakdown {
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

export async function insertRequestLog(entry: {
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

interface CachedUpstreamKey {
    data: any;
    expiresAt: number;
}
export const upstreamKeyCache = new Map<string, CachedUpstreamKey>();
const UPSTREAM_KEY_TTL_MS = 60_000;

export function invalidateUpstreamKeyCache(id?: string): void {
    if (id) upstreamKeyCache.delete(id);
    else upstreamKeyCache.clear();
}

export async function getCachedUpstreamKey(id: string): Promise<any> {
    const cached = upstreamKeyCache.get(id);
    if (cached && cached.expiresAt > Date.now()) {
        return cached.data;
    }
    const { data, error } = await supabase
        .from('upstream_keys')
        .select('*')
        .eq('id', id)
        .single();
    if (data && !error) {
        upstreamKeyCache.set(id, { data, expiresAt: Date.now() + UPSTREAM_KEY_TTL_MS });
    }
    return data;
}

export async function getCachedUpstreamMetadata(ids: string[]): Promise<Record<string, { provider: string; billing_type: string }>> {
    const map: Record<string, { provider: string; billing_type: string }> = {};
    const missingIds: string[] = [];

    for (const id of ids) {
        const cached = upstreamKeyCache.get(id);
        if (cached && cached.expiresAt > Date.now()) {
            map[id] = { provider: cached.data.provider, billing_type: cached.data.billing_type || 'free' };
        } else {
            missingIds.push(id);
        }
    }

    if (missingIds.length > 0) {
        const { data } = await supabase
            .from('upstream_keys')
            .select('*')
            .in('id', missingIds);

        (data || []).forEach((row: any) => {
            upstreamKeyCache.set(row.id, { data: row, expiresAt: Date.now() + UPSTREAM_KEY_TTL_MS });
            map[row.id] = { provider: row.provider, billing_type: row.billing_type || 'free' };
        });
    }

    return map;
}

const pricingCache = new Map<string, { data: PricingMatch | null; expiresAt: number }>();
const PRICING_TTL_MS = 300_000;

export async function getPricingForModel(model: string, provider: string | null): Promise<PricingMatch> {
    const cacheKey = `${model}:${provider || '*'}`;
    const cached = pricingCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now() && cached.data) {
        return cached.data;
    }

    const candidates = getModelLookupCandidates(model);

    try {
        const { data, error } = await supabase
            .from('model_pricing')
            .select('provider, model_name, input_price_per_1m, output_price_per_1m, is_active')
            .in('model_name', candidates)
            .eq('is_active', true)
            .in('provider', provider ? [provider, '*'] : ['*']);

        if (!error && data && data.length > 0) {
            const exact = provider ? data.find((row: any) => row.provider === provider) : null;
            const fallback = data.find((row: any) => row.provider === '*');
            const match = exact || fallback || data[0];
            if (match) {
                const result: PricingMatch = {
                    provider: match.provider,
                    model_name: match.model_name,
                    input_price_per_1m: Number(match.input_price_per_1m || 0),
                    output_price_per_1m: Number(match.output_price_per_1m || 0),
                };
                pricingCache.set(cacheKey, { data: result, expiresAt: Date.now() + PRICING_TTL_MS });
                return result;
            }
        }
    } catch (err) {
        console.error('Pricing lookup error:', err);
    }

    // Comprehensive standard market rates fallback so NO model is ever priced at $0
    const fallbackPricing = getFallbackMarketPricing(model, provider);
    pricingCache.set(cacheKey, { data: fallbackPricing, expiresAt: Date.now() + PRICING_TTL_MS });
    return fallbackPricing;
}

export async function buildCostFields(model: string, provider: string | null, promptTokens: number, completionTokens: number) {
    const pricing = await getPricingForModel(model, provider);
    const cost = calculateTokenCost(model, provider, promptTokens, completionTokens, promptTokens + completionTokens, pricing);

    return {
        input_cost_usd: cost.input_cost_usd,
        output_cost_usd: cost.output_cost_usd,
        total_cost_usd: cost.total_cost_usd,
        pricing_provider: pricing.provider,
        pricing_model_name: pricing.model_name,
        pricing_input_per_1m: pricing.input_price_per_1m,
        pricing_output_per_1m: pricing.output_price_per_1m,
    };
}

/**
 * High-Capacity Failover Engine:
 * When an agent harness (OpenClaw, Claude Code, SWE-bench) sends large prompts (> 6,500 tokens)
 * or when upstream providers reject with HTTP 413 (e.g. Groq 7,000 ITPM limit),
 * this engine automatically rescues the turn by routing to high-context providers
 * (Google Gemini 1M context / 1M TPM, DeepSeek 128k context, OpenRouter, Mistral)
 * with zero user interruption and seamless streaming/tools compatibility.
 */
async function executeHighCapacityFailover({
    body,
    gatewayKey,
    c,
    returnRawStream,
    isInternalCall,
    originalModel,
    estimatedPromptTokens,
    reason,
}: {
    body: any;
    gatewayKey: any;
    c?: any;
    returnRawStream?: boolean;
    isInternalCall?: boolean;
    originalModel: string;
    estimatedPromptTokens: number;
    reason: string;
}): Promise<any> {
    console.log(`[CompletionEngine] 🚨 Engaging High-Capacity Context Failover for model '${originalModel}' (${estimatedPromptTokens} tokens). Reason: ${reason}`);

    // Fetch available high-capacity upstream keys (Google, DeepSeek, OpenRouter, Mistral)
    const { data: projectKeys } = await supabase
        .from('upstream_keys')
        .select('*')
        .eq('project_id', gatewayKey.project_id);

    const { data: allKeys } = await supabase
        .from('upstream_keys')
        .select('*');

    const highContextProviders = ['mimo', 'deepseek', 'openrouter', 'mistral'];

    // Combine project keys first, then gateway-wide keys
    const candidatePool = [...(projectKeys || [])];
    (allKeys || []).forEach((k: any) => {
        if (!candidatePool.some(existing => existing.id === k.id)) {
            candidatePool.push(k);
        }
    });

    const eligibleKeys = candidatePool
        .filter((k: any) => highContextProviders.includes(k.provider) && checkAndRecoverProvider(k.id) !== 'paused')
        .sort((a: any, b: any) => {
            const idxA = highContextProviders.indexOf(a.provider);
            const idxB = highContextProviders.indexOf(b.provider);
            return idxA - idxB;
        });

    if (eligibleKeys.length === 0) {
        console.error(`[CompletionEngine] High-Capacity Failover failed: No high-capacity upstream keys (Mimo/DeepSeek/OpenRouter) available in gateway.`);
        const errObj = {
            error: {
                message: `Gateway Context Overflow: The prompt (${estimatedPromptTokens} tokens) exceeds available provider limits (413 Request Too Large), and no high-context provider (Mimo, DeepSeek, OpenRouter) is configured.`,
                type: 'context_overflow_error',
                code: 'context_length_exceeded'
            }
        };
        if (c && !isInternalCall && !returnRawStream) {
            return c.json(errObj, 413);
        }
        return { ok: false, status: 413, error: errObj.error };
    }

    const startTime = Date.now();

    for (const upstream of eligibleKeys) {
        let resolvedModel = 'mimo-v2.6-flash';
        let baseUrl = '';

        if (upstream.provider === 'mimo') {
            resolvedModel = 'mimo-v2.6-flash';
            baseUrl = 'https://api.xiaomimimo.com/v1/chat/completions';
        } else if (upstream.provider === 'deepseek') {
            resolvedModel = 'deepseek-chat';
            baseUrl = 'https://api.deepseek.com/chat/completions';
        } else if (upstream.provider === 'openrouter') {
            resolvedModel = originalModel.includes('qwen') ? 'qwen/qwen-2.5-72b-instruct' : 'openrouter/auto';
            baseUrl = 'https://openrouter.ai/api/v1/chat/completions';
        } else if (upstream.provider === 'mistral') {
            resolvedModel = 'mistral-large-latest';
            baseUrl = 'https://api.mistral.ai/v1/chat/completions';
        }

        console.log(`[CompletionEngine] High-Capacity Failover: attempting upstream '${upstream.provider}' with model '${resolvedModel}' (key: ${upstream.id.substring(0, 8)}…)`);

        const forwardBody = JSON.parse(JSON.stringify(body));
        forwardBody.model = resolvedModel;
        delete forwardBody._targetSlotSource;
        delete forwardBody.fallbackDraftContent;
        delete forwardBody.fusion_models;
        delete forwardBody.fusion_panel;
        delete forwardBody.fusion_judge;
        delete forwardBody.judge;

        // Consolidate multiple system messages for strict upstreams
        if (Array.isArray(forwardBody.messages) && forwardBody.messages.length > 0) {
            const systemMsgs: any[] = [];
            const otherMsgs: any[] = [];
            for (const msg of forwardBody.messages) {
                if (msg.role === 'system') systemMsgs.push(msg);
                else otherMsgs.push(msg);
            }
            if (systemMsgs.length > 0) {
                const mergedContent = systemMsgs
                    .map((m: any) => {
                        if (typeof m.content === 'string') return m.content.trim();
                        if (Array.isArray(m.content)) {
                            return m.content.map((b: any) => (typeof b === 'string' ? b : b?.text ?? '')).join('').trim();
                        }
                        return '';
                    })
                    .filter(Boolean)
                    .join('\n\n');

                forwardBody.messages = [
                    { role: 'system', content: mergedContent },
                    ...otherMsgs,
                ];
            }
        }

        const abortController = new AbortController();
        const abortTimer = setTimeout(() => abortController.abort(), 60000);

        try {
            const response = await fetch(baseUrl, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${upstream.api_key}`,
                    ...(upstream.provider === 'openrouter' ? { 'HTTP-Referer': 'https://cursor.com', 'X-Title': 'Cursor Agent' } : {})
                },
                body: JSON.stringify(forwardBody),
                signal: abortController.signal,
            });

            clearTimeout(abortTimer);

            if (!response.ok) {
                const errData = await response.json().catch(() => ({}));
                console.warn(`[CompletionEngine] High-Capacity Failover key ${upstream.id.substring(0, 8)} (${upstream.provider}) returned ${response.status}:`, errData?.error?.message || response.statusText);
                continue;
            }

            const latencyMs = Date.now() - startTime;
            const healingReason = `Auto-healed from 413 context overflow (${estimatedPromptTokens} tokens exceeded ${reason}). Routed to ${resolvedModel} (${upstream.provider}).`;
            console.log(`[CompletionEngine] ✅ High-Capacity Failover SUCCESS via ${upstream.provider} (${resolvedModel}) in ${latencyMs}ms`);

            // Handle Streaming
            if (body.stream && response.body) {
                const finalPromptTokens = estimatedPromptTokens;
                const finalCompletionTokens = 0;
                const finalTokens = Math.max(500, finalPromptTokens + finalCompletionTokens);
                updateProviderCalls(upstream.id, finalTokens);
                recordRateLimitConsumption(upstream.id, finalTokens);

                const costFields = await buildCostFields(resolvedModel, upstream.provider, finalPromptTokens, finalCompletionTokens);
                insertRequestLog({
                    project_id: upstream.project_id || gatewayKey.project_id,
                    gateway_key_id: gatewayKey.id,
                    upstream_key_id: upstream.id,
                    provider: upstream.provider,
                    model: resolvedModel,
                    status_code: 200,
                    latency_ms: latencyMs,
                    total_tokens: finalTokens,
                    prompt_tokens: finalPromptTokens,
                    completion_tokens: finalCompletionTokens,
                    ...costFields,
                }).catch(() => { });

                if (returnRawStream) {
                    return {
                        ok: true,
                        rawResponse: response,
                        status: 200,
                        provider: upstream.provider,
                        upstreamKeyId: upstream.id,
                        routingTier: 'high_capacity_failover',
                        isHealed: true,
                        healingInfo: {
                            healed: true,
                            originalModel,
                            resolvedModel,
                            reason: healingReason,
                        }
                    };
                }

                if (c) {
                    c.header('Content-Type', 'text/event-stream');
                    c.header('Cache-Control', 'no-cache');
                    c.header('Connection', 'keep-alive');
                    c.header('X-TierMax-Healed', 'true');
                    c.header('X-TierMax-Original-Model', originalModel);
                    c.header('X-TierMax-Resolved-Model', resolvedModel);
                    c.header('X-TierMax-Healing-Reason', encodeURIComponent(healingReason));

                    return stream(c, async (s) => {
                        const reader = response.body!.getReader();
                        s.onAbort(() => reader.cancel().catch(() => { }));
                        try {
                            while (true) {
                                const { done, value } = await reader.read();
                                if (done) break;
                                await s.write(value);
                            }
                        } catch (err: any) {
                            try {
                                const errEvent = `data: ${JSON.stringify({ error: { message: `Stream terminated (${upstream.provider}): ${err.message}`, type: 'stream_error' } })}\n\ndata: [DONE]\n\n`;
                                await s.write(new TextEncoder().encode(errEvent));
                            } catch { }
                        }
                    });
                }
            }

            // Handle Non-Streaming
            const data = await response.json();
            const usage = normalizeUsage(data.usage, estimatedPromptTokens);
            const finalPromptTokens = usage.prompt_tokens;
            const finalCompletionTokens = usage.completion_tokens;
            const finalTokens = usage.total_tokens;

            updateProviderCalls(upstream.id, finalTokens);
            recordRateLimitConsumption(upstream.id, finalTokens);

            const costFields = await buildCostFields(resolvedModel, upstream.provider, finalPromptTokens, finalCompletionTokens);
            insertRequestLog({
                project_id: upstream.project_id || gatewayKey.project_id,
                gateway_key_id: gatewayKey.id,
                upstream_key_id: upstream.id,
                provider: upstream.provider,
                model: resolvedModel,
                status_code: 200,
                latency_ms: latencyMs,
                total_tokens: finalTokens,
                prompt_tokens: finalPromptTokens,
                completion_tokens: finalCompletionTokens,
                ...costFields,
            }).catch(() => { });

            data._openclaw_healing = {
                healed: true,
                original_model: originalModel,
                resolved_model: resolvedModel,
                reason: healingReason,
            };

            if (c && !isInternalCall && !returnRawStream) {
                c.header('X-Cache', 'MISS');
                c.header('X-Router-Tier', 'high_capacity_failover');
                c.header('X-TierMax-Healed', 'true');
                c.header('X-TierMax-Original-Model', originalModel);
                c.header('X-TierMax-Resolved-Model', resolvedModel);
                c.header('X-TierMax-Healing-Reason', encodeURIComponent(healingReason));
                return c.json(data, 200);
            }

            return {
                ok: true,
                data,
                status: 200,
                provider: upstream.provider,
                upstreamKeyId: upstream.id,
                routingTier: 'high_capacity_failover',
                isHealed: true,
                healingInfo: {
                    healed: true,
                    originalModel,
                    resolvedModel,
                    reason: healingReason,
                }
            };

        } catch (fetchErr: any) {
            clearTimeout(abortTimer);
            console.warn(`[CompletionEngine] High-Capacity Failover attempt failed on ${upstream.provider}:`, fetchErr.message);
            continue;
        }
    }

    const errObj = {
        error: {
            message: `Gateway: High-Capacity Failover attempted all eligible providers (Google, DeepSeek, OpenRouter), but all returned errors for prompt size (${estimatedPromptTokens} tokens).`,
            type: 'server_error'
        }
    };
    if (c && !isInternalCall && !returnRawStream) {
        return c.json(errObj, 502);
    }
    return { ok: false, status: 502, error: errObj.error };
}

/**
 * Main completion execution engine.
 * Handles candidate resolution, routing tier filtering, round-robin selection,
 * fallback retry loop, prompt restructuring, latency guard, and provider normalizations.
 */
export async function executeCompletionEngine(options: CompletionEngineOptions): Promise<any> {
    const startTime = Date.now();
    const { body, gatewayKey, c, returnRawStream = false, isInternalCall = false } = options;
    const allowedModels = gatewayKey.gateway_key_models || [];
    let requestedModel: string = body.model || '';

    if (isInternalCall && !returnRawStream) {
        body.stream = false;
    }

    // Check if the gateway key is allowed to use this model
    let allowed = allowedModels.filter((m: any) => m.model_name === requestedModel);

    // Explicit slot target resolution from Virtual Consensus Fusion
    const targetSource: string = body._targetSlotSource || '';
    if (targetSource) {
        delete body._targetSlotSource;
        if (targetSource.startsWith('project:')) {
            const projId = targetSource.replace('project:', '');
            const { data: projKeys } = await supabase
                .from('upstream_keys')
                .select('id, provider')
                .eq('project_id', projId);
            if (projKeys && projKeys.length > 0) {
                const sampleProvider = projKeys[0].provider;
                // Auto-heal model if provider cannot service requested model
                if (sampleProvider === 'mimo' && !requestedModel.toLowerCase().includes('mimo')) {
                    console.log(`[CompletionEngine] Auto-healing slot model '${requestedModel}' for Mimo channel to 'mimo-v2.6-flash'`);
                    requestedModel = 'mimo-v2.6-flash';
                    body.model = requestedModel;
                } else if (sampleProvider === 'deepseek' && (!requestedModel.toLowerCase().includes('deepseek') || requestedModel.toLowerCase().includes('deepseek-v4'))) {
                    console.log(`[CompletionEngine] Auto-healing slot model '${requestedModel}' for DeepSeek channel to 'deepseek-chat'`);
                    requestedModel = 'deepseek-chat';
                    body.model = requestedModel;
                } else if (sampleProvider === 'openrouter' && (requestedModel.includes('max-prime') || requestedModel.includes('qwen3.8-max'))) {
                    console.log(`[CompletionEngine] Auto-healing '${requestedModel}' for OpenRouter channel to 'qwen/qwen-2.5-72b-instruct'`);
                    requestedModel = 'qwen/qwen-2.5-72b-instruct';
                    body.model = requestedModel;
                } else if (sampleProvider === 'nvidia' && !requestedModel.toLowerCase().includes('nvidia') && !requestedModel.toLowerCase().includes('diffusiongemma') && !requestedModel.toLowerCase().includes('deepseek') && !requestedModel.toLowerCase().includes('codegemma')) {
                    console.log(`[CompletionEngine] Auto-healing slot model '${requestedModel}' for Nvidia channel to 'google/diffusiongemma-26b-a4b-it'`);
                    requestedModel = 'google/diffusiongemma-26b-a4b-it';
                    body.model = requestedModel;
                } else if (sampleProvider === 'groq' && !requestedModel.toLowerCase().includes('groq') && !requestedModel.toLowerCase().includes('qwen') && !requestedModel.toLowerCase().includes('llama') && !requestedModel.toLowerCase().includes('gpt-oss') && !requestedModel.toLowerCase().includes('allam')) {
                    console.log(`[CompletionEngine] Auto-healing slot model '${requestedModel}' for Groq channel to 'qwen/qwen3.8-27b'`);
                    requestedModel = 'qwen/qwen3.8-27b';
                    body.model = requestedModel;
                }

                if (sampleProvider !== 'openrouter' && (requestedModel.includes(':free') || requestedModel.startsWith('thinkingmachines/') || requestedModel.startsWith('poolside/'))) {
                    const { data: orKeys } = await supabase
                        .from('upstream_keys')
                        .select('id, provider')
                        .eq('provider', 'openrouter');
                    if (orKeys && orKeys.length > 0) {
                        allowed = orKeys.map((k: any) => ({
                            upstream_key_id: k.id,
                            model_name: requestedModel,
                            upstream_model_name: null,
                        }));
                    }
                }

                if (allowed.length === 0) {
                    allowed = projKeys.map((k: any) => ({
                        upstream_key_id: k.id,
                        model_name: requestedModel,
                        upstream_model_name: null,
                    }));
                }

                // Resilient slot failover: Append active free keys from other free projects as backup candidates
                const { data: backupFreeKeys } = await supabase
                    .from('upstream_keys')
                    .select('id, provider')
                    .eq('billing_type', 'free')
                    .neq('project_id', projId);
                if (backupFreeKeys && backupFreeKeys.length > 0) {
                    const backupAllowed = backupFreeKeys.map((k: any) => ({
                        upstream_key_id: k.id,
                        model_name: requestedModel,
                        upstream_model_name: null,
                    }));
                    allowed = [...allowed, ...backupAllowed];
                }
            }
        } else {
            const keyId = targetSource.replace('key:', '');
            allowed = [{
                upstream_key_id: keyId,
                model_name: requestedModel,
                upstream_model_name: null,
            }];
        }
    }

    const engineConfig = getEngineConfig(false);
    const isStrictFree = engineConfig?.strictFreeTierMode ?? true;

    // Cross-project resolution & Free-Tier Priority:
    // 1. If allowed is empty, search across all projects (internal or external).
    // 2. If strictFreeTierMode is active and allowed has NO free keys, discover and prepend matching free-tier keys!
    const alreadyHasProjectKeys = allowed.length > 0;
    if (!alreadyHasProjectKeys || isInternalCall) {
        // 1. Direct model lookup across all projects
        const { data: globalMatches } = await supabase
            .from('gateway_key_models')
            .select('upstream_key_id, model_name, upstream_model_name')
            .eq('model_name', requestedModel);

        if (globalMatches && globalMatches.length > 0 && allowed.length === 0) {
            allowed = globalMatches;
        } else {
            // 2. Provider-heuristic lookup across all upstream_keys in the gateway
            const { data: allUpstreams } = await supabase
                .from('upstream_keys')
                .select('id, provider, billing_type');

            let matchingGlobal: any[] = [];
            const reqLower = requestedModel.toLowerCase();
            if (reqLower.includes('mimo')) {
                matchingGlobal = (allUpstreams || []).filter((k: any) => k.provider === 'mimo');
            } else if (reqLower.includes('deepseek')) {
                matchingGlobal = (allUpstreams || []).filter((k: any) => k.provider === 'deepseek' || (k.provider === 'nvidia' && k.billing_type === 'free'));
            } else if (reqLower.includes('gemini') || reqLower.includes('google')) {
                matchingGlobal = (allUpstreams || []).filter((k: any) => k.provider === 'google' || (k.provider === 'nvidia' && k.billing_type === 'free') || (k.provider === 'openrouter' && k.billing_type === 'free'));
                // Ensure native Google keys are always first
                matchingGlobal.sort((a: any, b: any) => {
                    if (a.provider === 'google' && b.provider !== 'google') return -1;
                    if (b.provider === 'google' && a.provider !== 'google') return 1;
                    return 0;
                });
            } else if (reqLower.includes('groq') || reqLower.includes('llama')) {
                matchingGlobal = (allUpstreams || []).filter((k: any) => k.provider === 'groq');
            } else if (reqLower.includes('qwen') || reqLower.includes('cerebras')) {
                matchingGlobal = (allUpstreams || []).filter((k: any) => (k.provider === 'groq' && k.billing_type === 'free') || (k.provider === 'openrouter' && k.billing_type === 'free') || k.provider === 'cerebras');
            } else if (reqLower.includes('gpt') || reqLower.includes('oss')) {
                matchingGlobal = (allUpstreams || []).filter((k: any) => k.provider === 'groq');
            } else if (reqLower.includes('diffusiongemma') || reqLower.includes('codegemma')) {
                matchingGlobal = (allUpstreams || []).filter((k: any) => k.provider === 'nvidia');
            } else if (reqLower.includes('mistral') || reqLower.includes('codestral')) {
                matchingGlobal = (allUpstreams || []).filter((k: any) => k.provider === 'mistral');
            } else if (reqLower.includes('claude')) {
                matchingGlobal = (allUpstreams || []).filter((k: any) => k.provider === 'puter');
            }

            if (matchingGlobal.length === 0 && allowed.length === 0) {
                // Fallback to openrouter free keys first, then any openrouter
                matchingGlobal = (allUpstreams || []).filter((k: any) => k.provider === 'openrouter');
            }

            if (matchingGlobal.length > 0) {
                const mappedGlobal = matchingGlobal.map((k: any) => ({
                    upstream_key_id: k.id,
                    model_name: requestedModel,
                    upstream_model_name: null,
                }));
                if (allowed.length === 0) {
                    allowed = mappedGlobal;
                }
            }
        }
    }

    let isHealed = false;
    let healingInfo: HealingResult | null = null;

    // --- Self-Healing Auto-Remap Engine ---
    // If model is not explicitly configured on this key (e.g. deprecated or retired by OpenAI/Anthropic),
    // automatically find the best active replacement in this project to prevent agent failure.
    if (allowed.length === 0) {
        const configuredProjectModels: string[] = (allowedModels || [])
            .map((m: any) => m.model_name)
            .filter(Boolean);

        const { data: projectKeys } = await supabase
            .from('upstream_keys')
            .select('id, provider')
            .eq('project_id', gatewayKey.project_id);

        const projectProviders = (projectKeys || []).map((k: any) => ({ id: k.id, provider: k.provider }));

        const { data: allKeyModels } = await supabase
            .from('gateway_keys')
            .select('gateway_key_models(model_name)')
            .eq('project_id', gatewayKey.project_id);

        (allKeyModels || []).forEach((gk: any) => {
            (gk.gateway_key_models || []).forEach((m: any) => {
                if (m.model_name && !configuredProjectModels.includes(m.model_name)) {
                    configuredProjectModels.push(m.model_name);
                }
            });
        });

        const healResult = resolveModelOrHeal(
            gatewayKey.project_id,
            requestedModel,
            configuredProjectModels,
            projectProviders
        );

        if (healResult.healed) {
            isHealed = true;
            healingInfo = healResult;
            console.log(`[CompletionEngine] Self-Healing engaged for project ${gatewayKey.project_id}: '${requestedModel}' -> '${healResult.resolvedModel}'`);
            requestedModel = healResult.resolvedModel;
            body.model = requestedModel;

            // Re-bind allowed models using healed model
            allowed = allowedModels.filter((m: any) => m.model_name === requestedModel);
            if (allowed.length === 0 && projectKeys && projectKeys.length > 0) {
                allowed = projectKeys.map((k: any) => ({
                    upstream_key_id: k.id,
                    model_name: requestedModel,
                    upstream_model_name: null,
                }));
            }
        } else if (projectKeys && projectKeys.length > 0) {
            // Heuristic matching for specific families if not explicitly healed
            let matchingKeys: any[] = [];
            if (requestedModel.includes('deepseek')) {
                matchingKeys = projectKeys.filter((k: any) => k.provider === 'deepseek' || k.provider === 'groq' || k.provider === 'openrouter');
            } else if (requestedModel.includes('qwen')) {
                matchingKeys = projectKeys.filter((k: any) => k.provider === 'groq' || k.provider === 'cerebras' || k.provider === 'openrouter');
            } else if (requestedModel.includes('kimi') || requestedModel.includes('moonshot')) {
                matchingKeys = projectKeys.filter((k: any) => k.provider === 'nvidia' || k.provider === 'moonshot' || k.provider === 'openrouter');
            } else if (requestedModel.includes('minimax')) {
                matchingKeys = projectKeys.filter((k: any) => k.provider === 'nvidia' || k.provider === 'minimax' || k.provider === 'openrouter');
            }

            if (matchingKeys.length > 0) {
                allowed = matchingKeys.map((k: any) => ({
                    upstream_key_id: k.id,
                    model_name: requestedModel,
                    upstream_model_name: null,
                }));
            }
        }
    }

    if (allowed.length === 0) {
        const errObj = { error: { message: `Model ${requestedModel} is not available for this API key.`, type: "invalid_request_error" } };
        if (c && !isInternalCall && !returnRawStream) {
            return c.json(errObj, 403);
        }
        return { ok: false, status: 403, error: errObj.error };
    }

    // Filter out keys marked as error, rate_limited, in circuit breaker cooldown, or slow
    const healthyAllowed = allowed.filter((m: any) => {
        return checkAndRecoverProvider(m.upstream_key_id) === 'healthy'
            && canPassCircuit(m.upstream_key_id)
            && !isProviderSlow(m.upstream_key_id);
    });

    // Fallback to mappings passing circuit, EXCEPT explicitly paused ones
    let candidates = healthyAllowed.length > 0
        ? healthyAllowed
        : allowed.filter((m: any) => checkAndRecoverProvider(m.upstream_key_id) !== 'paused' && canPassCircuit(m.upstream_key_id));

    if (candidates.length === 0) {
        const errObj = { error: { message: `Gateway: Model ${requestedModel} is not available. All configured providers are exhausted, broken, or paused.`, type: "server_error" } };
        if (c && !isInternalCall && !returnRawStream) {
            return c.json(errObj, 503);
        }
        return { ok: false, status: 503, error: errObj.error };
    }

    // --- Smart Context Pruning for OpenClaw & Agentic Sessions ---
    if (Array.isArray(body.messages) && body.messages.length > 0) {
        const pruneResult = pruneContext(body.messages);
        if (pruneResult.pruned) {
            body.messages = pruneResult.messages;
            const ts = new Date().toISOString();
            console.log(`[${ts}] [ContextPruner] Compressed context ${pruneResult.originalEstimatedTokens} -> ${pruneResult.finalEstimatedTokens} tokens (saved ~${pruneResult.tokensSaved} tokens, ${pruneResult.prunedToolOutputsCount} tool outputs compressed)`);
            if (c) {
                c.header('X-OpenClaw-Context-Pruned', 'true');
                c.header('X-OpenClaw-Tokens-Saved', String(pruneResult.tokensSaved));
            }
        }
    }

    // --- SOAT: Semantic Cache Check (Stream & Non-Stream) ---
    const cacheKey = buildCacheKey(requestedModel, body.messages, { temperature: body.temperature });
    if (cacheKey) {
        const cached = getCached(cacheKey);
        if (cached) {
            const cacheHitLatencyMs = Math.max(1, Date.now() - startTime);
            const ts = new Date().toISOString();
            console.log(`[${ts}] [SemanticCache] HIT for model=${requestedModel} key=${cacheKey.substring(0, 12)}… (${cacheHitLatencyMs}ms)`);

            const promptTok = cached.usage?.prompt_tokens ?? estimateTokenCount(body.messages || [], body.tools || []);
            const compTok = cached.usage?.completion_tokens ?? 0;
            const totalTok = cached.usage?.total_tokens ?? (promptTok + compTok);

            if (!cached.usage?.total_tokens && totalTok > 0) {
                cached.usage = { prompt_tokens: promptTok, completion_tokens: compTok, total_tokens: totalTok };
                recordTokensSaved(totalTok);
            }

            const cacheCost = await buildCostFields(requestedModel, null, promptTok, compTok);

            // Insert cache hit log into telemetry
            insertRequestLog({
                project_id: gatewayKey.project_id,
                gateway_key_id: gatewayKey.id,
                upstream_key_id: null,
                provider: 'cache',
                model: requestedModel,
                status_code: 200,
                latency_ms: cacheHitLatencyMs,
                total_tokens: totalTok,
                prompt_tokens: promptTok,
                completion_tokens: compTok,
                total_cost_usd: cacheCost.total_cost_usd,
                input_cost_usd: cacheCost.input_cost_usd,
                output_cost_usd: cacheCost.output_cost_usd,
            }).catch((err) => {
                console.error('[SemanticCache] Failed to log cache hit:', err);
            });

            if (c) {
                c.header('X-Cache', 'HIT');
                c.header('X-Cache-Lookup', 'HIT');
                c.header('X-Router-Tier', 'cache');
            }

            if (c && !isInternalCall && !returnRawStream) {
                if (body.stream && cached.chunks && cached.chunks.length > 0) {
                    c.header('Content-Type', 'text/event-stream; charset=utf-8');
                    c.header('Cache-Control', 'no-cache, no-transform');
                    c.header('Connection', 'keep-alive');
                    c.header('X-Accel-Buffering', 'no');
                    return stream(c, async (s) => {
                        for (const chunk of cached.chunks!) {
                            await s.write(new TextEncoder().encode(chunk));
                        }
                    });
                }
                return c.json(cached.value, 200);
            }

            if (returnRawStream && cached.chunks && cached.chunks.length > 0) {
                const readable = new ReadableStream({
                    start(controller) {
                        for (const chunk of cached.chunks!) {
                            controller.enqueue(new TextEncoder().encode(chunk));
                        }
                        controller.close();
                    }
                });
                const mockResponse = new Response(readable, {
                    status: 200,
                    headers: { 'Content-Type': 'text/event-stream; charset=utf-8', 'X-Cache': 'HIT' }
                });
                return {
                    ok: true,
                    rawResponse: mockResponse,
                    status: 200,
                    provider: 'cache',
                    isCacheHit: true,
                };
            }

            return { ok: true, data: cached.value || cached, status: 200, isCacheHit: true };
        }
    }

    // --- SOAT: Atlas Smart Router — 3-Tier Classification ---
    const candidateUpstreamIds = candidates.map((m: any) => m.upstream_key_id);
    const metaMap = await getCachedUpstreamMetadata(candidateUpstreamIds);

    const enrichedCandidates = candidates.map((m: any) => ({
        ...m,
        provider: metaMap[m.upstream_key_id]?.provider || 'unknown',
        billing_type: metaMap[m.upstream_key_id]?.billing_type || 'free',
    }));

    const estimatedTok = estimateTokenCount(body.messages || [], body.tools || []);
    const jevDecision = await consultSystemOne({
        messages: body.messages || [],
        tools: body.tools || [],
        model: requestedModel,
        candidateCount: enrichedCandidates.length,
        hasNearLimitKeys: enrichedCandidates.some((m: any) => {
            const st = getOrCreateKeyState(m.upstream_key_id, m.provider);
            return st.status === 'near_limit' || st.status === 'throttled';
        }),
    });
    const routingTier = jevDecision.tier;
    candidates = filterCandidatesByTier(routingTier, enrichedCandidates);

    // Free Tier Priority Engine: Separate free tier keys and paid/premium keys.
    // Free keys are rotated via round-robin; paid keys are placed strictly as secondary fallbacks!
    let freeCandidates = candidates.filter((cand: any) => cand.billing_type === 'free');
    let paidCandidates = candidates.filter((cand: any) => cand.billing_type !== 'free');

    // Daily Pool Exhaustion Check & Automatic Model Substitution:
    // If all free candidates for requestedModel are daily exhausted (e.g. 8 keys * 20 RPD on gemini-3.8-flash reached limit),
    // automatically substitute to the next available fallback model in the chain!
    const normalizedReqModel = requestedModel.toLowerCase().replace(/^(google|vertex)\//, '');
    let substitutionInfo: {
        substituted: boolean;
        originalModel: string;
        substitutedModel: string;
        reason: string;
        resetsAt: string;
    } | null = null;

    const allFreeExhausted = freeCandidates.length > 0 && freeCandidates.every((cand: any) => {
        const st = getOrCreateKeyState(cand.upstream_key_id, cand.provider, 'free', undefined, requestedModel);
        return st.status === 'daily_exhausted';
    });

    if (allFreeExhausted && MODEL_FALLBACK_CHAINS[normalizedReqModel]) {
        const fallbackList = MODEL_FALLBACK_CHAINS[normalizedReqModel];
        for (const nextModel of fallbackList) {
            const hasCapacity = freeCandidates.some((cand: any) => {
                const st = getOrCreateKeyState(cand.upstream_key_id, cand.provider, 'free', undefined, nextModel);
                return st.status !== 'daily_exhausted';
            });
            if (hasCapacity) {
                const resetInfo = calculateQuotaResetTime();
                substitutionInfo = {
                    substituted: true,
                    originalModel: requestedModel,
                    substitutedModel: nextModel,
                    reason: `All ${freeCandidates.length} upstream keys reached daily free limit for '${requestedModel}' (20 RPD/key). Automatically substituted to '${nextModel}'. Restabilizes at ${resetInfo.resetsAtHuman}`,
                    resetsAt: resetInfo.resetsAtIso,
                };
                console.warn(`[CompletionEngine] 🔄 Daily Pool Exhaustion: ${substitutionInfo.reason}`);
                requestedModel = nextModel;
                body.model = nextModel;
                break;
            }
        }
    }

    // Round Tracker: Order candidates fairly according to round state
    if (freeCandidates.length > 0) {
        const prioritizedFree = prioritizeCandidatesByRound(freeCandidates, gatewayKey.project_id, requestedModel);
        candidates = isStrictFree ? prioritizedFree : [...prioritizedFree, ...paidCandidates];
    } else if (paidCandidates.length > 0) {
        const prioritizedPaid = prioritizeCandidatesByRound(paidCandidates, gatewayKey.project_id, requestedModel);
        candidates = prioritizedPaid;
    }

    const tsRouter = new Date().toISOString();
    console.log(`[${tsRouter}] [DualEngine] tier=${routingTier} engine=${jevDecision.decisionSource} confidence=${jevDecision.confidenceScore}% estimatedTokens=${estimatedTok} candidatesAfterFilter=${candidates.length}/${enrichedCandidates.length} (free=${freeCandidates.length}, paid=${paidCandidates.length})`);

    if (c) {
        c.header('X-TierMax-Engine', jevDecision.decisionSource);
        c.header('X-TierMax-Tier', routingTier);
        c.header('X-TierMax-Confidence', `${jevDecision.confidenceScore}`);
        if (substitutionInfo && substitutionInfo.substituted) {
            c.header('X-TierMax-Model-Substituted', 'true');
            c.header('X-TierMax-Original-Model', substitutionInfo.originalModel);
            c.header('X-TierMax-Substituted-Model', substitutionInfo.substitutedModel);
            c.header('X-TierMax-Substitution-Reason', encodeURIComponent(substitutionInfo.reason));
            c.header('X-TierMax-Quota-Reset-At', substitutionInfo.resetsAt);
        }
    }

    if (candidates.length === 0) {
        const errObj = { error: { message: `Model ${requestedModel} is not available.`, type: "invalid_request_error" } };
        if (c && !isInternalCall && !returnRawStream) {
            return c.json(errObj, 403);
        }
        return { ok: false, status: 403, error: errObj.error };
    }

    let finalResponse: any = null;
    let finalStatus = 500;
    let finalTokens = 0;
    let finalPromptTokens = 0;
    let finalCompletionTokens = 0;
    let usedUpstreamKeyId: string | null = null;
    let usedUpstreamProject: string | null = null;
    let usedProvider: string | null = null;
    let finalErrorMsg: string | null = null;
    let finalErrorData: any = null;
    const estimatedPromptTokens = estimateTokenCount(body.messages || [], body.tools || []);

    // Proactive Context Overflow Filter:
    // If prompt > 6500 tokens, Groq free-tier keys will reject with HTTP 413 (ITPM limit 7000).
    if (estimatedPromptTokens > 6500 && candidates.some((cand: any) => cand.provider !== 'groq')) {
        const nonGroq = candidates.filter((cand: any) => cand.provider !== 'groq');
        if (nonGroq.length > 0) {
            console.log(`[CompletionEngine] Large prompt (${estimatedPromptTokens} tokens): filtered out Groq candidates to avoid 413.`);
            candidates = nonGroq;
        }
    }

    if (candidates.length > 0 && candidates.every((cand: any) => cand.provider === 'groq') && estimatedPromptTokens > 6500) {
        console.log(`[CompletionEngine] Proactive Context-Overflow Bypass: All candidates for ${requestedModel} are Groq keys (7k ITPM limit), but prompt is ${estimatedPromptTokens} tokens. Engaging High-Capacity Failover directly.`);
        return await executeHighCapacityFailover({
            body,
            gatewayKey,
            c,
            returnRawStream,
            isInternalCall,
            originalModel: requestedModel,
            estimatedPromptTokens,
            reason: `Groq free tier 7000 ITPM limit exceeded by prompt (${estimatedPromptTokens} tokens)`,
        });
    }

    let had413TooLarge = false;

    // Fallback Loop: Tries free candidates first, then paid candidates only if free fails
    for (let attempt = 0; attempt < candidates.length; attempt++) {
        const selectedMapping = candidates[attempt];

        usedUpstreamKeyId = selectedMapping.upstream_key_id;

        const upstream = await getCachedUpstreamKey(selectedMapping.upstream_key_id);

        if (!upstream) {
            const timestamp = new Date().toISOString();
            console.error(`[${timestamp}] Upstream provider not found or misconfigured for id: ${selectedMapping.upstream_key_id}`);
            continue;
        }

        usedProvider = upstream.provider;
        usedUpstreamProject = upstream.project_id || null;
        const timestamp = new Date().toISOString();
        console.log(`[${timestamp}] [Load Balancer] Attempt ${attempt + 1}: Using upstream key ${upstream.id} for model ${requestedModel} (${usedProvider})`);

        // FreeTierGuardian: Proactive rate-limit check to avoid 429 errors
        const guardianCheck = checkRateLimitCapacity(
            upstream.id,
            upstream.provider,
            upstream.billing_type || 'free',
            estimatedPromptTokens,
            {
                rpm: upstream.rpm_limit,
                tpm: upstream.tpm_limit,
                rpd: upstream.rpd_limit,
                tpd: upstream.tpd_limit,
            },
            requestedModel
        );

        if (!guardianCheck.canProceedImmediately) {
            if (guardianCheck.state.status === 'daily_exhausted') {
                const hasAlternative = candidates.some((c: any) => c.upstream_key_id !== upstream.id);
                if (hasAlternative) {
                    console.log(`[FreeTierGuardian] Skipping key ${upstream.id} (${upstream.provider}): Daily free tier limit reached, rotating to alternative.`);
                    continue;
                }
                console.warn(`[FreeTierGuardian] Key ${upstream.id} (${upstream.provider}) reached daily soft limit, but no alternative available; proceeding with request.`);
            }
            if (guardianCheck.shouldWaitMs > 6000) {
                console.log(`[FreeTierGuardian] Key ${upstream.id} cannot service request (${guardianCheck.reason}), skipping candidate.`);
                had413TooLarge = true;
                continue;
            }
            if (guardianCheck.shouldWaitMs > 0 && guardianCheck.shouldWaitMs <= 6000) {
                console.log(`[FreeTierGuardian] Applying smooth rate delay of ${guardianCheck.shouldWaitMs}ms for ${upstream.provider} to prevent 429`);
                await new Promise(res => setTimeout(res, guardianCheck.shouldWaitMs));
            } else if (candidates.length > 1) {
                console.log(`[FreeTierGuardian] Key ${upstream.id} near limit window (${guardianCheck.reason}), rotating to next candidate`);
                continue;
            }
        }

        let baseUrl = '';
        if (upstream.provider === 'openai') baseUrl = 'https://api.openai.com/v1/chat/completions';
        else if (upstream.provider === 'groq') baseUrl = 'https://api.groq.com/openai/v1/chat/completions';
        else if (upstream.provider === 'openrouter') baseUrl = 'https://openrouter.ai/api/v1/chat/completions';
        else if (upstream.provider === 'cerebras') baseUrl = 'https://api.cerebras.ai/v1/chat/completions';
        else if (upstream.provider === 'google' || upstream.provider === 'vertex') baseUrl = 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions';
        else if (upstream.provider === 'mistral') baseUrl = 'https://api.mistral.ai/v1/chat/completions';
        else if (upstream.provider === 'nvidia') baseUrl = 'https://integrate.api.nvidia.com/v1/chat/completions';
        else if (upstream.provider === 'vercel') baseUrl = 'https://ai-gateway.vercel.sh/v1/chat/completions';
        else if (upstream.provider === 'minimax') baseUrl = 'https://api.minimax.chat/v1/chat/completions';
        else if (upstream.provider === 'moonshot') baseUrl = 'https://api.moonshot.cn/v1/chat/completions';
        else if (upstream.provider === 'deepseek') baseUrl = 'https://api.deepseek.com/chat/completions';
        else if (upstream.provider === 'mimo') baseUrl = 'https://api.xiaomimimo.com/v1/chat/completions';
        else if (upstream.provider === 'kie') baseUrl = `https://api.kie.ai/${encodeURIComponent(requestedModel)}/v1/chat/completions`;
        else if (upstream.provider === 'zettacore') baseUrl = 'http://localhost:8000/v1/chat/completions';
        else if (upstream.provider === 'ollama') baseUrl = (upstream.base_url || 'http://localhost:11434').replace(/\/+$/, '') + '/v1/chat/completions';
        else if (upstream.provider === 'lmstudio') baseUrl = (upstream.base_url || 'http://localhost:1234').replace(/\/+$/, '') + '/v1/chat/completions';
        else if (upstream.provider === 'vllm' || upstream.provider === 'local') baseUrl = (upstream.base_url || 'http://localhost:8000').replace(/\/+$/, '') + '/v1/chat/completions';
        else if (upstream.provider === 'puter') {
            try {
                if (body.stream && !returnRawStream) {
                    finalStatus = 200;
                    finalPromptTokens = estimatedPromptTokens;
                    finalCompletionTokens = 0;
                    finalTokens = Math.max(500, finalPromptTokens + finalCompletionTokens);
                    updateProviderCalls(upstream.id, finalTokens);
                    recordRateLimitConsumption(upstream.id, finalTokens);
                    const latencyMs = Date.now() - startTime;
                    const costFields = await buildCostFields(requestedModel, 'puter', finalPromptTokens, finalCompletionTokens);
                    insertRequestLog({
                        project_id: upstream.project_id || gatewayKey.project_id,
                        gateway_key_id: gatewayKey.id,
                        upstream_key_id: upstream.id,
                        provider: 'puter',
                        model: requestedModel,
                        status_code: 200,
                        latency_ms: latencyMs,
                        total_tokens: finalTokens,
                        prompt_tokens: finalPromptTokens,
                        completion_tokens: finalCompletionTokens,
                        ...costFields,
                    }).catch(() => { });

                    if (c) {
                        c.header('Content-Type', 'text/event-stream');
                        c.header('Cache-Control', 'no-cache');
                        c.header('Connection', 'keep-alive');

                        return stream(c, async (s) => {
                            try {
                                const gen = callPuterAIStream(upstream.api_key, body.messages, {
                                    model: requestedModel,
                                    max_tokens: body.max_tokens,
                                    temperature: body.temperature,
                                });
                                for await (const chunk of gen) {
                                    await s.write(new TextEncoder().encode(chunk));
                                }
                            } catch (err: any) {
                                console.error(`[Puter] Stream error: ${err.message}`);
                                markProviderError(upstream.id, 'error', err.message);
                            }
                        });
                    }
                } else {
                    const data = await callPuterAI(upstream.api_key, body.messages, {
                        model: requestedModel,
                        max_tokens: body.max_tokens,
                        temperature: body.temperature,
                    });

                    finalStatus = 200;
                    const usage = normalizeUsage(data.usage, estimatedPromptTokens);
                    finalPromptTokens = usage.prompt_tokens;
                    finalCompletionTokens = usage.completion_tokens;
                    finalTokens = usage.total_tokens;
                    updateProviderCalls(upstream.id, finalTokens);
                    recordRateLimitConsumption(upstream.id, finalTokens);

                    data._openclaw_metadata = { provider: 'puter', upstream_key_id: upstream.id };
                    finalResponse = data;
                    break;
                }
            } catch (puterErr: any) {
                console.error(`[Puter] Error: ${puterErr.message}`);
                markProviderError(upstream.id, 'error', puterErr.message);
                finalStatus = 500;
                finalErrorMsg = puterErr.message;
                continue;
            }
        }

        if (!baseUrl) {
            console.error(`Unknown provider ${upstream.provider}`);
            continue;
        }

        const forwardBody = JSON.parse(JSON.stringify(body));

        if (selectedMapping.upstream_model_name) {
            forwardBody.model = selectedMapping.upstream_model_name;
        }

        // SOAT: Prompt Anchor (consolidate system prompts at [0])
        if (Array.isArray(forwardBody.messages) && forwardBody.messages.length > 0) {
            const systemMsgs: any[] = [];
            const otherMsgs: any[] = [];

            for (const msg of forwardBody.messages) {
                if (msg.role === 'system') systemMsgs.push(msg);
                else otherMsgs.push(msg);
            }

            if (systemMsgs.length > 0) {
                const mergedContent = systemMsgs
                    .map((m: any) => {
                        if (typeof m.content === 'string') return m.content.trim();
                        if (Array.isArray(m.content)) {
                            return m.content.map((b: any) => (typeof b === 'string' ? b : b?.text ?? '')).join('').trim();
                        }
                        return '';
                    })
                    .filter(Boolean)
                    .join('\n\n');

                forwardBody.messages = [
                    { role: 'system', content: mergedContent },
                    ...otherMsgs,
                ];
                if (c) c.header('X-Prompt-Restructured', 'true');
            }
        }

        // Universal Message Sanitization:
        // Strip client-specific telemetry (e.g. OpenClaw metadata like __openclaw, idempotencyKey, timestamp, responseId, responseModel, usage, stopReason, api, provider, model)
        // that cause strict schema validation providers (like Mistral, Cohere, Anthropic) to throw HTTP 422 extra_forbidden.
        if (Array.isArray(forwardBody.messages)) {
            const standardKeys = new Set(['role', 'content', 'name', 'tool_calls', 'tool_call_id']);
            forwardBody.messages = forwardBody.messages.map((msg: any) => {
                if (!msg || typeof msg !== 'object') return msg;
                const clean: any = {};
                for (const [k, v] of Object.entries(msg)) {
                    if (standardKeys.has(k)) {
                        clean[k] = v;
                    }
                }
                if (upstream.provider === 'mistral' || upstream.provider === 'cerebras') {
                    if (Array.isArray(clean.content)) {
                        clean.content = clean.content
                            .map((b: any) => typeof b === 'string' ? b : b?.text ?? '')
                            .join('');
                    }
                }
                return clean;
            });
        }

        // Token Cap
        const premiumKey = process.env.SOAT_PREMIUM_BYPASS_KEY || '';
        const isPremiumProject = premiumKey.length > 0 && typeof gatewayKey?.id === 'string' && gatewayKey.id === premiumKey;

        if (!isPremiumProject && upstream.provider !== 'google' && upstream.provider !== 'vertex') {
            const envDefault = process.env.SOAT_DEFAULT_MAX_TOKENS ? Number(process.env.SOAT_DEFAULT_MAX_TOKENS) : 16000;
            const effectiveCap = (upstream.max_output_tokens && upstream.max_output_tokens > 0)
                ? upstream.max_output_tokens
                : envDefault;
            if (forwardBody.max_tokens && forwardBody.max_tokens > effectiveCap) {
                forwardBody.max_tokens = effectiveCap;
            }
        }

        // Context Trim Guard
        if (upstream.max_context_tokens && Array.isArray(forwardBody.messages)) {
            const limit = upstream.max_context_tokens;
            let estimated = estimateTokenCount(forwardBody.messages, forwardBody.tools);
            if (estimated > limit) {
                const systemMsgs = forwardBody.messages.filter((m: any) => m.role === 'system');
                const nonSystem = forwardBody.messages.filter((m: any) => m.role !== 'system');
                const lastUserIdx = nonSystem.map((m: any) => m.role).lastIndexOf('user');
                let trimIdx = 0;
                while (estimated > limit && trimIdx < lastUserIdx) {
                    const removed = nonSystem.splice(0, 1);
                    estimated -= Math.ceil((JSON.stringify(removed[0]).length) / 3);
                    trimIdx++;
                }
                forwardBody.messages = [...systemMsgs, ...nonSystem];
            }
        }

        // Google / Vertex normalization
        if (upstream.provider === 'google' || upstream.provider === 'vertex' || (upstream.provider === 'kie' && requestedModel.includes('gemini'))) {
            if (forwardBody.max_completion_tokens && !forwardBody.max_tokens) {
                forwardBody.max_tokens = forwardBody.max_completion_tokens;
            }
            delete forwardBody.store;
            delete forwardBody.stream_options;
            delete forwardBody.max_completion_tokens;

            if (Array.isArray(forwardBody.messages)) {
                const hasTools = Array.isArray(forwardBody.tools) && forwardBody.tools.length > 0;
                forwardBody.messages = forwardBody.messages.map((msg: any) => {
                    let content = msg.content;
                    if (Array.isArray(content)) {
                        content = content.map((b: any) => typeof b === 'string' ? b : b?.text ?? '').join('');
                    }
                    if (msg.role === 'tool') {
                        if (hasTools) {
                            return {
                                role: 'tool',
                                tool_call_id: msg.tool_call_id || msg.id || 'call_0',
                                content: content ?? '',
                            };
                        }
                        return { role: 'user', content: content ?? '' };
                    }
                    if (msg.role === 'assistant') {
                        if (!hasTools && msg.tool_calls) {
                            const { tool_calls, ...rest } = msg;
                            return { ...rest, content: content || '[Tool call completed]' };
                        }
                        if (content === null || content === undefined) content = '';
                    }
                    return { ...msg, content };
                });
            }
        }

        // Cerebras normalization
        if (upstream.provider === 'cerebras') {
            delete forwardBody.store;
            delete forwardBody.stream_options;
            delete forwardBody.parallel_tool_calls;
            delete forwardBody.tools;
            delete forwardBody.tool_choice;

            if (Array.isArray(forwardBody.messages)) {
                forwardBody.messages = forwardBody.messages
                    .map((msg: any) => {
                        let content = msg.content;
                        if (Array.isArray(content)) {
                            content = content.map((b: any) => typeof b === 'string' ? b : b?.text ?? '').join('');
                        }
                        if (msg.role === 'tool') return { role: 'user', content: `[Tool result]: ${content ?? ''}` };
                        if (msg.role === 'assistant' && msg.tool_calls) {
                            const toolNames = (msg.tool_calls as any[]).map((tc: any) => tc.function?.name ?? tc.id).join(', ');
                            return { role: 'assistant', content: content || `[Called tools: ${toolNames}]` };
                        }
                        return { ...msg, content: content ?? '' };
                    })
                    .filter((msg: any) => !(msg.role === 'assistant' && msg.content === ''));
            }
        }

        // DeepSeek & Generic Non-Streaming Normalization:
        // DeepSeek and other strict APIs reject requests with HTTP 400 if stream_options is present when stream is false.
        if (!forwardBody.stream) {
            delete forwardBody.stream_options;
        }
        if (upstream.provider === 'deepseek' && !forwardBody.stream) {
            delete forwardBody.stream_options;
        }

        try {
            const abortController = new AbortController();
            const abortTimer = setTimeout(() => abortController.abort(), LATENCY_ABORT_TIMEOUT_MS);

            const fetchStartMs = Date.now();
            let response: Response;
            try {
                response = await fetch(baseUrl, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': `Bearer ${upstream.api_key}`,
                        'Connection': 'keep-alive',
                        ...(upstream.provider === 'openrouter' ? { 'HTTP-Referer': 'https://cursor.com', 'X-Title': 'Cursor Agent' } : {})
                    },
                    body: JSON.stringify(forwardBody),
                    signal: abortController.signal,
                    keepalive: true,
                });
            } finally {
                clearTimeout(abortTimer);
            }

            if (!response.ok) {
                const errData = await response.json().catch(() => ({}));
                const isRateLimit = response.status === 429;
                const isCapacityOr503 = response.status === 503 || response.status === 502;
                const errMsg = errData.error?.message || response.statusText;
                markProviderError(upstream.id, isRateLimit ? 'rate_limited' : 'error', errMsg);

                if (isRateLimit || isCapacityOr503) {
                    const retryAfter = response.headers.get('retry-after');
                    const retrySec = retryAfter ? parseInt(retryAfter, 10) : undefined;
                    markRateLimitExceeded(upstream.id, retrySec);
                    handleEarlyUpstreamAnomaly(upstream.id, response.status, errMsg, retrySec);
                    console.warn(`[CompletionEngine] ⚠️ Early upstream anomaly (HTTP ${response.status}) on key ${upstream.id}. Seamlessly rotating to next key in round.`);
                }

                finalStatus = response.status;
                finalErrorMsg = errMsg;
                finalErrorData = errData;

                const isRequestTooLarge = errData?.error?.code === 'request_too_large' ||
                    response.status === 413 ||
                    errMsg?.toLowerCase().includes('request too large') ||
                    errMsg?.toLowerCase().includes('reduce your message size') ||
                    errMsg?.toLowerCase().includes('context length exceeded');

                if (isRequestTooLarge) {
                    had413TooLarge = true;
                }

                const isModelNotFound = response.status === 404 || 
                    (response.status === 400 && (
                        errMsg?.toLowerCase().includes('model') || 
                        errMsg?.toLowerCase().includes('deprecated') || 
                        errMsg?.toLowerCase().includes('not exist') ||
                        errData?.error?.code === 'model_not_found'
                    ));

                const isPaymentOrQuota = response.status === 402 ||
                    errMsg?.toLowerCase().includes('in_flight_budget') ||
                    errMsg?.toLowerCase().includes('insufficient_quota') ||
                    errMsg?.toLowerCase().includes('exceed your available credits');

                const isSchemaOrClientError = response.status === 422 || response.status === 400;

                if (isRateLimit || response.status >= 500 || isRequestTooLarge || isModelNotFound || isPaymentOrQuota || isSchemaOrClientError) {
                    const { tripped } = recordCircuitFailure(upstream.id, upstream.provider, errMsg);
                    if (tripped) {
                        dispatchAlert({
                            event: 'circuit_trip',
                            title: `Circuit Breaker Tripped: ${upstream.provider.toUpperCase()}`,
                            message: `Key ${upstream.id.substring(0, 8)} (${upstream.provider}) entered 60s quarantine. Error: ${errMsg}`,
                            level: 'warning',
                            metadata: { key_id: upstream.id, provider: upstream.provider, status: response.status }
                        });
                    }
                    continue;
                } else {
                    break;
                }
            }

            // Ingest rate limit headers and reset circuit breaker on success
            ingestRateLimitHeaders(upstream.id, response.headers);
            recordCircuitSuccess(upstream.id);

            // Kie fake 200 interception
            const contentType = response.headers.get('content-type') || '';
            if (upstream.provider === 'kie' && contentType.includes('application/json')) {
                const clonedResponse = response.clone();
                const jsonBody = await clonedResponse.json().catch(() => ({}));
                if (jsonBody.code === 500 || jsonBody.code === 422 || jsonBody.error) {
                    const errMsg = jsonBody.msg || jsonBody.error?.message || 'Fake 200 Server Error';
                    markProviderError(upstream.id, 'error', errMsg);
                    finalStatus = 500;
                    finalErrorMsg = errMsg;
                    finalErrorData = jsonBody;
                    continue;
                }
            }

            // Handle Streaming
            if (body.stream && response.body) {
                finalStatus = 200;
                finalPromptTokens = estimatedPromptTokens;
                finalCompletionTokens = 0;
                finalTokens = Math.max(500, finalPromptTokens + finalCompletionTokens);
                updateProviderCalls(upstream.id, finalTokens);
                recordRateLimitConsumption(upstream.id, finalTokens);

                const latencyMs = Date.now() - startTime;
                const costFields = await buildCostFields(requestedModel, usedProvider, finalPromptTokens, finalCompletionTokens);
                insertRequestLog({
                    project_id: upstream.project_id || gatewayKey.project_id,
                    gateway_key_id: gatewayKey.id,
                    upstream_key_id: usedUpstreamKeyId,
                    provider: usedProvider,
                    model: requestedModel,
                    status_code: finalStatus,
                    latency_ms: latencyMs,
                    total_tokens: finalTokens,
                    prompt_tokens: finalPromptTokens,
                    completion_tokens: finalCompletionTokens,
                    ...costFields,
                }).catch(() => { });

                recordKeyUsedInRound(usedUpstreamKeyId || upstream.id, gatewayKey.project_id, requestedModel, candidates.map((cand: any) => cand.upstream_key_id));

                if (returnRawStream) {
                    return {
                        ok: true,
                        rawResponse: response,
                        status: 200,
                        provider: usedProvider,
                        upstreamKeyId: usedUpstreamKeyId,
                        routingTier,
                    };
                }

                if (c) {
                    c.header('X-Cache', 'MISS');
                    c.header('Content-Type', 'text/event-stream; charset=utf-8');
                    c.header('Cache-Control', 'no-cache, no-transform');
                    c.header('Connection', 'keep-alive');
                    c.header('X-Accel-Buffering', 'no');
                    if (isHealed && healingInfo) {
                        c.header('X-TierMax-Healed', 'true');
                        c.header('X-TierMax-Original-Model', healingInfo.originalModel);
                        c.header('X-TierMax-Resolved-Model', healingInfo.resolvedModel);
                        if (healingInfo.reason) {
                            c.header('X-TierMax-Healing-Reason', encodeURIComponent(healingInfo.reason));
                        }
                    }
                    if (substitutionInfo && substitutionInfo.substituted) {
                        c.header('X-TierMax-Model-Substituted', 'true');
                        c.header('X-TierMax-Original-Model', substitutionInfo.originalModel);
                        c.header('X-TierMax-Substituted-Model', substitutionInfo.substitutedModel);
                        c.header('X-TierMax-Substitution-Reason', encodeURIComponent(substitutionInfo.reason));
                        c.header('X-TierMax-Quota-Reset-At', substitutionInfo.resetsAt);
                    }

                    return stream(c, async (s) => {
                        const reader = response.body!.getReader();
                        s.onAbort(() => reader.cancel().catch(() => { }));
                        const chunksToCache: string[] = [];
                        const textDecoder = new TextDecoder();
                        const textEncoder = new TextEncoder();

                        try {
                            while (true) {
                                const { done, value } = await reader.read();
                                if (done) break;
                                if (value) {
                                    const rawText = textDecoder.decode(value, { stream: true });
                                    chunksToCache.push(rawText);
                                    if (rawText.includes('function_call_filter') || rawText.includes('MALFORMED')) {
                                        const sanitized = rawText
                                            .replace(/"finish_reason"\s*:\s*"[^"]*function_call_filter[^"]*"/g, '"finish_reason":"stop"')
                                            .replace(/"finish_reason"\s*:\s*"[^"]*MALFORMED[^"]*"/g, '"finish_reason":"stop"');
                                        await s.write(textEncoder.encode(sanitized));
                                    } else {
                                        await s.write(value);
                                    }
                                }
                            }
                            if (cacheKey && chunksToCache.length > 0) {
                                const streamUsage = estimateStreamUsage(chunksToCache, estimatedPromptTokens);
                                setCachedStream(cacheKey, chunksToCache, streamUsage);
                            }
                        } catch (err: any) {
                            try {
                                const errEvent = `data: ${JSON.stringify({ error: { message: `Stream terminated (${usedProvider}): ${err.message}`, type: 'stream_error' } })}\n\ndata: [DONE]\n\n`;
                                await s.write(new TextEncoder().encode(errEvent));
                            } catch { }
                        }
                    });
                }
            }

            // Handle non-streaming
            const data = await response.json();
            finalStatus = 200;
            const usage = normalizeUsage(data.usage, estimatedPromptTokens);
            finalPromptTokens = usage.prompt_tokens;
            finalCompletionTokens = usage.completion_tokens;
            finalTokens = usage.total_tokens;
            updateProviderCalls(upstream.id, finalTokens);
            recordRateLimitConsumption(upstream.id, finalTokens);
            recordLatency(upstream.id, Date.now() - fetchStartMs);
            recordKeyUsedInRound(upstream.id, gatewayKey.project_id, requestedModel, candidates.map((cand: any) => cand.upstream_key_id));

            data._openclaw_metadata = {
                provider: upstream.provider,
                upstream_key_id: upstream.id
            };

            if (cacheKey) {
                setCached(cacheKey, data, usage);
            }

            finalResponse = data;
            break;

        } catch (fetchErr: any) {
            finalStatus = 500;
            finalErrorMsg = fetchErr.message;
            if ((fetchErr as Error).name === 'AbortError') {
                markProviderSlow(upstream.id);
                recordCircuitFailure(upstream.id, upstream.provider, 'Network fetch timeout aborted');
            } else {
                markProviderError(upstream.id, 'error', fetchErr.message);
                recordCircuitFailure(upstream.id, upstream.provider, fetchErr.message);
            }
            continue;
        }
    }

    const latencyMs = Date.now() - startTime;
    const costFields = await buildCostFields(requestedModel, usedProvider, finalPromptTokens, finalCompletionTokens);
    insertRequestLog({
        project_id: usedUpstreamProject || gatewayKey.project_id,
        gateway_key_id: gatewayKey.id,
        upstream_key_id: usedUpstreamKeyId,
        provider: usedProvider,
        model: requestedModel,
        status_code: finalStatus,
        latency_ms: latencyMs,
        total_tokens: finalTokens,
        prompt_tokens: finalPromptTokens,
        completion_tokens: finalCompletionTokens,
        ...costFields,
        error_message: finalStatus === 200 ? null : finalErrorMsg
    }).catch(() => { });

    if (finalResponse) {
        if (finalResponse?.choices && Array.isArray(finalResponse.choices)) {
            for (const choice of finalResponse.choices) {
                if (typeof choice.finish_reason === 'string' && (choice.finish_reason.includes('function_call_filter') || choice.finish_reason.includes('MALFORMED'))) {
                    choice.finish_reason = 'stop';
                }
            }
        }
        if (isHealed && healingInfo) {
            finalResponse._openclaw_healing = {
                healed: true,
                original_model: healingInfo.originalModel,
                resolved_model: healingInfo.resolvedModel,
                reason: healingInfo.reason,
            };
        }
        if (substitutionInfo && substitutionInfo.substituted) {
            finalResponse._openclaw_substitution = {
                substituted: true,
                original_model: substitutionInfo.originalModel,
                substituted_model: substitutionInfo.substitutedModel,
                reason: substitutionInfo.reason,
                resets_at: substitutionInfo.resetsAt,
            };
        }
        if (c && !isInternalCall && !returnRawStream) {
            c.header('X-Cache', 'MISS');
            c.header('X-Router-Tier', routingTier);
            if (isHealed && healingInfo) {
                c.header('X-TierMax-Healed', 'true');
                c.header('X-TierMax-Original-Model', healingInfo.originalModel);
                c.header('X-TierMax-Resolved-Model', healingInfo.resolvedModel);
                if (healingInfo.reason) {
                    c.header('X-TierMax-Healing-Reason', encodeURIComponent(healingInfo.reason));
                }
            }
            if (substitutionInfo && substitutionInfo.substituted) {
                c.header('X-TierMax-Model-Substituted', 'true');
                c.header('X-TierMax-Original-Model', substitutionInfo.originalModel);
                c.header('X-TierMax-Substituted-Model', substitutionInfo.substitutedModel);
                c.header('X-TierMax-Substitution-Reason', encodeURIComponent(substitutionInfo.reason));
                c.header('X-TierMax-Quota-Reset-At', substitutionInfo.resetsAt);
            }
            return c.json(finalResponse, finalStatus as any);
        }
        return {
            ok: true,
            data: finalResponse,
            status: finalStatus,
            provider: usedProvider,
            upstreamKeyId: usedUpstreamKeyId,
            routingTier,
            isHealed,
            healingInfo,
            isSubstituted: substitutionInfo?.substituted ?? false,
            substitutionInfo,
        };
    } else {
        if (had413TooLarge || finalStatus === 413) {
            console.log(`[CompletionEngine] All upstream candidates failed with 413 / Request Too Large. Engaging High-Capacity Failover.`);
            return await executeHighCapacityFailover({
                body,
                gatewayKey,
                c,
                returnRawStream,
                isInternalCall,
                originalModel: requestedModel,
                estimatedPromptTokens,
                reason: `Upstream candidates failed with 413 / Request Too Large (${finalErrorMsg || 'Exceeded context or ITPM limits'})`,
            });
        }

        // Adaptive Early Anomaly Failover:
        // If all upstream keys for the model failed due to rate limits (429) or capacity issues (503/502),
        // automatically failover to the fallback model chain before giving up!
        const normalizedFailModel = requestedModel.toLowerCase().replace(/^(google|vertex)\//, '');
        const allFailedRateLimitOrCapacity = candidates.length > 0 && (finalStatus === 429 || finalStatus === 503 || finalStatus === 502);
        if (allFailedRateLimitOrCapacity && MODEL_FALLBACK_CHAINS[normalizedFailModel] && !options._hasFallenBack) {
            const fallbackChain = MODEL_FALLBACK_CHAINS[normalizedFailModel];
            for (const nextModel of fallbackChain) {
                console.log(`[CompletionEngine] 🚨 All upstream keys throttled or congested on '${requestedModel}'. Engaging Adaptive Early-Failover to '${nextModel}'`);
                const resetInfo = calculateQuotaResetTime();
                const failoverResult = await executeCompletionEngine({
                    ...options,
                    body: { ...body, model: nextModel },
                    _hasFallenBack: true,
                } as any);
                if (failoverResult.ok || failoverResult.status === 200) {
                    if (c && !isInternalCall && !returnRawStream) {
                        c.header('X-TierMax-Model-Substituted', 'true');
                        c.header('X-TierMax-Original-Model', requestedModel);
                        c.header('X-TierMax-Substituted-Model', nextModel);
                        c.header('X-TierMax-Substitution-Reason', encodeURIComponent(`All upstream keys throttled early on ${requestedModel}. Restabilizes: ${resetInfo.resetsAtIso}`));
                        c.header('X-TierMax-Quota-Reset-At', resetInfo.resetsAtIso);
                    }
                    return failoverResult;
                }
            }
        }

        // Sanitize error status and messages for OpenClaw clients:
        // Never pass raw 402 or billing URLs to OpenClaw, because OpenClaw will permanently
        // mark the provider profile as disabledReason: "billing" for 10 minutes.
        let sanitizedStatus = finalStatus;
        let sanitizedErrorMsg = finalErrorMsg || "All upstream candidates failed";

        if (sanitizedStatus === 402) {
            sanitizedStatus = 429;
        }

        // Clean out any external billing URLs or billing words
        sanitizedErrorMsg = sanitizedErrorMsg
            .replace(/https?:\/\/[^\s]*billing[^\s]*/gi, '')
            .replace(/\b(billing|payment required|settings\/billing)\b/gi, 'upstream capacity');

        const errRes = finalErrorData && finalErrorData.error
            ? { ...finalErrorData, error: { ...finalErrorData.error, message: sanitizedErrorMsg, code: sanitizedStatus === 429 ? 'rate_limit_exceeded' : finalErrorData.error.code } }
            : { error: { message: sanitizedErrorMsg, type: sanitizedStatus === 429 ? "rate_limit_error" : "api_error" } };

        errRes._openclaw_metadata = {
            provider: usedProvider,
            upstream_key_id: usedUpstreamKeyId
        };
        if (c && !isInternalCall && !returnRawStream) {
            return c.json(errRes, sanitizedStatus as any);
        }
        return {
            ok: false,
            error: errRes.error || errRes,
            status: sanitizedStatus,
            provider: usedProvider,
            upstreamKeyId: usedUpstreamKeyId,
        };
    }
}
