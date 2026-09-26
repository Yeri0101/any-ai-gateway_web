import { Hono } from 'hono';
import { supabase } from '../db';
import { authMiddleware } from '../middleware/auth';
import { recordLatency } from '../utils/latencyGuard';
import { callPuterAI } from '../utils/puterClient';
import { getCircuitDiagnostics } from '../utils/circuitBreaker';
import { probeUpstreamHealth } from '../utils/healthProber';

const channelTesting = new Hono();

channelTesting.use('*', authMiddleware);

interface TestResult {
    upstreamKeyId: string;
    provider: string;
    ok: boolean;
    latencyMs: number;
    statusCode: number;
    error?: string;
    modelTested: string;
}

const DEFAULT_TEST_MODELS: Record<string, string> = {
    google: 'gemini-2.5-flash',
    vertex: 'gemini-2.5-flash',
    groq: 'llama-3.3-70b-versatile',
    cerebras: 'llama3.1-8b',
    openai: 'gpt-4o-mini',
    openrouter: 'openrouter/auto',
    mistral: 'mistral-small-latest',
    deepseek: 'deepseek-chat',
    puter: 'gpt-4o-mini',
    nvidia: 'meta/llama-3.1-8b-instruct',
    minimax: 'abab6.5s-chat',
    moonshot: 'moonshot-v1-8k',
    mimo: 'mimo-v2.6-flash',
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

export async function runKeyPing(key: any): Promise<TestResult> {
    const provider = key.provider?.toLowerCase() || '';
    const model = DEFAULT_TEST_MODELS[provider] || 'gpt-4o-mini';
    const start = Date.now();

    if (provider === 'puter') {
        try {
            await callPuterAI(key.api_key, [{ role: 'user', content: 'ping' }], {
                model,
                max_tokens: 5,
            });
            const latencyMs = Date.now() - start;
            recordLatency(key.id, latencyMs);
            return {
                upstreamKeyId: key.id,
                provider,
                ok: true,
                latencyMs,
                statusCode: 200,
                modelTested: model,
            };
        } catch (err: any) {
            return {
                upstreamKeyId: key.id,
                provider,
                ok: false,
                latencyMs: Date.now() - start,
                statusCode: 500,
                error: err.message,
                modelTested: model,
            };
        }
    }

    const endpoint = getProviderEndpoint(provider, model);
    if (!endpoint) {
        return {
            upstreamKeyId: key.id,
            provider,
            ok: false,
            latencyMs: 0,
            statusCode: 400,
            error: `Unsupported provider for automatic ping: ${provider}`,
            modelTested: model,
        };
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000); // 8s ping timeout

    try {
        const res = await fetch(endpoint, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${key.api_key}`,
                ...(provider === 'openrouter' ? { 'HTTP-Referer': 'http://localhost:3000', 'X-Title': 'TierMax Ping' } : {})
            },
            body: JSON.stringify({
                model,
                messages: [{ role: 'user', content: 'hi' }],
                max_tokens: 2,
            }),
            signal: controller.signal,
        });
        clearTimeout(timer);

        const latencyMs = Date.now() - start;
        if (res.ok) {
            recordLatency(key.id, latencyMs);
            return {
                upstreamKeyId: key.id,
                provider,
                ok: true,
                latencyMs,
                statusCode: res.status,
                modelTested: model,
            };
        } else {
            const errData = await res.json().catch(() => ({}));
            return {
                upstreamKeyId: key.id,
                provider,
                ok: false,
                latencyMs,
                statusCode: res.status,
                error: errData?.error?.message || res.statusText,
                modelTested: model,
            };
        }
    } catch (err: any) {
        clearTimeout(timer);
        return {
            upstreamKeyId: key.id,
            provider,
            ok: false,
            latencyMs: Date.now() - start,
            statusCode: 0,
            error: err.name === 'AbortError' ? 'Timeout (8s exceeded)' : err.message,
            modelTested: model,
        };
    }
}

/**
 * POST /channels/test/:id — Test single upstream key
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

    const result = await runKeyPing(key);
    return c.json(result);
});

/**
 * POST /channels/test-project/:projectId — Test all keys in project concurrently
 */
channelTesting.post('/test-project/:projectId', async (c) => {
    const { projectId } = c.req.param();
    const { data: keys, error } = await supabase
        .from('upstream_keys')
        .select('*')
        .eq('project_id', projectId);

    if (error) return c.json({ error: error.message }, 500);
    if (!keys || keys.length === 0) return c.json({ results: [], count: 0 });

    const results = await Promise.all((keys || []).map((k: any) => runKeyPing(k)));
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
