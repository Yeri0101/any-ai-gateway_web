import { createHash } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

/**
 * OpenClaw Gateway — High-Performance Semantic Cache Module
 * 
 * In-memory LRU cache with SHA-256 normalized keying.
 * Supports:
 * - Instant non-streaming response replay
 * - Instant streaming SSE chunk replay for repeated prompts
 * - Real-time cache hit/miss and token savings metrics
 * - Persistent stats across server restarts (SQLite / JSON)
 */

const TTL_MS = (parseInt(process.env.CACHE_TTL_SECONDS || '300', 10)) * 1000; // 5 min default
const MAX_SIZE = parseInt(process.env.CACHE_MAX_SIZE || '1000', 10);

export interface CacheEntry {
    value: any;
    isStream: boolean;
    chunks?: string[];
    usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
    expiresAt: number;
    lastAccessed: number;
    hits: number;
}

const cache = new Map<string, CacheEntry>();

let totalHits = 0;
let totalMisses = 0;
let estimatedTokensSaved = 0;

function getStatsFilePaths(): string[] {
    const candidateDirs = [
        path.resolve(process.cwd(), 'data'),
        path.resolve(process.cwd(), 'backend', 'data'),
        path.resolve(__dirname, '..', '..', 'data'),
        path.resolve(__dirname, '..', 'data'),
    ];
    const existingDirs = new Set<string>();
    for (const dir of candidateDirs) {
        if (fs.existsSync(dir)) {
            existingDirs.add(dir);
        }
    }
    if (existingDirs.size === 0) {
        const fallback = path.resolve(process.cwd(), 'data');
        try { fs.mkdirSync(fallback, { recursive: true }); } catch { }
        existingDirs.add(fallback);
    }
    return Array.from(existingDirs).map(dir => path.join(dir, 'cache_stats.json'));
}

function loadPersistedStats(): void {
    const paths = getStatsFilePaths();
    for (const filePath of paths) {
        try {
            if (fs.existsSync(filePath)) {
                const raw = fs.readFileSync(filePath, 'utf8');
                const parsed = JSON.parse(raw);
                if (typeof parsed.totalHits === 'number') totalHits = Math.max(0, parsed.totalHits);
                if (typeof parsed.totalMisses === 'number') totalMisses = Math.max(0, parsed.totalMisses);
                if (typeof parsed.estimatedTokensSaved === 'number') estimatedTokensSaved = Math.max(0, parsed.estimatedTokensSaved);
                console.log(`[SemanticCache] Loaded persistent stats from ${filePath}: hits=${totalHits}, misses=${totalMisses}, savedTokens=${estimatedTokensSaved}`);
                break;
            }
        } catch { }
    }
}

function persistStats(): void {
    try {
        const payload = JSON.stringify({
            totalHits,
            totalMisses,
            estimatedTokensSaved,
            updatedAt: new Date().toISOString()
        }, null, 2);
        const paths = getStatsFilePaths();
        for (const filePath of paths) {
            try {
                fs.writeFileSync(filePath, payload, 'utf8');
            } catch { }
        }
    } catch { }
}

// Load persisted stats on startup
loadPersistedStats();

/**
 * Normalizes message content for consistent semantic hashing.
 */
function normalizeContent(content: any): string {
    if (typeof content === 'string') {
        return content.trim().replace(/\s+/g, ' ');
    }
    if (Array.isArray(content)) {
        return content.map(part => typeof part === 'string' ? part.trim() : JSON.stringify(part)).join('');
    }
    return JSON.stringify(content || '');
}

/**
 * Build a robust SHA-256 cache key from model + normalized messages array + temperature.
 */
export function buildCacheKey(model: string, messages: any[], extra?: { temperature?: number }): string {
    const normalizedMsgs = (messages || []).map((m: any) => ({
        r: m.role,
        c: normalizeContent(m.content),
        tc: m.tool_calls ? JSON.stringify(m.tool_calls) : ''
    }));
    
    const raw = `${(model || '').toLowerCase()}::${JSON.stringify(normalizedMsgs)}::t=${extra?.temperature ?? 0}`;
    return createHash('sha256').update(raw).digest('hex');
}

/**
 * Retrieve cached response.
 */
export function getCached(key: string, options?: { recordHit?: boolean }): CacheEntry | null {
    const entry = cache.get(key);
    if (!entry) {
        recordCacheMiss();
        return null;
    }

    const now = Date.now();
    if (now > entry.expiresAt) {
        cache.delete(key);
        recordCacheMiss();
        return null;
    }

    // Hit!
    entry.lastAccessed = now;
    entry.hits++;
    if (options?.recordHit !== false) {
        recordCacheHit(entry.usage?.total_tokens || 0);
    }
    return entry;
}

/**
 * Record a cache hit explicitly.
 */
export function recordCacheHit(tokensSaved: number = 0): void {
    totalHits++;
    if (tokensSaved > 0) {
        estimatedTokensSaved += tokensSaved;
    }
    persistStats();
}

/**
 * Record a cache miss explicitly.
 */
export function recordCacheMiss(): void {
    totalMisses++;
    persistStats();
}

/**
 * Add tokens to estimatedTokensSaved without incrementing totalHits.
 */
export function recordTokensSaved(tokens: number): void {
    if (tokens > 0) {
        estimatedTokensSaved += tokens;
        persistStats();
    }
}

/**
 * Reset all cache metrics and clear memory cache.
 */
export function resetCacheStats(): void {
    cache.clear();
    totalHits = 0;
    totalMisses = 0;
    estimatedTokensSaved = 0;
    persistStats();
    console.log('[SemanticCache] Cache stats and entries successfully reset to 0');
}

/**
 * Store non-streaming response.
 */
export function setCached(key: string, value: any, usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number }): void {
    const now = Date.now();
    ensureCapacity();

    // Construct mock streaming chunks from non-streaming value so subsequent stream calls hit cache too
    const content = value?.choices?.[0]?.message?.content || '';
    const chunks = [
        `data: ${JSON.stringify({ id: value?.id || `chatcmpl-${Date.now()}`, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: value?.model || 'cached', choices: [{ index: 0, delta: { role: 'assistant', content }, finish_reason: null }] })}\n\n`,
        `data: ${JSON.stringify({ id: value?.id || `chatcmpl-${Date.now()}`, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: value?.model || 'cached', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`
    ];

    cache.set(key, {
        value,
        isStream: false,
        chunks,
        usage,
        expiresAt: now + TTL_MS,
        lastAccessed: now,
        hits: 0,
    });
}

/**
 * Store streaming response chunks.
 */
export function setCachedStream(key: string, chunks: string[], usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number }): void {
    const now = Date.now();
    ensureCapacity();

    // Reconstruct non-streaming value from stream chunks so subsequent non-stream calls hit cache too
    let accumulatedContent = '';
    for (const chunk of chunks) {
        const lines = chunk.split('\n');
        for (const line of lines) {
            const trimmed = line.trim();
            if (trimmed.startsWith('data:') && !trimmed.includes('[DONE]')) {
                const jsonStr = trimmed.replace(/^data:\s*/, '').trim();
                if (!jsonStr) continue;
                try {
                    const parsed = JSON.parse(jsonStr);
                    const deltaContent = parsed.choices?.[0]?.delta?.content;
                    if (typeof deltaContent === 'string') accumulatedContent += deltaContent;
                } catch { }
            }
        }
    }

    const value = {
        id: `chatcmpl-cached-${Date.now()}`,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        choices: [{
            index: 0,
            message: { role: 'assistant', content: accumulatedContent },
            finish_reason: 'stop',
        }],
        usage,
        _openclaw_metadata: { provider: 'cache' }
    };

    cache.set(key, {
        value,
        isStream: true,
        chunks,
        usage,
        expiresAt: now + TTL_MS,
        lastAccessed: now,
        hits: 0,
    });
}

/**
 * Compute estimated usage breakdown from streamed chunks and prompt tokens.
 */
export function estimateStreamUsage(chunks: string[], promptTokens: number): { prompt_tokens: number; completion_tokens: number; total_tokens: number } {
    let accumulatedContent = '';
    let foundUsage: any = null;

    for (const chunk of chunks) {
        const lines = chunk.split('\n');
        for (const line of lines) {
            const trimmed = line.trim();
            if (trimmed.startsWith('data:') && !trimmed.includes('[DONE]')) {
                const jsonStr = trimmed.replace(/^data:\s*/, '').trim();
                if (!jsonStr) continue;
                try {
                    const parsed = JSON.parse(jsonStr);
                    if (parsed.usage && typeof parsed.usage.total_tokens === 'number') {
                        foundUsage = parsed.usage;
                    }
                    const deltaContent = parsed.choices?.[0]?.delta?.content;
                    if (typeof deltaContent === 'string') {
                        accumulatedContent += deltaContent;
                    }
                } catch { }
            }
        }
    }

    if (foundUsage) {
        const pTok = Number(foundUsage.prompt_tokens) || promptTokens;
        const cTok = Number(foundUsage.completion_tokens) || Math.max(1, Math.ceil(accumulatedContent.length / 3.5));
        const tTok = Number(foundUsage.total_tokens) || (pTok + cTok);
        return {
            prompt_tokens: pTok,
            completion_tokens: cTok,
            total_tokens: tTok,
        };
    }

    const completionTokens = accumulatedContent.length > 0
        ? Math.max(1, Math.ceil(accumulatedContent.length / 3.5))
        : Math.max(1, Math.ceil(chunks.reduce((acc, c) => acc + c.length, 0) / 10));

    return {
        prompt_tokens: promptTokens,
        completion_tokens: completionTokens,
        total_tokens: promptTokens + completionTokens,
    };
}

function ensureCapacity(): void {
    if (cache.size >= MAX_SIZE) {
        let oldestKey = '';
        let oldestTime = Infinity;
        for (const [k, v] of cache.entries()) {
            if (v.lastAccessed < oldestTime) {
                oldestTime = v.lastAccessed;
                oldestKey = k;
            }
        }
        if (oldestKey) cache.delete(oldestKey);
    }
}

/**
 * Returns current cache telemetry metrics.
 */
export function getCacheStats() {
    const totalRequests = totalHits + totalMisses;
    return {
        size: cache.size,
        maxSize: MAX_SIZE,
        ttlMs: TTL_MS,
        totalHits,
        totalMisses,
        hitRate: totalRequests > 0 ? (totalHits / totalRequests) : 0,
        estimatedTokensSaved,
    };
}

