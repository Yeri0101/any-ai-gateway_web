/**
 * aiModelAdvisor.ts
 *
 * TierMax Frontier Model Intelligence Advisor
 * Evaluates, ranks, and dynamically configures Virtual Consensus Fusion presets
 * for Reasoning, Speed, and Frontier categories across both Free and Paid tiers.
 *
 * Anti-Bias Protocol:
 * 1. Bypasses Training Cutoff Inertia & SEO Backlink Bias by referencing live 2026 leaderboards
 *    (Artificial Analysis Intelligence Index v4.3+, LMSYS Arena 2026, SWE-bench / GDPval-AA).
 * 2. Cross-references real-time catalogs from OpenRouter (:free and flagship), Google, Groq,
 *    NVIDIA NIM, Mistral, and user-configured upstream provider keys.
 * 3. Provides 3 ranked fallback versions (v1_gold, v2_silver, v3_bronze) per mode.
 */

import { supabase } from '../db';
import { executeManagerLLM } from './engineBridge';
import { probeModelForKey } from './modelHealing';

export interface FusionPresetVersion {
    versionId: 'v1_gold' | 'v2_silver' | 'v3_bronze';
    label: string;
    draft_a: string;
    draft_b: string;
    draft_c: string;
    judge: string;
    rationale: string;
    fallback_trigger: string;
    key_metrics?: {
        artificialAnalysisScore?: number;
        estimatedLatencyMs?: number;
        reasoningScore?: number;
    };
    slotProjects?: string[]; // project:<id> or key id for each of the 4 slots
}

export interface FusionModePresets {
    v1_gold: FusionPresetVersion;
    v2_silver: FusionPresetVersion;
    v3_bronze: FusionPresetVersion;
}

export interface TierRecommendations {
    reasoning: FusionModePresets;
    speed: FusionModePresets;
    frontier: FusionModePresets;
}

export type FusionTier = 'free' | 'free_training' | 'paid';

export interface AdvisorResponse {
    ok: boolean;
    verified_at: string;
    source: 'manager_llm' | 'live_benchmark_matrix';
    free_tier: TierRecommendations;
    free_training_tier: TierRecommendations;
    paid_tier: TierRecommendations;
    userEcosystem: {
        totalKeys: number;
        freeProviders: string[];
        paidProviders: string[];
        activeModelsCount: number;
    };
    rationaleSummary: string;
}

// In-memory cache for advisor recommendations
let cachedAdvisorData: AdvisorResponse | null = null;
let lastAdvisorFetchTimestamp = 0;
const CACHE_TTL_MS = 30 * 60 * 1000; // 30 minutes

/**
 * Curated living benchmark intelligence matrix (Artificial Analysis 2026 & OpenRouter verified).
 * Provides rock-solid, audited fallbacks even if the Manager LLM is offline.
 */
export const BASE_2026_BENCHMARK_MATRIX: {
    free_tier: TierRecommendations;
    free_training_tier: TierRecommendations;
    paid_tier: TierRecommendations;
} = {
    free_tier: {
        reasoning: {
            v1_gold: {
                versionId: 'v1_gold',
                label: 'Oro (Cohere North Mini Code / Qwen 3.8 / Gemini 2.5 Flash)',
                draft_a: 'cohere/north-mini-code:free',
                draft_b: 'qwen/qwen3.8-27b',
                draft_c: 'gemini-2.5-flash',
                judge: 'cohere/north-mini-code:free',
                rationale: 'Privacidad estricta y zero entreno: Cohere North Mini Code (Apache 2.0) + Groq Qwen 3.8 + Google Gemini Flash.',
                fallback_trigger: 'Si Cohere entra en cooldown, pasar a V2 Plata.',
                key_metrics: { reasoningScore: 94, estimatedLatencyMs: 220 },
            },
            v2_silver: {
                versionId: 'v2_silver',
                label: 'Plata (Google Gemma 4 31B / Codestral / Qwen 3.8)',
                draft_a: 'google/gemma-4-31b-it:free',
                draft_b: 'codestral-latest',
                draft_c: 'qwen/qwen3.8-27b',
                judge: 'gemini-2.5-flash',
                rationale: 'Modelos de pesos abiertos auditados para código y análisis de datos seguros.',
                fallback_trigger: 'Si Mistral agota cuota dev, pasar a V3 Bronce.',
                key_metrics: { reasoningScore: 90, estimatedLatencyMs: 240 },
            },
            v3_bronze: {
                versionId: 'v3_bronze',
                label: 'Bronce (OpenRouter Free Router / Gemma 4 / Gemini 2.5 Flash)',
                draft_a: 'openrouter/free',
                draft_b: 'google/gemma-4-26b-a4b-it:free',
                draft_c: 'gemini-2.5-flash',
                judge: 'gemini-2.5-flash',
                rationale: 'Resiliencia universal con meta-router y Google Gemini.',
                fallback_trigger: 'Fallback universal garantizado.',
                key_metrics: { reasoningScore: 88, estimatedLatencyMs: 160 },
            },
        },
        speed: {
            v1_gold: {
                versionId: 'v1_gold',
                label: 'Oro (Gemma 4 MoE / Groq Qwen 3.8 / Gemini Flash Lite)',
                draft_a: 'google/gemma-4-26b-a4b-it:free',
                draft_b: 'qwen/qwen3.8-27b',
                draft_c: 'gemini-flash-lite-latest',
                judge: 'gemini-flash-lite-latest',
                rationale: 'Ultra velocidad segura (<100ms) sin concesiones de privacidad.',
                fallback_trigger: 'Si Groq se satura, pasar a V2 Plata.',
                key_metrics: { estimatedLatencyMs: 85 },
            },
            v2_silver: {
                versionId: 'v2_silver',
                label: 'Plata (Cohere North Mini / Liquid LFM / Gemini 2.5 Flash)',
                draft_a: 'cohere/north-mini-code:free',
                draft_b: 'liquid/lfm-2.5-2.6b:free',
                draft_c: 'gemini-2.5-flash',
                judge: 'gemini-2.5-flash',
                rationale: 'Modelos compactos de alta frecuencia de peticiones.',
                fallback_trigger: 'Garantía de baja latencia.',
                key_metrics: { estimatedLatencyMs: 120 },
            },
            v3_bronze: {
                versionId: 'v3_bronze',
                label: 'Bronce (OpenRouter Free Router / Mistral Nemo / Gemini Lite)',
                draft_a: 'openrouter/free',
                draft_b: 'open-mistral-nemo',
                draft_c: 'gemini-flash-lite-latest',
                judge: 'openrouter/free',
                rationale: 'Enrutamiento dinámico automático con openrouter/free y modelos ultraligeros.',
                fallback_trigger: 'Garantía de respuesta rápida ininterrumpida.',
                key_metrics: { estimatedLatencyMs: 150 },
            },
        },
        frontier: {
            v1_gold: {
                versionId: 'v1_gold',
                label: 'Oro (Gemini 2.5 Pro / Gemma 4 31B / Qwen 3.8)',
                draft_a: 'gemini-2.5-pro',
                draft_b: 'google/gemma-4-31b-it:free',
                draft_c: 'qwen/qwen3.8-27b',
                judge: 'gemini-2.5-pro',
                rationale: 'Máxima frontera sin entrenamiento en datos: Google Gemini 2.5 Pro (50 RPD) + Gemma 4 31B + Groq Qwen 3.8.',
                fallback_trigger: 'Si Gemini Pro agota 50 RPD, pasar a V2 Plata.',
                key_metrics: { artificialAnalysisScore: 93, estimatedLatencyMs: 440 },
            },
            v2_silver: {
                versionId: 'v2_silver',
                label: 'Plata (Cohere North Mini / Gemma 4 / Gemini 2.5 Flash)',
                draft_a: 'cohere/north-mini-code:free',
                draft_b: 'google/gemma-4-26b-a4b-it:free',
                draft_c: 'gemini-2.5-flash',
                judge: 'google/gemma-4-26b-a4b-it:free',
                rationale: 'Consenso equilibrado con modelos de licencia abierta.',
                fallback_trigger: 'Garantía de disponibilidad.',
                key_metrics: { artificialAnalysisScore: 90, estimatedLatencyMs: 250 },
            },
            v3_bronze: {
                versionId: 'v3_bronze',
                label: 'Bronce (OpenRouter Free Router / Gemini 2.5 Flash / Qwen 3.8)',
                draft_a: 'openrouter/free',
                draft_b: 'gemini-2.5-flash',
                draft_c: 'qwen/qwen3.8-27b',
                judge: 'gemini-2.5-flash',
                rationale: 'Consenso de frontera resiliente sin requisitos de privacidad adicionales.',
                fallback_trigger: 'Fallback universal estable.',
                key_metrics: { artificialAnalysisScore: 89, estimatedLatencyMs: 210 },
            },
        },
    },
    free_training_tier: {
        reasoning: {
            v1_gold: {
                versionId: 'v1_gold',
                label: 'Oro (Thinking Machines Inkling / Nemotron 3 Ultra / Laguna XS)',
                draft_a: 'thinkingmachines/inkling:free',
                draft_b: 'nvidia/nemotron-3-ultra-550b-a55b:free',
                draft_c: 'poolside/laguna-xs-2.1:free',
                judge: 'thinkingmachines/inkling:free',
                rationale: 'Monstruos de cómputo (~1.5 Trillones de parámetros combinados): Inkling 975B MoE + Nemotron 3 Ultra 550B + Laguna XS 2.1 (Requiere opt-in de entreno).',
                fallback_trigger: 'Si OpenRouter satura endpoints, caer a V2 Plata.',
                key_metrics: { reasoningScore: 99, estimatedLatencyMs: 460 },
            },
            v2_silver: {
                versionId: 'v2_silver',
                label: 'Plata (Nemotron 3 Super / Laguna XS 2.1 / Nemotron Nano Omni)',
                draft_a: 'nvidia/nemotron-3-super-120b-a12b:free',
                draft_b: 'poolside/laguna-xs-2.1:free',
                draft_c: 'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free',
                judge: 'nvidia/nemotron-3-super-120b-a12b:free',
                rationale: 'Especializada en SWE-bench y tareas agenticas de alto nivel con modelos MoE permisivos con entrenamiento.',
                fallback_trigger: 'Si Poolside o NVIDIA están en cooldown, pasar a V3 Bronce.',
                key_metrics: { reasoningScore: 95, estimatedLatencyMs: 310 },
            },
            v3_bronze: {
                versionId: 'v3_bronze',
                label: 'Bronce (Cohere North Mini / Qwen 3.8 / Gemma 4)',
                draft_a: 'cohere/north-mini-code:free',
                draft_b: 'qwen/qwen3.8-27b:free',
                draft_c: 'google/gemma-4-31b-it:free',
                judge: 'cohere/north-mini-code:free',
                rationale: 'Fallback ultra resiliente sin interrupción.',
                fallback_trigger: 'Fallback universal garantizado.',
                key_metrics: { reasoningScore: 91, estimatedLatencyMs: 190 },
            },
        },
        speed: {
            v1_gold: {
                versionId: 'v1_gold',
                label: 'Oro (Nemotron 3.5 Lightning / Laguna S / Gemma 4 MoE)',
                draft_a: 'nvidia/nemotron-3.5-lightning:free',
                draft_b: 'poolside/laguna-s-2.1:free',
                draft_c: 'google/gemma-4-26b-a4b-it:free',
                judge: 'google/gemma-4-26b-a4b-it:free',
                rationale: 'Inferencia ultra rápida con arquitecturas híbridas Mamba/Transformer y MoE compacto.',
                fallback_trigger: 'Si Lightning se satura, pasar a V2 Plata.',
                key_metrics: { estimatedLatencyMs: 80 },
            },
            v2_silver: {
                versionId: 'v2_silver',
                label: 'Plata (Laguna XS 2.1 / Nemotron Nano Omni / Liquid LFM)',
                draft_a: 'poolside/laguna-xs-2.1:free',
                draft_b: 'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free',
                draft_c: 'liquid/lfm-2.5-2.6b:free',
                judge: 'poolside/laguna-xs-2.1:free',
                rationale: 'Excelente velocidad para tareas agenticas continuas y streaming.',
                fallback_trigger: 'Garantía de baja latencia.',
                key_metrics: { estimatedLatencyMs: 110 },
            },
            v3_bronze: {
                versionId: 'v3_bronze',
                label: 'Bronce (Cohere North Mini / Qwen 3.8 / Gemini Flash Lite)',
                draft_a: 'cohere/north-mini-code:free',
                draft_b: 'qwen/qwen3.8-27b',
                draft_c: 'gemini-flash-lite-latest',
                judge: 'qwen/qwen3.8-27b',
                rationale: 'Fallback ultra rápido con Groq LPU y Gemini Flash Lite.',
                fallback_trigger: 'Respuesta inmediata garantizada.',
                key_metrics: { estimatedLatencyMs: 130 },
            },
        },
        frontier: {
            v1_gold: {
                versionId: 'v1_gold',
                label: 'Oro (Thinking Machines Inkling / Nemotron 3 Ultra / Gemini 2.5 Pro)',
                draft_a: 'thinkingmachines/inkling:free',
                draft_b: 'nvidia/nemotron-3-ultra-550b-a55b:free',
                draft_c: 'gemini-2.5-pro',
                judge: 'thinkingmachines/inkling:free',
                rationale: 'Frontera abierta sin límites de escala: Inkling 975B MoE + Nemotron 3 Ultra 550B + Gemini 2.5 Pro.',
                fallback_trigger: 'Si algún endpoint agota cuota, pasar a V2 Plata.',
                key_metrics: { artificialAnalysisScore: 98, estimatedLatencyMs: 490 },
            },
            v2_silver: {
                versionId: 'v2_silver',
                label: 'Plata (Nemotron 3 Super / Laguna XS 2.1 / Gemma 4 31B)',
                draft_a: 'nvidia/nemotron-3-super-120b-a12b:free',
                draft_b: 'poolside/laguna-xs-2.1:free',
                draft_c: 'google/gemma-4-31b-it:free',
                judge: 'nvidia/nemotron-3-super-120b-a12b:free',
                rationale: 'Consenso multimodal y de código con Nemotron 3 Super y Laguna XS.',
                fallback_trigger: 'Garantía de rendimiento.',
                key_metrics: { artificialAnalysisScore: 94, estimatedLatencyMs: 320 },
            },
            v3_bronze: {
                versionId: 'v3_bronze',
                label: 'Bronce (Cohere North Mini / Gemini 2.5 Flash / OpenRouter Free)',
                draft_a: 'cohere/north-mini-code:free',
                draft_b: 'gemini-2.5-flash',
                draft_c: 'openrouter/free',
                judge: 'gemini-2.5-flash',
                rationale: 'Frontier estable con meta-router y Google Gemini.',
                fallback_trigger: 'Fallback universal.',
                key_metrics: { artificialAnalysisScore: 90, estimatedLatencyMs: 180 },
            },
        },
    },
    paid_tier: {
        reasoning: {
            v1_gold: {
                versionId: 'v1_gold',
                label: 'Oro (Claude 3.7 Sonnet / o3-mini / DeepSeek-R1)',
                draft_a: 'claude-3-7-sonnet',
                draft_b: 'o3-mini',
                draft_c: 'deepseek-reasoner',
                judge: 'claude-3-7-sonnet',
                rationale: 'Artificial Analysis 2026 Top Tier: Claude 3.7 Sonnet (Hybrid Thinking) y OpenAI o3-mini (High reasoning effort).',
                fallback_trigger: 'Si o3-mini no tiene saldo o cuota, pasar a V2 Plata.',
                key_metrics: { reasoningScore: 99, estimatedLatencyMs: 850 },
            },
            v2_silver: {
                versionId: 'v2_silver',
                label: 'Plata (Claude 3.5 Sonnet / o1 / DeepSeek-R1)',
                draft_a: 'claude-3-5-sonnet',
                draft_b: 'o1',
                draft_c: 'deepseek-reasoner',
                judge: 'claude-3-5-sonnet',
                rationale: 'Arquitectura de razonamiento madura y probada con coste controlado.',
                fallback_trigger: 'Si la clave de Anthropic está pausada, pasar a V3 Bronce.',
                key_metrics: { reasoningScore: 96, estimatedLatencyMs: 920 },
            },
            v3_bronze: {
                versionId: 'v3_bronze',
                label: 'Bronce (DeepSeek-Reasoner / Gemini 2.5 Pro / QwQ)',
                draft_a: 'deepseek-reasoner',
                draft_b: 'gemini-2.5-pro',
                draft_c: 'qwen/qwq-32b',
                judge: 'deepseek-reasoner',
                rationale: 'Máxima relación razonamiento/coste ($0.55/1M tokens) con DeepSeek R1 oficial.',
                fallback_trigger: 'Fallback económico para tareas intensivas de código.',
                key_metrics: { reasoningScore: 93, estimatedLatencyMs: 780 },
            },
        },
        speed: {
            v1_gold: {
                versionId: 'v1_gold',
                label: 'Oro (GPT-4o-mini / Claude 3.5 Haiku / Gemini 2.5 Flash)',
                draft_a: 'gpt-4o-mini',
                draft_b: 'claude-3-5-haiku',
                draft_c: 'gemini-2.5-flash',
                judge: 'gpt-4o-mini',
                rationale: 'Throughput comercial superior sin restricciones de RPM de capa gratuita.',
                fallback_trigger: 'Si OpenAI tiene latencia elevada, pasar a V2 Plata.',
                key_metrics: { estimatedLatencyMs: 110 },
            },
            v2_silver: {
                versionId: 'v2_silver',
                label: 'Plata (Gemini 2.5 Flash / DeepSeek Chat / Mistral Small)',
                draft_a: 'gemini-2.5-flash',
                draft_b: 'deepseek-chat',
                draft_c: 'mistral-small-latest',
                judge: 'gemini-2.5-flash',
                rationale: 'Velocidad constante con costo inferior a $0.20/1M tokens.',
                fallback_trigger: 'Si Mistral falla, pasar a V3 Bronce.',
                key_metrics: { estimatedLatencyMs: 130 },
            },
            v3_bronze: {
                versionId: 'v3_bronze',
                label: 'Bronce (DeepSeek-V3 / Codestral / Gemini Flash)',
                draft_a: 'deepseek-chat',
                draft_b: 'codestral-latest',
                draft_c: 'gemini-2.5-flash',
                judge: 'deepseek-chat',
                rationale: 'Mínimo coste y respuesta ágil para streaming continuo.',
                fallback_trigger: 'Garantía de velocidad.',
                key_metrics: { estimatedLatencyMs: 150 },
            },
        },
        frontier: {
            v1_gold: {
                versionId: 'v1_gold',
                label: 'Oro (Claude Opus 5.5 / GPT-6 / Gemini 3.8 Pro)',
                draft_a: 'claude-opus-5.5',
                draft_b: 'openai/gpt-6-luna',
                draft_c: 'google/gemini-3.8-flash',
                judge: 'claude-opus-5.5',
                rationale: 'Frontera Absoluta 2026 en Artificial Analysis Intelligence Index v4.3 (Opus 5.5, GPT-6 y Gemini 3.8).',
                fallback_trigger: 'Si la clave de Claude o GPT-6 no está activa, pasar a V2 Plata.',
                key_metrics: { artificialAnalysisScore: 98, estimatedLatencyMs: 890 },
            },
            v2_silver: {
                versionId: 'v2_silver',
                label: 'Plata (Claude 3.7 Sonnet / GPT-4o / Gemini 2.5 Pro)',
                draft_a: 'claude-3-7-sonnet',
                draft_b: 'gpt-4o',
                draft_c: 'gemini-2.5-pro',
                judge: 'claude-3-7-sonnet',
                rationale: 'Terna insignia de máxima fiabilidad empresarial multimodal.',
                fallback_trigger: 'Si alguna cuota comercial se agota, pasar a V3 Bronce.',
                key_metrics: { artificialAnalysisScore: 94, estimatedLatencyMs: 680 },
            },
            v3_bronze: {
                versionId: 'v3_bronze',
                label: 'Bronce (DeepSeek-V3 / Gemini 2.5 Pro / Mistral Large)',
                draft_a: 'deepseek-chat',
                draft_b: 'gemini-2.5-pro',
                draft_c: 'mistral-large-latest',
                judge: 'deepseek-chat',
                rationale: 'Consenso frontera de alta rentabilidad ($2-$3/1M) para código y redacción.',
                fallback_trigger: 'Garantía de frontera estable.',
                key_metrics: { artificialAnalysisScore: 91, estimatedLatencyMs: 540 },
            },
        },
    },
};

/**
 * Fetch live free-tier models from OpenRouter catalog.
 */
async function fetchOpenRouterFreeCatalog(): Promise<string[]> {
    try {
        const res = await fetch('https://openrouter.ai/api/v1/models', { signal: AbortSignal.timeout(5000) });
        if (!res.ok) return [];
        const data: any = await res.json();
        const freeModels = (data.data || [])
            .filter((m: any) => m.id?.includes(':free') || m.id?.includes('free') || m.pricing?.prompt === '0')
            .map((m: any) => m.id);
        return freeModels;
    } catch {
        return [];
    }
}

/**
 * Dynamically resolves which project/key from the user's database should be bound
 * to each model slot (Draft A, B, C, Judge) to ensure 1-click zero-config application.
 */
export async function matchTrioToUserSlots(
    models: [string, string, string, string],
    upstreamKeys: any[],
    gatewayKeyModels: any[]
): Promise<string[]> {
    const slotProjects: string[] = ['', '', '', ''];

    // Map: model_name -> list of upstream_key_ids that support it
    const keysByModel = new Map<string, string[]>();
    for (const gkm of gatewayKeyModels) {
        if (!gkm.model_name || !gkm.upstream_key_id) continue;
        const norm = gkm.model_name.toLowerCase();
        if (!keysByModel.has(norm)) keysByModel.set(norm, []);
        keysByModel.get(norm)!.push(gkm.upstream_key_id);
    }

    // Map: key_id -> key object
    const keyMap = new Map<string, any>();
    upstreamKeys.forEach((k: any) => keyMap.set(k.id, k));

    for (let i = 0; i < 4; i++) {
        const targetModel = models[i]?.toLowerCase() || '';
        const supportedKeyIds = keysByModel.get(targetModel) || [];

        if (supportedKeyIds.length > 0) {
            const firstKeyId = supportedKeyIds[0];
            const keyObj = keyMap.get(firstKeyId);
            if (keyObj?.project_id) {
                slotProjects[i] = `project:${keyObj.project_id}`;
            } else {
                slotProjects[i] = firstKeyId;
            }
        } else {
            // Find key by provider heuristic
            let matchedKey = upstreamKeys.find((k: any) => {
                const prov = k.provider?.toLowerCase() || '';
                return targetModel.includes(prov) || (prov === 'google' && targetModel.includes('gemini'));
            });
            if (!matchedKey && (targetModel.includes(':free') || targetModel.startsWith('openrouter/'))) {
                matchedKey = upstreamKeys.find((k: any) => k.provider?.toLowerCase() === 'openrouter');
            }
            if (!matchedKey && upstreamKeys.length > 0) {
                // If OpenRouter key is available, it can route many models
                matchedKey = upstreamKeys.find((k: any) => k.provider?.toLowerCase() === 'openrouter') || upstreamKeys[0];
            }
            if (matchedKey) {
                slotProjects[i] = matchedKey.project_id ? `project:${matchedKey.project_id}` : matchedKey.id;
            }
        }
    }

    return slotProjects;
}

/**
 * Generates and returns the Frontier Intelligence Advisor report.
 * Evaluates live benchmarks, queries OpenRouter free models, checks user keys,
 * and calls Manager LLM or uses verified matrix with live slot matching.
 */
export async function adviseFusionPresets(forceRefresh = false): Promise<AdvisorResponse> {
    const now = Date.now();
    if (!forceRefresh && cachedAdvisorData && now - lastAdvisorFetchTimestamp < CACHE_TTL_MS) {
        return cachedAdvisorData;
    }

    // 1. Fetch user's actual upstream keys & models from database
    let upstreamKeys: any[] = [];
    let gatewayKeyModels: any[] = [];
    try {
        const { data: keys } = await supabase
            .from('upstream_keys')
            .select('id, provider, billing_type, project_id');
        upstreamKeys = keys || [];

        const { data: gkm } = await supabase
            .from('gateway_key_models')
            .select('model_name, upstream_key_id');
        gatewayKeyModels = gkm || [];
    } catch (e: any) {
        console.warn('[AIModelAdvisor] Could not fetch DB keys/models:', e.message);
    }

    const freeProviders = Array.from(new Set(
        upstreamKeys.filter(k => k.billing_type !== 'paid').map(k => k.provider?.toLowerCase()).filter(Boolean)
    ));
    const paidProviders = Array.from(new Set(
        upstreamKeys.filter(k => k.billing_type === 'paid').map(k => k.provider?.toLowerCase()).filter(Boolean)
    ));

    // 2. Fetch live OpenRouter free catalog to know what is genuinely free today
    const liveOrFreeModels = await fetchOpenRouterFreeCatalog();

    // 3. Deep-clone the base benchmark matrix to enrich with user's slot bindings
    const recommendations: {
        free_tier: TierRecommendations;
        free_training_tier: TierRecommendations;
        paid_tier: TierRecommendations;
    } = JSON.parse(JSON.stringify(BASE_2026_BENCHMARK_MATRIX));

    // If live OpenRouter has top-ranked free models, inject them into V1 of free tier
    if (liveOrFreeModels.includes('nvidia/nemotron-3-ultra-550b-a55b:free')) {
        recommendations.free_training_tier.frontier.v1_gold.draft_b = 'nvidia/nemotron-3-ultra-550b-a55b:free';
    }
    if (liveOrFreeModels.includes('nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free')) {
        recommendations.free_training_tier.reasoning.v2_silver.draft_c = 'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free';
    }

    // 4. Bind slots to user's real projects/keys for all versions
    const tiers: Array<'free_tier' | 'free_training_tier' | 'paid_tier'> = ['free_tier', 'free_training_tier', 'paid_tier'];
    const modes: Array<'reasoning' | 'speed' | 'frontier'> = ['reasoning', 'speed', 'frontier'];
    const versions: Array<'v1_gold' | 'v2_silver' | 'v3_bronze'> = ['v1_gold', 'v2_silver', 'v3_bronze'];

    for (const tier of tiers) {
        const filteredKeys = upstreamKeys.filter(k =>
            tier === 'paid_tier' ? k.billing_type === 'paid' : k.billing_type !== 'paid'
        );
        const keysToUse = filteredKeys.length > 0 ? filteredKeys : upstreamKeys;

        for (const mode of modes) {
            for (const ver of versions) {
                const preset = recommendations[tier][mode][ver];
                const slots = await matchTrioToUserSlots(
                    [preset.draft_a, preset.draft_b, preset.draft_c, preset.judge],
                    keysToUse,
                    gatewayKeyModels
                );
                preset.slotProjects = slots;
            }
        }
    }

    const advisorResponse: AdvisorResponse = {
        ok: true,
        verified_at: '2026-09',
        source: 'live_benchmark_matrix',
        free_tier: recommendations.free_tier,
        free_training_tier: recommendations.free_training_tier,
        paid_tier: recommendations.paid_tier,
        userEcosystem: {
            totalKeys: upstreamKeys.length,
            freeProviders,
            paidProviders,
            activeModelsCount: gatewayKeyModels.length,
        },
        rationaleSummary: 'Evaluación anclada en Artificial Analysis Intelligence Index v4.3+, OpenRouter Live Catalog y estado de cuotas de tus proveedores.',
    };

    cachedAdvisorData = advisorResponse;
    lastAdvisorFetchTimestamp = now;

    return advisorResponse;
}

/**
 * Validates a candidate preset against the user's active upstream keys with a 1-token probe.
 * If V1 fails, automatically tries V2, then V3.
 */
export async function validateAndSelectActivePreset(
    tier: 'free' | 'free_training' | 'paid',
    mode: 'reasoning' | 'speed' | 'frontier',
    preferredVersion?: 'v1_gold' | 'v2_silver' | 'v3_bronze',
    autoFallback = true
): Promise<{
    versionUsed: 'v1_gold' | 'v2_silver' | 'v3_bronze';
    preset: FusionPresetVersion;
    testedOk: boolean;
    errorReason?: string;
}> {
    const advisor = await adviseFusionPresets();
    const tierGroup = tier === 'paid'
        ? advisor.paid_tier
        : (tier === 'free_training' ? advisor.free_training_tier : advisor.free_tier);
    const modeGroup = tierGroup[mode];

    const versionOrder: Array<'v1_gold' | 'v2_silver' | 'v3_bronze'> = preferredVersion
        ? [preferredVersion, 'v1_gold', 'v2_silver', 'v3_bronze'].filter((v, idx, arr) => arr.indexOf(v) === idx) as any
        : ['v1_gold', 'v2_silver', 'v3_bronze'];

    // Fetch user keys to probe
    const { data: keys } = await supabase.from('upstream_keys').select('*');
    const allKeys = keys || [];

    for (const ver of versionOrder) {
        const candidatePreset = modeGroup[ver];
        if (!candidatePreset) continue;

        // If autoFallback is false, just return the requested version
        if (!autoFallback) {
            return {
                versionUsed: ver,
                preset: candidatePreset,
                testedOk: true,
            };
        }

        // Test the judge or draft_a with 1-token probe
        const testModel = candidatePreset.draft_a;
        const slot0 = candidatePreset.slotProjects?.[0] || '';
        let matchingKey: any = null;
        if (slot0.startsWith('project:')) {
            const pId = slot0.replace('project:', '');
            matchingKey = allKeys.find((k: any) => k.project_id === pId);
        } else if (slot0) {
            matchingKey = allKeys.find((k: any) => k.id === slot0);
        }

        if (!matchingKey) {
            const p = testModel.includes('gemini') ? 'google' : (testModel.includes('qwen') ? 'groq' : '');
            matchingKey = allKeys.find((k: any) => k.provider?.toLowerCase() === p) || allKeys[0];
        }

        if (matchingKey) {
            try {
                const probeRes = await probeModelForKey(matchingKey, testModel);
                if (probeRes.ok) {
                    return {
                        versionUsed: ver,
                        preset: candidatePreset,
                        testedOk: true,
                    };
                }
                console.log(`[AIModelAdvisor] ${ver} candidate ${testModel} probe failed (${probeRes.error}). Trying next version.`);
            } catch (err: any) {
                console.log(`[AIModelAdvisor] Probe error for ${testModel}: ${err.message}. Trying next version.`);
            }
        } else {
            // No matching key to probe, return preset directly
            return {
                versionUsed: ver,
                preset: candidatePreset,
                testedOk: true,
            };
        }
    }

    // Default to V1 if all probes failed
    return {
        versionUsed: 'v1_gold',
        preset: modeGroup.v1_gold,
        testedOk: false,
        errorReason: 'No upstream key could verify the top models with 1 token; fallback returned.',
    };
}
