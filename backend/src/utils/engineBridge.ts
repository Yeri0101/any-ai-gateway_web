/**
 * TierMax — Dual Engine Bridge (System 1: TypeSafe Jev + System 2: Manager LLM)
 *
 * Implements the dual intelligence architecture:
 * - System 1 (TypeSafe AI / Jev): Sub-millisecond typed decision engine for
 *   intelligent tier routing, rate-limit branch decisions, and cache confidence scoring.
 * - System 2 (Manager LLM): High-reasoning model for auto-calibrating free-tier limits,
 *   diagnosing provider errors, and optimizing token economics.
 */

import { RoutingTier } from './tierConfig';
import { classifyRequest, estimateTokenCount } from './smartRouter';
import { supabase } from '../db';
import * as fs from 'fs';
import * as path from 'path';

export interface JevDecisionResult {
    tier: RoutingTier;
    shouldThrottle: boolean;
    confidenceScore: number;
    decisionSource: 'jev_system_one' | 'heuristic_fallback';
    latencyMs: number;
}

export interface EngineConfig {
    // System 1: TypeSafe AI / Jev
    typesafeApiKey?: string;
    typesafeEndpoint?: string;
    typesafeModel?: string;
    enableJevRouting: boolean;

    // System 2: Manager LLM
    managerProvider: 'google' | 'groq' | 'openai' | 'anthropic' | 'deepseek' | 'openrouter' | 'custom';
    managerApiKey?: string;
    managerModel?: string;
    managerBaseUrl?: string;
    managerTemperature: number;
    managerProjectId?: string;
    managerUpstreamKeyId?: string;

    // System 3: Virtual Consensus Fusion Configuration
    fusionDefaultModels?: string[];
    fusionDefaultJudge?: string;
    fusionSlotProjects?: string[];
}

const DEFAULT_ENGINE_CONFIG: EngineConfig = {
    typesafeApiKey: process.env.TYPESAFE_API_KEY || '',
    typesafeEndpoint: process.env.TYPESAFE_ENDPOINT || 'https://openrouter.ai/api/alpha/decisions',
    typesafeModel: process.env.TYPESAFE_MODEL || '~typesafe/jev-latest',
    enableJevRouting: process.env.ENABLE_JEV_ROUTING === 'true',

    managerProvider: (process.env.MANAGER_LLM_PROVIDER as any) || 'google',
    managerApiKey: process.env.MANAGER_LLM_API_KEY || '',
    managerModel: process.env.MANAGER_LLM_MODEL || 'gemini-2.5-flash',
    managerBaseUrl: process.env.MANAGER_LLM_BASE_URL || 'https://generativelanguage.googleapis.com/v1beta/openai',
    managerTemperature: 0.2,
    managerProjectId: '',
    managerUpstreamKeyId: '',

    fusionDefaultModels: ['deepseek-chat', 'qwen/qwen3.8-27b', 'gemini-2.5-flash'],
    fusionDefaultJudge: 'qwen/qwen3.8-27b',
    fusionSlotProjects: ['', '', '', ''],
};

let currentConfig: EngineConfig = { ...DEFAULT_ENGINE_CONFIG };

function getResolvedConfigPath(): string {
    const fromDir = path.resolve(__dirname, '../../.engine_config.json');
    if (fs.existsSync(fromDir)) return fromDir;
    const fromCwd = path.resolve(process.cwd(), '.engine_config.json');
    if (fs.existsSync(fromCwd)) return fromCwd;
    const fromCwdBackend = path.resolve(process.cwd(), 'backend', '.engine_config.json');
    if (fs.existsSync(fromCwdBackend)) return fromCwdBackend;
    return fromDir;
}

function loadPersistedConfig() {
    try {
        const filePath = getResolvedConfigPath();
        if (fs.existsSync(filePath)) {
            const raw = fs.readFileSync(filePath, 'utf-8');
            const parsed = JSON.parse(raw);
            currentConfig = { ...DEFAULT_ENGINE_CONFIG, ...parsed };
        }
    } catch (e) {
        console.warn('[EngineBridge] Could not load persisted engine config:', e);
    }
}
loadPersistedConfig();

export function isMaskedOrPreviewKey(key?: string): boolean {
    if (!key) return true;
    const trimmed = key.trim();
    if (!trimmed) return true;
    if (trimmed.includes('••••')) return true;
    if (trimmed.includes('...')) return true;
    if (trimmed.includes('…')) return true;
    if (trimmed.includes('🔄') || trimmed.includes('Rotación')) return true;
    return false;
}

export function getEngineConfig(maskKeys = true): EngineConfig {
    loadPersistedConfig();
    if (!maskKeys) return { ...currentConfig };

    return {
        ...currentConfig,
        typesafeApiKey: maskSecret(currentConfig.typesafeApiKey),
        managerApiKey: maskSecret(currentConfig.managerApiKey),
    };
}

export function updateEngineConfig(updates: Partial<EngineConfig>): EngineConfig {
    loadPersistedConfig();
    // Only update API keys if not sent as masked/preview strings
    const cleanUpdates: Partial<EngineConfig> = { ...updates };
    if (cleanUpdates.typesafeApiKey && isMaskedOrPreviewKey(cleanUpdates.typesafeApiKey)) {
        delete cleanUpdates.typesafeApiKey;
    }
    if (cleanUpdates.managerApiKey && isMaskedOrPreviewKey(cleanUpdates.managerApiKey)) {
        delete cleanUpdates.managerApiKey;
    }
    // If manager is linked to an upstream project key or project pool, ensure managerApiKey is empty in file
    if (cleanUpdates.managerUpstreamKeyId || cleanUpdates.managerProjectId) {
        cleanUpdates.managerApiKey = '';
    }

    currentConfig = { ...currentConfig, ...cleanUpdates };

    try {
        const filePath = getResolvedConfigPath();
        fs.writeFileSync(filePath, JSON.stringify(currentConfig, null, 2), 'utf-8');
    } catch (err) {
        console.error('[EngineBridge] Failed to persist config to disk:', err);
    }

    return getEngineConfig(true);
}

function maskSecret(val?: string): string {
    if (!val || val.length <= 6) return val ? '••••••' : '';
    return `${val.slice(0, 3)}••••••${val.slice(-3)}`;
}

/**
 * System 1: Ask Jev for a typed routing and rate-limit guard decision.
 * Falls back transparently to zero-overhead local heuristics if Jev is disabled or unavailable.
 */
export async function consultSystemOne(payload: {
    messages: any[];
    tools?: any[];
    model?: string;
    candidateCount: number;
    hasNearLimitKeys: boolean;
}): Promise<JevDecisionResult> {
    const start = Date.now();
    const heuristicTier = classifyRequest({ messages: payload.messages, tools: payload.tools });
    const estimatedTokens = estimateTokenCount(payload.messages);

    // If Jev routing is not enabled or no key is provided, return instant heuristic result
    if (!currentConfig.enableJevRouting || !currentConfig.typesafeApiKey) {
        return {
            tier: heuristicTier,
            shouldThrottle: payload.hasNearLimitKeys,
            confidenceScore: 92,
            decisionSource: 'heuristic_fallback',
            latencyMs: Date.now() - start,
        };
    }

    try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 150); // Strict 150ms fast-timeout for System 1 so upstream TTFT is never blocked

        const lastMsg = payload.messages?.slice(-1)[0]?.content;
        const preview = typeof lastMsg === 'string' ? lastMsg.slice(0, 500) : '';

        const endpoint = currentConfig.typesafeEndpoint || 'https://openrouter.ai/api/alpha/decisions';
        const model = currentConfig.typesafeModel || '~typesafe/jev-latest';
        const isOpenRouter = endpoint.includes('openrouter.ai') || endpoint.includes('/decisions');

        let jevBody: any;
        if (isOpenRouter) {
            jevBody = {
                model,
                state: {
                    prompt: preview || 'General query',
                    estimated_tokens: estimatedTokens,
                    tool_count: payload.tools?.length || 0,
                    candidate_count: payload.candidateCount,
                    has_near_limit_keys: payload.hasNearLimitKeys,
                },
                questions: {
                    route_tier: {
                        type: 'choice',
                        instructions: 'Determine the optimal LLM execution tier for this user request based on its computational complexity, nuance, and domain requirements.',
                        criteria: {
                            economy: 'Simple questions, basic greetings, lightweight summarization, trivial text extraction, fast lookups',
                            standard: 'General conversation, content writing, standard explanations, moderate code snippets, translation',
                            premium: 'Advanced software engineering, complex system architecture, deep mathematical reasoning, multi-file code synthesis'
                        }
                    },
                    should_throttle: {
                        type: 'noul',
                        instructions: 'Probability (0 to 1) that this request is abusive, spammy, or likely to exhaust rate limits rapidly'
                    }
                }
            };
        } else {
            jevBody = {
                model,
                state: {
                    prompt_preview: preview,
                    estimated_tokens: estimatedTokens,
                    tool_count: payload.tools?.length || 0,
                    candidate_count: payload.candidateCount,
                    heuristic_tier: heuristicTier,
                    has_near_limit_keys: payload.hasNearLimitKeys,
                },
                questions: {
                    route_tier: {
                        type: 'choice',
                        options: ['economy', 'standard', 'premium'],
                        question: 'Select the optimal LLM tier based on task complexity and token budget'
                    },
                    should_throttle: {
                        type: 'noul',
                        question: 'Is it recommended to apply smooth throttling to preserve free-tier limits?'
                    },
                    confidence: {
                        type: 'score',
                        min: 0,
                        max: 100,
                        question: 'Confidence score for selected tier'
                    }
                }
            };
        }

        const res = await fetch(endpoint, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${currentConfig.typesafeApiKey}`,
            },
            body: JSON.stringify(jevBody),
            signal: controller.signal,
        });
        clearTimeout(timeout);

        if (res.ok) {
            const data: any = await res.json();
            const chosenTier: RoutingTier = data?.answers?.route_tier?.choice || data?.answers?.route_tier?.selected || heuristicTier;
            const throttleVal = data?.answers?.should_throttle?.noul ?? data?.answers?.should_throttle?.probability ?? 0;
            const shouldThrottle = Boolean(throttleVal > 0.6);
            const rawScore = data?.answers?.route_tier?.confidence ?? data?.answers?.confidence?.value ?? 0.95;
            const score = rawScore <= 1 ? Math.round(rawScore * 100) : Math.round(rawScore);

            return {
                tier: ['economy', 'standard', 'premium'].includes(chosenTier) ? chosenTier : heuristicTier,
                shouldThrottle: shouldThrottle || payload.hasNearLimitKeys,
                confidenceScore: score,
                decisionSource: 'jev_system_one',
                latencyMs: Date.now() - start,
            };
        }
    } catch (err: any) {
        // Safe fallback without interrupting user request
        console.warn(`[EngineBridge] Jev System 1 unavailable (${err.message}). Using heuristic classifier.`);
    }

    return {
        tier: heuristicTier,
        shouldThrottle: payload.hasNearLimitKeys,
        confidenceScore: 88,
        decisionSource: 'heuristic_fallback',
        latencyMs: Date.now() - start,
    };
}

/**
 * System 2: Execute an instruction using the Management LLM.
 * Used for auto-calibrating free-tier limits and provider health diagnostics.
 */
export async function executeManagerLLM(
    prompt: string,
    systemPrompt?: string,
    overrides?: {
        apiKey?: string;
        baseUrl?: string;
        model?: string;
        provider?: string;
        upstreamKeyId?: string;
        temperature?: number;
    }
): Promise<{ success: boolean; content: string; latencyMs: number; error?: string }> {
    const start = Date.now();
    let apiKey = overrides?.apiKey;
    const keyId = overrides?.upstreamKeyId || currentConfig.managerUpstreamKeyId;
    let provider = overrides?.provider || currentConfig.managerProvider || 'google';

    let managerKeyRotationIndex = 0;
    const projectId = currentConfig.managerProjectId;

    // 1. If a project pool is selected (with rotation across its keys), pick a key with round-robin
    if (!keyId && projectId && isMaskedOrPreviewKey(apiKey)) {
        try {
            const { data: projectKeys } = await supabase
                .from('upstream_keys')
                .select('id, api_key, provider')
                .eq('project_id', projectId);

            if (projectKeys && projectKeys.length > 0) {
                const picked = projectKeys[Math.floor(Math.random() * projectKeys.length)];
                if (picked?.api_key) {
                    apiKey = picked.api_key;
                }
                if (picked?.provider && !overrides?.provider) {
                    provider = picked.provider;
                }
            }
        } catch (dbErr: any) {
            console.warn('[EngineBridge] Could not fetch project keys for Manager LLM:', dbErr?.message || dbErr);
        }
    }

    // 2. If a specific upstream key is pinned to this manager, fetch real secret key if needed
    if (keyId && isMaskedOrPreviewKey(apiKey)) {
        try {
            const { data: keyRow, error: keyErr } = await supabase
                .from('upstream_keys')
                .select('api_key, provider')
                .eq('id', keyId)
                .single();
            if (keyRow?.api_key) {
                apiKey = keyRow.api_key;
            }
            if (keyRow?.provider && !overrides?.provider) {
                provider = keyRow.provider;
            }
        } catch (dbErr: any) {
            console.warn('[EngineBridge] Could not fetch upstream key for Manager LLM:', dbErr?.message || dbErr);
        }
    }

    // 3. Fall back to currentConfig if no project key was used and a manual key exists
    if (!apiKey && !isMaskedOrPreviewKey(currentConfig.managerApiKey)) {
        apiKey = currentConfig.managerApiKey;
    }

    if (!apiKey) {
        return {
            success: false,
            content: '',
            latencyMs: Date.now() - start,
            error: 'Manager LLM API key not configured. Please select a project or configure an API key in Engine Settings.',
        };
    }

    const providerDefaults: Record<string, string> = {
        google: 'https://generativelanguage.googleapis.com/v1beta/openai',
        openrouter: 'https://openrouter.ai/api/v1',
        groq: 'https://api.groq.com/openai/v1',
        cerebras: 'https://api.cerebras.ai/v1',
        mistral: 'https://api.mistral.ai/v1',
        openai: 'https://api.openai.com/v1',
        mimo: 'https://api.xiaomimimo.com/v1',
        deepseek: 'https://api.deepseek.com/v1',
        nvidia: 'https://integrate.api.nvidia.com/v1',
        moonshot: 'https://api.moonshot.cn/v1',
        minimax: 'https://api.minimax.chat/v1',
        vertex: 'https://generativelanguage.googleapis.com/v1beta/openai',
    };

    const temperature = overrides?.temperature ?? currentConfig.managerTemperature ?? 0.2;

    if (provider === 'anthropic') {
        const anthropicUrl = overrides?.baseUrl || 'https://api.anthropic.com/v1/messages';
        const anthropicModel = overrides?.model || currentConfig.managerModel || 'claude-3-5-haiku-20241022';
        try {
            const res = await fetch(anthropicUrl, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'x-api-key': apiKey,
                    'anthropic-version': '2023-06-01',
                },
                body: JSON.stringify({
                    model: anthropicModel,
                    max_tokens: 1024,
                    ...(systemPrompt ? { system: systemPrompt } : {}),
                    messages: [{ role: 'user', content: prompt }],
                    temperature,
                }),
            });
            if (!res.ok) {
                const errData = await res.json().catch(() => ({}));
                return {
                    success: false,
                    content: '',
                    latencyMs: Date.now() - start,
                    error: `Anthropic Manager LLM HTTP ${res.status}: ${errData?.error?.message || res.statusText}`,
                };
            }
            const data: any = await res.json();
            const content = data?.content?.[0]?.text || '';
            return {
                success: true,
                content,
                latencyMs: Date.now() - start,
            };
        } catch (err: any) {
            return {
                success: false,
                content: '',
                latencyMs: Date.now() - start,
                error: err.message,
            };
        }
    }

    let url = overrides?.baseUrl || providerDefaults[provider] || currentConfig.managerBaseUrl || 'https://generativelanguage.googleapis.com/v1beta/openai';
    if (!url.endsWith('/chat/completions')) {
        url = url.replace(/\/+$/, '') + '/chat/completions';
    }

    const model = overrides?.model || currentConfig.managerModel || 'gemini-2.5-flash';

    const messages = [
        ...(systemPrompt ? [{ role: 'system', content: systemPrompt }] : []),
        { role: 'user', content: prompt }
    ];

    try {
        const headers: Record<string, string> = {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${apiKey}`,
        };
        if (provider === 'openrouter') {
            headers['HTTP-Referer'] = 'https://cursor.com';
            headers['X-Title'] = 'Cursor Agent';
        }

        const res = await fetch(url, {
            method: 'POST',
            headers,
            body: JSON.stringify({
                model,
                messages,
                temperature,
            }),
        });

        if (!res.ok) {
            const errText = await res.text().catch(() => '');
            let errMsg = res.statusText;
            try {
                const parsed = JSON.parse(errText);
                errMsg = parsed?.error?.message || parsed?.message || (typeof parsed === 'string' ? parsed : errText);
            } catch {
                errMsg = errText || res.statusText;
            }
            return {
                success: false,
                content: '',
                latencyMs: Date.now() - start,
                error: `Manager LLM HTTP ${res.status}: ${errMsg}`,
            };
        }

        const data: any = await res.json();
        const content = data?.choices?.[0]?.message?.content || '';
        return {
            success: true,
            content,
            latencyMs: Date.now() - start,
        };
    } catch (err: any) {
        return {
            success: false,
            content: '',
            latencyMs: Date.now() - start,
            error: err.message,
        };
    }
}

/**
 * Auto-calibrate Free Tier limits for all configured keys in a project using System 2.
 */
export async function autoCalibrateFreeTiers(providersList: Array<{ id: string; provider: string; billing_type: string }>): Promise<any> {
    const prompt = `You are the TierMax Free-Tier Optimization Engine.
Given this list of active provider keys in the gateway:
${JSON.stringify(providersList, null, 2)}

Provide the recommended conservative Rate Limits (RPM, TPM, RPD) to guarantee zero 429 errors for each provider on their free tier.
Return ONLY a valid JSON array matching this exact schema:
[
  {
    "id": "key-id-here",
    "provider": "provider-name",
    "recommended_rpm": 15,
    "recommended_tpm": 1000000,
    "recommended_rpd": 1500,
    "rationale": "Official Gemini Flash free tier specification"
  }
]`;

    const res = await executeManagerLLM(prompt, 'You are an expert in AI API rate limits and quotas. Return only pure JSON without markdown or code fences.');
    if (!res.success) {
        return { success: false, error: res.error };
    }

    try {
        const cleaned = res.content.replace(/```json/g, '').replace(/```/g, '').trim();
        const parsed = JSON.parse(cleaned);
        return {
            success: true,
            recommendations: parsed,
            latencyMs: res.latencyMs,
        };
    } catch (parseErr: any) {
        return {
            success: false,
            error: `Failed to parse Manager LLM output as JSON: ${parseErr.message}`,
            rawContent: res.content,
        };
    }
}
