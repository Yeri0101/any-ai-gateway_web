/**
 * TierMax — Adaptive Free-Tier Limit Guardian
 *
 * Prevents 429 "Too Many Requests" and quota exhaustion errors when using
 * free or rate-limited API tiers (Google AI Studio, Groq, Cerebras, Mistral, OpenRouter, etc.).
 *
 * Core capabilities:
 * 1. Sliding window tracking of RPM, TPM, RPD, and TPD per upstream key.
 * 2. Pre-configured free-tier baseline profiles for popular providers and models.
 * 3. Smooth queue delay: Delays requests approaching the rate limit window instead of failing.
 * 4. Silent fallback: Automatically rotates to alternative keys or tiers when daily quota is exhausted.
 * 5. Passive header ingestion: Updates limits in real-time from upstream response headers (x-ratelimit-*).
 * 6. Full manual override support via API & UI.
 */

export interface RateLimitProfile {
    rpm: number;        // Requests Per Minute
    tpm: number;        // Tokens Per Minute
    rpd: number;        // Requests Per Day
    tpd: number;        // Tokens Per Day
}

export interface KeyRateLimitState {
    upstreamKeyId: string;
    provider: string;
    isFreeTier: boolean;
    // Limits
    rpmLimit: number;
    tpmLimit: number;
    rpdLimit: number;
    tpdLimit: number;
    isCustomLimit: boolean;
    // Current window metrics
    requestsThisMinute: number[];   // timestamps in ms
    tokensThisMinute: { time: number; tokens: number }[];
    requestsToday: number;
    tokensToday: number;
    lastDayReset: string;           // YYYY-MM-DD
    // Health and cooldown
    status: 'healthy' | 'near_limit' | 'throttled' | 'daily_exhausted';
    cooldownUntilMs: number;
    lastResponseHeaders?: Record<string, string>;
    lastUpdatedMs: number;
}

// Baseline known free tier limits by provider
export const DEFAULT_FREE_TIER_PROFILES: Record<string, RateLimitProfile> = {
    google: {
        rpm: 10,            // Baseline Gemini Flash free tier
        tpm: 250_000,
        rpd: 250,
        tpd: 100_000_000,
    },
    groq: {
        rpm: 30,            // Groq free tier
        tpm: 14_400,
        rpd: 14_400,
        tpd: 10_000_000,
    },
    cerebras: {
        rpm: 30,            // Cerebras free tier
        tpm: 60_000,
        rpd: 14_400,
        tpd: 20_000_000,
    },
    mistral: {
        rpm: 60,            // Mistral experimentation (1 RPS)
        tpm: 100_000,
        rpd: 5_000,
        tpd: 5_000_000,
    },
    openrouter: {
        rpm: 30,            // OpenRouter free models
        tpm: 200_000,
        rpd: 10_000,
        tpd: 50_000_000,
    },
    puter: {
        rpm: 60,
        tpm: 150_000,
        rpd: 10_000,
        tpd: 20_000_000,
    },
    mimo: {
        rpm: 60,
        tpm: 200_000,
        rpd: 10_000,
        tpd: 50_000_000,
    },
    default_paid: {
        rpm: 300,
        tpm: 500_000,
        rpd: 100_000,
        tpd: 500_000_000,
    },
};

// Granular free tier rate limits by model (Google Gemini tiered free quotas)
export const MODEL_RATE_LIMIT_PROFILES: Record<string, RateLimitProfile> = {
    'gemini-3.8-flash': {
        rpm: 5,
        tpm: 250_000,
        rpd: 20,
        tpd: 10_000_000,
    },
    'gemini-3.7-flash': {
        rpm: 5,
        tpm: 250_000,
        rpd: 50,
        tpd: 25_000_000,
    },
    'gemini-3.6-flash': {
        rpm: 10,
        tpm: 250_000,
        rpd: 100,
        tpd: 50_000_000,
    },
    'gemini-3.5-flash': {
        rpm: 10,
        tpm: 250_000,
        rpd: 250,
        tpd: 100_000_000,
    },
    'gemini-3.5-flash-lite': {
        rpm: 15,
        tpm: 250_000,
        rpd: 1_000,
        tpd: 250_000_000,
    },
};

import fs from 'fs';
import path from 'path';

const GUARDIAN_LIMITS_FILE = path.join(process.cwd(), '.guardian_limits.json');

function loadPersistedLimits(): Record<string, Partial<RateLimitProfile>> {
    try {
        if (fs.existsSync(GUARDIAN_LIMITS_FILE)) {
            const raw = fs.readFileSync(GUARDIAN_LIMITS_FILE, 'utf-8');
            return JSON.parse(raw);
        }
    } catch (e) {
        console.warn('[FreeTierGuardian] Could not read .guardian_limits.json:', e);
    }
    return {};
}

function savePersistedLimits(limits: Record<string, Partial<RateLimitProfile>>) {
    try {
        fs.writeFileSync(GUARDIAN_LIMITS_FILE, JSON.stringify(limits, null, 2), 'utf-8');
    } catch (e) {
        console.warn('[FreeTierGuardian] Could not write .guardian_limits.json:', e);
    }
}

const persistedCustomLimits = loadPersistedLimits();

// In-memory guardian registry of key states
const keyStates: Map<string, KeyRateLimitState> = new Map();

function getTodayString(): string {
    return new Date().toISOString().split('T')[0];
}

/**
 * Get or initialize rate limit tracking state for an upstream key.
 */
export function getOrCreateKeyState(
    upstreamKeyId: string,
    provider: string,
    billingType: 'free' | 'paid' = 'free',
    customLimits?: Partial<RateLimitProfile>,
    model?: string
): KeyRateLimitState {
    let state = keyStates.get(upstreamKeyId);
    const today = getTodayString();

    const normalizedModel = (model || '').toLowerCase().replace(/^(google|vertex)\//, '');
    const modelProfile = MODEL_RATE_LIMIT_PROFILES[normalizedModel];

    if (!state) {
        const isFree = billingType === 'free';
        const baseProfile = isFree
            ? (DEFAULT_FREE_TIER_PROFILES[provider.toLowerCase()] || DEFAULT_FREE_TIER_PROFILES.google)
            : DEFAULT_FREE_TIER_PROFILES.default_paid;
        const profile = modelProfile && isFree ? modelProfile : baseProfile;

        const effectiveCustom = customLimits || persistedCustomLimits[upstreamKeyId];
        state = {
            upstreamKeyId,
            provider: provider.toLowerCase(),
            isFreeTier: isFree,
            rpmLimit: effectiveCustom?.rpm ?? profile.rpm,
            tpmLimit: effectiveCustom?.tpm ?? profile.tpm,
            rpdLimit: effectiveCustom?.rpd ?? profile.rpd,
            tpdLimit: effectiveCustom?.tpd ?? profile.tpd,
            isCustomLimit: !!effectiveCustom,
            requestsThisMinute: [],
            tokensThisMinute: [],
            requestsToday: 0,
            tokensToday: 0,
            lastDayReset: today,
            status: 'healthy',
            cooldownUntilMs: 0,
            lastUpdatedMs: Date.now(),
        };
        keyStates.set(upstreamKeyId, state);
    } else {
        // Daily rollover check
        if (state.lastDayReset !== today) {
            state.requestsToday = 0;
            state.tokensToday = 0;
            state.lastDayReset = today;
            if (state.status === 'daily_exhausted') {
                state.status = 'healthy';
            }
        }
        // If not custom limit, adapt to model limits dynamically if model profile exists
        if (!state.isCustomLimit && modelProfile && state.isFreeTier) {
            state.rpmLimit = modelProfile.rpm;
            state.tpmLimit = modelProfile.tpm;
            state.rpdLimit = modelProfile.rpd;
            state.tpdLimit = modelProfile.tpd;
        }
        // Update custom limits if provided
        if (customLimits) {
            if (customLimits.rpm !== undefined) state.rpmLimit = customLimits.rpm;
            if (customLimits.tpm !== undefined) state.tpmLimit = customLimits.tpm;
            if (customLimits.rpd !== undefined) state.rpdLimit = customLimits.rpd;
            if (customLimits.tpd !== undefined) state.tpdLimit = customLimits.tpd;
            state.isCustomLimit = true;
        }
    }

    cleanExpiredWindows(state);
    return state;
}

/**
 * Clean sliding 60s windows for a state.
 */
function cleanExpiredWindows(state: KeyRateLimitState) {
    const now = Date.now();
    const oneMinuteAgo = now - 60_000;

    state.requestsThisMinute = state.requestsThisMinute.filter(ts => ts > oneMinuteAgo);
    state.tokensThisMinute = state.tokensThisMinute.filter(item => item.time > oneMinuteAgo);

    if (state.cooldownUntilMs > 0 && now >= state.cooldownUntilMs) {
        state.cooldownUntilMs = 0;
        if (state.status === 'throttled') {
            state.status = 'healthy';
        }
    }

    // Refresh status
    if (state.status !== 'throttled' && state.status !== 'daily_exhausted') {
        const rpmRatio = state.requestsThisMinute.length / Math.max(1, state.rpmLimit);
        const currentTokensMinute = state.tokensThisMinute.reduce((sum, i) => sum + i.tokens, 0);
        const tpmRatio = currentTokensMinute / Math.max(1, state.tpmLimit);

        if (state.requestsToday >= state.rpdLimit || state.tokensToday >= state.tpdLimit) {
            state.status = 'daily_exhausted';
        } else if (rpmRatio >= 0.85 || tpmRatio >= 0.85) {
            state.status = 'near_limit';
        } else {
            state.status = 'healthy';
        }
    }
}

/**
 * Check if an upstream key can accept a request of `estimatedTokens`.
 * Returns decision and estimated wait time if smooth throttling is recommended.
 */
export function checkRateLimitCapacity(
    upstreamKeyId: string,
    provider: string,
    billingType: 'free' | 'paid' = 'free',
    estimatedTokens: number = 200,
    customLimits?: Partial<RateLimitProfile>,
    model?: string
): {
    canProceedImmediately: boolean;
    shouldWaitMs: number;
    reason?: string;
    state: KeyRateLimitState;
} {
    const state = getOrCreateKeyState(upstreamKeyId, provider, billingType, customLimits, model);
    const now = Date.now();

    // 1. If currently in cooldown or daily exhausted
    if (state.status === 'daily_exhausted') {
        return {
            canProceedImmediately: false,
            shouldWaitMs: 0,
            reason: `Daily free tier quota reached for provider ${provider} (${state.requestsToday}/${state.rpdLimit} reqs)`,
            state,
        };
    }

    if (state.cooldownUntilMs > now) {
        const remainingCooldown = state.cooldownUntilMs - now;
        return {
            canProceedImmediately: false,
            shouldWaitMs: remainingCooldown,
            reason: `Key is in cooldown for ${Math.ceil(remainingCooldown / 1000)}s after upstream 429`,
            state,
        };
    }

    // 2. Check RPM
    const currentRpm = state.requestsThisMinute.length;
    if (currentRpm >= state.rpmLimit) {
        // Find oldest timestamp in current window to calculate wait time
        const oldest = state.requestsThisMinute[0] || (now - 60_000);
        const timeToWindowFree = Math.max(100, (oldest + 60_000) - now + 150); // slight buffer
        return {
            canProceedImmediately: false,
            shouldWaitMs: Math.min(timeToWindowFree, 10_000),
            reason: `RPM limit reached (${currentRpm}/${state.rpmLimit})`,
            state,
        };
    }

    // 3. Check TPM
    // 3a. If a single request exceeds the key's absolute TPM/ITPM limit, waiting is futile (would trigger HTTP 413)
    const effectiveSingleRequestLimit = state.provider === 'groq' ? Math.min(state.tpmLimit, 7000) : state.tpmLimit;
    if (estimatedTokens > effectiveSingleRequestLimit && state.rpmLimit > 0) {
        return {
            canProceedImmediately: false,
            shouldWaitMs: 999999, // Unresolvable by waiting in window
            reason: `Single request tokens (${estimatedTokens}) exceed provider ${state.provider} ITPM limit (${effectiveSingleRequestLimit})`,
            state,
        };
    }

    const currentTpm = state.tokensThisMinute.reduce((sum, item) => sum + item.tokens, 0);
    if (currentTpm + estimatedTokens > state.tpmLimit && state.rpmLimit > 0) {
        const oldestTokenItem = state.tokensThisMinute[0];
        const timeToTokenFree = oldestTokenItem ? Math.max(100, (oldestTokenItem.time + 60_000) - now + 150) : 1000;
        return {
            canProceedImmediately: false,
            shouldWaitMs: Math.min(timeToTokenFree, 10_000),
            reason: `TPM limit approached (${currentTpm + estimatedTokens}/${state.tpmLimit})`,
            state,
        };
    }

    return {
        canProceedImmediately: true,
        shouldWaitMs: 0,
        state,
    };
}

/**
 * Record an actual request execution and token consumption.
 */
export function recordRateLimitConsumption(
    upstreamKeyId: string,
    tokens: number
) {
    const state = keyStates.get(upstreamKeyId);
    if (!state) return;

    const now = Date.now();
    state.requestsThisMinute.push(now);
    state.tokensThisMinute.push({ time: now, tokens });
    state.requestsToday++;
    state.tokensToday += tokens;
    state.lastUpdatedMs = now;

    cleanExpiredWindows(state);
}

/**
 * Ingest response headers from upstream to synchronize rate limits dynamically.
 */
export function ingestRateLimitHeaders(
    upstreamKeyId: string,
    headers: Headers
) {
    const state = keyStates.get(upstreamKeyId);
    if (!state) return;

    // Common header formats:
    // Groq / OpenAI: x-ratelimit-remaining-requests, x-ratelimit-remaining-tokens, x-ratelimit-reset-requests
    // Gemini: retry-after (on 429)
    const remainingReqStr = headers.get('x-ratelimit-remaining-requests');
    const limitReqStr = headers.get('x-ratelimit-limit-requests');
    const remainingTokStr = headers.get('x-ratelimit-remaining-tokens');
    const limitTokStr = headers.get('x-ratelimit-limit-tokens');
    const resetReqStr = headers.get('x-ratelimit-reset-requests') || headers.get('retry-after');

    if (limitReqStr) {
        const parsed = parseInt(limitReqStr, 10);
        if (!isNaN(parsed) && parsed > 0 && !state.isCustomLimit) {
            state.rpmLimit = parsed;
        }
    }

    if (limitTokStr) {
        const parsed = parseInt(limitTokStr, 10);
        if (!isNaN(parsed) && parsed > 0 && !state.isCustomLimit) {
            state.tpmLimit = parsed;
        }
    }

    if (remainingReqStr) {
        const remaining = parseInt(remainingReqStr, 10);
        if (!isNaN(remaining) && remaining <= 1) {
            state.status = 'near_limit';
        }
    }

    if (resetReqStr && state.status === 'throttled') {
        const parsedSec = parseInt(resetReqStr, 10);
        if (!isNaN(parsedSec) && parsedSec > 0) {
            state.cooldownUntilMs = Date.now() + (parsedSec * 1000);
        }
    }

    state.lastUpdatedMs = Date.now();
}

/**
 * Handle upstream 429 error by placing the key on adaptive cooldown.
 */
export function markRateLimitExceeded(
    upstreamKeyId: string,
    retryAfterSeconds?: number
) {
    const state = keyStates.get(upstreamKeyId);
    if (!state) return;

    const cooldownSec = (retryAfterSeconds && retryAfterSeconds > 0)
        ? Math.min(retryAfterSeconds, 120)
        : 30; // default 30s cooldown for 429

    state.cooldownUntilMs = Date.now() + (cooldownSec * 1000);
    state.status = 'throttled';
    console.warn(`[FreeTierGuardian] Key ${upstreamKeyId} (${state.provider}) throttled for ${cooldownSec}s due to 429.`);
}

/**
 * Update rate limit configurations manually for an upstream key.
 */
export function updateCustomLimits(
    upstreamKeyId: string,
    limits: Partial<RateLimitProfile>,
    provider = 'google',
    billingType: 'free' | 'paid' = 'free'
): KeyRateLimitState {
    let state = keyStates.get(upstreamKeyId);
    if (!state) {
        state = getOrCreateKeyState(upstreamKeyId, provider, billingType);
    }

    if (limits.rpm !== undefined && limits.rpm !== null) state.rpmLimit = Math.max(1, limits.rpm);
    if (limits.tpm !== undefined && limits.tpm !== null) state.tpmLimit = Math.max(100, limits.tpm);
    if (limits.rpd !== undefined && limits.rpd !== null) state.rpdLimit = Math.max(1, limits.rpd);
    if (limits.tpd !== undefined && limits.tpd !== null) state.tpdLimit = Math.max(100, limits.tpd);
    state.isCustomLimit = true;
    cleanExpiredWindows(state);
    persistedCustomLimits[upstreamKeyId] = {
        rpm: state.rpmLimit,
        tpm: state.tpmLimit,
        rpd: state.rpdLimit,
        tpd: state.tpdLimit,
    };
    savePersistedLimits(persistedCustomLimits);
    return state;
}

/**
 * Get snapshot of all active key states for dashboard monitoring.
 */
export function getAllRateLimitStates(): Record<string, any> {
    const result: Record<string, any> = {};
    const now = Date.now();

    keyStates.forEach((state, id) => {
        cleanExpiredWindows(state);
        const currentTokensMinute = state.tokensThisMinute.reduce((sum, i) => sum + i.tokens, 0);
        result[id] = {
            upstreamKeyId: id,
            provider: state.provider,
            isFreeTier: state.isFreeTier,
            rpm: {
                current: state.requestsThisMinute.length,
                limit: state.rpmLimit,
                percent: Math.min(100, Math.round((state.requestsThisMinute.length / Math.max(1, state.rpmLimit)) * 100)),
            },
            tpm: {
                current: currentTokensMinute,
                limit: state.tpmLimit,
                percent: Math.min(100, Math.round((currentTokensMinute / Math.max(1, state.tpmLimit)) * 100)),
            },
            daily: {
                requestsToday: state.requestsToday,
                rpdLimit: state.rpdLimit,
                percentRequests: Math.min(100, Math.round((state.requestsToday / Math.max(1, state.rpdLimit)) * 100)),
                tokensToday: state.tokensToday,
                tpdLimit: state.tpdLimit,
            },
            status: state.status,
            cooldownRemainingSec: Math.max(0, Math.ceil((state.cooldownUntilMs - now) / 1000)),
            isCustomLimit: state.isCustomLimit,
        };
    });

    return result;
}
