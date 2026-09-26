/**
 * TierMax — Self-Healing & Model Changelog Architecture
 *
 * Implements:
 * 1. Automatic Model Deprecation & Alias Resolution (Self-Healing Fallback).
 * 2. Persistent Model Changelog & Audit History per project.
 * 3. Proactive Health Diagnostics & "Reparador" Channel Scanner.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { supabase } from '../db';
import { recordLatency } from './latencyGuard';
import { callPuterAI, PUTER_MODELS } from './puterClient';
import { invalidateGatewayKeyCache } from '../middleware/gatewayAuth';
import { invalidateUpstreamKeyCache } from './completionEngine';
import { providerStates } from './limitTracker';

export interface ModelHistoryEvent {
    id: string;
    timestamp: string;
    projectId: string;
    eventType: 'model_added' | 'model_removed' | 'model_deprecated' | 'auto_healed' | 'channel_repaired';
    originalModel?: string;
    resolvedModel?: string;
    provider?: string;
    reason: string;
    metadata?: any;
}

export interface HealingResult {
    healed: boolean;
    originalModel: string;
    resolvedModel: string;
    reason?: string;
    matchedUpstreamKeyId?: string;
}

/**
 * Knowledge base of deprecated / retired LLMs across major providers,
 * mapped to their modern, fully compatible replacements.
 */
export const KNOWN_MODEL_MIGRATIONS: Record<string, { replacement: string; provider: string; reason: string }> = {
    // OpenAI Deprecated Models
    'gpt-4-0314': { replacement: 'gpt-4o', provider: 'openai', reason: 'Deprecated by OpenAI; superseded by GPT-4o' },
    'gpt-4-0613': { replacement: 'gpt-4o', provider: 'openai', reason: 'Deprecated by OpenAI; superseded by GPT-4o' },
    'gpt-4-vision-preview': { replacement: 'gpt-4o', provider: 'openai', reason: 'Vision unified into GPT-4o omni engine' },
    'gpt-4-1106-preview': { replacement: 'gpt-4o', provider: 'openai', reason: 'Superseded by GPT-4o' },
    'gpt-4-0125-preview': { replacement: 'gpt-4o', provider: 'openai', reason: 'Superseded by GPT-4o' },
    'gpt-3.5-turbo-0301': { replacement: 'gpt-4o-mini', provider: 'openai', reason: 'Retired by OpenAI; upgraded to GPT-4o-mini' },
    'gpt-3.5-turbo-0613': { replacement: 'gpt-4o-mini', provider: 'openai', reason: 'Retired by OpenAI; upgraded to GPT-4o-mini' },
    'gpt-3.5-turbo-1106': { replacement: 'gpt-4o-mini', provider: 'openai', reason: 'Legacy model replaced by GPT-4o-mini' },
    'gpt-3.5-turbo-16k': { replacement: 'gpt-4o-mini', provider: 'openai', reason: 'Legacy model replaced by GPT-4o-mini' },
    'text-davinci-003': { replacement: 'gpt-4o-mini', provider: 'openai', reason: 'Completions API retired; mapped to Chat GPT-4o-mini' },
    'text-davinci-002': { replacement: 'gpt-4o-mini', provider: 'openai', reason: 'Completions API retired; mapped to Chat GPT-4o-mini' },

    // Anthropic Deprecated Models
    'claude-3-opus-20240229': { replacement: 'claude-3-5-sonnet-20241022', provider: 'anthropic', reason: 'Superseded by Claude 3.5 Sonnet' },
    'claude-3-sonnet-20240229': { replacement: 'claude-3-5-sonnet-20241022', provider: 'anthropic', reason: 'Sonnet 3.0 superseded by Claude 3.5 Sonnet' },
    'claude-2.1': { replacement: 'claude-3-5-haiku-20241022', provider: 'anthropic', reason: 'Claude 2.1 retired; mapped to Claude 3.5 Haiku' },
    'claude-2.0': { replacement: 'claude-3-5-haiku-20241022', provider: 'anthropic', reason: 'Claude 2.0 retired; mapped to Claude 3.5 Haiku' },
    'claude-instant-1.2': { replacement: 'claude-3-5-haiku-20241022', provider: 'anthropic', reason: 'Claude Instant retired; mapped to Claude 3.5 Haiku' },

    // Google Gemini Preview / Deprecated Models
    'gemini-1.0-pro': { replacement: 'gemini-2.5-flash', provider: 'google', reason: 'Gemini 1.0 retired; mapped to Gemini 2.5 Flash' },
    'gemini-1.5-pro-preview': { replacement: 'gemini-2.5-flash', provider: 'google', reason: 'Preview expired; mapped to Gemini 2.5 Flash' },
    'gemini-1.5-flash-preview': { replacement: 'gemini-2.5-flash', provider: 'google', reason: 'Preview expired; mapped to Gemini 2.5 Flash' },
    'gemini-pro': { replacement: 'gemini-2.5-flash', provider: 'google', reason: 'Legacy model; mapped to Gemini 2.5 Flash' },
    'gemini-1.5-flash': { replacement: 'gemini-2.5-flash', provider: 'google', reason: 'Gemini 1.5 retired; mapped to Gemini 2.5 Flash' },
    'gemini-1.5-pro': { replacement: 'gemini-2.5-pro', provider: 'google', reason: 'Gemini 1.5 Pro retired; mapped to Gemini 2.5 Pro' },
    'gemini-2.0-flash': { replacement: 'gemini-2.5-flash', provider: 'google', reason: 'Gemini 2.0 retired (404); mapped to Gemini 2.5 Flash' },
    'gemini-2.0-flash-exp': { replacement: 'gemini-2.5-flash', provider: 'google', reason: 'Experimental expired; mapped to Gemini 2.5 Flash' },
    'gemini-2.0-flash-001': { replacement: 'gemini-2.5-flash', provider: 'google', reason: 'Deprecated endpoint; mapped to Gemini 2.5 Flash' },
    'gemini-3.5-flash': { replacement: 'gemini-2.5-flash', provider: 'google', reason: 'Retired preview alias; mapped to Gemini 2.5 Flash' },
    'gemini-3.6-flash': { replacement: 'gemini-2.5-flash', provider: 'google', reason: 'Preview alias mapped to Gemini 2.5 Flash' },
    'gemini-3.7-flash': { replacement: 'gemini-2.5-flash', provider: 'google', reason: 'Preview alias mapped to Gemini 2.5 Flash' },
    'gemini-3-flash-preview': { replacement: 'gemini-2.5-flash', provider: 'google', reason: 'Preview expired; mapped to Gemini 2.5 Flash' },
    'nano-banana-pro-preview': { replacement: 'gemini-2.5-flash', provider: 'google', reason: 'Fictitious preview alias mapped to Gemini 2.5 Flash' },

    // Meta Llama 2 / 3.0 -> Modern Llama 3.3 / 3.1
    'llama-2-70b-chat': { replacement: 'llama-3.3-70b-versatile', provider: 'groq', reason: 'Llama 2 retired; mapped to Llama 3.3 70B' },
    'llama-3-70b-instruct': { replacement: 'llama-3.3-70b-versatile', provider: 'groq', reason: 'Llama 3.0 superseded by Llama 3.3 70B' },
    'llama-3-8b-instruct': { replacement: 'llama-3.1-8b-instant', provider: 'groq', reason: 'Llama 3.0 8b superseded by Llama 3.1 8B' },

    // DeepSeek Aliases & Deprecations
    'deepseek-v4-flash': { replacement: 'deepseek-chat', provider: 'deepseek', reason: 'DeepSeek alias mapped to official deepseek-chat' },
    'deepseek-v4-flash-0731': { replacement: 'deepseek-chat', provider: 'deepseek', reason: 'DeepSeek alias mapped to official deepseek-chat' },
    'deepseek-v4-pro': { replacement: 'deepseek-reasoner', provider: 'deepseek', reason: 'DeepSeek reasoning alias mapped to deepseek-reasoner' },
    'deepseek-v4-flash-vision-exp': { replacement: 'deepseek-chat', provider: 'deepseek', reason: 'Experimental vision alias mapped to deepseek-chat' },

    // Mistral Deprecations
    'mistral-medium-3.5': { replacement: 'mistral-small-latest', provider: 'mistral', reason: 'Retired preview; mapped to mistral-small-latest' },
    'open-mistral-7b': { replacement: 'open-mistral-nemo', provider: 'mistral', reason: 'Superseded by Nemo 12B' },

    // OpenRouter Free Models Retired / Discontinued
    'z-ai/glm-5.2:free': { replacement: 'z-ai/glm-5.3-flash', provider: 'openrouter', reason: 'GLM 5.2 free retired (404); mapped to GLM 5.3 Flash' },
    'z-ai/glm-5.3-flashx': { replacement: 'z-ai/glm-5.3-flash', provider: 'openrouter', reason: 'Deprecated alias; mapped to z-ai/glm-5.3-flash' },
    'minimax/minimax-m3:free': { replacement: 'z-ai/glm-5.3-flash', provider: 'openrouter', reason: 'MiniMax free tier discontinued (404); mapped to active z-ai/glm-5.3-flash' },
    'openai/gpt-6-luna': { replacement: 'openai/gpt-4o-mini', provider: 'openrouter', reason: 'Placeholder model mapped to GPT-4o-mini' },
    'google/gemini-3.8-flash': { replacement: 'google/gemini-2.5-flash', provider: 'openrouter', reason: 'Placeholder model mapped to Gemini 2.5 Flash' },
};

// Local persistent changelog file
const HISTORY_FILE_PATH = path.resolve(process.cwd(), '.project_model_history.json');

/**
 * In-memory cache of project history
 */
let historyCache: Record<string, ModelHistoryEvent[]> = {};

function loadHistory() {
    try {
        if (fs.existsSync(HISTORY_FILE_PATH)) {
            const raw = fs.readFileSync(HISTORY_FILE_PATH, 'utf-8');
            historyCache = JSON.parse(raw);
        }
    } catch (err) {
        console.warn('[ModelHealing] Error reading .project_model_history.json:', err);
    }
}
loadHistory();

function saveHistory() {
    try {
        fs.writeFileSync(HISTORY_FILE_PATH, JSON.stringify(historyCache, null, 2), 'utf-8');
    } catch (err) {
        console.error('[ModelHealing] Error saving .project_model_history.json:', err);
    }
}

/**
 * Record a new history event for a project
 */
export function recordProjectEvent(event: Omit<ModelHistoryEvent, 'id' | 'timestamp'>): ModelHistoryEvent {
    loadHistory();
    const fullEvent: ModelHistoryEvent = {
        ...event,
        id: `evt_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
        timestamp: new Date().toISOString(),
    };

    if (!historyCache[event.projectId]) {
        historyCache[event.projectId] = [];
    }

    // Keep the last 150 events per project to prevent unbounded growth
    historyCache[event.projectId].unshift(fullEvent);
    if (historyCache[event.projectId].length > 150) {
        historyCache[event.projectId] = historyCache[event.projectId].slice(0, 150);
    }

    saveHistory();
    return fullEvent;
}

/**
 * Get the history of events for a project
 */
export function getProjectHistory(projectId: string): ModelHistoryEvent[] {
    loadHistory();
    return historyCache[projectId] || [];
}

/**
 * Resolves a requested model name against the available models of a project/key.
 * If the model does not exist or has been deprecated/retired, it finds the best
 * active compatible replacement and logs an auto-healing event.
 */
export function resolveModelOrHeal(
    projectId: string,
    requestedModel: string,
    configuredModels: string[],
    projectUpstreamProviders: Array<{ id: string; provider: string }> = []
): HealingResult {
    const normalizedReq = (requestedModel || '').trim();

    // 1. Direct Match: If the model is explicitly configured and available, no healing needed
    if (configuredModels.includes(normalizedReq)) {
        return {
            healed: false,
            originalModel: normalizedReq,
            resolvedModel: normalizedReq,
        };
    }

    // 2. Virtual special models (fusion, systemone) don't need remapping
    if (normalizedReq === 'fusion' || normalizedReq === 'openclaw/fusion' || normalizedReq.startsWith('fusion:')) {
        return {
            healed: false,
            originalModel: normalizedReq,
            resolvedModel: normalizedReq,
        };
    }

    let resolvedModel: string | null = null;
    let healingReason = '';

    // 3. Known Deprecation Mapping
    const knownMigration = KNOWN_MODEL_MIGRATIONS[normalizedReq];
    if (knownMigration) {
        // If the suggested replacement is directly in our configured models
        if (configuredModels.includes(knownMigration.replacement)) {
            resolvedModel = knownMigration.replacement;
            healingReason = knownMigration.reason;
        } else {
            // Find another active model of the same provider
            const sameProviderModel = configuredModels.find(m => {
                if (knownMigration.provider === 'openai' && (m.includes('gpt') || m.includes('o1') || m.includes('o3'))) return true;
                if (knownMigration.provider === 'anthropic' && m.includes('claude')) return true;
                if (knownMigration.provider === 'google' && m.includes('gemini')) return true;
                if (knownMigration.provider === 'groq' && (m.includes('llama') || m.includes('qwen'))) return true;
                return false;
            });

            if (sameProviderModel) {
                resolvedModel = sameProviderModel;
                healingReason = `${knownMigration.reason} (Mapped to active project model: ${sameProviderModel})`;
            }
        }
    }

    // 4. Heuristic Prefix / Family Match
    if (!resolvedModel) {
        if (normalizedReq.startsWith('gpt-') || normalizedReq.startsWith('o1') || normalizedReq.startsWith('o3')) {
            resolvedModel = configuredModels.find(m => m.includes('gpt-4o') || m.includes('gpt-4o-mini') || m.includes('gpt')) || null;
            if (resolvedModel) healingReason = `Auto-healed legacy OpenAI model to active project variant (${resolvedModel})`;
        } else if (normalizedReq.startsWith('claude-')) {
            resolvedModel = configuredModels.find(m => m.includes('claude-3-5') || m.includes('claude-3') || m.includes('claude')) || null;
            if (resolvedModel) healingReason = `Auto-healed legacy Claude model to active project variant (${resolvedModel})`;
        } else if (normalizedReq.startsWith('gemini-')) {
            resolvedModel = configuredModels.find(m => m.includes('gemini-2.5') || m.includes('gemini-2.0') || m.includes('gemini-1.5') || m.includes('gemini')) || null;
            if (resolvedModel) healingReason = `Auto-healed legacy Gemini model to active project variant (${resolvedModel})`;
        } else if (normalizedReq.includes('deepseek')) {
            resolvedModel = configuredModels.find(m => m.includes('deepseek')) || null;
            if (resolvedModel) healingReason = `Auto-healed DeepSeek model to active project variant (${resolvedModel})`;
        } else if (normalizedReq.includes('qwen')) {
            resolvedModel = configuredModels.find(m => m.includes('qwen')) || null;
            if (resolvedModel) healingReason = `Auto-healed Qwen model to active project variant (${resolvedModel})`;
        } else if (normalizedReq.includes('mimo')) {
            resolvedModel = configuredModels.find(m => m.includes('mimo')) || null;
            if (resolvedModel) healingReason = `Auto-healed Mimo model to active project variant (${resolvedModel})`;
        }
    }

    // 5. Ultimate Fallback: If still unmatched, but project has at least 1 active model, use the first available
    if (!resolvedModel && configuredModels.length > 0) {
        resolvedModel = configuredModels[0];
        healingReason = `Model '${normalizedReq}' is retired or unmapped. Auto-routed to active project primary model '${resolvedModel}' to preserve agent availability.`;
    }

    // If a resolution was found, record event and return healed result
    if (resolvedModel && resolvedModel !== normalizedReq) {
        const event = recordProjectEvent({
            projectId,
            eventType: 'auto_healed',
            originalModel: normalizedReq,
            resolvedModel,
            reason: healingReason,
            metadata: {
                configuredCount: configuredModels.length,
            },
        });

        console.log(`[TierMax Healing] [${event.timestamp}] Project ${projectId}: Healed '${normalizedReq}' -> '${resolvedModel}'. Reason: ${healingReason}`);

        return {
            healed: true,
            originalModel: normalizedReq,
            resolvedModel,
            reason: healingReason,
        };
    }

    // Cannot heal (no configured models in project)
    return {
        healed: false,
        originalModel: normalizedReq,
        resolvedModel: normalizedReq,
        reason: 'No replacement model candidates available in project.',
    };
}

/**
 * Diagnostic & Auto-Repair Agent for a Project:
 * Scans all upstream keys and models, runs ping checks, identifies broken/depleted
 * channels, and produces an actionable remediation report.
 */
export async function repairProjectChannels(projectId: string): Promise<{
    projectId: string;
    timestamp: string;
    summary: {
        totalUpstreamKeys: number;
        healthyKeys: number;
        degradedKeys: number;
        totalConfiguredModels: number;
        activeModels: string[];
    };
    channelHealth: Array<{
        keyId: string;
        provider: string;
        ok: boolean;
        latencyMs: number;
        statusCode: number;
        error?: string;
        modelTested: string;
    }>;
    remediationActions: Array<{
        type: 'repaired' | 'failover_ready' | 'action_required';
        target: string;
        details: string;
    }>;
}> {
    const timestamp = new Date().toISOString();

    // 1. Fetch upstream keys for the project
    const { data: upstreamKeys, error: keyErr } = await supabase
        .from('upstream_keys')
        .select('*')
        .eq('project_id', projectId);

    if (keyErr || !upstreamKeys) {
        throw new Error(`Failed to load upstream keys for project ${projectId}: ${keyErr?.message}`);
    }

    // 2. Fetch gateway keys and model mappings for the project
    const { data: gatewayKeys } = await supabase
        .from('gateway_keys')
        .select('id, key_name, gateway_key_models(model_name, upstream_key_id)')
        .eq('project_id', projectId);

    const configuredModelsSet = new Set<string>();
    (gatewayKeys || []).forEach((gk: any) => {
        (gk.gateway_key_models || []).forEach((m: any) => {
            if (m.model_name) configuredModelsSet.add(m.model_name);
        });
    });

    // 3. Ping each active upstream key concurrently with its configured models
    const activeKeys = (upstreamKeys || []).filter((k: any) => k.is_active !== false);
    const pingPromises = activeKeys.map((key: any) => {
        const modelsForThisKey = (gatewayKeys || []).flatMap((gk: any) =>
            (gk.gateway_key_models || [])
                .filter((m: any) => m.upstream_key_id === key.id)
                .map((m: any) => m.model_name)
        );
        return runKeyPing(key, modelsForThisKey);
    });
    const pingResults = await Promise.allSettled(pingPromises);

    const channelHealth: any[] = [];
    let healthyCount = 0;
    let degradedCount = 0;
    const remediations: any[] = [];

    pingResults.forEach((res, i) => {
        const key = activeKeys[i];
        if (res.status === 'fulfilled') {
            channelHealth.push(res.value);
            if (res.value.ok) {
                healthyCount++;
            } else {
                degradedCount++;
                remediations.push({
                    type: 'action_required',
                    target: `${key.provider} (${key.id.slice(0, 8)})`,
                    details: `API returned HTTP ${res.value.statusCode}: ${res.value.error || 'Connection failed'}. Traffic will automatically failover to healthy providers.`,
                });
            }
        } else {
            degradedCount++;
            channelHealth.push({
                upstreamKeyId: key.id,
                provider: key.provider,
                ok: false,
                latencyMs: 0,
                statusCode: 500,
                error: res.reason?.message || 'Ping probe timeout or error',
                modelTested: 'unknown',
            });
            remediations.push({
                type: 'action_required',
                target: `${key.provider} (${key.id.slice(0, 8)})`,
                details: `Probe failed: ${res.reason?.message}. Checked and flagged for failover.`,
            });
        }
    });

    if (healthyCount > 0 && degradedCount > 0) {
        remediations.push({
            type: 'repaired',
            target: 'Smart Failover Mesh',
            details: `Auto-routed incoming requests away from ${degradedCount} degraded provider(s) to ${healthyCount} healthy channel(s).`,
        });
    }

    if (healthyCount > 0 && remediations.length === 0) {
        remediations.push({
            type: 'repaired',
            target: 'All Channels',
            details: `All ${healthyCount} upstream channel(s) are online with nominal response latencies.`,
        });
    }

    const activeModelsList = Array.from(configuredModelsSet);

    // Record repair event in history
    recordProjectEvent({
        projectId,
        eventType: 'channel_repaired',
        reason: `Channel Health Scan: ${healthyCount}/${activeKeys.length} channels healthy. ${remediations.length} diagnostic findings.`,
        metadata: {
            healthyCount,
            degradedCount,
            totalChannels: activeKeys.length,
        },
    });

    return {
        projectId,
        timestamp,
        summary: {
            totalUpstreamKeys: upstreamKeys.length,
            healthyKeys: healthyCount,
            degradedKeys: degradedCount,
            totalConfiguredModels: activeModelsList.length,
            activeModels: activeModelsList,
        },
        channelHealth,
        remediationActions: remediations,
    };
}

export interface TestResult {
    upstreamKeyId: string;
    provider: string;
    ok: boolean;
    latencyMs: number;
    statusCode: number;
    error?: string;
    modelTested: string;
}

export const DEFAULT_TEST_MODELS: Record<string, string> = {
    google: 'gemini-2.5-flash',
    vertex: 'gemini-2.5-flash',
    groq: 'qwen/qwen3.8-27b',
    cerebras: 'llama3.1-8b',
    openai: 'gpt-4o-mini',
    openrouter: 'openrouter/free',
    mistral: 'codestral-latest',
    deepseek: 'deepseek-chat',
    puter: 'gpt-4o-mini',
    nvidia: 'meta/llama-3.3-70b-instruct',
    minimax: 'abab6.5s-chat',
    moonshot: 'moonshot-v1-8k',
    mimo: 'mimo-v2.6-flash',
    kie: 'gemini-3-flash',
    ollama: 'qwen2.5-coder:latest',
    lmstudio: 'local-model',
    vllm: 'default',
    local: 'default',
};

export function getProviderEndpoint(provider: string, model: string, baseUrl?: string | null): string {
    if (baseUrl && baseUrl.trim()) {
        const clean = baseUrl.trim().replace(/\/+$/, '');
        if (clean.endsWith('/chat/completions')) return clean;
        if (clean.endsWith('/v1')) return `${clean}/chat/completions`;
        return `${clean}/v1/chat/completions`;
    }
    if (provider === 'openai') return 'https://api.openai.com/v1/chat/completions';
    if (provider === 'groq') return 'https://api.groq.com/openai/v1/chat/completions';
    if (provider === 'openrouter') return 'https://openrouter.ai/api/v1/chat/completions';
    if (provider === 'cerebras') return 'https://api.cerebras.ai/v1/chat/completions';
    if (provider === 'google' || provider === 'vertex') return 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions';
    if (provider === 'mistral') return 'https://api.mistral.ai/v1/chat/completions';
    if (provider === 'nvidia') return 'https://integrate.api.nvidia.com/v1/chat/completions';
    if (provider === 'deepseek') return 'https://api.deepseek.com/chat/completions';
    if (provider === 'moonshot') return 'https://api.moonshot.cn/v1/chat/completions';
    if (provider === 'minimax') return 'https://api.minimax.chat/v1/chat/completions';
    if (provider === 'mimo') return 'https://api.xiaomimimo.com/v1/chat/completions';
    if (provider === 'kie') return `https://api.kie.ai/${encodeURIComponent(model)}/v1/chat/completions`;
    if (provider === 'ollama') return 'http://localhost:11434/v1/chat/completions';
    if (provider === 'lmstudio') return 'http://localhost:1234/v1/chat/completions';
    if (provider === 'vllm' || provider === 'local') return 'http://localhost:8000/v1/chat/completions';
    return '';
}

export interface ProbeModelResult {
    ok: boolean;
    model: string;
    upstreamKeyId: string;
    provider: string;
    statusCode: number;
    latencyMs: number;
    error?: string;
    errorCategory?: 'deprecated_or_not_found' | 'paid_or_exhausted' | 'rate_limited' | 'network_or_timeout' | 'other';
}

/**
 * Sends a lightweight, real probe completion request (1 token max) to test
 * if an upstream key can successfully execute a model without error.
 */
export async function probeModelForKey(key: any, model: string): Promise<ProbeModelResult> {
    const provider = key.provider?.toLowerCase() || '';
    const start = Date.now();

    if (provider === 'puter') {
        try {
            await callPuterAI(key.api_key, [{ role: 'user', content: 'hi' }], {
                model,
                max_tokens: 1,
            });
            const latencyMs = Date.now() - start;
            recordLatency(key.id, latencyMs);
            return {
                ok: true,
                model,
                upstreamKeyId: key.id,
                provider,
                statusCode: 200,
                latencyMs,
            };
        } catch (err: any) {
            const latencyMs = Date.now() - start;
            const errMsg = err?.message || 'Puter call failed';
            let cat: ProbeModelResult['errorCategory'] = 'other';
            if (/not found|unknown model|unsupported/i.test(errMsg)) cat = 'deprecated_or_not_found';
            if (/quota|credit|billing|payment/i.test(errMsg)) cat = 'paid_or_exhausted';
            return {
                ok: false,
                model,
                upstreamKeyId: key.id,
                provider,
                statusCode: 500,
                latencyMs,
                error: errMsg,
                errorCategory: cat,
            };
        }
    }

    const endpoint = getProviderEndpoint(provider, model, key.base_url);
    if (!endpoint) {
        return {
            ok: false,
            model,
            upstreamKeyId: key.id,
            provider,
            statusCode: 400,
            latencyMs: 0,
            error: `Unsupported provider endpoint for ${provider}`,
            errorCategory: 'other',
        };
    }

    const controller = new AbortController();
    const timeoutMs = 6000;
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
        const headers: Record<string, string> = {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${key.api_key}`,
        };
        if (provider === 'openrouter') {
            headers['HTTP-Referer'] = 'http://localhost:3000';
            headers['X-Title'] = 'TierMax Discovery';
        }

        const res = await fetch(endpoint, {
            method: 'POST',
            headers,
            body: JSON.stringify({
                model,
                messages: [{ role: 'user', content: 'hi' }],
                max_tokens: 1,
            }),
            signal: controller.signal,
        });
        clearTimeout(timer);
        const latencyMs = Date.now() - start;

        if (res.ok) {
            recordLatency(key.id, latencyMs);
            return {
                ok: true,
                model,
                upstreamKeyId: key.id,
                provider,
                statusCode: res.status,
                latencyMs,
            };
        }

        const errJson = await res.json().catch(() => ({}));
        const errMsg = errJson?.error?.message || errJson?.message || res.statusText || `HTTP ${res.status}`;
        let cat: ProbeModelResult['errorCategory'] = 'other';

        if (/free model training violation|settings\/privacy|agentic harness/i.test(errMsg)) {
            cat = 'paid_or_exhausted';
        } else if (res.status === 404 || res.status === 400 || /not found|deprecated|retired|decommissioned|unknown model|invalid model/i.test(errMsg)) {
            cat = 'deprecated_or_not_found';
        } else if (res.status === 402 || res.status === 403 || /billing|credit|balance|insufficient|quota|payment required|free tier limit/i.test(errMsg)) {
            cat = 'paid_or_exhausted';
        } else if (res.status === 429) {
            cat = 'rate_limited';
        }

        return {
            ok: false,
            model,
            upstreamKeyId: key.id,
            provider,
            statusCode: res.status,
            latencyMs,
            error: errMsg,
            errorCategory: cat,
        };
    } catch (err: any) {
        clearTimeout(timer);
        const latencyMs = Date.now() - start;
        const isTimeout = err?.name === 'AbortError';
        return {
            ok: false,
            model,
            upstreamKeyId: key.id,
            provider,
            statusCode: isTimeout ? 408 : 0,
            latencyMs,
            error: isTimeout ? 'Probe timeout (6s)' : err?.message || 'Network error',
            errorCategory: 'network_or_timeout',
        };
    }
}

/**
 * Pings an upstream key using live 1-token probe logic.
 * Checks project-configured models first, heals deprecated models,
 * and falls back to candidate models without blindly testing broken defaults.
 */
export async function runKeyPing(key: any, candidateModels?: string[]): Promise<TestResult> {
    const provider = key.provider?.toLowerCase() || '';

    // 1. Gather models to test
    let modelsToTry: string[] = [];
    if (candidateModels && candidateModels.length > 0) {
        modelsToTry = [...candidateModels];
    } else {
        // Query models configured for this upstream key in the database
        try {
            const { data: gkm } = await supabase
                .from('gateway_key_models')
                .select('model_name')
                .eq('upstream_key_id', key.id);
            if (gkm && gkm.length > 0) {
                modelsToTry = gkm.map((m: any) => m.model_name).filter(Boolean);
            }
        } catch {
            // ignore
        }
    }

    // 2. Heal any deprecated models in the candidates list
    const healedCandidates: string[] = [];
    for (const m of modelsToTry) {
        const migration = KNOWN_MODEL_MIGRATIONS[m.toLowerCase()] || KNOWN_MODEL_MIGRATIONS[m];
        if (migration?.replacement) {
            healedCandidates.push(migration.replacement);
        } else {
            healedCandidates.push(m);
        }
    }

    // 3. Fallback to curated default for this provider if empty
    if (healedCandidates.length === 0) {
        const fallback = DEFAULT_TEST_MODELS[provider] || 'gpt-4o-mini';
        healedCandidates.push(fallback);
    }

    // Deduplicate while preserving order
    const uniqueModels = Array.from(new Set(healedCandidates));

    let lastResult: ProbeModelResult | null = null;
    let testedModelName = uniqueModels[0] || 'default';

    // 4. Test up to 3 candidate models until one succeeds
    for (let i = 0; i < Math.min(uniqueModels.length, 3); i++) {
        const m = uniqueModels[i];
        testedModelName = m;
        const probeRes = await probeModelForKey(key, m);
        lastResult = probeRes;

        if (probeRes.ok) {
            return {
                upstreamKeyId: key.id,
                provider: key.provider,
                ok: true,
                latencyMs: probeRes.latencyMs,
                statusCode: probeRes.statusCode || 200,
                modelTested: m,
            };
        }

        // If the error was because the model is deprecated/not found or payment required,
        // try the next candidate model so a valid key isn't falsely marked dead!
        if (probeRes.errorCategory === 'deprecated_or_not_found' || probeRes.errorCategory === 'paid_or_exhausted') {
            continue;
        }

        // Hard auth errors (401/403) mean the key itself is invalid; stop testing
        if (probeRes.statusCode === 401 || probeRes.statusCode === 403) {
            break;
        }
    }

    return {
        upstreamKeyId: key.id,
        provider: key.provider,
        ok: false,
        latencyMs: lastResult?.latencyMs || 0,
        statusCode: lastResult?.statusCode || 500,
        error: lastResult?.error || 'All candidate models failed',
        modelTested: testedModelName,
    };
}

/**
 * Gathers candidate models for a given upstream key from provider catalogs
 * and existing configurations, deduplicating and limiting candidates.
 */
export async function fetchCandidateModelsForKey(key: any, existingModels: string[] = []): Promise<string[]> {
    const provider = key.provider?.toLowerCase() || '';
    const candidateSet = new Set<string>(existingModels);

    try {
        if (provider === 'google' || provider === 'vertex') {
            candidateSet.add('gemini-2.5-flash');
            candidateSet.add('gemini-2.5-pro');
            const googleRes = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${key.api_key}`, { signal: AbortSignal.timeout(5000) });
            if (googleRes.ok) {
                const data: any = await googleRes.json();
                (data.models || []).forEach((m: any) => {
                    const name = (m.name || '').replace('models/', '');
                    const isChat = (m.supportedGenerationMethods || []).includes('generateContent');
                    if (isChat && !name.includes('embedding') && !name.includes('aqa') && !name.includes('imagen')) {
                        candidateSet.add(name);
                    }
                });
            }
        } else if (provider === 'groq') {
            const defaults = [
                'qwen/qwen3.8-27b',
                'llama-3.3-70b-versatile',
                'deepseek-r1-distill-llama-70b',
                'llama-3.1-8b-instant',
                'qwen/qwen3.6-27b',
                'openai/gpt-oss-120b',
                'openai/gpt-oss-20b',
            ];
            defaults.forEach(m => candidateSet.add(m));
            const groqRes = await fetch('https://api.groq.com/openai/v1/models', {
                headers: { 'Authorization': `Bearer ${key.api_key}` },
                signal: AbortSignal.timeout(5000),
            });
            if (groqRes.ok) {
                const data: any = await groqRes.json();
                (data.data || []).forEach((m: any) => {
                    if (m.id && !m.id.includes('whisper') && !m.id.includes('guard')) {
                        candidateSet.add(m.id);
                    }
                });
            }
        } else if (provider === 'openrouter') {
            const defaults = [
                'openrouter/free',
                'cohere/north-mini-code:free',
                'qwen/qwen3.8-27b:free',
                'thinkingmachines/inkling:free',
                'poolside/laguna-xs-2.1:free',
                'nvidia/nemotron-3-ultra-550b-a55b:free',
                'nvidia/nemotron-3-super-120b-a12b:free',
                'google/gemma-4-31b-it:free',
                'google/gemma-4-26b-a4b-it:free',
                'nvidia/nemotron-3.5-lightning:free',
                'liquid/lfm-2.5-2.6b:free',
                'z-ai/glm-5.3-flash',
                'google/gemini-2.5-flash',
                'deepseek/deepseek-chat',
            ];
            defaults.forEach(m => candidateSet.add(m));
            const orRes = await fetch('https://openrouter.ai/api/v1/models', { signal: AbortSignal.timeout(5000) });
            if (orRes.ok) {
                const data: any = await orRes.json();
                const freeOrPopular = (data.data || []).filter((m: any) =>
                    m.id?.includes(':free') || m.id === 'openrouter/free' || m.id?.includes('flash')
                );
                freeOrPopular.forEach((m: any) => candidateSet.add(m.id));
            }
        } else if (provider === 'deepseek') {
            ['deepseek-chat', 'deepseek-reasoner', 'deepseek-v4-flash'].forEach(m => candidateSet.add(m));
            const dsRes = await fetch('https://api.deepseek.com/models', {
                headers: { 'Authorization': `Bearer ${key.api_key}` },
                signal: AbortSignal.timeout(5000),
            });
            if (dsRes.ok) {
                const data: any = await dsRes.json();
                (data.data || []).forEach((m: any) => candidateSet.add(m.id));
            }
        } else if (provider === 'mistral') {
            ['open-mistral-nemo', 'mistral-small-latest', 'codestral-latest', 'mistral-large-latest'].forEach(m => candidateSet.add(m));
            const misRes = await fetch('https://api.mistral.ai/v1/models', {
                headers: { 'Authorization': `Bearer ${key.api_key}` },
                signal: AbortSignal.timeout(5000),
            });
            if (misRes.ok) {
                const data: any = await misRes.json();
                (data.data || []).forEach((m: any) => candidateSet.add(m.id));
            }
        } else if (provider === 'cerebras') {
            ['llama3.3-70b', 'llama3.1-8b', 'qwen-3-235b-a22b-instruct-2507', 'gpt-oss-120b'].forEach(m => candidateSet.add(m));
            const cbRes = await fetch('https://api.cerebras.ai/v1/models', {
                headers: { 'Authorization': `Bearer ${key.api_key}` },
                signal: AbortSignal.timeout(5000),
            });
            if (cbRes.ok) {
                const data: any = await cbRes.json();
                (data.data || []).forEach((m: any) => candidateSet.add(m.id));
            }
        } else if (provider === 'mimo') {
            ['mimo-v2.6-flash', 'mimo-v2.6-pro', 'mimo-v2-flash', 'mimo-v2-omni', 'mimo-v2-pro'].forEach(m => candidateSet.add(m));
        } else if (provider === 'puter') {
            PUTER_MODELS.forEach(m => candidateSet.add(m.id));
        } else if (provider === 'nvidia') {
            ['meta/llama-3.3-70b-instruct', 'deepseek-ai/deepseek-v4-flash-0731', 'moonshotai/kimi-k3'].forEach(m => candidateSet.add(m));
        } else if (provider === 'ollama') {
            const baseUrl = (key.base_url || 'http://localhost:11434').replace(/\/+$/, '');
            const res = await fetch(`${baseUrl}/api/tags`, { signal: AbortSignal.timeout(3000) });
            if (res.ok) {
                const data: any = await res.json();
                (data.models || []).forEach((m: any) => candidateSet.add(m.name || m.model));
            }
        }
    } catch (catalogErr: any) {
        console.warn(`[ModelHealing] Catalog fetch for ${provider} (${key.id.slice(0, 8)}) failed: ${catalogErr.message}`);
    }

    // Deduplicate and cap candidates per key to keep scanning snappy
    return Array.from(candidateSet).filter(Boolean).slice(0, 15);
}

export interface ProjectAutoDiscoveryReport {
    projectId: string;
    projectName: string;
    timestamp: string;
    summary: {
        totalUpstreamKeys: number;
        totalProbed: number;
        workingCount: number;
        prunedCount: number;
        healedCount: number;
        activeModelsCount: number;
    };
    discoveredWorkingModels: Array<{ model: string; provider: string; latencyMs: number; upstreamKeyId: string }>;
    prunedDeadModels: Array<{ model: string; provider: string; reason: string; statusCode: number; upstreamKeyId: string }>;
    healedMigrations: Array<{ originalModel: string; replacementModel: string; provider: string; reason: string }>;
    activeModelsAfterSync: string[];
}

/**
 * Intelligent Auto-Discovery, Live Validation and Deprecation Healing for a Project.
 * Probes all candidate models on active keys, eliminates failing/paid-out models,
 * auto-migrates deprecated ones, and binds working models to gateway_key_models.
 */
export async function autoDiscoverAndSyncProjectModels(projectId: string): Promise<ProjectAutoDiscoveryReport> {
    const timestamp = new Date().toISOString();

    // 1. Fetch project details
    const { data: project } = await supabase
        .from('projects')
        .select('*')
        .eq('id', projectId)
        .maybeSingle();

    const projectName = project?.name || 'Unknown Project';

    // 2. Fetch upstream keys
    const { data: upstreamKeys, error: keyErr } = await supabase
        .from('upstream_keys')
        .select('*')
        .eq('project_id', projectId);

    if (keyErr || !upstreamKeys) {
        throw new Error(`Failed to load upstream keys for project ${projectId}: ${keyErr?.message}`);
    }

    // 3. Fetch gateway keys for the project
    let { data: gatewayKeys } = await supabase
        .from('gateway_keys')
        .select('id, key_name, api_key, gateway_key_models(id, model_name, upstream_key_id)')
        .eq('project_id', projectId);

    // If project has no gateway key, create a default one so routing is always available
    if (!gatewayKeys || gatewayKeys.length === 0) {
        const defaultGwId = crypto.randomUUID();
        const defaultGwKey = `gk_${crypto.randomBytes(16).toString('hex')}`;
        await supabase.from('gateway_keys').insert([{
            id: defaultGwId,
            project_id: projectId,
            key_name: 'Default Gateway Key',
            api_key: defaultGwKey,
        }]);

        const refetch = await supabase
            .from('gateway_keys')
            .select('id, key_name, api_key, gateway_key_models(id, model_name, upstream_key_id)')
            .eq('project_id', projectId);
        gatewayKeys = refetch.data || [];
    }

    const activeKeys = (upstreamKeys || []).filter((k: any) => {
        if (k.is_active === false || k.is_active === 0 || k.is_active === 'false') return false;
        if (providerStates[k.id]?.status === 'paused') return false;
        return true;
    });

    // Map existing models configured in gateway_key_models
    const existingModelsByKey = new Map<string, string[]>();
    (gatewayKeys || []).forEach((gk: any) => {
        (gk.gateway_key_models || []).forEach((m: any) => {
            const kId = m.upstream_key_id;
            if (kId && m.model_name) {
                if (!existingModelsByKey.has(kId)) existingModelsByKey.set(kId, []);
                existingModelsByKey.get(kId)!.push(m.model_name);
            }
        });
    });

    const discoveredWorking: ProjectAutoDiscoveryReport['discoveredWorkingModels'] = [];
    const prunedDead: ProjectAutoDiscoveryReport['prunedDeadModels'] = [];
    const healedMigrations: ProjectAutoDiscoveryReport['healedMigrations'] = [];
    let totalProbed = 0;

    // Set of working model names mapped to upstreamKeyId
    const confirmedWorkingPairs: Array<{ model_name: string; upstream_key_id: string; provider: string }> = [];
    const failedModelNamesSet = new Set<string>();

    for (const key of activeKeys) {
        const existingForThisKey = existingModelsByKey.get(key.id) || [];
        const candidateModels = await fetchCandidateModelsForKey(key, existingForThisKey);

        const CHUNK_SIZE = key.provider?.toLowerCase() === 'puter' ? 1 : 3;
        for (let i = 0; i < candidateModels.length; i += CHUNK_SIZE) {
            const chunk = candidateModels.slice(i, i + CHUNK_SIZE);
            totalProbed += chunk.length;
            const chunkResults = await Promise.all(chunk.map(c => probeModelForKey(key, c)));

            for (const probeRes of chunkResults) {
                const candidate = probeRes.model;

                if (probeRes.ok) {
                    discoveredWorking.push({
                        model: candidate,
                        provider: key.provider,
                        latencyMs: probeRes.latencyMs,
                        upstreamKeyId: key.id,
                    });
                    confirmedWorkingPairs.push({
                        model_name: candidate,
                        upstream_key_id: key.id,
                        provider: key.provider,
                    });
                } else {
                    failedModelNamesSet.add(candidate);

                    // Check if candidate has a known migration to a modern free replacement
                    const migration = KNOWN_MODEL_MIGRATIONS[candidate];
                    let healedSuccessfully = false;

                    if (migration && migration.replacement !== candidate) {
                        // Probe the replacement model on this same key
                        const replacementProbe = await probeModelForKey(key, migration.replacement);
                        if (replacementProbe.ok) {
                            healedSuccessfully = true;
                            healedMigrations.push({
                                originalModel: candidate,
                                replacementModel: migration.replacement,
                                provider: key.provider,
                                reason: migration.reason,
                            });
                            confirmedWorkingPairs.push({
                                model_name: migration.replacement,
                                upstream_key_id: key.id,
                                provider: key.provider,
                            });
                            discoveredWorking.push({
                                model: migration.replacement,
                                provider: key.provider,
                                latencyMs: replacementProbe.latencyMs,
                                upstreamKeyId: key.id,
                            });

                            recordProjectEvent({
                                projectId,
                                eventType: 'auto_healed',
                                originalModel: candidate,
                                resolvedModel: migration.replacement,
                                provider: key.provider,
                                reason: `Discontinued/Paid-out model '${candidate}' auto-migrated to verified working '${migration.replacement}'. (${migration.reason})`,
                            });
                        }
                    }

                    prunedDead.push({
                        model: candidate,
                        provider: key.provider,
                        reason: healedSuccessfully
                            ? `Replaced with ${migration?.replacement}`
                            : probeRes.error || `HTTP ${probeRes.statusCode}`,
                        statusCode: probeRes.statusCode,
                        upstreamKeyId: key.id,
                    });
                }
            }
        }
    }


    // 4. Synchronize gateway_key_models in Database
    // A model is pruned if it failed and is NOT confirmed working on any active key in this project
    const workingModelNames = new Set(confirmedWorkingPairs.map(p => p.model_name));
    const modelsToPrune = Array.from(failedModelNamesSet).filter(m => !workingModelNames.has(m));

    for (const gk of gatewayKeys || []) {
        // Prune dead models from this gateway key
        if (modelsToPrune.length > 0) {
            for (const deadName of modelsToPrune) {
                await supabase
                    .from('gateway_key_models')
                    .delete()
                    .eq('gateway_key_id', gk.id)
                    .eq('model_name', deadName);

                recordProjectEvent({
                    projectId,
                    eventType: 'model_removed',
                    originalModel: deadName,
                    reason: `Model probe failed (unavailable/paid/deprecated). Pruned from gateway to prevent turn failures.`,
                });
            }
        }

        // Add confirmed working models to this gateway key
        const existingEntries = gk.gateway_key_models || [];
        const existingPairKeys = new Set(existingEntries.map((e: any) => `${e.gateway_key_id || gk.id}_${e.model_name}`));

        const inserts: any[] = [];
        for (const wp of confirmedWorkingPairs) {
            const pairKey = `${gk.id}_${wp.model_name}`;
            if (!existingPairKeys.has(pairKey)) {
                existingPairKeys.add(pairKey);
                inserts.push({
                    id: crypto.randomUUID(),
                    gateway_key_id: gk.id,
                    upstream_key_id: wp.upstream_key_id,
                    model_name: wp.model_name,
                });

                recordProjectEvent({
                    projectId,
                    eventType: 'model_added',
                    resolvedModel: wp.model_name,
                    provider: wp.provider,
                    reason: `Live probe verified 200 OK. Auto-added to project available models.`,
                });
            }
        }

        if (inserts.length > 0) {
            await supabase.from('gateway_key_models').insert(inserts);
        }
    }

    // Invalidate caches
    invalidateGatewayKeyCache();
    invalidateUpstreamKeyCache();

    // Query updated active models
    const { data: updatedGk } = await supabase
        .from('gateway_keys')
        .select('gateway_key_models(model_name)')
        .eq('project_id', projectId);

    const activeSet = new Set<string>();
    (updatedGk || []).forEach((gk: any) => {
        (gk.gateway_key_models || []).forEach((m: any) => {
            if (m.model_name) activeSet.add(m.model_name);
        });
    });
    const activeModelsAfterSync = Array.from(activeSet).sort();

    recordProjectEvent({
        projectId,
        eventType: 'channel_repaired',
        reason: `Auto-Discovery complete: Probed ${totalProbed} candidate(s). ${discoveredWorking.length} verified online, ${modelsToPrune.length} pruned, ${healedMigrations.length} auto-migrated. Total active models: ${activeModelsAfterSync.length}.`,
        metadata: {
            discoveredCount: discoveredWorking.length,
            prunedCount: modelsToPrune.length,
            healedCount: healedMigrations.length,
            activeModels: activeModelsAfterSync,
        },
    });

    console.log(`[ModelHealing] Project ${projectName} (${projectId}): Synced. Discovered=${discoveredWorking.length}, Pruned=${modelsToPrune.length}, Healed=${healedMigrations.length}, TotalActive=${activeModelsAfterSync.length}`);

    return {
        projectId,
        projectName,
        timestamp,
        summary: {
            totalUpstreamKeys: activeKeys.length,
            totalProbed,
            workingCount: discoveredWorking.length,
            prunedCount: modelsToPrune.length,
            healedCount: healedMigrations.length,
            activeModelsCount: activeModelsAfterSync.length,
        },
        discoveredWorkingModels: discoveredWorking,
        prunedDeadModels: prunedDead,
        healedMigrations,
        activeModelsAfterSync,
    };
}

export interface AllProjectsAutoDiscoveryReport {
    timestamp: string;
    totalProjects: number;
    totalWorkingDiscovered: number;
    totalPruned: number;
    totalHealed: number;
    projectsSummary: Array<{
        projectId: string;
        projectName: string;
        workingCount: number;
        prunedCount: number;
        healedCount: number;
        activeModels: string[];
    }>;
}

/**
 * Executes Auto-Discovery, Live Validation and Deprecation Healing across ALL projects.
 */
export async function autoDiscoverAndSyncAllProjects(): Promise<AllProjectsAutoDiscoveryReport> {
    const timestamp = new Date().toISOString();
    const { data: allProjects, error } = await supabase
        .from('projects')
        .select('id, name')
        .order('name');

    if (error || !allProjects) {
        throw new Error(`Failed to load projects: ${error?.message}`);
    }

    const projectsSummary: AllProjectsAutoDiscoveryReport['projectsSummary'] = [];
    let totalWorkingDiscovered = 0;
    let totalPruned = 0;
    let totalHealed = 0;

    for (const proj of allProjects) {
        try {
            const report = await autoDiscoverAndSyncProjectModels(proj.id);
            totalWorkingDiscovered += report.summary.workingCount;
            totalPruned += report.summary.prunedCount;
            totalHealed += report.summary.healedCount;

            projectsSummary.push({
                projectId: proj.id,
                projectName: proj.name,
                workingCount: report.summary.workingCount,
                prunedCount: report.summary.prunedCount,
                healedCount: report.summary.healedCount,
                activeModels: report.activeModelsAfterSync,
            });
        } catch (projErr: any) {
            console.warn(`[ModelHealing] Auto-sync failed for project ${proj.name} (${proj.id}): ${projErr.message}`);
            projectsSummary.push({
                projectId: proj.id,
                projectName: proj.name,
                workingCount: 0,
                prunedCount: 0,
                healedCount: 0,
                activeModels: [],
            });
        }
    }

    return {
        timestamp,
        totalProjects: allProjects.length,
        totalWorkingDiscovered,
        totalPruned,
        totalHealed,
        projectsSummary,
    };
}

