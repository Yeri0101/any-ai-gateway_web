import { Hono } from 'hono';
import { supabase } from '../db';
import { authMiddleware } from '../middleware/auth';
import { invalidateGatewayKeyCache } from '../middleware/gatewayAuth';
import crypto from 'crypto';

const gatewayKeys = new Hono();

gatewayKeys.use('*', authMiddleware);

gatewayKeys.get('/', async (c) => {
    const { data, error } = await supabase
        .from('gateway_keys')
        .select(`
      *,
      projects(name),
      gateway_key_models(upstream_key_id, model_name)
    `)
        .order('created_at', { ascending: false });

    if (error) return c.json({ error: error.message }, 500);

    const sanitized = (data || []).map((row: any) => {
        const key: string = row.api_key || '';
        const key_preview = key.length > 9
            ? `${key.slice(0, 4)}...${key.slice(-5)}`
            : `${key.slice(0, 4)}...`;
        return { ...row, key_preview };
    });

    return c.json(sanitized);
});

gatewayKeys.post('/', async (c) => {
    const { project_id, key_name, custom_key, models } = await c.req.json();
    // Generate a random key if custom key not provided
    const normalizedKeyName = typeof key_name === 'string' ? key_name.trim() : '';
    const normalizedCustomKey = typeof custom_key === 'string' ? custom_key.trim() : '';
    const api_key = normalizedCustomKey || `gk_${crypto.randomBytes(16).toString('hex')}`;

    if (!project_id || !normalizedKeyName) {
        return c.json({ error: 'project_id and key_name are required' }, 400);
    }

    const { data: existingKey, error: existingKeyError } = await supabase
        .from('gateway_keys')
        .select('id')
        .eq('api_key', api_key)
        .limit(1)
        .maybeSingle();

    if (existingKeyError) return c.json({ error: existingKeyError.message }, 500);
    if (existingKey) return c.json({ error: 'This gateway API key already exists' }, 409);

    // Insert Gateway Key
    const { data: keyData, error: keyError } = await supabase
        .from('gateway_keys')
        .insert([{ project_id, key_name: normalizedKeyName, api_key }])
        .select()
        .single();

    if (keyError) return c.json({ error: keyError.message }, 500);

    // Insert Mapping Models
    // models should be an array of objects: { upstream_key_id, model_name }
    if (models && models.length > 0) {
        const inserts = models
            .filter((m: any) => m && m.model_name && String(m.model_name).trim())
            .map((m: any) => ({
                id: crypto.randomUUID(),
                gateway_key_id: keyData.id,
                upstream_key_id: (m.upstream_key_id && String(m.upstream_key_id).trim() !== '') ? m.upstream_key_id : null,
                model_name: m.model_name.trim()
            }));

        if (inserts.length > 0) {
            const { error: modelError } = await supabase.from('gateway_key_models').insert(inserts);
            if (modelError) {
                console.error("Failed to map models:", modelError);
            }
        }
    }

    invalidateGatewayKeyCache();
    return c.json(keyData, 201);
});

gatewayKeys.delete('/:id', async (c) => {
    const { id } = c.req.param();
    const { error } = await supabase.from('gateway_keys').delete().eq('id', id);
    if (error) return c.json({ error: error.message }, 500);
    invalidateGatewayKeyCache();
    return c.json({ success: true });
});

// Reveal the full api_key value for clipboard copy — admin-only
gatewayKeys.get('/:id/reveal', async (c) => {
    const { id } = c.req.param();
    const { data, error } = await supabase
        .from('gateway_keys')
        .select('api_key')
        .eq('id', id)
        .single();
    if (error || !data) return c.json({ error: 'Key not found' }, 404);
    return c.json({ api_key: data.api_key });
});

gatewayKeys.post('/:id/models', async (c) => {
    const { id } = c.req.param();
    const { models } = await c.req.json();

    if (models && models.length > 0) {
        const { data: existing } = await supabase
            .from('gateway_key_models')
            .select('model_name')
            .eq('gateway_key_id', id);

        const existingNames = new Set((existing || []).map((r: any) => r.model_name));

        const inserts = models
            .filter((m: any) => m && m.model_name && !existingNames.has(m.model_name.trim()))
            .map((m: any) => ({
                id: crypto.randomUUID(),
                gateway_key_id: id,
                upstream_key_id: (m.upstream_key_id && String(m.upstream_key_id).trim() !== '') ? m.upstream_key_id : null,
                model_name: m.model_name.trim()
            }));

        if (inserts.length > 0) {
            const { error: modelError } = await supabase.from('gateway_key_models').insert(inserts);
            if (modelError) {
                console.error('[gatewayKeys] Failed to map models:', modelError);
                return c.json({ error: modelError.message }, 500);
            }
        }
    }
    invalidateGatewayKeyCache();
    return c.json({ success: true }, 201);
});

gatewayKeys.delete('/:id/models/:modelName', async (c) => {
    const { id, modelName } = c.req.param();

    const decodedModel = decodeURIComponent(modelName);

    const { error } = await supabase.from('gateway_key_models')
        .delete()
        .eq('gateway_key_id', id)
        .eq('model_name', decodedModel);

    if (error) return c.json({ error: error.message }, 500);
    invalidateGatewayKeyCache();
    return c.json({ success: true });
});

export default gatewayKeys;
