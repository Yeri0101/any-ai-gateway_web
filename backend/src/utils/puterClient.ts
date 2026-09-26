/**
 * puterClient.ts
 * Adapter that wraps the @heyputer/puter.js SDK for Node.js usage.
 * Converts OpenAI-compatible messages/options → puter.ai.chat() calls,
 * and maps the response back to the OpenAI chat completion format.
 */

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { init } = require('@heyputer/puter.js/src/init.cjs');

export interface PuterChatOptions {
    model?: string;
    max_tokens?: number;
    temperature?: number;
    stream?: boolean;
}

export interface OpenAIMessage {
    role: 'system' | 'user' | 'assistant' | 'tool';
    content: string | null;
    tool_calls?: any[];
    tool_call_id?: string;
    name?: string;
}

/**
 * Extracts the text content from any Puter response structure.
 * Puter can return many different shapes depending on the model:
 * - string
 * - { message: { content: string } }
 * - { text: string }
 * - { choices: [{ message: { content: string } }] }
 * - AsyncIterable (Claude sometimes does this even in non-stream mode)
 */
async function extractContent(result: any): Promise<string> {
    const ts = new Date().toISOString();

    // If it's a plain string
    if (typeof result === 'string') {
        return result;
    }

    // If it's an AsyncIterable / async generator (some Claude models stream by default)
    if (result && typeof result[Symbol.asyncIterator] === 'function') {
        console.log(`[${ts}] [Puter] Response is AsyncIterable, collecting chunks for non-stream call`);
        let collected = '';
        for await (const chunk of result) {
            const delta =
                typeof chunk === 'string'
                    ? chunk
                    : chunk?.text ?? chunk?.delta?.content ?? chunk?.choices?.[0]?.delta?.content ?? '';
            collected += delta;
        }
        return collected;
    }

    // Standard OpenAI-like shape
    if (result?.choices?.[0]?.message?.content !== undefined) {
        const c = result.choices[0].message.content;
        if (Array.isArray(c)) return c.map((b: any) => b.text || '').join('');
        return c ?? '';
    }

    // Puter native shape: { message: { content } }
    if (result?.message?.content !== undefined) {
        const c = result.message.content;
        if (Array.isArray(c)) return c.map((b: any) => b.text || '').join('');
        return c ?? '';
    }

    // Puter native shape: { text }
    if (result?.text !== undefined) {
        return String(result.text);
    }

    // Last resort: stringify non-null result
    if (result !== null && result !== undefined) {
        console.warn(`[${ts}] [Puter] Unknown response shape, keys:`, Object.keys(result));
        return JSON.stringify(result);
    }

    return '';
}

/**
 * Normalize messages to what puter.ai.chat() accepts.
 */
function normalizeMessages(messages: OpenAIMessage[]) {
    return messages.map((m) => ({
        role: m.role === 'tool' ? 'user' : m.role,
        content: m.content ?? '',
        ...(m.tool_calls ? { tool_calls: m.tool_calls } : {}),
        ...(m.tool_call_id ? { tool_call_id: m.tool_call_id } : {}),
        ...(m.name ? { name: m.name } : {}),
    }));
}

/**
 * Calls puter.ai.chat() with the given auth token and returns an
 * OpenAI-compatible chat completion response object (non-streaming).
 */
export async function callPuterAI(
    authToken: string,
    messages: OpenAIMessage[],
    options: PuterChatOptions = {}
): Promise<any> {
    const ts = new Date().toISOString();
    const puter = init(authToken);

    const normalizedMessages = normalizeMessages(messages);

    const chatOptions: Record<string, any> = {};
    if (options.model) chatOptions.model = options.model;
    if (options.max_tokens) chatOptions.max_tokens = options.max_tokens;
    if (options.temperature !== undefined) chatOptions.temperature = options.temperature;

    console.log(`[${ts}] [Puter] Calling puter.ai.chat model=${options.model ?? 'default'} msgs=${normalizedMessages.length}`);

    const startTime = Date.now();
    const timeoutPromise = new Promise((_, reject) => {
        setTimeout(() => reject(new Error('Puter AI request timed out')), 6000);
    });

    let result: any;
    try {
        result = await Promise.race([
            Promise.resolve(puter.ai.chat(normalizedMessages, chatOptions)).catch((err: any) => {
                const msg = err?.message || (typeof err === 'object' ? JSON.stringify(err) : String(err));
                throw new Error(msg);
            }),
            timeoutPromise,
        ]);
    } catch (err: any) {
        const msg = err?.message || (typeof err === 'object' ? JSON.stringify(err) : String(err));
        throw new Error(msg);
    }
    const latency = Date.now() - startTime;

    console.log(`[${ts}] [Puter] Raw result type=${typeof result} isAsyncIterable=${result && typeof result[Symbol.asyncIterator] === 'function'} keys=${result && typeof result === 'object' ? Object.keys(result).join(',') : 'n/a'}`);

    const messageContent = await extractContent(result);

    console.log(`[${ts}] [Puter] Content extracted, length=${messageContent.length} latency=${latency}ms`);

    // Try to get usage from result
    const usage = (result && typeof result === 'object' && !result[Symbol.asyncIterator])
        ? (result?.usage ?? { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 })
        : { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };

    return {
        id: `puter-${Date.now()}`,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: options.model ?? 'puter-default',
        choices: [
            {
                index: 0,
                message: {
                    role: 'assistant',
                    content: messageContent,
                },
                finish_reason: 'stop',
            },
        ],
        usage,
        _puter_latency_ms: latency,
    };
}

/**
 * Streaming version: returns an async generator that yields SSE-compatible
 * text chunks in the OpenAI stream format.
 */
export async function* callPuterAIStream(
    authToken: string,
    messages: OpenAIMessage[],
    options: PuterChatOptions = {}
): AsyncGenerator<string> {
    const ts = new Date().toISOString();
    const puter = init(authToken);

    const normalizedMessages = normalizeMessages(messages);

    const chatOptions: Record<string, any> = { stream: true };
    if (options.model) chatOptions.model = options.model;
    if (options.max_tokens) chatOptions.max_tokens = options.max_tokens;
    if (options.temperature !== undefined) chatOptions.temperature = options.temperature;

    console.log(`[${ts}] [Puter] Stream call model=${options.model ?? 'default'}`);

    const stream = await puter.ai.chat(normalizedMessages, chatOptions);

    const completionId = `puter-${Date.now()}`;
    const createdAt = Math.floor(Date.now() / 1000);
    const model = options.model ?? 'puter-default';

    // Handle if puter returns a non-iterable (e.g. a complete string for some models)
    if (typeof stream === 'string') {
        const sseChunk = {
            id: completionId, object: 'chat.completion.chunk', created: createdAt, model,
            choices: [{ index: 0, delta: { role: 'assistant', content: stream }, finish_reason: 'stop' }],
        };
        yield `data: ${JSON.stringify(sseChunk)}\n\n`;
        yield 'data: [DONE]\n\n';
        return;
    }

    if (!stream || typeof stream[Symbol.asyncIterator] !== 'function') {
        // Fallback: treat as complete response
        const content = await extractContent(stream);
        const sseChunk = {
            id: completionId, object: 'chat.completion.chunk', created: createdAt, model,
            choices: [{ index: 0, delta: { role: 'assistant', content }, finish_reason: 'stop' }],
        };
        yield `data: ${JSON.stringify(sseChunk)}\n\n`;
        yield 'data: [DONE]\n\n';
        return;
    }

    for await (const chunk of stream) {
        const deltaContent =
            typeof chunk === 'string'
                ? chunk
                : chunk?.text ?? chunk?.delta?.content ?? chunk?.choices?.[0]?.delta?.content ?? '';

        const isDone = chunk?.done === true || chunk?.finish_reason === 'stop';

        const sseChunk = {
            id: completionId,
            object: 'chat.completion.chunk',
            created: createdAt,
            model,
            choices: [
                {
                    index: 0,
                    delta: { role: 'assistant', content: deltaContent },
                    finish_reason: isDone ? 'stop' : null,
                },
            ],
        };

        yield `data: ${JSON.stringify(sseChunk)}\n\n`;

        if (isDone) break;
    }

    yield 'data: [DONE]\n\n';
}

/**
 * Curated list of popular Puter-supported models shown in the frontend.
 * Puter supports 500+ models; we expose a useful subset.
 */
export const PUTER_MODELS = [
    { id: 'gpt-4o' },
    { id: 'gpt-4o-mini' },
    { id: 'gpt-4.1' },
    { id: 'gpt-4.1-mini' },
    { id: 'o4-mini' },
    { id: 'claude-sonnet-4-5' },
    { id: 'claude-haiku-4-5' },
    { id: 'claude-opus-4-5' },
    { id: 'google/gemini-2.5-flash' },
    { id: 'google/gemini-2.5-pro' },
    { id: 'google/gemini-2.0-flash' },
    { id: 'deepseek/deepseek-chat' },
    { id: 'deepseek/deepseek-r1' },
    { id: 'meta-llama/llama-3.3-70b-instruct' },
    { id: 'mistralai/mistral-large-2' },
    { id: 'x-ai/grok-3-beta' },
    { id: 'qwen/qwen3-235b-a22b' },
];
