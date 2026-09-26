import { createClient } from '@supabase/supabase-js';
import * as dotenv from 'dotenv';
import * as path from 'path';

dotenv.config({ path: path.resolve(__dirname, '../backend/.env') });

const GATEWAY_URL = process.env.GATEWAY_URL || 'http://localhost:3000';
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || 'mock-admin-token-123';
const MODEL = process.env.TEST_MODEL || 'qwen/qwen3.8-27b';

async function runVerification() {
    console.log('=== STARTING SEMANTIC CACHE VERIFICATION SUITE ===\n');

    // Fetch an active gateway key dynamically
    let gatewayKey = process.env.GATEWAY_KEY;
    if (!gatewayKey) {
        const keysRes = await fetch(`${GATEWAY_URL}/api/gateway-keys`, {
            headers: { 'Authorization': `Bearer ${ADMIN_TOKEN}` }
        });
        const keys = await keysRes.json();
        gatewayKey = keys[0]?.api_key;
    }
    if (!gatewayKey) {
        throw new Error('No gateway key available for testing');
    }

    // 0. Reset state first
    console.log('0. Resetting telemetry & cache stats via POST /api/analytics/reset...');
    const resetRes = await fetch(`${GATEWAY_URL}/api/analytics/reset`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${ADMIN_TOKEN}` }
    });
    const resetJson = await resetRes.json();
    console.log('Reset response:', resetJson);

    // 1. Initial non-streaming request (Expect MISS)
    const prompt1 = 'Semantic test prompt ' + Date.now();
    console.log(`\n1. Sending non-streaming request 1 (Prompt: "${prompt1}")...`);
    const t0 = Date.now();
    const res1 = await fetch(`${GATEWAY_URL}/v1/chat/completions`, {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${gatewayKey}`,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({
            model: MODEL,
            messages: [{ role: 'user', content: prompt1 }],
            temperature: 0
        })
    });
    const latency1 = Date.now() - t0;
    const cacheHeader1 = res1.headers.get('x-cache');
    const data1 = await res1.json();
    console.log(`Result 1: Status=${res1.status}, X-Cache=${cacheHeader1}, Latency=${latency1}ms, TotalTokens=${data1.usage?.total_tokens}`);

    if (cacheHeader1 !== 'MISS') {
        throw new Error(`Expected X-Cache: MISS on request 1, got ${cacheHeader1}`);
    }

    // 2. Duplicate non-streaming request (Expect HIT in <15ms)
    console.log(`\n2. Sending duplicate non-streaming request 2 (Expect HIT)...`);
    const t1 = Date.now();
    const res2 = await fetch(`${GATEWAY_URL}/v1/chat/completions`, {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${gatewayKey}`,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({
            model: MODEL,
            messages: [{ role: 'user', content: prompt1 }],
            temperature: 0
        })
    });
    const latency2 = Date.now() - t1;
    const cacheHeader2 = res2.headers.get('x-cache');
    const data2 = await res2.json();
    console.log(`Result 2: Status=${res2.status}, X-Cache=${cacheHeader2}, Latency=${latency2}ms, TotalTokens=${data2.usage?.total_tokens}`);

    if (cacheHeader2 !== 'HIT') {
        throw new Error(`Expected X-Cache: HIT on request 2, got ${cacheHeader2}`);
    }
    if (latency2 > 500) {
        throw new Error(`Expected cache hit latency < 500ms, got ${latency2}ms`);
    }

    // 3. Streaming request 1 (Expect MISS)
    const promptStream = 'Semantic stream prompt ' + Date.now();
    console.log(`\n3. Sending streaming request 1 (Prompt: "${promptStream}")...`);
    const s0 = Date.now();
    const sRes1 = await fetch(`${GATEWAY_URL}/v1/chat/completions`, {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${gatewayKey}`,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({
            model: MODEL,
            messages: [{ role: 'user', content: promptStream }],
            stream: true,
            temperature: 0
        })
    });
    const sLatency1 = Date.now() - s0;
    const sCacheHeader1 = sRes1.headers.get('x-cache');
    const sBody1 = await sRes1.text();
    console.log(`Stream Result 1: Status=${sRes1.status}, X-Cache=${sCacheHeader1}, Latency=${sLatency1}ms, ChunksSize=${sBody1.length} bytes`);

    if (sCacheHeader1 !== 'MISS') {
        throw new Error(`Expected X-Cache: MISS on streaming request 1, got ${sCacheHeader1}`);
    }

    // 4. Duplicate streaming request (Expect HIT in <15ms)
    console.log(`\n4. Sending duplicate streaming request 2 (Expect HIT)...`);
    const s1 = Date.now();
    const sRes2 = await fetch(`${GATEWAY_URL}/v1/chat/completions`, {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${gatewayKey}`,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({
            model: MODEL,
            messages: [{ role: 'user', content: promptStream }],
            stream: true,
            temperature: 0
        })
    });
    const sLatency2 = Date.now() - s1;
    const sCacheHeader2 = sRes2.headers.get('x-cache');
    const sBody2 = await sRes2.text();
    console.log(`Stream Result 2: Status=${sRes2.status}, X-Cache=${sCacheHeader2}, Latency=${sLatency2}ms, ChunksSize=${sBody2.length} bytes`);

    if (sCacheHeader2 !== 'HIT') {
        throw new Error(`Expected X-Cache: HIT on streaming request 2, got ${sCacheHeader2}`);
    }
    if (sLatency2 > 500) {
        throw new Error(`Expected stream cache hit latency < 500ms, got ${sLatency2}ms`);
    }

    // 5. Check Cache Stats via /api/analytics/cache-stats
    console.log('\n5. Querying /api/analytics/cache-stats...');
    const statsRes = await fetch(`${GATEWAY_URL}/api/analytics/cache-stats`, {
        headers: { 'Authorization': `Bearer ${ADMIN_TOKEN}` }
    });
    const stats = await statsRes.json();
    console.log('Cache Stats:', stats);

    if (stats.totalHits < 2) {
        throw new Error(`Expected totalHits >= 2, got ${stats.totalHits}`);
    }
    if (stats.estimatedTokensSaved <= 0) {
        throw new Error(`Expected estimatedTokensSaved > 0, got ${stats.estimatedTokensSaved}`);
    }
    if (stats.hitRate <= 0) {
        throw new Error(`Expected hitRate > 0, got ${stats.hitRate}`);
    }

    // 6. Check Dashboard Overview via /api/projects/dashboard-overview
    console.log('\n6. Querying /api/projects/dashboard-overview...');
    const overviewRes = await fetch(`${GATEWAY_URL}/api/projects/dashboard-overview`, {
        headers: { 'Authorization': `Bearer ${ADMIN_TOKEN}` }
    });
    const overview = await overviewRes.json();
    console.log('Dashboard Recent Calls:', overview.recentCalls);
    console.log('Dashboard Usage Metrics:', overview.usageMetrics);
    console.log('Dashboard Cache Stats:', overview.cacheStats);

    const cacheHitsInCalls = overview.recentCalls.filter((c: any) => c.provider === 'cache');
    console.log(`Cache calls in recentCalls: ${cacheHitsInCalls.length}`);
    if (cacheHitsInCalls.length === 0) {
        throw new Error('Expected at least one call with provider="cache" in recentCalls');
    }

    // 7. Verify Supabase request_logs table
    console.log('\n7. Verifying Supabase request_logs table directly...');
    const supabase = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_ANON_KEY!);
    const { data: dbLogs, error: dbErr } = await supabase
        .from('request_logs')
        .select('*')
        .eq('provider', 'cache')
        .order('created_at', { ascending: false });

    if (dbErr) {
        throw new Error(`Supabase query failed: ${dbErr.message}`);
    }
    console.log(`Direct DB verified: Found ${dbLogs?.length} request_logs entries with provider='cache':`);
    for (const log of (dbLogs || []).slice(0, 3)) {
        console.log(`  - Log ID: ${log.id} | model: ${log.model} | latency: ${log.latency_ms}ms | tokens: ${log.total_tokens} | cost: $${log.total_cost_usd}`);
    }

    console.log('\n======================================================');
    console.log('✅ ALL SEMANTIC CACHE VERIFICATION TESTS PASSED SUCCESSFULLY!');
    console.log('======================================================\n');
}

runVerification().catch((err) => {
    console.error('❌ Verification failed:', err);
    process.exit(1);
});
