export type PricingMatch = {
    provider: string;
    model_name: string;
    input_price_per_1m: number;
    output_price_per_1m: number;
};

/**
 * Normalizes a model string to generate lookup candidate variations:
 * e.g. "thinkingmachines/inkling:free" -> ["thinkingmachines/inkling:free", "thinkingmachines/inkling", "inkling"]
 */
export function getModelLookupCandidates(model: string): string[] {
    if (!model) return [];
    const candidates = new Set<string>();
    candidates.add(model);

    // Strip trailing tags like :free, :nitro, :beta, :exact
    const noTag = model.replace(/:(free|nitro|beta|exact|online|extended)$/i, '');
    candidates.add(noTag);

    // Strip provider prefix if present: "google/gemini-2.5-flash" -> "gemini-2.5-flash"
    if (model.includes('/')) {
        const withoutPrefix = model.split('/').slice(1).join('/');
        candidates.add(withoutPrefix);
        candidates.add(withoutPrefix.replace(/:(free|nitro|beta|exact|online|extended)$/i, ''));
    }

    return Array.from(candidates).filter(Boolean);
}

/**
 * Comprehensive fallback market pricing catalog per 1M tokens.
 * Accurately models market rates for models when not explicitly present in the model_pricing DB.
 */
export function getFallbackMarketPricing(model: string, provider: string | null): PricingMatch {
    const m = (model || '').toLowerCase();
    const p = (provider || '').toLowerCase();

    // 1. Anthropic / Claude
    if (m.includes('opus')) {
        return { provider: provider || 'anthropic', model_name: model, input_price_per_1m: 15.00, output_price_per_1m: 75.00 };
    }
    if (m.includes('sonnet')) {
        return { provider: provider || 'anthropic', model_name: model, input_price_per_1m: 3.00, output_price_per_1m: 15.00 };
    }
    if (m.includes('haiku') || m.includes('claude') || p === 'anthropic') {
        return { provider: provider || 'anthropic', model_name: model, input_price_per_1m: 0.25, output_price_per_1m: 1.25 };
    }

    // 2. OpenAI / GPT
    if (m.includes('o1') || m.includes('o3') || m.includes('gpt-5')) {
        return { provider: provider || 'openai', model_name: model, input_price_per_1m: 2.50, output_price_per_1m: 10.00 };
    }
    if (m.includes('gpt-4o-mini') || m.includes('gpt-3.5')) {
        return { provider: provider || 'openai', model_name: model, input_price_per_1m: 0.15, output_price_per_1m: 0.60 };
    }
    if (m.includes('gpt-4o') || m.includes('gpt-4') || p === 'openai') {
        return { provider: provider || 'openai', model_name: model, input_price_per_1m: 2.00, output_price_per_1m: 8.00 };
    }

    // 3. DeepSeek
    if (m.includes('r1') || m.includes('reasoner')) {
        return { provider: provider || 'deepseek', model_name: model, input_price_per_1m: 0.55, output_price_per_1m: 2.19 };
    }
    if (m.includes('deepseek') || p === 'deepseek') {
        return { provider: provider || 'deepseek', model_name: model, input_price_per_1m: 0.14, output_price_per_1m: 0.28 };
    }

    // 4. Google Gemini & Gemma
    if (m.includes('pro') && (m.includes('gemini') || p === 'google')) {
        return { provider: provider || 'google', model_name: model, input_price_per_1m: 1.25, output_price_per_1m: 5.00 };
    }
    if (m.includes('gemini') || m.includes('gemma') || p === 'google' || p === 'vertex') {
        return { provider: provider || 'google', model_name: model, input_price_per_1m: 0.075, output_price_per_1m: 0.30 };
    }

    // 5. Mistral / Codestral
    if (m.includes('codestral')) {
        return { provider: provider || 'mistral', model_name: model, input_price_per_1m: 0.30, output_price_per_1m: 0.90 };
    }
    if (m.includes('mistral-large')) {
        return { provider: provider || 'mistral', model_name: model, input_price_per_1m: 2.00, output_price_per_1m: 6.00 };
    }
    if (m.includes('mistral') || p === 'mistral') {
        return { provider: provider || 'mistral', model_name: model, input_price_per_1m: 0.20, output_price_per_1m: 0.60 };
    }

    // 6. Groq / Llama
    if (m.includes('70b')) {
        return { provider: provider || 'groq', model_name: model, input_price_per_1m: 0.59, output_price_per_1m: 0.79 };
    }
    if (m.includes('8b')) {
        return { provider: provider || 'groq', model_name: model, input_price_per_1m: 0.05, output_price_per_1m: 0.08 };
    }
    if (m.includes('llama') || p === 'groq') {
        return { provider: provider || 'groq', model_name: model, input_price_per_1m: 0.30, output_price_per_1m: 0.50 };
    }

    // 7. Qwen
    if (m.includes('qwen')) {
        return { provider: provider || 'qwen', model_name: model, input_price_per_1m: 0.40, output_price_per_1m: 0.80 };
    }

    // 8. Xiaomi Mimo
    if (m.includes('mimo') || p === 'mimo' || p === 'xiaomi') {
        return { provider: provider || 'mimo', model_name: model, input_price_per_1m: 0.15, output_price_per_1m: 0.60 };
    }

    // 9. Nvidia NIM
    if (p === 'nvidia' || m.includes('nvidia') || m.includes('nemotron')) {
        return { provider: provider || 'nvidia', model_name: model, input_price_per_1m: 0.30, output_price_per_1m: 0.80 };
    }

    // 10. General industry benchmark baseline (OpenRouter free models, thinkingmachines, ling, etc.)
    return {
        provider: provider || '*',
        model_name: model,
        input_price_per_1m: 0.35,
        output_price_per_1m: 1.00,
    };
}

/**
 * Calculates dollar cost from token counts and pricing rates.
 */
export function calculateTokenCost(
    model: string,
    provider: string | null,
    promptTokens: number,
    completionTokens: number,
    totalTokens?: number,
    customPricing?: PricingMatch | null
): { input_cost_usd: number; output_cost_usd: number; total_cost_usd: number; pricing: PricingMatch } {
    const pricing = customPricing || getFallbackMarketPricing(model, provider);

    let pTok = Number(promptTokens || 0);
    let cTok = Number(completionTokens || 0);

    // If breakdown is missing, approximate 75% prompt / 25% completion from totalTokens
    if (pTok <= 0 && cTok <= 0 && totalTokens && totalTokens > 0) {
        pTok = Math.round(totalTokens * 0.75);
        cTok = Math.max(1, totalTokens - pTok);
    }

    const input_cost_usd = Number(((pTok / 1_000_000) * pricing.input_price_per_1m).toFixed(8));
    const output_cost_usd = Number(((cTok / 1_000_000) * pricing.output_price_per_1m).toFixed(8));
    const total_cost_usd = Number((input_cost_usd + output_cost_usd).toFixed(8));

    return {
        input_cost_usd,
        output_cost_usd,
        total_cost_usd,
        pricing,
    };
}

/**
 * Computes or repairs cost for any request log row.
 */
export function estimateLogCost(log: {
    model?: string;
    provider?: string | null;
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
    total_cost_usd?: number | null;
}): number {
    const loggedCost = Number(log.total_cost_usd || 0);
    if (loggedCost > 0) {
        return loggedCost;
    }

    const totalTok = Number(log.total_tokens || 0);
    if (totalTok <= 0) {
        return 0;
    }

    const { total_cost_usd } = calculateTokenCost(
        log.model || 'default',
        log.provider || null,
        Number(log.prompt_tokens || 0),
        Number(log.completion_tokens || 0),
        totalTok
    );

    return total_cost_usd;
}
