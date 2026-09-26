import { useState, useEffect } from 'react';
import { fetchApi } from '../api';
import {
    Check, AlertCircle, RefreshCw, Save, ExternalLink, Play, Sparkles, Award, ShieldCheck, ChevronRight, Flame
} from 'lucide-react';
import { DualEngineGlyph, PromptAnchorGlyph, RateGuardianGlyph, ProviderIcon, RouterCascadeGlyph } from '../components/Icons';
import { useLanguage } from '../i18n';

interface EngineConfig {
    typesafeApiKey?: string;
    typesafeEndpoint?: string;
    typesafeModel?: string;
    enableJevRouting: boolean;
    managerProvider: string;
    managerApiKey?: string;
    managerModel?: string;
    managerBaseUrl?: string;
    managerTemperature: number;
    managerProjectId?: string;
    managerUpstreamKeyId?: string;
    fusionDefaultModels?: string[];
    fusionDefaultJudge?: string;
    fusionSlotProjects?: string[];
}

const PROVIDER_BASE_URLS: Record<string, string> = {
    google: 'https://generativelanguage.googleapis.com/v1beta/openai',
    vertex: 'https://generativelanguage.googleapis.com/v1beta/openai',
    groq: 'https://api.groq.com/openai/v1',
    openai: 'https://api.openai.com/v1',
    anthropic: 'https://api.anthropic.com/v1',
    deepseek: 'https://api.deepseek.com/v1',
    openrouter: 'https://openrouter.ai/api/v1',
    cerebras: 'https://api.cerebras.ai/v1',
    mistral: 'https://api.mistral.ai/v1',
    nvidia: 'https://integrate.api.nvidia.com/v1',
    moonshot: 'https://api.moonshot.cn/v1',
    minimax: 'https://api.minimax.chat/v1',
    mimo: 'https://api.xiaomimimo.com/v1',
    puter: 'https://api.puter.com/v1',
};

export default function EngineSettings() {
    const { t } = useLanguage();
    const [config, setConfig] = useState<EngineConfig>({
        enableJevRouting: false,
        typesafeEndpoint: 'https://openrouter.ai/api/alpha/decisions',
        typesafeModel: '~typesafe/jev-latest',
        managerProvider: 'google',
        managerModel: 'gemini-2.5-flash',
        managerBaseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
        managerTemperature: 0.2,
        managerProjectId: '',
        managerUpstreamKeyId: '',
        fusionDefaultModels: ['deepseek-chat', 'qwen/qwen3.8-27b', 'moonshotai/kimi-k3'],
        fusionDefaultJudge: 'deepseek-chat',
        fusionSlotProjects: ['', '', '', ''],
    });

    const [typesafeKeyInput, setTypesafeKeyInput] = useState('');
    const [managerKeyInput, setManagerKeyInput] = useState('');

    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);
    const [saveSuccess, setSaveSuccess] = useState('');
    const [saveError, setSaveError] = useState('');

    // Project & Upstream Key Providers
    const [projects, setProjects] = useState<any[]>([]);
    const [upstreamKeys, setUpstreamKeys] = useState<any[]>([]);
    const [apiModels, setApiModels] = useState<string[]>([]);
    const [loadingModels, setLoadingModels] = useState(false);
    const [isCustomModel, setIsCustomModel] = useState(false);
    const [selectedSource, setSelectedSource] = useState<string>('');

    // Shared model cache per provider key
    const [modelsCache, setModelsCache] = useState<Record<string, string[]>>({});
    const [loadingKeyModels, setLoadingKeyModels] = useState<Record<string, boolean>>({});

    // Virtual Consensus Fusion Slots: 0: Draft A, 1: Draft B, 2: Draft C, 3: Judge
    const [fusionSlotKeys, setFusionSlotKeys] = useState<string[]>(['', '', '', '']);
    const [fusionSlotManual, setFusionSlotManual] = useState<boolean[]>([false, false, false, false]);

    // Frontier AI Model Advisor states
    const [fusionTier, setFusionTier] = useState<'free' | 'free_training' | 'paid'>('free');
    const [fusionMode, setFusionMode] = useState<'reasoning' | 'speed' | 'frontier'>('reasoning');
    const [advisorData, setAdvisorData] = useState<any>(null);
    const [loadingAdvisor, setLoadingAdvisor] = useState(false);
    const [applyingPreset, setApplyingPreset] = useState(false);
    const [presetFeedback, setPresetFeedback] = useState<{ type: 'success' | 'error'; message: string; details?: any } | null>(null);

    // Testing states
    const [testingJev, setTestingJev] = useState(false);
    const [jevTestResult, setJevTestResult] = useState<any>(null);

    const [testingManager, setTestingManager] = useState(false);
    const [managerTestResult, setManagerTestResult] = useState<any>(null);

    // Auto-calibration
    const [calibrating, setCalibrating] = useState(false);
    const [calibrationResult, setCalibrationResult] = useState<any>(null);

    useEffect(() => {
        loadConfig();
    }, []);

    const fetchModelsForKey = async (sourceId: string): Promise<string[]> => {
        if (!sourceId) return [];
        if (modelsCache[sourceId] && modelsCache[sourceId].length > 0) {
            return modelsCache[sourceId];
        }
        setLoadingKeyModels(prev => ({ ...prev, [sourceId]: true }));
        try {
            let modelsList: string[] = [];
            if (sourceId.startsWith('project:')) {
                const projId = sourceId.replace('project:', '');
                // 1. Try project models endpoint
                try {
                    const projRes = await fetchApi(`/projects/${projId}/models`);
                    if (projRes?.models && Array.isArray(projRes.models) && projRes.models.length > 0) {
                        modelsList = projRes.models;
                    }
                } catch {}

                // 2. Query upstream keys of this project to get full available catalog
                const projKeys = upstreamKeys.filter((k: any) => k.project_id === projId);
                for (const pk of projKeys) {
                    try {
                        const res = await fetchApi(`/providers/${pk.id}/models`);
                        const kModels = (res?.models || []).map((m: any) => typeof m === 'string' ? m : m.id || m.name).filter(Boolean);
                        kModels.forEach((m: string) => {
                            if (!modelsList.includes(m)) modelsList.push(m);
                        });
                        if (modelsList.length > 0) break;
                    } catch {}
                }
            } else {
                const keyId = sourceId.replace('key:', '');
                const res = await fetchApi(`/providers/${keyId}/models`);
                modelsList = (res?.models || []).map((m: any) => typeof m === 'string' ? m : m.id || m.name).filter(Boolean);
            }

            setModelsCache(prev => ({ ...prev, [sourceId]: modelsList }));
            return modelsList;
        } catch (err) {
            console.warn(`[EngineSettings] Could not fetch models for source ${sourceId}:`, err);
            return [];
        } finally {
            setLoadingKeyModels(prev => ({ ...prev, [sourceId]: false }));
        }
    };

    const loadModelsForProvider = async (sourceId: string, currentModelToKeep?: string) => {
        if (!sourceId) return;
        setLoadingModels(true);
        try {
            const modelsList = await fetchModelsForKey(sourceId);
            setApiModels(modelsList);

            if (modelsList.length > 0) {
                const targetModel = currentModelToKeep || config.managerModel;
                if (targetModel) {
                    setConfig(prev => ({ ...prev, managerModel: targetModel }));
                    if (!modelsList.includes(targetModel)) {
                        setIsCustomModel(true);
                    }
                } else {
                    const preferred = modelsList.find((m: string) =>
                        m.includes('flash') || m.includes('mini') || m.includes('versatile') || m.includes('chat')
                    ) || modelsList[0];
                    setConfig(prev => ({ ...prev, managerModel: preferred }));
                }
            }
        } finally {
            setLoadingModels(false);
        }
    };

    const handleFusionSlotKeyChange = async (slotIndex: number, newKeyId: string) => {
        const updatedKeys = [...fusionSlotKeys];
        updatedKeys[slotIndex] = newKeyId;
        setFusionSlotKeys(updatedKeys);
        setConfig(prev => ({ ...prev, fusionSlotProjects: updatedKeys }));

        if (!newKeyId) return;

        const updatedManual = [...fusionSlotManual];
        updatedManual[slotIndex] = false;
        setFusionSlotManual(updatedManual);

        const models = await fetchModelsForKey(newKeyId);
        if (models.length > 0) {
            const currentVal = slotIndex === 3
                ? config.fusionDefaultJudge
                : (config.fusionDefaultModels?.[slotIndex] || '');

            if (!currentVal || !models.includes(currentVal)) {
                const preferred = models.find((m: string) =>
                    m.includes('flash') || m.includes('mini') || m.includes('chat') || m.includes('versatile')
                ) || models[0];

                if (slotIndex === 3) {
                    setConfig(prev => ({ ...prev, fusionDefaultJudge: preferred, fusionSlotProjects: updatedKeys }));
                } else {
                    setConfig(prev => {
                        const next = [...(prev.fusionDefaultModels || ['deepseek-chat', 'qwen/qwen3.8-27b', 'moonshotai/kimi-k3'])];
                        next[slotIndex] = preferred;
                        return { ...prev, fusionDefaultModels: next, fusionSlotProjects: updatedKeys };
                    });
                }
            }
        }
    };

    const handleApplyProjectToAllSlots = async (newKeyId: string) => {
        if (!newKeyId) return;
        const allFour = [newKeyId, newKeyId, newKeyId, newKeyId];
        setFusionSlotKeys(allFour);
        setFusionSlotManual([false, false, false, false]);

        const models = await fetchModelsForKey(newKeyId);
        if (models.length > 0) {
            setConfig(prev => {
                const m1 = models[0];
                const m2 = models[Math.min(1, models.length - 1)];
                const m3 = models[Math.min(2, models.length - 1)];
                const judge = models.find((m: string) => m.includes('pro') || m.includes('plus') || m.includes('chat')) || models[0];
                return {
                    ...prev,
                    fusionDefaultModels: [m1, m2, m3],
                    fusionDefaultJudge: judge,
                    fusionSlotProjects: allFour,
                };
            });
        } else {
            setConfig(prev => ({ ...prev, fusionSlotProjects: allFour }));
        }
    };

    const handleFusionModelSelect = (slotIndex: number, modelName: string) => {
        if (slotIndex === 3) {
            setConfig(prev => ({ ...prev, fusionDefaultJudge: modelName }));
        } else {
            setConfig(prev => {
                const next = [...(prev.fusionDefaultModels || ['deepseek-chat', 'qwen/qwen3.8-27b', 'moonshotai/kimi-k3'])];
                next[slotIndex] = modelName;
                return { ...prev, fusionDefaultModels: next };
            });
        }
    };

    const toggleFusionSlotManual = (slotIndex: number) => {
        const updated = [...fusionSlotManual];
        updated[slotIndex] = !updated[slotIndex];
        setFusionSlotManual(updated);
    };

    const loadConfig = async () => {
        try {
            setLoading(true);
            const [data, projectsData, providersData, advisorRes] = await Promise.all([
                fetchApi('/engine/config').catch(() => null),
                fetchApi('/projects').catch(() => []),
                fetchApi('/providers').catch(() => []),
                fetchApi('/engine/fusion-advisor').catch(() => null),
            ]);

            setProjects(projectsData || []);
            setUpstreamKeys(providersData || []);
            if (advisorRes && advisorRes.ok) {
                setAdvisorData(advisorRes);
            }

            if (data) {
                setConfig(data);
                if (data.typesafeApiKey) setTypesafeKeyInput(data.typesafeApiKey);
                if (data.managerApiKey) setManagerKeyInput(data.managerApiKey);

                if (data.managerProjectId && !data.managerUpstreamKeyId) {
                    setSelectedSource(`project:${data.managerProjectId}`);
                    const projKeys = (providersData || []).filter((k: any) => k.project_id === data.managerProjectId);
                    setManagerKeyInput(`🔄 Rotación activa (${projKeys.length} llaves en pool)`);
                    loadModelsForProvider(`project:${data.managerProjectId}`, data.managerModel);
                } else if (data.managerUpstreamKeyId) {
                    setSelectedSource(`key:${data.managerUpstreamKeyId}`);
                    loadModelsForProvider(`key:${data.managerUpstreamKeyId}`, data.managerModel);
                } else if (data.managerProjectId) {
                    setSelectedSource(`project:${data.managerProjectId}`);
                    loadModelsForProvider(`project:${data.managerProjectId}`, data.managerModel);
                } else {
                    setSelectedSource(`manual:${data.managerProvider || 'google'}`);
                }

                if (data.fusionSlotProjects && Array.isArray(data.fusionSlotProjects)) {
                    const normalized = data.fusionSlotProjects.map((src: string) => {
                        if (!src) return '';
                        if (src.startsWith('project:') || src.startsWith('key:')) return src;
                        if ((projectsData || []).some((p: any) => p.id === src)) return `project:${src}`;
                        return `key:${src}`;
                    });
                    setFusionSlotKeys(normalized);
                    normalized.forEach((src: string) => {
                        if (src) fetchModelsForKey(src);
                    });
                    const initialManual = normalized.map((k: string) => !k);
                    setFusionSlotManual(initialManual);
                } else {
                    setFusionSlotManual([true, true, true, true]);
                }
            }
        } catch (err: any) {
            console.error('Failed to load engine config:', err);
        } finally {
            setLoading(false);
        }
    };

    const loadAdvisorData = async (forceRefresh = false) => {
        setLoadingAdvisor(true);
        try {
            const data = await fetchApi(`/engine/fusion-advisor${forceRefresh ? '?refresh=true' : ''}`);
            if (data && data.ok) {
                setAdvisorData(data);
            }
        } catch (err: any) {
            console.warn('[EngineSettings] Failed to fetch fusion advisor:', err);
        } finally {
            setLoadingAdvisor(false);
        }
    };

    const handleApplySmartPreset = async (
        mode: 'reasoning' | 'speed' | 'frontier',
        version?: 'v1_gold' | 'v2_silver' | 'v3_bronze'
    ) => {
        setApplyingPreset(true);
        setPresetFeedback(null);
        try {
            const body: any = {
                tier: fusionTier,
                mode,
                autoFallback: true
            };
            if (version) {
                body.version = version;
            }
            const res = await fetchApi('/engine/apply-fusion-preset', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body)
            });

            if (res && res.success && res.applied) {
                const applied = res.applied;
                setConfig(prev => ({
                    ...prev,
                    fusionDefaultModels: applied.models,
                    fusionDefaultJudge: applied.judge,
                    fusionSlotProjects: applied.slotProjects || prev.fusionSlotProjects
                }));

                if (applied.slotProjects && Array.isArray(applied.slotProjects)) {
                    setFusionSlotKeys(applied.slotProjects);
                    setFusionSlotManual([false, false, false, false]);
                    applied.slotProjects.forEach((src: string) => {
                        if (src) fetchModelsForKey(src);
                    });
                }

                const verName = applied.versionUsed === 'v1_gold' ? 'V1 Oro' : applied.versionUsed === 'v2_silver' ? 'V2 Plata' : 'V3 Bronce';
                setPresetFeedback({
                    type: 'success',
                    message: `${applied.preset?.label || mode.toUpperCase()} (${verName}): ${t('engine.fusion_preset_applied') || 'Preset aplicado y verificado con sonda de 1 token.'}`,
                    details: applied
                });

                setTimeout(() => setPresetFeedback(null), 8000);
            } else {
                setPresetFeedback({
                    type: 'error',
                    message: res?.error || t('engine.fusion_preset_error') || 'Error al aplicar el preset.'
                });
            }
        } catch (err: any) {
            setPresetFeedback({
                type: 'error',
                message: err.message || t('engine.fusion_preset_error') || 'Error al aplicar el preset.'
            });
        } finally {
            setApplyingPreset(false);
        }
    };

    const handleSourceChange = (newSource: string) => {
        setSelectedSource(newSource);

        if (newSource.startsWith('project:')) {
            const projId = newSource.replace('project:', '');
            const projKeys = upstreamKeys.filter((k: any) => k.project_id === projId);
            const targetKey = projKeys[0];
            const prov = targetKey?.provider || 'google';
            const baseUrl = PROVIDER_BASE_URLS[prov] || config.managerBaseUrl || 'https://api.openai.com/v1';

            setConfig(prev => ({
                ...prev,
                managerProvider: prov,
                managerBaseUrl: baseUrl,
                managerProjectId: projId,
                managerUpstreamKeyId: '', // ROTATION: empty upstream key id triggers pool rotation
            }));
            setManagerKeyInput(`🔄 Rotación activa (${projKeys.length} llaves en pool)`);
            loadModelsForProvider(newSource);
        } else if (newSource.startsWith('key:')) {
            const keyId = newSource.replace('key:', '');
            const targetKey = upstreamKeys.find((k: any) => k.id === keyId);
            if (targetKey) {
                const prov = targetKey.provider || 'google';
                const baseUrl = PROVIDER_BASE_URLS[prov] || config.managerBaseUrl || 'https://api.openai.com/v1';
                setConfig(prev => ({
                    ...prev,
                    managerProvider: prov,
                    managerBaseUrl: baseUrl,
                    managerProjectId: targetKey.project_id,
                    managerUpstreamKeyId: targetKey.id,
                }));
                setManagerKeyInput(targetKey.key_preview || '••••••••');
                loadModelsForProvider(newSource);
            }
        } else if (newSource.startsWith('manual:')) {
            const prov = newSource.replace('manual:', '');
            setConfig(prev => ({
                ...prev,
                managerProjectId: '',
                managerUpstreamKeyId: '',
            }));
            setApiModels([]);
            handleProviderPreset(prov);
        }
    };

    const handleSave = async (e?: React.FormEvent) => {
        if (e) e.preventDefault();
        setSaving(true);
        setSaveSuccess('');
        setSaveError('');

        try {
            const payload: any = {
                ...config,
                fusionSlotProjects: fusionSlotKeys,
            };
            if (typesafeKeyInput && !typesafeKeyInput.includes('••••') && !typesafeKeyInput.includes('...')) {
                payload.typesafeApiKey = typesafeKeyInput.trim();
            }
            if (!config.managerProjectId && !config.managerUpstreamKeyId && managerKeyInput && !managerKeyInput.includes('••••') && !managerKeyInput.includes('...') && !managerKeyInput.includes('🔄')) {
                payload.managerApiKey = managerKeyInput.trim();
            } else if (config.managerUpstreamKeyId || config.managerProjectId) {
                payload.managerApiKey = '';
            }

            const res = await fetchApi('/engine/config', {
                method: 'POST',
                body: JSON.stringify(payload),
            });

            if (res.success) {
                if (res.config) {
                    setConfig(prev => ({ ...prev, ...res.config }));
                    if (res.config.fusionSlotProjects && Array.isArray(res.config.fusionSlotProjects)) {
                        setFusionSlotKeys(res.config.fusionSlotProjects);
                    }
                }
                setSaveSuccess(t('engine.saved_success') || 'Engine configurations saved successfully!');
                setTimeout(() => setSaveSuccess(''), 4000);
            }
        } catch (err: any) {
            setSaveError(err.message || 'Failed to save configuration');
        } finally {
            setSaving(false);
        }
    };

    const testJevConnection = async () => {
        setTestingJev(true);
        setJevTestResult(null);

        try {
            const body: any = {
                typesafeEndpoint: config.typesafeEndpoint,
                typesafeModel: config.typesafeModel,
            };
            if (typesafeKeyInput && !typesafeKeyInput.includes('••••') && !typesafeKeyInput.includes('...')) {
                body.typesafeApiKey = typesafeKeyInput.trim();
            }

            const res = await fetchApi('/engine/test/typesafe', {
                method: 'POST',
                body: JSON.stringify(body),
            });
            setJevTestResult(res);
        } catch (err: any) {
            setJevTestResult({ ok: false, error: err.message });
        } finally {
            setTestingJev(false);
        }
    };

    const testManagerConnection = async () => {
        setTestingManager(true);
        setManagerTestResult(null);

        try {
            const body: any = {
                prompt: 'Ping check from TierMax Management Panel',
                managerProvider: config.managerProvider,
                managerModel: config.managerModel,
                managerBaseUrl: config.managerBaseUrl,
                managerUpstreamKeyId: config.managerUpstreamKeyId,
                managerTemperature: config.managerTemperature,
            };
            if (!config.managerUpstreamKeyId && managerKeyInput && !managerKeyInput.includes('••••') && !managerKeyInput.includes('...')) {
                body.managerApiKey = managerKeyInput.trim();
            }

            const res = await fetchApi('/engine/test/manager', {
                method: 'POST',
                body: JSON.stringify(body),
            });
            setManagerTestResult(res);
        } catch (err: any) {
            setManagerTestResult({ ok: false, error: err.message });
        } finally {
            setTestingManager(false);
        }
    };

    const runAutoCalibration = async () => {
        setCalibrating(true);
        setCalibrationResult(null);

        try {
            const res = await fetchApi('/engine/calibrate', {
                method: 'POST',
                body: JSON.stringify({}),
            });
            setCalibrationResult(res);
        } catch (err: any) {
            setCalibrationResult({ success: false, error: err.message });
        } finally {
            setCalibrating(false);
        }
    };

    const handleProviderPreset = (provider: string) => {
        const presets: Record<string, { model: string; baseUrl: string }> = {
            google: {
                model: 'gemini-2.5-flash',
                baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
            },
            groq: {
                model: 'llama-3.3-70b-versatile',
                baseUrl: 'https://api.groq.com/openai/v1',
            },
            openai: {
                model: 'gpt-4o-mini',
                baseUrl: 'https://api.openai.com/v1',
            },
            anthropic: {
                model: 'claude-3-5-haiku-20241022',
                baseUrl: 'https://api.anthropic.com/v1',
            },
            deepseek: {
                model: 'deepseek-chat',
                baseUrl: 'https://api.deepseek.com/v1',
            },
            openrouter: {
                model: 'google/gemini-2.0-flash-exp:free',
                baseUrl: 'https://openrouter.ai/api/v1',
            },
            custom: {
                model: config.managerModel || '',
                baseUrl: config.managerBaseUrl || '',
            },
        };

        const preset = presets[provider] || presets.google;
        setConfig(prev => ({
            ...prev,
            managerProvider: provider as any,
            managerModel: preset.model,
            managerBaseUrl: preset.baseUrl,
        }));
    };

    if (loading) {
        return (
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: 300, gap: '0.75rem' }}>
                <span className="spinner-ring" style={{ width: 24, height: 24, borderWidth: 3 }} />
                <span>{t('engine.loading')}</span>
            </div>
        );
    }

    return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '1.75rem' }}>
            {/* Header */}
            <div className="flex items-center justify-between" style={{ flexWrap: 'wrap', gap: '1rem' }}>
                <div>
                    <h1 style={{ margin: 0, fontSize: '1.75rem', fontWeight: 800, display: 'flex', alignItems: 'center', gap: '0.6rem' }}>
                        <DualEngineGlyph size={24} color="var(--accent-primary)" />
                        {t('engine.title')}
                    </h1>
                    <p style={{ margin: '0.3rem 0 0', color: 'var(--text-muted)', fontSize: '0.88rem' }}>
                        {t('engine.subtitle')}
                    </p>
                </div>

                <div className="flex items-center gap-3">
                    <button
                        onClick={() => handleSave()}
                        disabled={saving}
                        className="btn btn-primary"
                        style={{ padding: '0.6rem 1.4rem', fontWeight: 700, gap: '0.5rem' }}
                    >
                        {saving ? <RefreshCw size={15} className="spin" /> : <Save size={15} />}
                        <span>{t('engine.save_config')}</span>
                    </button>
                </div>
            </div>

            {/* Notifications */}
            {saveSuccess && (
                <div className="alert alert-success" style={{ display: 'flex', alignItems: 'center', gap: '0.6rem' }}>
                    <Check size={16} />
                    <span>{saveSuccess}</span>
                </div>
            )}
            {saveError && (
                <div className="alert alert-error" style={{ display: 'flex', alignItems: 'center', gap: '0.6rem' }}>
                    <AlertCircle size={16} />
                    <span>{saveError}</span>
                </div>
            )}

            {/* Dual Engine Cards Grid */}
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(440px, 1fr))', gap: '1.5rem' }}>
                {/* System 1: TypeSafe AI / Jev */}
                <div className="glass-panel" style={{ padding: '1.5rem', display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
                    <div className="flex items-center justify-between" style={{ borderBottom: '1px solid var(--border-subtle)', paddingBottom: '0.75rem' }}>
                        <div className="flex items-center gap-2">
                            <div style={{
                                width: 34, height: 34, borderRadius: 10, background: 'var(--surface-2)',
                                border: '1px solid var(--border-subtle)',
                                display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-secondary)'
                            }}>
                                <PromptAnchorGlyph size={18} color="var(--text-secondary)" />
                            </div>
                            <div>
                                <h3 style={{ margin: 0, fontSize: '1rem', fontWeight: 700 }}>{t('engine.system1_title')}</h3>
                                <span style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }}>{t('engine.system1_badge')}</span>
                            </div>
                        </div>

                        <label style={{
                            display: 'inline-flex',
                            alignItems: 'center',
                            gap: '0.5rem',
                            cursor: 'pointer',
                            fontSize: '0.8rem',
                            fontWeight: 600,
                            padding: '0.25rem 0.65rem',
                            borderRadius: '8px',
                            background: config.enableJevRouting ? 'var(--surface-3)' : 'var(--surface-2)',
                            border: '1px solid var(--border-subtle)',
                            transition: 'all 0.2s ease'
                        }}>
                            <input
                                type="checkbox"
                                checked={config.enableJevRouting}
                                onChange={e => setConfig({ ...config, enableJevRouting: e.target.checked })}
                                style={{ accentColor: 'var(--accent-primary)', cursor: 'pointer' }}
                            />
                            <span style={{ color: config.enableJevRouting ? 'var(--text-primary)' : 'var(--text-secondary)' }}>
                                {t('engine.enable_toggle')}
                            </span>
                        </label>
                    </div>

                    <p style={{ margin: 0, fontSize: '0.82rem', color: 'var(--text-muted)', lineHeight: 1.5 }}>
                        {t('engine.system1_desc')}
                    </p>

                    <div className="form-group" style={{ margin: 0 }}>
                        <label style={{ fontSize: '0.78rem' }}>{t('engine.endpoint')}</label>
                        <input
                            type="text"
                            value={config.typesafeEndpoint || ''}
                            onChange={e => setConfig({ ...config, typesafeEndpoint: e.target.value })}
                            placeholder="https://openrouter.ai/api/alpha/decisions"
                            style={{ width: '100%', fontFamily: 'var(--font-mono)', fontSize: '0.82rem' }}
                        />
                    </div>

                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem' }}>
                        <div className="form-group" style={{ margin: 0 }}>
                            <label style={{ fontSize: '0.78rem' }}>{t('engine.model')}</label>
                            <input
                                type="text"
                                value={config.typesafeModel || ''}
                                onChange={e => setConfig({ ...config, typesafeModel: e.target.value })}
                                placeholder="~typesafe/jev-latest"
                                style={{ width: '100%', fontFamily: 'var(--font-mono)', fontSize: '0.82rem' }}
                            />
                        </div>

                        <div className="form-group" style={{ margin: 0 }}>
                            <label style={{ fontSize: '0.78rem' }}>{t('engine.api_key')}</label>
                            <input
                                type="password"
                                value={typesafeKeyInput}
                                onChange={e => setTypesafeKeyInput(e.target.value)}
                                placeholder={config.typesafeApiKey ? "••••••••••••••••" : "sk-or-v1-..."}
                                style={{ width: '100%', fontFamily: 'var(--font-mono)', fontSize: '0.82rem' }}
                            />
                        </div>
                    </div>

                    <div className="flex items-center gap-2" style={{ marginTop: '0.5rem' }}>
                        <button
                            type="button"
                            onClick={testJevConnection}
                            disabled={testingJev}
                            className="btn btn-secondary"
                            style={{ flex: 1, justifyContent: 'center', gap: '0.4rem', fontSize: '0.82rem' }}
                        >
                            {testingJev ? <RefreshCw size={14} className="spin" /> : <Play size={14} />}
                            <span>{t('engine.test_jev')}</span>
                        </button>

                        <a
                            href="https://openrouter.ai/~typesafe/jev-latest"
                            target="_blank"
                            rel="noreferrer"
                            className="btn btn-secondary"
                            style={{ padding: '0.5rem 0.75rem', gap: '0.3rem', fontSize: '0.82rem', textDecoration: 'none' }}
                        >
                            <ExternalLink size={14} />
                            <span>Docs</span>
                        </a>
                    </div>

                    {jevTestResult && (
                        <div style={{
                            padding: '0.75rem', borderRadius: 6, fontSize: '0.78rem',
                            background: jevTestResult.ok ? 'rgba(34,197,94,0.1)' : 'rgba(239,68,68,0.1)',
                            border: `1px solid ${jevTestResult.ok ? 'rgba(34,197,94,0.3)' : 'rgba(239,68,68,0.3)'}`,
                        }}>
                            <div style={{ fontWeight: 700, color: jevTestResult.ok ? '#22c55e' : '#ef4444' }}>
                                {jevTestResult.ok ? `Connected (${jevTestResult.latencyMs}ms)` : 'Connection Error'}
                            </div>
                            <div style={{ marginTop: '0.3rem', color: 'var(--text-muted)' }}>
                                {jevTestResult.ok ? `Route: ${jevTestResult.classification?.action || 'FORWARD'} · Score: ${jevTestResult.classification?.confidence || '1.0'}` : jevTestResult.error}
                            </div>
                        </div>
                    )}
                </div>

                {/* System 2: Management LLM */}
                <div className="glass-panel" style={{ padding: '1.5rem', display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
                    <div className="flex items-center justify-between" style={{ borderBottom: '1px solid var(--border-subtle)', paddingBottom: '0.75rem' }}>
                        <div className="flex items-center gap-2">
                            <div style={{
                                width: 34, height: 34, borderRadius: 10, background: 'var(--surface-2)',
                                border: '1px solid var(--border-subtle)',
                                display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-secondary)'
                            }}>
                                <ProviderIcon provider={config.managerProvider} size={18} />
                            </div>
                            <div>
                                <h3 style={{ margin: 0, fontSize: '1rem', fontWeight: 700 }}>{t('engine.system2_title')}</h3>
                                <span style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }}>Background Orchestration & Diagnostics</span>
                            </div>
                        </div>

                        <span style={{
                            fontSize: '0.72rem',
                            padding: '0.2rem 0.55rem',
                            borderRadius: '6px',
                            background: 'var(--surface-2)',
                            border: '1px solid var(--border-subtle)',
                            color: 'var(--text-muted)',
                            fontWeight: 600
                        }}>
                            Self-Healing
                        </span>
                    </div>

                    <p style={{ margin: 0, fontSize: '0.82rem', color: 'var(--text-muted)', lineHeight: 1.5 }}>
                        {t('engine.system2_desc')} Evaluates free-tier limits, audits logs, and advises on optimal token limits.
                    </p>

                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem' }}>
                        {/* Source / Provider Selector */}
                        <div className="form-group" style={{ margin: 0 }}>
                            <label style={{ fontSize: '0.78rem', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                                <span>{t('engine.source_label')}</span>
                                {config.managerUpstreamKeyId && (
                                    <span style={{ fontSize: '0.68rem', color: 'var(--text-muted)', fontWeight: 600 }}>
                                        ✓ {t('engine.key_linked_project')}
                                    </span>
                                )}
                            </label>
                            <select
                                value={selectedSource}
                                onChange={e => handleSourceChange(e.target.value)}
                                style={{ width: '100%', padding: '0.5rem 0.75rem', fontSize: '0.85rem' }}
                            >
                                <optgroup label={`📂 ${t('engine.source_projects_pool') || 'Proyectos (Pool con Rotación Automática)'}`}>
                                    {projects.map((proj: any) => {
                                        const projKeys = upstreamKeys.filter((k: any) => k.project_id === proj.id);
                                        if (projKeys.length === 0) {
                                            return (
                                                <option key={`proj:${proj.id}`} value={`project:${proj.id}`}>
                                                    📂 {proj.name} (Sin canales activos)
                                                </option>
                                            );
                                        }
                                        const prov = projKeys[0]?.provider?.toUpperCase() || 'CANAL';
                                        return (
                                            <option key={`proj:${proj.id}`} value={`project:${proj.id}`}>
                                                📂 {proj.name} · {prov} ({projKeys.length} {projKeys.length === 1 ? 'llave' : 'llaves con rotación'})
                                            </option>
                                        );
                                    })}
                                </optgroup>
                                <optgroup label={`🔑 ${t('engine.source_individual_keys') || 'Llaves Individuales (Fijas sin rotación)'}`}>
                                    {projects.map((proj: any) => {
                                        const projKeys = upstreamKeys.filter((k: any) => k.project_id === proj.id);
                                        return projKeys.map((k: any, idx: number) => (
                                            <option key={`key:${k.id}`} value={`key:${k.id}`}>
                                                ↳ {proj.name} · {k.provider.toUpperCase()} #{idx + 1} ({k.key_preview || 'Llave'})
                                            </option>
                                        ));
                                    })}
                                </optgroup>
                                <optgroup label={`⚙️ ${t('engine.source_manual_optgroup')}`}>
                                    <option value="manual:google">Google Gemini Directo</option>
                                    <option value="manual:groq">Groq Directo</option>
                                    <option value="manual:openai">OpenAI Directo</option>
                                    <option value="manual:deepseek">DeepSeek Directo</option>
                                    <option value="manual:openrouter">OpenRouter Directo</option>
                                    <option value="manual:custom">Custom Provider URL</option>
                                </optgroup>
                            </select>
                        </div>

                        {/* Model Name / Dynamic API Model Selector */}
                        <div className="form-group" style={{ margin: 0 }}>
                            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.35rem' }}>
                                <label style={{ fontSize: '0.78rem', margin: 0 }}>
                                    {t('engine.manager_model')} {apiModels.length > 0 && (
                                        <span style={{ color: 'var(--accent-primary)', fontWeight: 600 }}>
                                            ({apiModels.length} {t('engine.models_available')})
                                        </span>
                                    )}
                                </label>
                                {apiModels.length > 0 && (
                                    <button
                                        type="button"
                                        onClick={() => setIsCustomModel(!isCustomModel)}
                                        style={{
                                            background: 'none', border: 'none', color: 'var(--accent-primary)',
                                            fontSize: '0.72rem', cursor: 'pointer', padding: 0, textDecoration: 'underline'
                                        }}
                                    >
                                        {isCustomModel ? t('engine.select_model_toggle') : t('engine.manual_model_toggle')}
                                    </button>
                                )}
                            </div>

                            {loadingModels ? (
                                <div style={{
                                    display: 'flex', alignItems: 'center', gap: '0.5rem', padding: '0.5rem 0.75rem',
                                    background: 'var(--surface-1)', border: '1px solid var(--border-subtle)', borderRadius: 6,
                                    fontSize: '0.82rem', color: 'var(--text-muted)'
                                }}>
                                    <RefreshCw size={14} className="spin" style={{ color: 'var(--accent-primary)' }} />
                                    <span>{t('engine.loading_models')}</span>
                                </div>
                            ) : apiModels.length > 0 && !isCustomModel ? (
                                <select
                                    value={config.managerModel || ''}
                                    onChange={e => setConfig(c => ({ ...c, managerModel: e.target.value }))}
                                    style={{ width: '100%', padding: '0.5rem 0.75rem', fontSize: '0.85rem', fontFamily: 'var(--font-mono)' }}
                                >
                                    {apiModels.map((m: string) => (
                                        <option key={m} value={m}>
                                            {m}
                                        </option>
                                    ))}
                                </select>
                            ) : (
                                <input
                                    type="text"
                                    value={config.managerModel || ''}
                                    onChange={e => setConfig(c => ({ ...c, managerModel: e.target.value }))}
                                    onKeyDown={e => { if (e.key === 'Enter') handleSave(); }}
                                    placeholder="ej. gemini-2.5-flash o llama-3.3-70b-versatile"
                                    style={{ width: '100%', padding: '0.5rem 0.75rem', fontSize: '0.85rem' }}
                                />
                            )}
                        </div>
                    </div>

                    <div className="form-group" style={{ margin: 0 }}>
                        <label style={{ fontSize: '0.78rem', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                            <span>{t('engine.manager_key')}</span>
                            {config.managerUpstreamKeyId && (
                                <span style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }}>
                                    🔒 {t('engine.key_linked_project')}
                                </span>
                            )}
                        </label>
                        <input
                            type="password"
                            value={config.managerUpstreamKeyId ? (managerKeyInput || '••••••••••••••••') : managerKeyInput}
                            onChange={e => setManagerKeyInput(e.target.value)}
                            placeholder={config.managerUpstreamKeyId ? "🔒 Llave vinculada y protegida en el servidor" : "AIzaSy•••••••• or gsk_••••••••"}
                            disabled={!!config.managerUpstreamKeyId}
                            style={{
                                width: '100%',
                                padding: '0.5rem 0.75rem',
                                fontSize: '0.85rem',
                                opacity: config.managerUpstreamKeyId ? 0.75 : 1,
                                cursor: config.managerUpstreamKeyId ? 'not-allowed' : 'text'
                            }}
                        />
                    </div>

                    <div className="form-group" style={{ margin: 0 }}>
                        <label style={{ fontSize: '0.78rem' }}>{t('engine.manager_base_url')}</label>
                        <input
                            type="text"
                            value={config.managerBaseUrl || ''}
                            onChange={e => setConfig(c => ({ ...c, managerBaseUrl: e.target.value }))}
                            placeholder="https://generativelanguage.googleapis.com/v1beta/openai"
                            style={{ width: '100%', padding: '0.5rem 0.75rem', fontSize: '0.85rem', fontFamily: 'var(--font-mono)' }}
                        />
                    </div>

                    {/* Test & Auto-Calibrate actions */}
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.75rem', marginTop: '0.5rem' }}>
                        <button
                            type="button"
                            onClick={testManagerConnection}
                            disabled={testingManager}
                            className="btn btn-secondary"
                            style={{ justifyContent: 'center', gap: '0.4rem', fontSize: '0.82rem' }}
                        >
                            {testingManager ? <RefreshCw size={14} className="spin" /> : <Play size={14} />}
                            <span>{t('engine.test_manager')}</span>
                        </button>

                        <button
                            type="button"
                            onClick={runAutoCalibration}
                            disabled={calibrating}
                            className="btn btn-secondary"
                            style={{
                                justifyContent: 'center', gap: '0.4rem', fontSize: '0.82rem'
                            }}
                        >
                            {calibrating ? <RefreshCw size={14} className="spin" /> : <RateGuardianGlyph size={14} color="var(--text-secondary)" />}
                            <span>Auto-Calibrate Quotas</span>
                        </button>
                    </div>

                    {managerTestResult && (
                        <div style={{
                            padding: '0.75rem', borderRadius: 6, fontSize: '0.78rem',
                            background: managerTestResult.ok ? 'rgba(34,197,94,0.1)' : 'rgba(239,68,68,0.1)',
                            border: `1px solid ${managerTestResult.ok ? 'rgba(34,197,94,0.3)' : 'rgba(239,68,68,0.3)'}`,
                        }}>
                            <div style={{ fontWeight: 700, color: managerTestResult.ok ? '#22c55e' : '#ef4444' }}>
                                {managerTestResult.ok ? `Connected (${managerTestResult.latencyMs}ms)` : 'Connection Error'}
                            </div>
                            <div style={{ marginTop: '0.3rem', color: 'var(--text-muted)' }}>
                                {managerTestResult.ok ? managerTestResult.reply : managerTestResult.error}
                            </div>
                        </div>
                    )}
                </div>
            </div>

            {/* System 3: Virtual Consensus Fusion Configuration (3 Fixed LLMs + Judge) */}
            <div className="glass-panel" style={{ padding: '1.5rem', display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
                <div className="flex items-center justify-between" style={{ borderBottom: '1px solid var(--border-subtle)', paddingBottom: '0.75rem', flexWrap: 'wrap', gap: '0.5rem' }}>
                    <div className="flex items-center gap-2">
                        <div style={{
                            width: 34, height: 34, borderRadius: 10, background: 'var(--surface-2)',
                            border: '1px solid var(--border-subtle)',
                            display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-secondary)'
                        }}>
                            <RouterCascadeGlyph size={18} color="var(--text-secondary)" />
                        </div>
                        <div>
                            <h3 style={{ margin: 0, fontSize: '1rem', fontWeight: 700 }}>{t('engine.fusion_title') || 'Virtual Consensus Fusion · Panel Fijo de 3 Modelos & Juez'}</h3>
                            <span style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }}>{t('engine.fusion_subtitle') || 'Configuración fija predeterminada para model: "fusion"'}</span>
                        </div>
                    </div>

                    <div style={{ display: 'flex', gap: '0.45rem', flexWrap: 'wrap', alignItems: 'center' }}>
                        <button
                            type="button"
                            onClick={() => handleSave()}
                            disabled={saving}
                            className="btn btn-primary btn-sm"
                            style={{
                                fontSize: '0.75rem',
                                padding: '0.35rem 0.85rem',
                                fontWeight: 700,
                                gap: '0.4rem'
                            }}
                            title="Guardar cambios de la terna Fusion y Motores"
                        >
                            {saving ? <RefreshCw size={13} className="spin" /> : <Save size={13} />}
                            <span>{t('engine.save_config')}</span>
                        </button>
                    </div>
                </div>

                {/* Preset Apply Feedback Notification */}
                {presetFeedback && (
                    <div style={{
                        padding: '0.65rem 0.9rem',
                        borderRadius: 8,
                        background: presetFeedback.type === 'success' ? 'rgba(34,197,94,0.12)' : 'rgba(239,68,68,0.12)',
                        border: `1px solid ${presetFeedback.type === 'success' ? 'rgba(34,197,94,0.3)' : 'rgba(239,68,68,0.3)'}`,
                        color: presetFeedback.type === 'success' ? '#22c55e' : '#ef4444',
                        fontSize: '0.8rem',
                        display: 'flex',
                        flexDirection: 'column',
                        gap: '0.35rem'
                    }}>
                        <div className="flex items-center justify-between" style={{ flexWrap: 'wrap', gap: '0.4rem' }}>
                            <div className="flex items-center gap-2" style={{ fontWeight: 700 }}>
                                {presetFeedback.type === 'success' ? <ShieldCheck size={16} /> : <AlertCircle size={16} />}
                                <span>{presetFeedback.message}</span>
                            </div>
                            {presetFeedback.details?.testedOk && (
                                <span style={{
                                    fontSize: '0.68rem',
                                    background: 'rgba(34,197,94,0.2)',
                                    padding: '0.15rem 0.5rem',
                                    borderRadius: 12,
                                    border: '1px solid rgba(34,197,94,0.4)',
                                    color: '#4ade80',
                                    fontWeight: 700
                                }}>
                                    ✓ {t('engine.fusion_verified_badge') || '1-Token Probe Verified'}
                                </span>
                            )}
                        </div>
                        {presetFeedback.details && (
                            <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)', lineHeight: 1.4 }}>
                                Draft A: <b style={{ color: 'var(--text-primary)' }}>{presetFeedback.details.models?.[0]}</b> |
                                {' '}Draft B: <b style={{ color: 'var(--text-primary)' }}>{presetFeedback.details.models?.[1]}</b> |
                                {' '}Draft C: <b style={{ color: 'var(--text-primary)' }}>{presetFeedback.details.models?.[2]}</b> |
                                {' '}Juez: <b style={{ color: 'var(--text-primary)' }}>{presetFeedback.details.judge}</b>
                            </div>
                        )}
                    </div>
                )}

                {/* Frontier Model Intelligence Advisor Card */}
                <div style={{
                    background: 'var(--surface-1)',
                    border: '1px solid var(--border-subtle)',
                    borderRadius: 12,
                    padding: '1.25rem',
                    display: 'flex',
                    flexDirection: 'column',
                    gap: '1rem'
                }}>
                    {/* Advisor Header & Live Sources */}
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '0.5rem' }}>
                        <div className="flex items-center gap-2">
                            <Sparkles size={16} color="var(--accent-primary)" />
                            <span style={{ fontWeight: 700, fontSize: '0.9rem', color: 'var(--text-primary)' }}>
                                {t('engine.fusion_advisor_title') || 'Asesor Inteligente de Modelos Frontera (Benchmarks Vivos 2026)'}
                            </span>
                            <div style={{ display: 'flex', gap: '0.35rem', flexWrap: 'wrap' }}>
                                <span style={{ fontSize: '0.66rem', background: 'var(--surface-2)', border: '1px solid var(--border-subtle)', color: 'var(--text-muted)', padding: '0.12rem 0.45rem', borderRadius: 4, fontWeight: 500 }}>
                                    Artificial Analysis v4.3+
                                </span>
                                <span style={{ fontSize: '0.66rem', background: 'var(--surface-2)', border: '1px solid var(--border-subtle)', color: 'var(--text-muted)', padding: '0.12rem 0.45rem', borderRadius: 4, fontWeight: 500 }}>
                                    LMSYS Arena 2026
                                </span>
                                <span style={{ fontSize: '0.66rem', background: 'var(--surface-2)', border: '1px solid var(--border-subtle)', color: 'var(--text-muted)', padding: '0.12rem 0.45rem', borderRadius: 4, fontWeight: 500 }}>
                                    Live OpenRouter Catalog
                                </span>
                            </div>
                        </div>

                        <button
                            type="button"
                            onClick={() => loadAdvisorData(true)}
                            disabled={loadingAdvisor}
                            className="btn btn-secondary btn-sm"
                            style={{ fontSize: '0.72rem', padding: '0.25rem 0.6rem', gap: '0.35rem' }}
                            title="Consultar catálogos vivos e índices de referencia en tiempo real"
                        >
                            <RefreshCw size={12} className={loadingAdvisor ? 'spin' : ''} />
                            <span>{t('engine.fusion_advisor_refresh') || 'Actualizar Inteligencia'}</span>
                        </button>
                    </div>

                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '0.5rem', fontSize: '0.73rem', color: 'var(--text-muted)' }}>
                        <p style={{ margin: 0, lineHeight: 1.4, flex: 1, minWidth: 260 }}>
                            {t('engine.fusion_advisor_desc') || 'Motor anti-sesgo y rastreo en vivo de benchmarks para seleccionar automáticamente la terna y el juez óptimos.'}
                        </p>
                        {advisorData?.userEcosystem && (
                            <span style={{ background: 'var(--surface-2)', padding: '0.2rem 0.55rem', borderRadius: 6, border: '1px solid var(--border-subtle)', whiteSpace: 'nowrap' }}>
                                🔑 <b>{advisorData.userEcosystem.totalKeys}</b> llaves analizadas · <b>{advisorData.userEcosystem.activeModelsCount || 100}+</b> modelos en catálogo
                            </span>
                        )}
                    </div>

                    {/* Tier Switcher + Mode Selection Bar */}
                    <div style={{
                        display: 'flex',
                        justifyContent: 'space-between',
                        alignItems: 'center',
                        flexWrap: 'wrap',
                        gap: '0.75rem',
                        background: 'var(--surface-card)',
                        padding: '0.5rem 0.75rem',
                        borderRadius: 8,
                        border: '1px solid var(--border-subtle)'
                    }}>
                        {/* Tier Selector (Segmented Control) */}
                        <div style={{ display: 'inline-flex', background: 'var(--surface-2)', padding: '3px', borderRadius: 8, border: '1px solid var(--border-subtle)', flexWrap: 'wrap', gap: '2px' }}>
                            <button
                                type="button"
                                onClick={() => setFusionTier('free')}
                                style={{
                                    padding: '0.35rem 0.75rem',
                                    borderRadius: 6,
                                    fontSize: '0.74rem',
                                    fontWeight: 600,
                                    cursor: 'pointer',
                                    border: fusionTier === 'free' ? '1px solid var(--border-default)' : '1px solid transparent',
                                    background: fusionTier === 'free' ? 'var(--surface-1)' : 'transparent',
                                    color: fusionTier === 'free' ? 'var(--text-primary)' : 'var(--text-muted)',
                                    boxShadow: fusionTier === 'free' ? '0 1px 2px rgba(0,0,0,0.2)' : 'none',
                                    transition: 'all 0.15s ease',
                                    display: 'flex',
                                    alignItems: 'center',
                                    gap: '0.35rem'
                                }}
                            >
                                <ShieldCheck size={13} />
                                <span>{t('engine.fusion_tier_free') || 'Capa Gratuita Segura'}</span>
                            </button>
                            <button
                                type="button"
                                onClick={() => setFusionTier('free_training')}
                                style={{
                                    padding: '0.35rem 0.75rem',
                                    borderRadius: 6,
                                    fontSize: '0.74rem',
                                    fontWeight: 600,
                                    cursor: 'pointer',
                                    border: fusionTier === 'free_training' ? '1px solid var(--border-default)' : '1px solid transparent',
                                    background: fusionTier === 'free_training' ? 'var(--surface-1)' : 'transparent',
                                    color: fusionTier === 'free_training' ? 'var(--text-primary)' : 'var(--text-muted)',
                                    boxShadow: fusionTier === 'free_training' ? '0 1px 2px rgba(0,0,0,0.2)' : 'none',
                                    transition: 'all 0.15s ease',
                                    display: 'flex',
                                    alignItems: 'center',
                                    gap: '0.35rem'
                                }}
                            >
                                <Flame size={13} />
                                <span>{t('engine.fusion_tier_free_training') || 'Permite Entreno (550B+)'}</span>
                            </button>
                            <button
                                type="button"
                                onClick={() => setFusionTier('paid')}
                                style={{
                                    padding: '0.35rem 0.75rem',
                                    borderRadius: 6,
                                    fontSize: '0.74rem',
                                    fontWeight: 600,
                                    cursor: 'pointer',
                                    border: fusionTier === 'paid' ? '1px solid var(--border-default)' : '1px solid transparent',
                                    background: fusionTier === 'paid' ? 'var(--surface-1)' : 'transparent',
                                    color: fusionTier === 'paid' ? 'var(--text-primary)' : 'var(--text-muted)',
                                    boxShadow: fusionTier === 'paid' ? '0 1px 2px rgba(0,0,0,0.2)' : 'none',
                                    transition: 'all 0.15s ease',
                                    display: 'flex',
                                    alignItems: 'center',
                                    gap: '0.35rem'
                                }}
                            >
                                <Award size={13} />
                                <span>{t('engine.fusion_tier_paid') || 'Capa Premium (Paid)'}</span>
                            </button>
                        </div>

                        {/* Mode Selector Buttons */}
                        <div style={{ display: 'inline-flex', background: 'var(--surface-2)', padding: '3px', borderRadius: 8, border: '1px solid var(--border-subtle)', flexWrap: 'wrap', gap: '2px' }}>
                            {[
                                { id: 'reasoning', label: t('engine.fusion_mode_reasoning') || '🧠 Reasoning Trio', title: 'Terna de alto razonamiento lógico, matemáticas y código' },
                                { id: 'speed', label: t('engine.fusion_mode_speed') || '⚡ Speed & Free', title: 'Terna de ultra-alta velocidad y respuesta instantánea' },
                                { id: 'frontier', label: t('engine.fusion_mode_frontier') || '🌐 Frontier Mix', title: 'Terna balanceada con los modelos insignia de mayor capacidad general' },
                            ].map(m => {
                                const isActive = fusionMode === m.id;
                                return (
                                    <button
                                        key={m.id}
                                        type="button"
                                        onClick={() => setFusionMode(m.id as any)}
                                        style={{
                                            fontSize: '0.74rem',
                                            padding: '0.35rem 0.75rem',
                                            borderRadius: 6,
                                            fontWeight: 600,
                                            cursor: 'pointer',
                                            border: isActive ? '1px solid var(--border-default)' : '1px solid transparent',
                                            background: isActive ? 'var(--surface-1)' : 'transparent',
                                            color: isActive ? 'var(--text-primary)' : 'var(--text-muted)',
                                            boxShadow: isActive ? '0 1px 2px rgba(0,0,0,0.2)' : 'none',
                                            transition: 'all 0.15s ease'
                                        }}
                                        title={m.title}
                                    >
                                        {m.label}
                                    </button>
                                );
                            })}
                        </div>
                    </div>

                    {/* Opt-In Training Guidance Notice */}
                    {fusionTier === 'free_training' && (
                        <div style={{
                            background: 'var(--surface-2)',
                            border: '1px solid var(--border-subtle)',
                            borderRadius: 8,
                            padding: '0.55rem 0.85rem',
                            fontSize: '0.73rem',
                            color: 'var(--text-secondary)',
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'space-between',
                            flexWrap: 'wrap',
                            gap: '0.5rem'
                        }}>
                            <div className="flex items-center gap-2" style={{ flex: 1, minWidth: 260 }}>
                                <Flame size={15} color="var(--accent-primary)" />
                                <span>{t('engine.fusion_training_warning')}</span>
                            </div>
                            <a
                                href="https://openrouter.ai/settings/privacy"
                                target="_blank"
                                rel="noopener noreferrer"
                                style={{ color: 'var(--text-primary)', textDecoration: 'underline', fontWeight: 600, display: 'flex', alignItems: 'center', gap: '0.3rem' }}
                            >
                                <span>Configuración de Privacidad OpenRouter</span>
                                <ExternalLink size={12} />
                            </a>
                        </div>
                    )}

                    {/* Presets & Auto-Apply Bar */}
                    {(() => {
                        const tierKey = fusionTier === 'free' ? 'free_tier' : (fusionTier === 'free_training' ? 'free_training_tier' : 'paid_tier');
                        const currentPresets = advisorData?.[tierKey]?.[fusionMode];

                        return (
                            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
                                {/* Auto-Best One-Click CTA */}
                                <div style={{
                                    display: 'flex',
                                    justifyContent: 'space-between',
                                    alignItems: 'center',
                                    flexWrap: 'wrap',
                                    gap: '0.6rem',
                                    background: 'var(--surface-2)',
                                    padding: '0.65rem 0.85rem',
                                    borderRadius: 8,
                                    border: '1px solid var(--border-subtle)'
                                }}>
                                    <div style={{ flex: 1, minWidth: 260 }}>
                                        <div style={{ fontSize: '0.8rem', fontWeight: 700, display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
                                            <span>{fusionMode === 'reasoning' ? '🧠 Reasoning Trio' : fusionMode === 'speed' ? '⚡ Speed & Free' : '🌐 Frontier Mix'}</span>
                                            <span style={{
                                                fontSize: '0.68rem',
                                                padding: '0.1rem 0.45rem',
                                                borderRadius: 6,
                                                fontWeight: 600,
                                                background: 'var(--surface-1)',
                                                border: '1px solid var(--border-subtle)',
                                                color: 'var(--text-secondary)'
                                            }}>
                                                {fusionTier === 'free'
                                                    ? '⚡ Free Tier (Strict Privacy)'
                                                    : (fusionTier === 'free_training' ? '🚀 Free Tier (Opt-In Training 550B+)' : '💎 Premium Tier (Paid)')}
                                            </span>
                                        </div>
                                        <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)', marginTop: '0.15rem' }}>
                                            {currentPresets?.v1_gold?.rationale || 'Sonda automática de 1 token para verificar salud y cuota antes de enlazar proyectos.'}
                                        </div>
                                    </div>

                                    <button
                                        type="button"
                                        onClick={() => handleApplySmartPreset(fusionMode, undefined)}
                                        disabled={applyingPreset}
                                        className="btn btn-primary btn-sm"
                                        style={{
                                            fontSize: '0.76rem',
                                            padding: '0.45rem 1rem',
                                            fontWeight: 700,
                                            gap: '0.45rem'
                                        }}
                                        title="Prueba V1 con sonda de 1 token; si está agotado o en cooldown, auto-aplica V2 o V3 sin error"
                                    >
                                        {applyingPreset ? <RefreshCw size={13} className="spin" /> : <Sparkles size={13} />}
                                        <span>{applyingPreset ? (t('engine.fusion_advisor_applying') || 'Sondeando y aplicando...') : (t('engine.fusion_auto_best') || 'Auto-Seleccionar Mejor')}</span>
                                    </button>
                                </div>

                                {/* 3 Ranked Fallback Version Cards */}
                                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: '0.75rem' }}>
                                    {[
                                        { id: 'v1_gold', label: t('engine.fusion_v1_gold') || 'V1 Principal', preset: currentPresets?.v1_gold },
                                        { id: 'v2_silver', label: t('engine.fusion_v2_silver') || 'V2 Alternativa', preset: currentPresets?.v2_silver },
                                        { id: 'v3_bronze', label: t('engine.fusion_v3_bronze') || 'V3 Respaldo', preset: currentPresets?.v3_bronze },
                                    ].map(v => {
                                        const p = v.preset;
                                        if (!p) {
                                            return (
                                                <div
                                                    key={v.id}
                                                    style={{
                                                        background: 'var(--surface-2)',
                                                        border: '1px solid var(--border-subtle)',
                                                        borderRadius: 8,
                                                        padding: '0.75rem',
                                                        display: 'flex',
                                                        alignItems: 'center',
                                                        justifyContent: 'center',
                                                        color: 'var(--text-muted)',
                                                        fontSize: '0.75rem'
                                                    }}
                                                >
                                                    {loadingAdvisor ? <RefreshCw size={14} className="spin" /> : `${v.label} (Cargando datos...)`}
                                                </div>
                                            );
                                        }

                                        return (
                                            <div
                                                key={v.id}
                                                style={{
                                                    background: 'var(--surface-2)',
                                                    border: '1px solid var(--border-subtle)',
                                                    borderRadius: 8,
                                                    padding: '0.75rem',
                                                    display: 'flex',
                                                    flexDirection: 'column',
                                                    justifyContent: 'space-between',
                                                    gap: '0.55rem'
                                                }}
                                            >
                                                <div style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem' }}>
                                                    <div className="flex items-center justify-between">
                                                        <span style={{ fontSize: '0.78rem', fontWeight: 700, color: 'var(--text-primary)' }}>
                                                            {v.label}
                                                        </span>
                                                        {p.key_metrics?.artificialAnalysisScore && (
                                                            <span style={{ fontSize: '0.67rem', background: 'var(--surface-1)', border: '1px solid var(--border-subtle)', padding: '0.1rem 0.4rem', borderRadius: 4, color: 'var(--text-muted)' }}>
                                                                AA: <b>{p.key_metrics.artificialAnalysisScore}</b>
                                                            </span>
                                                        )}
                                                    </div>

                                                    <div style={{ fontSize: '0.72rem', display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>
                                                        <div style={{ display: 'flex', gap: '0.4rem', alignItems: 'center' }}>
                                                            <span style={{ color: 'var(--text-muted)', fontWeight: 600, minWidth: 16 }}>A:</span>
                                                            <span style={{ fontFamily: 'var(--font-mono)', color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.draft_a}</span>
                                                        </div>
                                                        <div style={{ display: 'flex', gap: '0.4rem', alignItems: 'center' }}>
                                                            <span style={{ color: 'var(--text-muted)', fontWeight: 600, minWidth: 16 }}>B:</span>
                                                            <span style={{ fontFamily: 'var(--font-mono)', color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.draft_b}</span>
                                                        </div>
                                                        <div style={{ display: 'flex', gap: '0.4rem', alignItems: 'center' }}>
                                                            <span style={{ color: 'var(--text-muted)', fontWeight: 600, minWidth: 16 }}>C:</span>
                                                            <span style={{ fontFamily: 'var(--font-mono)', color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.draft_c}</span>
                                                        </div>
                                                        <div style={{ display: 'flex', gap: '0.4rem', alignItems: 'center', borderTop: '1px dashed var(--border-subtle)', paddingTop: '0.3rem', marginTop: '0.1rem' }}>
                                                            <span style={{ color: 'var(--text-muted)', fontWeight: 600, minWidth: 16 }}>Juez:</span>
                                                            <span style={{ fontFamily: 'var(--font-mono)', color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.judge}</span>
                                                        </div>
                                                    </div>

                                                    <p style={{ margin: 0, fontSize: '0.67rem', color: 'var(--text-muted)', lineHeight: 1.35 }}>
                                                        {p.fallback_trigger || p.rationale}
                                                    </p>
                                                </div>

                                                <button
                                                    type="button"
                                                    onClick={() => handleApplySmartPreset(fusionMode, v.id as any)}
                                                    disabled={applyingPreset}
                                                    className="btn btn-secondary btn-sm"
                                                    style={{ fontSize: '0.72rem', padding: '0.28rem 0.5rem', width: '100%', justifyContent: 'center', gap: '0.3rem' }}
                                                >
                                                    {applyingPreset ? <RefreshCw size={11} className="spin" /> : <ChevronRight size={12} />}
                                                    <span>Aplicar {v.label.split(' ')[1] || v.label}</span>
                                                </button>
                                            </div>
                                        );
                                    })}
                                </div>
                            </div>
                        );
                    })()}
                </div>

                {saveSuccess && (
                    <div style={{
                        padding: '0.45rem 0.75rem',
                        borderRadius: 6,
                        background: 'rgba(34,197,94,0.12)',
                        border: '1px solid rgba(34,197,94,0.25)',
                        color: '#22c55e',
                        fontSize: '0.78rem',
                        display: 'flex',
                        alignItems: 'center',
                        gap: '0.4rem',
                        fontWeight: 600
                    }}>
                        <Check size={14} />
                        <span>{saveSuccess}</span>
                    </div>
                )}

                <div style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                    flexWrap: 'wrap',
                    gap: '0.75rem',
                    background: 'rgba(255,255,255,0.02)',
                    padding: '0.6rem 0.85rem',
                    borderRadius: 6,
                    border: '1px solid var(--border-subtle)'
                }}>
                    <p style={{ margin: 0, fontSize: '0.8rem', color: 'var(--text-muted)', lineHeight: 1.4, flex: 1, minWidth: 280 }}>
                        {t('engine.fusion_desc') || 'Define la terna de 3 modelos LLM que competirán en paralelo para generar borradores y el modelo árbitro (Juez) que sintetizará la respuesta definitiva.'}
                    </p>
                    <div className="flex items-center gap-2" style={{ fontSize: '0.75rem' }}>
                        <span style={{ color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>
                            ⚡ {t('engine.fusion_apply_all') || 'Cargar proyecto en toda la terna'}:
                        </span>
                        <select
                            onChange={e => {
                                if (e.target.value) {
                                    handleApplyProjectToAllSlots(e.target.value);
                                }
                            }}
                            defaultValue=""
                            style={{ padding: '0.25rem 0.5rem', fontSize: '0.75rem', maxWidth: 260 }}
                        >
                            <option value="">-- {t('engine.source_projects_pool') || 'Seleccionar Proyecto (Pool)'} --</option>
                            {projects.map((proj: any) => {
                                const projKeys = upstreamKeys.filter((k: any) => k.project_id === proj.id);
                                if (projKeys.length === 0) return null;
                                const prov = projKeys[0]?.provider?.toUpperCase() || 'CANAL';
                                return (
                                    <option key={`apply:${proj.id}`} value={`project:${proj.id}`}>
                                        📂 {proj.name} ({prov} · {projKeys.length} {projKeys.length === 1 ? 'llave' : 'llaves'})
                                    </option>
                                );
                            })}
                        </select>
                    </div>
                </div>

                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: '1.25rem' }}>
                    {[
                        {
                            slotKey: 'draft_a',
                            name: 'Draft A',
                            label: t('engine.fusion_slot_draft_a') || 'Modelo Contendiente 1 (Draft A)',
                            placeholder: 'deepseek-chat',
                            isJudge: false,
                            index: 0
                        },
                        {
                            slotKey: 'draft_b',
                            name: 'Draft B',
                            label: t('engine.fusion_slot_draft_b') || 'Modelo Contendiente 2 (Draft B)',
                            placeholder: 'qwen/qwen3.8-27b',
                            isJudge: false,
                            index: 1
                        },
                        {
                            slotKey: 'draft_c',
                            name: 'Draft C',
                            label: t('engine.fusion_slot_draft_c') || 'Modelo Contendiente 3 (Draft C)',
                            placeholder: 'moonshotai/kimi-k3',
                            isJudge: false,
                            index: 2
                        },
                        {
                            slotKey: 'judge',
                            name: 'Arbiter',
                            label: t('engine.fusion_slot_judge') || 'Modelo Juez (Synthesizer Arbiter)',
                            placeholder: 'deepseek-chat',
                            isJudge: true,
                            index: 3
                        },
                    ].map((slot) => {
                        const i = slot.index;
                        const currentModel = slot.isJudge
                            ? (config.fusionDefaultJudge || '')
                            : (config.fusionDefaultModels?.[i] || '');
                        const selectedKey = fusionSlotKeys[i] || '';
                        const isManual = fusionSlotManual[i];
                        const slotModels = selectedKey ? (modelsCache[selectedKey] || []) : [];
                        const isLoadingModels = Boolean(selectedKey && loadingKeyModels[selectedKey]);

                        return (
                            <div
                                key={i}
                                style={{
                                    background: 'var(--surface-card)',
                                    border: '1px solid var(--border-subtle)',
                                    borderRadius: 12,
                                    padding: '1.15rem',
                                    display: 'flex',
                                    flexDirection: 'column',
                                    gap: '0.85rem',
                                    position: 'relative',
                                    transition: 'all 0.2s ease'
                                }}
                            >
                                {/* Slot Header */}
                                <div className="flex items-center justify-between">
                                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                                        <span style={{
                                            fontSize: '0.68rem',
                                            fontWeight: 700,
                                            textTransform: 'uppercase',
                                            letterSpacing: '0.04em',
                                            padding: '0.2rem 0.5rem',
                                            borderRadius: 6,
                                            background: slot.isJudge ? 'var(--surface-3)' : 'var(--surface-2)',
                                            border: '1px solid var(--border-subtle)',
                                            color: slot.isJudge ? 'var(--text-primary)' : 'var(--text-secondary)'
                                        }}>
                                            {slot.name}
                                        </span>
                                        <span style={{
                                            fontSize: '0.82rem',
                                            fontWeight: 700,
                                            color: 'var(--text-primary)',
                                        }}>
                                            {slot.label.split('(')[0].trim()}
                                        </span>
                                    </div>
                                    <button
                                        type="button"
                                        onClick={() => toggleFusionSlotManual(i)}
                                        style={{
                                            background: 'none',
                                            border: 'none',
                                            color: 'var(--text-muted)',
                                            fontSize: '0.72rem',
                                            cursor: 'pointer',
                                            padding: 0,
                                            textDecoration: 'underline',
                                            fontWeight: 500
                                        }}
                                    >
                                        {isManual ? (t('engine.select_model_toggle') || 'Seleccionar de lista') : (t('engine.manual_model_toggle') || 'Escribir manual')}
                                    </button>
                                </div>

                                {/* Project / Channel selector (ALWAYS visible) */}
                                <div className="form-group" style={{ margin: 0 }}>
                                    <span style={{ fontSize: '0.7rem', color: 'var(--text-secondary)', display: 'block', marginBottom: '0.25rem', fontWeight: 600 }}>
                                        {t('engine.channel_label') || 'Proyecto / Canal'}:
                                    </span>
                                    <select
                                        value={selectedKey}
                                        onChange={e => handleFusionSlotKeyChange(i, e.target.value)}
                                        style={{ width: '100%', padding: '0.45rem 0.6rem', fontSize: '0.8rem' }}
                                    >
                                        <option value="">-- {t('engine.source_projects_pool') || 'Seleccionar Canal / Pool'} --</option>
                                        <optgroup label={`📂 ${t('engine.source_projects_pool') || 'Proyectos (Pool con Rotación Automática)'}`}>
                                            {projects.map((proj: any) => {
                                                const projKeys = upstreamKeys.filter((k: any) => k.project_id === proj.id);
                                                if (projKeys.length === 0) return null;
                                                const prov = projKeys[0]?.provider?.toUpperCase() || 'CANAL';
                                                return (
                                                    <option key={`fproj:${proj.id}`} value={`project:${proj.id}`}>
                                                        📂 {proj.name} · {prov} ({projKeys.length} {projKeys.length === 1 ? 'llave' : 'llaves con rotación'})
                                                    </option>
                                                );
                                            })}
                                        </optgroup>
                                        <optgroup label={`🔑 ${t('engine.source_individual_keys') || 'Llaves Individuales (Fijas sin rotación)'}`}>
                                            {projects.map((proj: any) => {
                                                const projKeys = upstreamKeys.filter((k: any) => k.project_id === proj.id);
                                                return projKeys.map((k: any, idx: number) => (
                                                    <option key={`fkey:${k.id}`} value={`key:${k.id}`}>
                                                        ↳ {proj.name} · {k.provider.toUpperCase()} #{idx + 1} ({k.key_preview || 'Llave'})
                                                    </option>
                                                ));
                                            })}
                                        </optgroup>
                                    </select>
                                </div>

                                {/* Model Selector or Input */}
                                <div className="form-group" style={{ margin: 0 }}>
                                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.25rem' }}>
                                        <span style={{ fontSize: '0.7rem', color: 'var(--text-secondary)', fontWeight: 600 }}>
                                            {t('engine.manager_model') || 'Modelo'}:
                                        </span>
                                        {slotModels.length > 0 && !isManual && (
                                            <span style={{ fontSize: '0.68rem', color: 'var(--text-muted)', fontWeight: 600 }}>
                                                ({slotModels.length} {t('engine.models_available') || 'disponibles'})
                                            </span>
                                        )}
                                    </div>

                                    {isLoadingModels ? (
                                        <div style={{
                                            display: 'flex', alignItems: 'center', gap: '0.45rem', padding: '0.45rem 0.6rem',
                                            background: 'var(--surface-2)', border: '1px solid var(--border-subtle)', borderRadius: 8,
                                            fontSize: '0.78rem', color: 'var(--text-muted)'
                                        }}>
                                            <RefreshCw size={12} className="spin" style={{ color: 'var(--text-muted)' }} />
                                            <span>{t('engine.loading_models') || 'Cargando modelos...'}</span>
                                        </div>
                                    ) : !isManual && slotModels.length > 0 ? (
                                        <select
                                            value={currentModel}
                                            onChange={e => handleFusionModelSelect(i, e.target.value)}
                                            style={{
                                                width: '100%', padding: '0.45rem 0.6rem', fontSize: '0.82rem',
                                                fontFamily: 'var(--font-mono)'
                                            }}
                                        >
                                            {currentModel && !slotModels.includes(currentModel) && (
                                                <option value={currentModel}>{currentModel} (actual)</option>
                                            )}
                                            {slotModels.map((m: string) => (
                                                <option key={m} value={m}>{m}</option>
                                            ))}
                                        </select>
                                    ) : (
                                        <input
                                            type="text"
                                            value={currentModel}
                                            onChange={e => handleFusionModelSelect(i, e.target.value)}
                                            onKeyDown={e => { if (e.key === 'Enter') handleSave(); }}
                                            placeholder={slot.placeholder}
                                            style={{
                                                width: '100%', padding: '0.45rem 0.6rem', fontSize: '0.82rem',
                                                fontFamily: 'var(--font-mono)'
                                            }}
                                        />
                                    )}
                                </div>
                            </div>
                        );
                    })}
                </div>
            </div>

            {/* Calibration Results Panel */}
            {calibrationResult && (
                <div className="glass-panel" style={{ padding: '1.5rem', display: 'flex', flexDirection: 'column', gap: '1rem' }}>
                    <div className="flex items-center justify-between">
                        <div className="flex items-center gap-2" style={{ fontWeight: 700, fontSize: '1rem' }}>
                            <RateGuardianGlyph size={18} color="var(--accent-primary)" />
                            <span>{t('engine.calibrated_title')}</span>
                        </div>
                        {calibrationResult.latencyMs && (
                            <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>
                                Calibrated in {calibrationResult.latencyMs}ms
                            </span>
                        )}
                    </div>

                    {calibrationResult.success && Array.isArray(calibrationResult.recommendations) ? (
                        <div style={{ overflowX: 'auto' }}>
                            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.82rem' }}>
                                <thead>
                                    <tr style={{ borderBottom: '1px solid var(--border-subtle)', textAlign: 'left' }}>
                                        <th style={{ padding: '0.6rem' }}>{t('engine.col_provider')}</th>
                                        <th style={{ padding: '0.6rem' }}>{t('engine.col_rpm')}</th>
                                        <th style={{ padding: '0.6rem' }}>{t('engine.col_tpm')}</th>
                                        <th style={{ padding: '0.6rem' }}>{t('engine.col_rpd')}</th>
                                        <th style={{ padding: '0.6rem' }}>{t('engine.col_rationale')}</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {calibrationResult.recommendations.map((rec: any, idx: number) => (
                                        <tr key={idx} style={{ borderBottom: '1px solid var(--border-subtle)' }}>
                                            <td style={{ padding: '0.6rem', fontWeight: 700 }}>
                                                <div style={{ display: 'flex', alignItems: 'center', gap: '0.45rem' }}>
                                                    <ProviderIcon provider={rec.provider} size={15} />
                                                    <span style={{ textTransform: 'capitalize' }}>{rec.provider}</span>
                                                </div>
                                            </td>
                                            <td style={{ padding: '0.6rem', fontFamily: 'var(--font-mono)', color: '#22c55e' }}>
                                                {rec.recommended_rpm} RPM
                                            </td>
                                            <td style={{ padding: '0.6rem', fontFamily: 'var(--font-mono)' }}>
                                                {rec.recommended_tpm?.toLocaleString()} TPM
                                            </td>
                                            <td style={{ padding: '0.6rem', fontFamily: 'var(--font-mono)' }}>
                                                {rec.recommended_rpd?.toLocaleString()} RPD
                                            </td>
                                            <td style={{ padding: '0.6rem', color: 'var(--text-muted)' }}>
                                                {rec.rationale}
                                            </td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>
                    ) : (
                        <div className="alert alert-error">
                            {calibrationResult.error || 'Failed to calibrate free tier limits'}
                        </div>
                    )}
                </div>
            )}

            {/* Sticky Floating Save Bar for frictionless ergonomics */}
            <div style={{
                position: 'fixed',
                bottom: '1.5rem',
                right: '2rem',
                zIndex: 99,
                display: 'flex',
                alignItems: 'center',
                gap: '0.75rem',
                background: 'var(--glass-bg)',
                backdropFilter: 'blur(16px)',
                WebkitBackdropFilter: 'blur(16px)',
                padding: '0.6rem 1rem',
                borderRadius: 12,
                border: '1px solid var(--border-default)',
                boxShadow: 'var(--shadow-lg), 0 8px 32px rgba(0, 0, 0, 0.5)'
            }}>
                {saveSuccess ? (
                    <span style={{ fontSize: '0.78rem', color: '#22c55e', display: 'flex', alignItems: 'center', gap: '0.35rem', fontWeight: 600 }}>
                        <Check size={14} />
                        {saveSuccess}
                    </span>
                ) : (
                    <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>
                        TierMax Engine
                    </span>
                )}
                <button
                    type="button"
                    onClick={() => handleSave()}
                    disabled={saving}
                    className="btn btn-primary"
                    style={{ padding: '0.45rem 1.15rem', fontWeight: 700, gap: '0.45rem', fontSize: '0.8rem' }}
                >
                    {saving ? <RefreshCw size={13} className="spin" /> : <Save size={13} />}
                    <span>{t('engine.save_config')}</span>
                </button>
            </div>
        </div>
    );
}
