import { useState, useEffect } from 'react';
import { useParams, Link } from 'react-router-dom';
import { fetchApi } from '../api';
import {
    KeyRound, Server, ChevronLeft, Trash2, Plus, RefreshCw,
    Activity, Pause, Play, Zap, Shield, Download, AlertTriangle,
    CheckCircle2, XCircle, Clock, Cpu, Sliders, Edit2, Save, X, DollarSign, ChevronDown,
    Wrench, History, ArrowRight, Copy
} from 'lucide-react';
import { useLanguage } from '../i18n';
import { useToast } from '../ToastContext';
import { ProviderIcon, PromptAnchorGlyph, RateGuardianGlyph, DualEngineGlyph, RouterCascadeGlyph } from '../components/Icons';

type BillingType = 'paid' | 'free';
type UpstreamKey = { id: string; provider: string; created_at: string; key_preview?: string; billing_type?: BillingType; max_context_tokens?: number | null; max_output_tokens?: number | null };
type GatewayKey = { id: string; key_name: string; api_key?: string; key_preview?: string; gateway_key_models: any[] };
type PricingEntry = {
    id: string;
    provider: string;
    model_name: string;
    input_price_per_1m: number | string;
    output_price_per_1m: number | string;
    is_active: boolean;
    source?: string | null;
    is_manual_override?: boolean;
    synced_at?: string | null;
};

interface RequestLog {
    id: string;
    created_at: string;
    provider: string;
    model: string;
    status: 'success' | 'error';
    status_code: number;
    latency_ms: number;
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens: number;
    total_cost_usd?: number | string;
    error_message?: string;
}

/* ─── Provider color / abbrev config ─── */
const PROVIDER_STYLES: Record<string, { cls: string; abbr: string }> = {
    google: { cls: 'provider-google', abbr: 'GG' },
    vertex: { cls: 'provider-google', abbr: 'VX' },
    cerebras: { cls: 'provider-cerebras', abbr: 'CB' },
    kie: { cls: 'provider-kie', abbr: 'KI' },
    openai: { cls: 'provider-openai', abbr: 'OA' },
    groq: { cls: 'provider-groq', abbr: 'GQ' },
    anthropic: { cls: 'provider-anthropic', abbr: 'AN' },
    mistral: { cls: 'provider-mistral', abbr: 'MS' },
    puter: { cls: 'provider-puter', abbr: 'PT' },
    brave: { cls: 'provider-brave', abbr: 'BV' },
    openrouter: { cls: 'provider-openrouter', abbr: 'OR' },
    nvidia: { cls: 'provider-nvidia', abbr: 'NV' },
    vercel: { cls: 'provider-vercel', abbr: 'VL' },
    moonshot: { cls: 'provider-moonshot', abbr: 'KM' },
    minimax: { cls: 'provider-minimax', abbr: 'MX' },
    deepseek: { cls: 'provider-deepseek', abbr: 'DS' },
    mimo: { cls: 'provider-default', abbr: 'MM' },
    zettacore: { cls: 'provider-default', abbr: 'ZC' },
};

function ProviderChip({ provider }: { provider: string }) {
    const cfg = PROVIDER_STYLES[provider] ?? { cls: 'provider-default', abbr: provider.slice(0, 2).toUpperCase() };
    return (
        <div className="provider-chip" style={{ display: 'inline-flex', alignItems: 'center', gap: '0.45rem' }}>
            <div className={`provider-icon ${cfg.cls}`} style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                <ProviderIcon provider={provider} size={14} />
            </div>
            <span style={{ textTransform: 'capitalize' }}>{provider}</span>
        </div>
    );
}

function StatusBadge({ status }: { status: string }) {
    const map: Record<string, string> = {
        healthy: 'badge-healthy',
        error: 'badge-error',
        rate_limited: 'badge-warning',
        paused: 'badge-paused',
        slow: 'badge-slow',
    };
    const label: Record<string, string> = {
        healthy: 'Healthy',
        error: 'Error',
        rate_limited: 'Rate Limited',
        paused: 'Paused',
        slow: 'Slow',
    };
    return (
        <span className={`badge ${map[status] ?? 'badge-paused'}`}>
            <span className="badge-dot" />
            {label[status] ?? status}
        </span>
    );
}

function CtxPill({ value, onClick }: { value: number | null | undefined; onClick: () => void }) {
    const hasLimit = value != null && value > 0;
    return (
        <button
            className={`ctx-pill ${hasLimit ? 'has-limit' : ''}`}
            onClick={onClick}
            title={hasLimit ? `Context limit: ${value!.toLocaleString()} tokens — click to edit` : 'No limit — click to set'}
        >
            {hasLimit ? `${(value! / 1000).toFixed(0)}K tokens` : '∞ Unlimited'}
            <span style={{ fontSize: '0.6rem', opacity: 0.7 }}>✎</span>
        </button>
    );
}

export default function ProjectDetail() {
    const { t } = useLanguage();
    const toast = useToast();
    const { id } = useParams();
    const [activeTab, setActiveTab] = useState<'providers' | 'gateway' | 'analytics' | 'healing'>('providers');
    const [project, setProject] = useState<any>(null);
    const [providers, setProviders] = useState<UpstreamKey[]>([]);
    const [providerHealth, setProviderHealth] = useState<Record<string, any>>({});
    const [gateways, setGateways] = useState<GatewayKey[]>([]);
    const [analyticsData, setAnalyticsData] = useState<any>(null);
    const [loading, setLoading] = useState(true);

    const [projectHistory, setProjectHistory] = useState<any[]>([]);
    const [loadingHistory, setLoadingHistory] = useState(false);
    const [repairing, setRepairing] = useState(false);
    const [repairReport, setRepairReport] = useState<any | null>(null);
    const [discovering, setDiscovering] = useState(false);
    const [discoveryReport, setDiscoveryReport] = useState<any | null>(null);

    const [newProvider, setNewProvider] = useState<{ provider: string; api_key: string; billing_type: BillingType }>({ provider: 'groq', api_key: '', billing_type: 'paid' });
    const [newGateway, setNewGateway] = useState({ key_name: '', custom_key: '' });
    const [availableModels, setAvailableModels] = useState<{ upstream_key_id: string, provider: string, models: any[] }[]>([]);
    const [selectedModels, setSelectedModels] = useState<{ upstream_key_id: string, model_name: string }[]>([]);

    const [testPrompts, setTestPrompts] = useState<Record<string, string>>({});
    const [testModels, setTestModels] = useState<Record<string, string>>({});
    const [testResults, setTestResults] = useState<Record<string, any>>({});
    const [testLoading, setTestLoading] = useState<Record<string, boolean>>({});
    // Audio test state
    const [audioFiles, setAudioFiles] = useState<Record<string, File | null>>({});
    const [audioRecording, setAudioRecording] = useState<Record<string, boolean>>({});
    const [mediaRecorders, setMediaRecorders] = useState<Record<string, MediaRecorder | null>>({});
    const [_audioChunks, setAudioChunks] = useState<Record<string, Blob[]>>({});
    const [ttsVoice, setTtsVoice] = useState<Record<string, string>>({});

    const [recentRequests, setRecentRequests] = useState<RequestLog[]>([]);
    const [pricingEntries, setPricingEntries] = useState<PricingEntry[]>([]);
    const [pricingForm, setPricingForm] = useState({ id: '', provider: '*', model_name: '', input_price_per_1m: '', output_price_per_1m: '' });
    const [pricingSyncing, setPricingSyncing] = useState(false);
    const [pricingSyncSummary, setPricingSyncSummary] = useState<string | null>(null);
    const [budgetInput, setBudgetInput] = useState('');
    const [budgetAlertThresholdInput, setBudgetAlertThresholdInput] = useState('80');

    const [gatewayKeyBulkModels, setGatewayKeyBulkModels] = useState<Record<string, string[]>>({});
    const [expandedAddModels, setExpandedAddModels] = useState<Record<string, boolean>>({});
    const [ctxLimitEdit, setCtxLimitEdit] = useState<Record<string, string | null>>({});
    const [gatewaySearch, setGatewaySearch] = useState('');
    const [createModelSearch, setCreateModelSearch] = useState('');
    const [addModelSearch, setAddModelSearch] = useState<Record<string, string>>({});
    const [isTestingAll, setIsTestingAll] = useState(false);
    const [testProviderResults, setTestProviderResults] = useState<Record<string, { success: boolean; msg: string; testing: boolean }>>({});
    const [tokenLimitModal, setTokenLimitModal] = useState<{ mode: 'global' | 'single'; providerId?: string; providerName?: string } | null>(null);
    const [tokenLimitInput, setTokenLimitInput] = useState<string>('');
    const [providerEdit, setProviderEdit] = useState<Record<string, { api_key: string; billing_type: BillingType } | null>>({});
    const [rateLimitModal, setRateLimitModal] = useState<{
        providerId: string;
        providerName: string;
        billingType: string;
        rpm: number;
        tpm: number;
        rpd: number;
        tpd: number;
        hasKnownLimits?: boolean;
        limitSource?: 'verified' | 'custom' | 'unverified';
    } | null>(null);
    const [guardianStates, setGuardianStates] = useState<Record<string, any>>({});
    const [roundStates, setRoundStates] = useState<any[]>([]);
    const [billingMenuOpen, setBillingMenuOpen] = useState(false);
    const [modesModalOpen, setModesModalOpen] = useState(false);

    /* ─── Data loading ─── */
    const loadData = async () => {
        try {
            const projData = await fetchApi('/projects');
            const currentProj = projData.find((p: any) => p.id === id);
            // Only update if we actually found the project — never overwrite with undefined
            if (currentProj) setProject(currentProj);

            const provData = await fetchApi('/providers');
            const projProv = provData.filter((p: any) => p.project_id === id);
            setProviders(projProv);

            const gwData = await fetchApi('/gateway-keys');
            setGateways(gwData.filter((g: any) => g.project_id === id));

            try {
                const healthData = await fetchApi('/providers/health');
                setProviderHealth(healthData.providers || healthData);
                if (healthData.guardian) setGuardianStates(healthData.guardian);
            } catch (e) { console.error('Health fetch error:', e); }

            try {
                const guardianRes = await fetchApi('/engine/guardian/states');
                if (guardianRes) setGuardianStates(guardianRes);
                const roundsRes = await fetchApi(`/engine/guardian/rounds?projectId=${id}`);
                if (roundsRes && roundsRes.rounds) setRoundStates(roundsRes.rounds);
            } catch { }

            const modelsData = [];
            for (const p of projProv) {
                try {
                    const res = await fetchApi(`/providers/${p.id}/models`);
                    modelsData.push({ upstream_key_id: p.id, provider: p.provider, models: res.models });
                } catch (modelErr: any) {
                    console.warn(`[OpenClaw] Failed to fetch models for ${p.provider} (${p.id}):`, modelErr?.message || modelErr);
                }
            }
            setAvailableModels(modelsData);

            try {
                const analyticsRes = await fetchApi(`/analytics/${id}`);
                setAnalyticsData(analyticsRes);
                if (analyticsRes?.recentLogs) setRecentRequests(analyticsRes.recentLogs);
            } catch { /* skip */ }

            try {
                setPricingEntries(await fetchApi('/pricing'));
            } catch { /* skip */ }

            try {
                const historyRes = await fetchApi(`/projects/${id}/history`);
                setProjectHistory(historyRes?.events || []);
            } catch { /* skip */ }

            setBudgetInput(currentProj?.budget_usd != null ? String(currentProj.budget_usd) : '');
            setBudgetAlertThresholdInput(currentProj?.budget_alert_threshold_pct != null ? String(currentProj.budget_alert_threshold_pct) : '80');

        } catch (err) {
            console.error(err);
        } finally {
            setLoading(false);
        }
    };

    const loadProjectHistory = async () => {
        if (!id) return;
        setLoadingHistory(true);
        try {
            const res = await fetchApi(`/projects/${id}/history`);
            setProjectHistory(res?.events || []);
        } catch (err: any) {
            console.warn('[OpenClaw] Failed to fetch project history:', err?.message || err);
        } finally {
            setLoadingHistory(false);
        }
    };

    const handleRunRepair = async () => {
        if (!id || repairing) return;
        setRepairing(true);
        try {
            const res = await fetchApi(`/projects/${id}/repair`, { method: 'POST' });
            if (res?.ok && res.report) {
                setRepairReport(res.report);
                toast.success(t('healing.title') + ' — ' + (t('healing.remediation_title') || 'Diagnóstico completado'));
                loadProjectHistory();
            } else {
                toast.error(res?.error || 'Falló el diagnóstico');
            }
        } catch (err: any) {
            toast.error(err?.message || 'Error al ejecutar diagnóstico de auto-reparación');
        } finally {
            setRepairing(false);
        }
    };

    const handleAutoDiscover = async () => {
        if (!id || discovering) return;
        setDiscovering(true);
        try {
            const res = await fetchApi(`/projects/${id}/auto-discover-models`, { method: 'POST' });
            if (res?.ok && res.report) {
                setDiscoveryReport(res.report);
                toast.success(t('healing.sync_success') || 'Modelos sincronizados exitosamente');
                loadData();
                loadProjectHistory();
            } else {
                toast.error(res?.error || 'Falló la sincronización de modelos');
            }
        } catch (err: any) {
            toast.error(err?.message || 'Error al ejecutar auto-descubrimiento');
        } finally {
            setDiscovering(false);
        }
    };

    const loadRealtimeData = async () => {
        if (!id) return;
        try { setProviderHealth(await fetchApi('/providers/health')); } catch { /* skip */ }
        try {
            const r = await fetchApi(`/analytics/${id}`);
            setAnalyticsData(r);
            if (r?.recentLogs) setRecentRequests(r.recentLogs);
        } catch { /* skip */ }
    };

    useEffect(() => {
        loadData();
        const interval = setInterval(loadRealtimeData, 4000);
        return () => clearInterval(interval);
    }, [id]);

    /* ─── Handlers ─── */
    const handleAddProvider = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!newProvider.api_key) return;
        try {
            await fetchApi('/providers', { method: 'POST', body: JSON.stringify({ project_id: id, ...newProvider }) });
            setNewProvider({ ...newProvider, api_key: '' });
            toast.success(t('project.provider_added') || 'Provider added successfully');
            loadData();
        } catch (err: any) { toast.error(err.message || 'Failed to add provider'); }
    };

    const handleStartProviderEdit = (provider: UpstreamKey) => {
        setProviderEdit(prev => ({
            ...prev,
            [provider.id]: {
                api_key: '',
                billing_type: provider.billing_type || 'paid',
            },
        }));
    };

    const handleCancelProviderEdit = (providerId: string) => {
        setProviderEdit(prev => ({ ...prev, [providerId]: null }));
    };

    const handleSaveProviderEdit = async (providerId: string) => {
        const edit = providerEdit[providerId];
        if (!edit) return;

        const payload: Record<string, any> = { billing_type: edit.billing_type };
        if (edit.api_key.trim()) payload.api_key = edit.api_key.trim();

        try {
            await fetchApi(`/providers/${providerId}`, {
                method: 'PATCH',
                body: JSON.stringify(payload),
            });
            setProviderEdit(prev => ({ ...prev, [providerId]: null }));
            toast.success('Provider updated');
            loadData();
        } catch (err: any) {
            toast.error(err.message || 'Failed to update provider');
        }
    };

    const handleSetAllProviderBilling = async (billingType: BillingType) => {
        if (!id || providers.length === 0) return;
        try {
            await fetchApi(`/providers/project/${id}/billing-type`, {
                method: 'PATCH',
                body: JSON.stringify({ billing_type: billingType }),
            });
            setProviders(prev => prev.map(p => ({ ...p, billing_type: billingType })));
            setProviderEdit({});
            setBillingMenuOpen(false);
            toast.success(`Updated all providers to ${billingType.toUpperCase()}`);
            loadRealtimeData();
        } catch (err: any) {
            toast.error(err.message || 'Failed to update provider billing types');
        }
    };

    const handleDeleteProvider = async (provId: string) => {
        if (!confirm('Delete this provider key?')) return;
        try { 
            await fetchApi(`/providers/${provId}`, { method: 'DELETE' }); 
            toast.success('Provider deleted');
            loadData(); 
        }
        catch { toast.error('Failed to delete provider'); }
    };

    const handleSaveContextLimit = async (provId: string) => {
        const raw = ctxLimitEdit[provId];
        const value = raw === '' || raw === null ? null : Number(raw);
        if (value !== null && (isNaN(value) || value < 100)) {
            toast.warning('Enter a number ≥ 100, or leave blank to remove the limit');
            return;
        }
        try {
            await fetchApi(`/providers/${provId}/context-limit`, {
                method: 'PATCH',
                body: JSON.stringify({ max_context_tokens: value }),
            });
            setProviders(prev => prev.map(p => p.id === provId ? { ...p, max_context_tokens: value } : p));
            setCtxLimitEdit(prev => ({ ...prev, [provId]: null }));
            toast.success('Context limit saved');
        } catch { toast.error('Failed to save context limit'); }
    };

    const handleResetAllProviders = async () => {
        try { 
            await fetchApi('/providers/reset-all', { method: 'POST' }); 
            toast.success('All providers reset');
            loadData(); 
        }
        catch { toast.error('Failed to reset all providers'); }
    };

    const handlePingSingleKey = async (keyId: string) => {
        setTestProviderResults(prev => ({ ...prev, [keyId]: { success: false, msg: 'Testing…', testing: true } }));
        try {
            const res = await fetchApi(`/channels/test/${keyId}`, { method: 'POST' });
            setTestProviderResults(prev => ({
                ...prev,
                [keyId]: {
                    success: res.ok,
                    msg: res.ok ? `⚡ ${res.latencyMs}ms (${res.modelTested})` : `❌ ${res.error || 'Failed'} (${res.modelTested || 'err'})`,
                    testing: false,
                }
            }));
        } catch (err: any) {
            setTestProviderResults(prev => ({
                ...prev,
                [keyId]: { success: false, msg: `❌ ${err.message || 'Error'}`, testing: false }
            }));
        }
    };

    const handlePingAllProviders = async () => {
        setIsTestingAll(true);
        providers.forEach(p => {
            setTestProviderResults(prev => ({ ...prev, [p.id]: { success: false, msg: 'Testing…', testing: true } }));
        });
        try {
            const data = await fetchApi(`/channels/test-project/${id}`, { method: 'POST' });
            if (data?.results && Array.isArray(data.results)) {
                const map: Record<string, any> = {};
                data.results.forEach((r: any) => {
                    map[r.upstreamKeyId] = {
                        success: r.ok,
                        msg: r.ok ? `⚡ ${r.latencyMs}ms (${r.modelTested})` : `❌ ${r.error || 'Failed'} (${r.modelTested || 'err'})`,
                        testing: false,
                    };
                });
                setTestProviderResults(prev => ({ ...prev, ...map }));
            }
        } catch (err: any) {
            console.error('Test all channels error:', err);
        } finally {
            setIsTestingAll(false);
        }
    };

    const openRateLimitModal = (p: UpstreamKey) => {
        const guardian = guardianStates[p.id];
        const isKnownDefault = ['google', 'groq', 'cerebras', 'mistral', 'openrouter'].includes(p.provider.toLowerCase());
        setRateLimitModal({
            providerId: p.id,
            providerName: p.provider,
            billingType: p.billing_type || 'free',
            rpm: guardian?.rpm?.nominalLimit ?? guardian?.rpm?.limit ?? 15,
            tpm: guardian?.tpm?.limit ?? 1000000,
            rpd: guardian?.daily?.rpdLimit ?? 1500,
            tpd: guardian?.daily?.tpdLimit ?? 10000000,
            hasKnownLimits: guardian?.hasKnownLimits !== undefined ? guardian.hasKnownLimits : isKnownDefault,
            limitSource: guardian?.limitSource || (isKnownDefault ? 'verified' : 'unverified'),
        });
    };

    const handleSaveRateLimits = async () => {
        if (!rateLimitModal) return;
        try {
            await fetchApi('/engine/guardian/limits', {
                method: 'POST',
                body: JSON.stringify({
                    upstreamKeyId: rateLimitModal.providerId,
                    provider: rateLimitModal.providerName,
                    billing_type: rateLimitModal.billingType,
                    rpm: Number(rateLimitModal.rpm),
                    tpm: Number(rateLimitModal.tpm),
                    rpd: Number(rateLimitModal.rpd),
                    tpd: Number(rateLimitModal.tpd),
                    hasKnownLimits: rateLimitModal.hasKnownLimits,
                    limitSource: rateLimitModal.limitSource,
                }),
            });
            toast.success(t('project.limits_saved') || 'Rate limits updated successfully');
            setRateLimitModal(null);
            loadData();
        } catch (err: any) {
            toast.error(err.message || 'Failed to update rate limits');
        }
    };

    const handlePauseAllProjectProviders = async () => {
        try { 
            await fetchApi(`/projects/${id}/pause-all`, { method: 'POST' }); 
            toast.info('All project providers paused');
            loadData(); 
        }
        catch { toast.error('Failed to pause project providers'); }
    };

    const openTokenLimitModal = (mode: 'global' | 'single', providerId?: string, providerName?: string) => {
        const current = mode === 'single'
            ? providers.find(p => p.id === providerId)?.max_output_tokens
            : null;
        setTokenLimitInput(current != null ? String(current) : '');
        setTokenLimitModal({ mode, providerId, providerName });
    };

    const handleSaveTokenLimit = async () => {
        if (!tokenLimitModal) return;
        const value = tokenLimitInput.trim() === '' ? null : Number(tokenLimitInput);
        if (value !== null && (isNaN(value) || value < 100)) {
            toast.warning('Enter a number ≥ 100, or leave blank to remove the limit (uses gateway default)');
            return;
        }
        try {
            if (tokenLimitModal.mode === 'global') {
                await fetchApi('/providers/output-token-limit-all', {
                    method: 'PATCH',
                    body: JSON.stringify({ max_output_tokens: value }),
                });
            } else if (tokenLimitModal.providerId) {
                await fetchApi(`/providers/${tokenLimitModal.providerId}/output-token-limit`, {
                    method: 'PATCH',
                    body: JSON.stringify({ max_output_tokens: value }),
                });
            }
            toast.success('Token limit saved');
            setTokenLimitModal(null);
            loadData();
        } catch { toast.error('Failed to save token limit'); }
    };

    const handleResetProvider = async (provId: string) => {
        try { 
            await fetchApi(`/providers/${provId}/reset`, { method: 'POST' }); 
            toast.success('Provider reset');
            loadData(); 
        }
        catch { toast.error('Failed to reset provider'); }
    };

    const handlePauseProvider = async (provId: string) => {
        try { 
            await fetchApi(`/providers/${provId}/pause`, { method: 'POST' }); 
            toast.info('Provider state toggled');
            loadData(); 
        }
        catch { toast.error('Failed to pause provider'); }
    };

    const handleCreateGateway = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!newGateway.key_name) return;
        try {
            await fetchApi('/gateway-keys', {
                method: 'POST',
                body: JSON.stringify({ project_id: id, ...newGateway, models: selectedModels }),
            });
            setNewGateway({ key_name: '', custom_key: '' });
            setSelectedModels([]);
            toast.success('Gateway key created');
            loadData();
        } catch (err: any) { toast.error(err.message || 'Failed to create gateway key'); }
    };

    const handleDeleteGateway = async (gwId: string) => {
        if (!confirm('Delete this gateway key?')) return;
        try { 
            await fetchApi(`/gateway-keys/${gwId}`, { method: 'DELETE' }); 
            toast.success('Gateway key deleted');
            loadData(); 
        }
        catch { toast.error('Failed to delete gateway key'); }
    };

    const handleAddModelsToGateway = async (gwId: string) => {
        const modelNames = gatewayKeyBulkModels[gwId] || [];
        if (modelNames.length === 0) return;
        const newSelections: { upstream_key_id: string; model_name: string }[] = [];
        modelNames.forEach(model_name => {
            const matchingKeys: string[] = [];
            for (const am of availableModels) {
                if (am.models?.some((m: any) => (m.id || m) === model_name)) {
                    matchingKeys.push(am.upstream_key_id);
                }
            }
            if (matchingKeys.length === 0) {
                providers.forEach(p => matchingKeys.push(p.id));
            }
            matchingKeys.forEach(kId => {
                newSelections.push({ upstream_key_id: kId, model_name });
            });
        });
        try {
            await fetchApi(`/gateway-keys/${gwId}/models`, { method: 'POST', body: JSON.stringify({ models: newSelections }) });
            setGatewayKeyBulkModels(prev => ({ ...prev, [gwId]: [] }));
            toast.success('Modelos vinculados con rotación de llaves');
            loadData();
        } catch { toast.error('Failed to add models'); }
    };

    const handleAddCustomModelToGateway = async (gwId: string, modelName?: string) => {
        const targetModel = (modelName || addModelSearch[gwId] || '').trim();
        if (!targetModel) {
            toast.error('Por favor escribe el nombre del modelo');
            return;
        }

        const matchingKeys: string[] = [];
        for (const am of availableModels) {
            if (am.models?.some((m: any) => (m.id || m) === targetModel)) {
                matchingKeys.push(am.upstream_key_id);
            }
        }
        if (matchingKeys.length === 0) {
            providers.forEach(p => matchingKeys.push(p.id));
        }

        const newSelections = matchingKeys.map(kId => ({
            upstream_key_id: kId,
            model_name: targetModel
        }));

        try {
            await fetchApi(`/gateway-keys/${gwId}/models`, {
                method: 'POST',
                body: JSON.stringify({
                    models: newSelections.length > 0 ? newSelections : [{ upstream_key_id: null, model_name: targetModel }]
                })
            });
            setAddModelSearch(prev => ({ ...prev, [gwId]: '' }));
            toast.success(`Modelo "${targetModel}" agregado para rotación en el proyecto`);
            loadData();
        } catch (err: any) {
            toast.error(err.message || 'Error al agregar modelo manual');
        }
    };

    const handleDeleteModelFromGateway = async (gwId: string, modelName: string) => {
        if (!confirm(`Remove ${modelName}?`)) return;
        try { 
            await fetchApi(`/gateway-keys/${gwId}/models/${encodeURIComponent(modelName)}`, { method: 'DELETE' }); 
            toast.success(`Removed ${modelName}`);
            loadData(); 
        }
        catch { toast.error('Failed to delete model'); }
    };

    // Helpers to classify model type
    const isSttModel = (model: string) => /whisper|transcri/i.test(model);
    const isTtsModel = (model: string) => /[\-_]tts[\-_]?|voxtral.*tts|tts.*preview/i.test(model);

    // ── Voice recording helpers ─────────────────────────────────────────
    const startRecording = async (gwId: string) => {
        try {
            const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
            const recorder = new MediaRecorder(stream, { mimeType: 'audio/webm' });
            const chunks: Blob[] = [];
            recorder.ondataavailable = e => { if (e.data.size > 0) chunks.push(e.data); };
            recorder.onstop = () => {
                const blob = new Blob(chunks, { type: 'audio/webm' });
                const file = new File([blob], 'recording.webm', { type: 'audio/webm' });
                setAudioFiles(prev => ({ ...prev, [gwId]: file }));
                stream.getTracks().forEach(t => t.stop());
            };
            recorder.start();
            setMediaRecorders(prev => ({ ...prev, [gwId]: recorder }));
            setAudioChunks(prev => ({ ...prev, [gwId]: chunks }));
            setAudioRecording(prev => ({ ...prev, [gwId]: true }));
        } catch {
            toast.error('No se pudo acceder al micrófono. Verifica los permisos del navegador.');
        }
    };

    const stopRecording = (gwId: string) => {
        mediaRecorders[gwId]?.stop();
        setAudioRecording(prev => ({ ...prev, [gwId]: false }));
    };

    // ── Main test handler ───────────────────────────────────────────────
    const handleTestKey = async (gatewayKey: GatewayKey) => {
        const model = testModels[gatewayKey.id] || gatewayKey.gateway_key_models?.[0]?.model_name;
        const baseUrl = window.location.port === '5173'
            ? `${window.location.protocol}//${window.location.hostname}:3000`
            : window.location.origin;

        setTestLoading(prev => ({ ...prev, [gatewayKey.id]: true }));
        setTestResults(prev => ({ ...prev, [gatewayKey.id]: null }));

        try {
            // Resolve active API key (fallback to reveal endpoint if sanitized)
            let activeApiKey = gatewayKey.api_key;
            if (!activeApiKey) {
                try {
                    const revealed = await fetchApi(`/gateway-keys/${gatewayKey.id}/reveal`);
                    if (revealed?.api_key) activeApiKey = revealed.api_key;
                } catch { /* skip */ }
            }

            if (!activeApiKey) {
                toast.error('No se pudo resolver la clave de API para la prueba.');
                setTestLoading(prev => ({ ...prev, [gatewayKey.id]: false }));
                return;
            }

            // ── STT: speech-to-text ─────────────────────────────────────
            if (isSttModel(model)) {
                const audioFile = audioFiles[gatewayKey.id];
                if (!audioFile) {
                    toast.warning('Graba o sube un archivo de audio primero.');
                    setTestLoading(prev => ({ ...prev, [gatewayKey.id]: false }));
                    return;
                }
                const form = new FormData();
                form.set('model', model);
                form.set('file', audioFile, audioFile.name);
                const res = await fetch(`${baseUrl}/v1/audio/transcriptions`, {
                    method: 'POST',
                    headers: { 'Authorization': `Bearer ${activeApiKey}` },
                    body: form,
                });
                const data = await res.json();
                setTestResults(prev => ({ ...prev, [gatewayKey.id]: { status: res.status, data, type: 'stt' } }));

            // ── TTS: text-to-speech ─────────────────────────────────────
            } else if (isTtsModel(model)) {
                const input = testPrompts[gatewayKey.id];
                if (!input) { toast.warning('Escribe el texto a convertir en voz.'); setTestLoading(prev => ({ ...prev, [gatewayKey.id]: false })); return; }
                const voice = ttsVoice[gatewayKey.id] || 'alloy';
                const res = await fetch(`${baseUrl}/v1/audio/speech`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${activeApiKey}` },
                    body: JSON.stringify({ model, input, voice, response_format: 'mp3' }),
                });
                if (!res.ok) {
                    const errData = await res.json().catch(() => ({ error: { message: 'Error desconocido' } }));
                    setTestResults(prev => ({ ...prev, [gatewayKey.id]: { status: res.status, data: errData, type: 'tts' } }));
                } else {
                    const audioBlob = await res.blob();
                    const audioUrl = URL.createObjectURL(audioBlob);
                    setTestResults(prev => ({ ...prev, [gatewayKey.id]: { status: 200, audioUrl, type: 'tts' } }));
                }

            // ── Chat completions ────────────────────────────────────────
            } else {
                const prompt = testPrompts[gatewayKey.id];
                if (!prompt) { toast.warning('Escribe un mensaje de prueba.'); setTestLoading(prev => ({ ...prev, [gatewayKey.id]: false })); return; }
                const res = await fetch(`${baseUrl}/v1/chat/completions`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${activeApiKey}` },
                    body: JSON.stringify({ model, messages: [{ role: 'user', content: prompt }] }),
                });
                const data = await res.json();
                setTestResults(prev => ({ ...prev, [gatewayKey.id]: { status: res.status, data, type: 'chat' } }));
            }
            loadData();
        } catch (err: any) {
            setTestResults(prev => ({ ...prev, [gatewayKey.id]: { status: 500, error: err.message } }));
        } finally {
            setTestLoading(prev => ({ ...prev, [gatewayKey.id]: false }));
        }
    };

    // ── Render test result by type ──────────────────────────────────────
    const renderTestResult = (gwId: string) => {
        const r = testResults[gwId];
        if (!r) return null;

        // STT result: show transcription text
        if (r.type === 'stt') {
            return (
                <div className="test-result" style={{ borderColor: r.status === 200 ? 'rgba(34,197,94,0.3)' : 'rgba(239,68,68,0.3)' }}>
                    <div className="test-result-header">
                        <div className="flex items-center gap-2">
                            {r.status === 200 ? <CheckCircle2 size={14} style={{ color: 'var(--status-healthy)' }} /> : <XCircle size={14} style={{ color: 'var(--status-error)' }} />}
                            <span style={{ fontSize: '0.8rem', fontWeight: 700, fontFamily: 'var(--font-mono)', color: r.status === 200 ? '#22c55e' : '#ef4444' }}>
                                {r.status === 200 ? '🎤 Transcripción' : `HTTP ${r.status}`}
                            </span>
                        </div>
                    </div>
                    <div className="test-result-body" style={{ color: r.status === 200 ? 'var(--text-primary)' : '#ef4444' }}>
                        {r.status === 200 ? (r.data?.text || JSON.stringify(r.data, null, 2)) : JSON.stringify(r.data, null, 2)}
                    </div>
                </div>
            );
        }

        // TTS result: inline audio player
        if (r.type === 'tts') {
            return (
                <div className="test-result" style={{ borderColor: r.status === 200 ? 'rgba(34,197,94,0.3)' : 'rgba(239,68,68,0.3)' }}>
                    <div className="test-result-header">
                        <div className="flex items-center gap-2">
                            {r.status === 200 ? <CheckCircle2 size={14} style={{ color: 'var(--status-healthy)' }} /> : <XCircle size={14} style={{ color: 'var(--status-error)' }} />}
                            <span style={{ fontSize: '0.8rem', fontWeight: 700, fontFamily: 'var(--font-mono)', color: r.status === 200 ? '#22c55e' : '#ef4444' }}>
                                {r.status === 200 ? '🔊 Audio generado' : `HTTP ${r.status}`}
                            </span>
                        </div>
                    </div>
                    <div className="test-result-body">
                        {r.audioUrl
                            ? <audio controls src={r.audioUrl} style={{ width: '100%' }} autoPlay />
                            : <pre style={{ margin: 0 }}>{JSON.stringify(r.data, null, 2)}</pre>}
                    </div>
                </div>
            );
        }

        // Chat / generic HTTP result
        const meta = r.data?._openclaw_metadata;
        const cfg = meta ? (PROVIDER_STYLES[meta.provider] ?? { cls: 'provider-default', abbr: (meta.provider || '??').slice(0, 2).toUpperCase() }) : null;
        return (
            <div className="test-result" style={{ borderColor: r.status === 200 ? 'rgba(34,197,94,0.3)' : 'rgba(239,68,68,0.3)' }}>
                <div className="test-result-header">
                    <div className="flex items-center gap-2" style={{ flexWrap: 'wrap' }}>
                        {r.status === 200 ? <CheckCircle2 size={14} style={{ color: 'var(--status-healthy)' }} /> : <XCircle size={14} style={{ color: 'var(--status-error)' }} />}
                        <span style={{ fontSize: '0.8rem', fontWeight: 700, fontFamily: 'var(--font-mono)', color: r.status === 200 ? '#22c55e' : '#ef4444' }}>
                            HTTP {r.status}
                        </span>
                        {meta && cfg && (
                            <>
                                <div className="provider-chip" style={{ fontSize: '0.7rem', display: 'inline-flex', alignItems: 'center', gap: '0.35rem' }}>
                                    <div className={`provider-icon ${cfg.cls}`} style={{ width: 18, height: 18, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                                        <ProviderIcon provider={meta.provider} size={12} />
                                    </div>
                                    <span style={{ textTransform: 'capitalize' }}>{meta.provider}</span>
                                </div>
                                {meta.upstream_key_id && (
                                    <code style={{ fontSize: '0.7rem', fontFamily: 'var(--font-mono)', color: 'var(--brand-amber)', background: 'rgba(255,170,0,0.08)', padding: '0.1rem 0.4rem', borderRadius: 'var(--radius-sm)', border: '1px solid rgba(255,170,0,0.2)' }}>
                                        {meta.upstream_key_id.split('-')[0]}…
                                    </code>
                                )}
                            </>
                        )}
                    </div>
                    <button
                        onClick={() => setTestResults(prev => ({ ...prev, [gwId]: { ...prev[gwId], showRaw: !prev[gwId].showRaw } }))}
                        style={{ background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', fontSize: '0.72rem', textDecoration: 'underline', fontFamily: 'var(--font-mono)', flexShrink: 0 }}
                    >
                        {r.showRaw ? 'formatted' : 'raw json'}
                    </button>
                </div>
                <div className="test-result-body">
                    {r.status === 200 && !r.showRaw && r.data?.choices?.[0]?.message?.content
                        ? r.data.choices[0].message.content
                        : JSON.stringify(r.data || r.error, null, 2)}
                </div>
            </div>
        );
    };

    // ── Render model multi-selector for gateway key creation form ────────
    const renderModelSelector = () => {
        if (availableModels.length === 0) {
            return <p style={{ fontSize: '0.85rem', color: 'var(--text-muted)' }}>{t('project.no_models')}</p>;
        }
        const allModelIds = Array.from(new Set(availableModels.flatMap(am => am.models.map(m => m.id)))).sort();
        const uniqueSelected = Array.from(new Set(selectedModels.map(sm => sm.model_name)));
        return (
            <div>
                <p style={{ fontSize: '0.7rem', color: 'var(--text-muted)', marginBottom: '0.4rem' }}>Ctrl/Cmd para selección múltiple</p>
                <input
                    type="text"
                    placeholder="Buscar modelos..."
                    value={createModelSearch}
                    onChange={e => setCreateModelSearch(e.target.value)}
                    style={{ width: '100%', marginBottom: '0.5rem', padding: '0.5rem', borderRadius: 'var(--radius-md)', border: '1px solid var(--border-default)', background: 'var(--bg-primary)', color: 'var(--text-primary)', fontSize: '0.8rem' }}
                />
                <select
                    multiple
                    value={uniqueSelected}
                    onChange={e => {
                        const vals = Array.from(e.target.selectedOptions, o => o.value);
                        const newSel: { upstream_key_id: string; model_name: string }[] = [];
                        vals.forEach(mn => availableModels.forEach(am => {
                            if (am.models.some(m => m.id === mn)) newSel.push({ upstream_key_id: am.upstream_key_id, model_name: mn });
                        }));
                        setSelectedModels(newSel);
                    }}
                    style={{ width: '100%', minHeight: 160, padding: '0.4rem', borderRadius: 'var(--radius-md)', border: '1px solid var(--border-default)', background: 'var(--bg-secondary)', color: 'var(--text-primary)', fontSize: '0.8rem', fontFamily: 'var(--font-mono)' }}
                >
                    {allModelIds.filter(mid => mid.toLowerCase().includes(createModelSearch.toLowerCase())).map(mid => <option key={mid} value={mid}>{mid}</option>)}
                </select>
            </div>
        );
    };

    const handleClearAnalytics = async () => {
        if (!confirm('Clear all analytics data for this project?')) return;
        try { 
            await fetchApi(`/analytics/${id}`, { method: 'DELETE' }); 
            toast.success('Analytics cleared');
            loadData(); 
        }
        catch { toast.error('Failed to clear analytics'); }
    };

    const handleExportAnalytics = () => {
        if (!analyticsData) return;
        let md = `# Analytics: ${project?.name || 'Project'}\n\n`;
        md += `## Stats\n- Requests: ${analyticsData.stats?.totalRequests || 0}\n`;
        md += `- Success Rate: ${analyticsData.stats?.successRate || 0}%\n`;
        md += `- Tokens: ${(analyticsData.stats?.totalTokens || 0).toLocaleString()}\n`;
        md += `- Estimated Cost: $${Number(analyticsData.stats?.totalCostUsd || 0).toFixed(4)}\n`;
        md += `- Avg Latency: ${analyticsData.stats?.averageLatency || 0}ms\n\n`;
        const blob = new Blob([md], { type: 'text/markdown' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a'); a.href = url;
        a.download = `analytics-${project?.name || 'export'}.md`;
        document.body.appendChild(a); a.click();
        document.body.removeChild(a); URL.revokeObjectURL(url);
    };

    const handleSaveBudget = async () => {
        try {
            const budget = budgetInput.trim() === '' ? null : Number(budgetInput);
            const threshold = budgetAlertThresholdInput.trim() === '' ? 80 : Number(budgetAlertThresholdInput);
            if (budget !== null && (isNaN(budget) || budget < 0)) {
                toast.warning('Budget must be a number >= 0');
                return;
            }
            if (isNaN(threshold) || threshold < 1 || threshold > 100) {
                toast.warning('Alert threshold must be between 1 and 100');
                return;
            }
            const updated = await fetchApi(`/projects/${id}`, {
                method: 'PATCH',
                body: JSON.stringify({ budget_usd: budget, budget_alert_threshold_pct: threshold }),
            });
            setProject(updated);
            setBudgetInput(updated?.budget_usd != null ? String(updated.budget_usd) : '');
            setBudgetAlertThresholdInput(updated?.budget_alert_threshold_pct != null ? String(updated.budget_alert_threshold_pct) : '80');
            toast.success('Budget settings saved');
        } catch (err: any) {
            toast.error(err.message || 'Failed to save budget');
        }
    };

    const totalCostUsd = Number(analyticsData?.stats?.totalCostUsd || 0);
    const budgetUsd = project?.budget_usd != null ? Number(project.budget_usd) : null;
    const budgetAlertThresholdPct = project?.budget_alert_threshold_pct != null ? Number(project.budget_alert_threshold_pct) : 80;
    const budgetUsagePct = budgetUsd && budgetUsd > 0 ? (totalCostUsd / budgetUsd) * 100 : 0;
    const isBudgetExceeded = budgetUsd != null && totalCostUsd >= budgetUsd;
    const isBudgetWarning = !isBudgetExceeded && budgetUsd != null && budgetUsagePct >= budgetAlertThresholdPct;

    const handleSavePricing = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!pricingForm.model_name.trim()) return;
        try {
            const payload = {
                provider: pricingForm.provider.trim() || '*',
                model_name: pricingForm.model_name.trim(),
                input_price_per_1m: Number(pricingForm.input_price_per_1m || 0),
                output_price_per_1m: Number(pricingForm.output_price_per_1m || 0),
            };

            if (pricingForm.id) {
                await fetchApi(`/pricing/${pricingForm.id}`, {
                    method: 'PATCH',
                    body: JSON.stringify(payload),
                });
            } else {
                await fetchApi('/pricing', {
                    method: 'POST',
                    body: JSON.stringify(payload),
                });
            }

            setPricingEntries(await fetchApi('/pricing'));
            setPricingForm({ id: '', provider: '*', model_name: '', input_price_per_1m: '', output_price_per_1m: '' });
            toast.success('Pricing rule saved');
        } catch (err: any) {
            toast.error(err.message || 'Failed to save pricing');
        }
    };

    const handleEditPricing = (entry: PricingEntry) => {
        setPricingForm({
            id: entry.id,
            provider: entry.provider || '*',
            model_name: entry.model_name,
            input_price_per_1m: String(entry.input_price_per_1m ?? ''),
            output_price_per_1m: String(entry.output_price_per_1m ?? ''),
        });
    };

    const handleDeletePricing = async (entryId: string) => {
        if (!confirm('Delete this pricing rule?')) return;
        try {
            await fetchApi(`/pricing/${entryId}`, { method: 'DELETE' });
            setPricingEntries(await fetchApi('/pricing'));
            if (pricingForm.id === entryId) {
                setPricingForm({ id: '', provider: '*', model_name: '', input_price_per_1m: '', output_price_per_1m: '' });
            }
            toast.success('Pricing rule deleted');
        } catch (err: any) {
            toast.error(err.message || 'Failed to delete pricing');
        }
    };

    const handleSyncLiteLlmPricing = async () => {
        try {
            setPricingSyncing(true);
            setPricingSyncSummary(null);
            const result = await fetchApi('/pricing/sync-litellm', { method: 'POST' });
            setPricingEntries(await fetchApi('/pricing'));
            setPricingSyncSummary(`Synced ${result.synced} LiteLLM prices. Skipped ${result.skipped_manual_overrides} manual overrides.`);
            toast.success(`Synced ${result.synced} prices from LiteLLM`);
        } catch (err: any) {
            toast.error(err.message || 'Failed to sync LiteLLM pricing');
        } finally {
            setPricingSyncing(false);
        }
    };

    /* ─── Render guards ─── */
    if (loading) {
        return (
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', minHeight: '60vh', gap: '1rem' }}>
                <div className="spinner-ring" style={{ width: 32, height: 32, borderWidth: 3 }} />
                <p style={{ color: 'var(--text-muted)', fontSize: '0.85rem' }}>Loading project…</p>
            </div>
        );
    }
    if (!project) return (
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', minHeight: '60vh', gap: '1rem' }}>
            <p style={{ color: 'var(--text-primary)', fontSize: '1rem', fontWeight: 600 }}>Proyecto no encontrado</p>
            <p style={{ color: 'var(--text-muted)', fontSize: '0.85rem' }}>El proyecto puede estar cargando. Intenta recargar.</p>
            <button className="btn btn-primary btn-sm" onClick={() => window.location.reload()}>Recargar</button>
        </div>
    );

    const projColor = project.color || '#6366f1';
    const paidProviderCount = providers.filter(p => (p.billing_type || 'paid') === 'paid').length;
    const freeProviderCount = providers.filter(p => p.billing_type === 'free').length;
    const billingSummary =
        providers.length === 0
            ? t('project.billing_none')
            : paidProviderCount === providers.length
                ? t('project.billing_all_paid')
                : freeProviderCount === providers.length
                    ? t('project.billing_all_free')
                    : t('project.billing_mixed');

    /* ─── Main render ─── */
    return (
        <div style={{ animation: 'fadeIn 0.3s ease-out' }}>
            {/* Breadcrumbs */}
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', marginBottom: '1.25rem', fontSize: '0.8rem', color: 'var(--text-muted)' }}>
                <Link to="/" style={{ color: 'var(--text-muted)', textDecoration: 'none', display: 'flex', alignItems: 'center', gap: '0.25rem' }}>
                    <ChevronLeft size={14} /> {t('nav.projects')}
                </Link>
                <span style={{ opacity: 0.5 }}>/</span>
                <span style={{ color: 'var(--text-primary)', fontWeight: 600 }}>{project.name}</span>
                <span style={{ opacity: 0.5 }}>/</span>
                <span style={{ color: 'var(--accent-primary)', fontWeight: 600, textTransform: 'capitalize' }}>{activeTab}</span>
            </div>

            {/* Project Header */}
            <div className="flex items-center gap-3" style={{ marginBottom: '1.75rem' }}>
                <div style={{
                    width: 48, height: 48, borderRadius: 'var(--radius-md)',
                    background: `${projColor}18`, border: `1px solid ${projColor}40`,
                    display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
                    boxShadow: `0 0 16px ${projColor}30`,
                }}>
                    <Server size={22} style={{ color: projColor }} />
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                    <h1 style={{ margin: 0, fontSize: '1.45rem', fontWeight: 800, color: 'var(--text-primary)', letterSpacing: '-0.02em', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {project.name}
                    </h1>
                    <code style={{ fontSize: '0.7rem', fontFamily: 'var(--font-mono)', color: 'var(--text-muted)' }}>{project.id}</code>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', flexWrap: 'wrap', flexShrink: 0 }}>
                    <button
                        onClick={() => setModesModalOpen(true)}
                        title="Click to view all Gateway Operating Modes (SOAT, Guardian, Dual Engine, Atlas)"
                        style={{
                            display: 'inline-flex', alignItems: 'center', gap: '0.35rem',
                            background: 'rgba(99,102,241,0.12)', border: '1px solid rgba(99,102,241,0.3)',
                            borderRadius: 'var(--radius-pill)', padding: '0.28rem 0.65rem',
                            fontSize: '0.68rem', fontWeight: 700, letterSpacing: '0.06em',
                            color: 'var(--accent-primary)', textTransform: 'uppercase', cursor: 'pointer',
                            transition: 'all var(--transition-fast)',
                        }}
                    >
                        <PromptAnchorGlyph size={12} color="var(--accent-primary)" /> {t('modes.badge_soat')}
                    </button>
                    <button
                        onClick={() => setModesModalOpen(true)}
                        title="Click to view Guardian Anti-429 & Free Tier settings"
                        style={{
                            display: 'inline-flex', alignItems: 'center', gap: '0.35rem',
                            background: 'rgba(16,185,129,0.12)', border: '1px solid rgba(16,185,129,0.3)',
                            borderRadius: 'var(--radius-pill)', padding: '0.28rem 0.65rem',
                            fontSize: '0.68rem', fontWeight: 700, letterSpacing: '0.06em',
                            color: '#10b981', textTransform: 'uppercase', cursor: 'pointer',
                            transition: 'all var(--transition-fast)',
                        }}
                    >
                        <RateGuardianGlyph size={12} color="#10b981" /> {t('modes.badge_guardian')}
                    </button>
                    <button
                        onClick={() => setModesModalOpen(true)}
                        title="Click to view Dual Engine (TypeSafe Jev + LLM) status"
                        style={{
                            display: 'inline-flex', alignItems: 'center', gap: '0.35rem',
                            background: 'var(--surface-2)', border: '1px solid var(--border-default)',
                            borderRadius: 'var(--radius-pill)', padding: '0.28rem 0.65rem',
                            fontSize: '0.68rem', fontWeight: 700, letterSpacing: '0.06em',
                            color: 'var(--text-secondary)', textTransform: 'uppercase', cursor: 'pointer',
                            transition: 'all var(--transition-fast)',
                        }}
                    >
                        <DualEngineGlyph size={12} color="var(--text-secondary)" /> {t('modes.badge_engine')}
                    </button>
                </div>
            </div>

            {/* Tabs */}
            <div className="tabs">
                <button id="tab-providers" className={`tab-btn ${activeTab === 'providers' ? 'active' : ''}`} onClick={() => setActiveTab('providers')}>
                    <Server size={14} /> {t('project.tab_providers')}
                </button>
                <button id="tab-gateway" className={`tab-btn ${activeTab === 'gateway' ? 'active' : ''}`} onClick={() => setActiveTab('gateway')}>
                    <KeyRound size={14} /> {t('project.tab_gateway')}
                </button>
                <button id="tab-analytics" className={`tab-btn ${activeTab === 'analytics' ? 'active' : ''}`} onClick={() => setActiveTab('analytics')}>
                    <Activity size={14} /> {t('project.tab_analytics')}
                </button>
                <button id="tab-healing" className={`tab-btn ${activeTab === 'healing' ? 'active' : ''}`} onClick={() => { setActiveTab('healing'); loadProjectHistory(); }}>
                    <Wrench size={14} /> {t('project.tab_healing')}
                </button>
            </div>

            {/* ═══ TAB: PROVIDERS ═══ */}
            {activeTab === 'providers' && (
                <div className="side-panel-layout">
                    {/* Add Provider Form */}
                    <div className="glass-panel">
                        <div className="section-label" style={{ marginBottom: '1.25rem' }}>
                            <Plus size={11} /> {t('project.add_provider')}
                        </div>
                        <form onSubmit={handleAddProvider}>
                            <div className="form-group">
                                <label>{t('project.provider')}</label>
                                <select value={newProvider.provider} onChange={e => setNewProvider({ ...newProvider, provider: e.target.value })}>
                                    <option value="groq">Groq</option>
                                    <option value="mistral">Mistral AI</option>
                                    <option value="openrouter">OpenRouter</option>
                                    <option value="openai">OpenAI</option>
                                    <option value="google">Google</option>
                                    <option value="vertex">Vertex AI (via AI Studio)</option>
                                    <option value="anthropic">Anthropic</option>
                                    <option value="deepseek">DeepSeek</option>
                                    <option value="moonshot">Moonshot AI (Kimi)</option>
                                    <option value="minimax">MiniMax AI</option>
                                    <option value="kie">Kie (Gemini vía Kie)</option>
                                    <option value="cerebras">Cerebras</option>
                                    <option value="nvidia">NVIDIA NIM</option>
                                    <option value="vercel">Vercel AI Gateway</option>
                                    <option value="brave">Brave Search</option>
                                    <option value="puter">Puter (500+ modelos gratis)</option>
                                    <option value="mimo">Xiaomi MiMo</option>
                                    <option value="zettacore">ZettaCore (Chrome Bridge)</option>
                                </select>
                            </div>
                            <div className="form-group">
                                <label>{t('project.api_key')}</label>
                                <input
                                    type="password"
                                    value={newProvider.api_key}
                                    onChange={e => setNewProvider({ ...newProvider, api_key: e.target.value })}
                                    placeholder="gsk_... / sk-or-v1-..."
                                    required
                                />
                            </div>
                            <div className="form-group">
                                <label>{t('project.billing_type')}</label>
                                <select
                                    value={newProvider.billing_type}
                                    onChange={e => setNewProvider({ ...newProvider, billing_type: e.target.value as BillingType })}
                                >
                                    <option value="paid">{t('project.billing_paid')}</option>
                                    <option value="free">{t('project.billing_free')}</option>
                                </select>
                            </div>
                            <button type="submit" className="btn btn-primary w-full">
                                <Plus size={15} /> {t('project.btn_save_fetch')}
                            </button>
                        </form>
                    </div>

                    {/* Providers List */}
                    <div>
                        <div className="glass-panel">
                            <div className="panel-header">
                                <div className="section-label" style={{ marginBottom: 0 }}>
                                    <Server size={11} /> {t('project.configured_providers')} ({providers.length})
                                </div>
                                <div className="panel-actions">
                                    <div className="billing-dropdown">
                                        <button
                                            onClick={() => setBillingMenuOpen(open => !open)}
                                            className="btn btn-secondary btn-sm"
                                            disabled={providers.length === 0}
                                            title={t('project.billing_bulk_menu')}
                                            type="button"
                                        >
                                            <DollarSign size={13} /> {billingSummary} <ChevronDown size={13} />
                                        </button>
                                        {billingMenuOpen && providers.length > 0 && (
                                            <div className="billing-dropdown-menu">
                                                <button type="button" onClick={() => handleSetAllProviderBilling('paid')}>
                                                    <Shield size={13} /> {t('project.billing_set_all_paid')}
                                                </button>
                                                <button type="button" onClick={() => handleSetAllProviderBilling('free')}>
                                                    <DollarSign size={13} /> {t('project.billing_set_all_free')}
                                                </button>
                                            </div>
                                        )}
                                    </div>
                                    <button onClick={handlePauseAllProjectProviders} className="btn btn-warning btn-sm">
                                        <Pause size={13} /> {t('project.pause_all') || 'Pause All'}
                                    </button>
                                    <button onClick={handleResetAllProviders} className="btn btn-success btn-sm">
                                        <RefreshCw size={13} /> {t('project.reset_all') || 'Reset All'}
                                    </button>
                                    <button onClick={() => openTokenLimitModal('global')} className="btn btn-sm" style={{ background: 'rgba(139,92,246,0.15)', border: '1px solid rgba(139,92,246,0.35)', color: '#a78bfa' }}>
                                        <Sliders size={13} /> {t('project.token_limit') || 'Token Limit'}
                                    </button>
                                    <button onClick={handlePingAllProviders} className="btn btn-primary btn-sm" disabled={isTestingAll}>
                                        {isTestingAll ? <span className="spinner-ring" style={{ width: 13, height: 13, borderWidth: 2 }} /> : <Zap size={13} />} {t('project.test_all') || 'Test All'}
                                    </button>
                                    <button onClick={loadData} className="btn btn-secondary btn-icon btn-sm" title="Refresh">
                                        <RefreshCw size={14} />
                                    </button>
                                </div>
                            </div>

                            {providers.length === 0 ? (
                                <div className="empty-state">
                                    <div className="empty-state-icon"><Server size={24} /></div>
                                    <h3>{t('project.no_providers')}</h3>
                                    <p>Add your first upstream API key using the form on the left.</p>
                                </div>
                            ) : (
                                <>
                                    {roundStates && roundStates.length > 0 && (
                                        <div style={{ display: 'flex', gap: '0.6rem', flexWrap: 'wrap', marginBottom: '0.75rem' }}>
                                            {roundStates.map((rs: any) => (
                                                <div
                                                    key={rs.poolKey}
                                                    style={{
                                                        display: 'inline-flex',
                                                        alignItems: 'center',
                                                        gap: '0.5rem',
                                                        padding: '0.35rem 0.75rem',
                                                        borderRadius: 'var(--radius-pill)',
                                                        background: 'var(--surface-2)',
                                                        border: '1px solid var(--border-default)',
                                                        fontSize: '0.72rem',
                                                        fontFamily: 'var(--font-mono)'
                                                    }}
                                                >
                                                    <span style={{ color: 'var(--brand-cyan)', fontWeight: 700 }}>🔄 Round #{rs.currentRound}</span>
                                                    <span style={{ color: 'var(--text-muted)' }}>({rs.model}):</span>
                                                    <span style={{ color: 'var(--text-primary)', fontWeight: 600 }}>
                                                        {rs.usedKeysCount} / {rs.totalKeys} keys dispatched
                                                    </span>
                                                    <div style={{ width: 45, height: 4, background: 'var(--surface-1)', borderRadius: 2, overflow: 'hidden' }}>
                                                        <div style={{ width: `${Math.round((rs.usedKeysCount / Math.max(1, rs.totalKeys)) * 100)}%`, height: '100%', background: 'var(--brand-cyan)' }} />
                                                    </div>
                                                </div>
                                            ))}
                                        </div>
                                    )}
                                    <div className="table-wrapper">
                                    <table className="data-table">
                                        <thead>
                                            <tr>
                                                <th>{t('project.provider')} / Key</th>
                                                <th>{t('project.billing_type')}</th>
                                                <th>{t('project.status')}</th>
                                                <th>{t('project.usage')}</th>
                                                <th>Ctx Limit</th>
                                                <th>Output Limit</th>
                                                <th>{t('project.actions')}</th>
                                            </tr>
                                        </thead>
                                        <tbody>
                                            {providers.map((p, index) => {
                                                const health = providerHealth[p.id] || { status: 'healthy', requestsPerMinute: 0, requestsPerDay: 0, tokensPerMinute: 0, tokensPerDay: 0 };
                                                const isEditing = ctxLimitEdit[p.id] !== undefined && ctxLimitEdit[p.id] !== null;
                                                const apiEdit = providerEdit[p.id];
                                                return (
                                                    <tr key={p.id}>
                                                        <td>
                                                            <div className="flex items-center gap-1" style={{ marginBottom: '0.2rem' }}>
                                                                <span style={{ fontSize: '0.65rem', color: 'var(--text-muted)', fontFamily: 'var(--font-mono)', marginRight: '0.2rem' }}>#{index + 1}</span>
                                                                <ProviderChip provider={p.provider} />
                                                            </div>
                                                            <div className="provider-id">{p.key_preview || p.id.split('-')[0] + '...'}</div>
                                                            {testProviderResults[p.id] && (
                                                                <div style={{ fontSize: '0.65rem', marginTop: '0.2rem', color: testProviderResults[p.id].testing ? '#a69584' : (testProviderResults[p.id].success ? '#22c55e' : '#ef4444') }}>
                                                                    {testProviderResults[p.id].testing ? '⏳ Testing...' : testProviderResults[p.id].msg}
                                                                </div>
                                                            )}
                                                            {apiEdit && (
                                                                <div className="provider-edit-panel">
                                                                    <input
                                                                        type="password"
                                                                        value={apiEdit.api_key}
                                                                        onChange={e => setProviderEdit(prev => ({ ...prev, [p.id]: { ...apiEdit, api_key: e.target.value } }))}
                                                                        placeholder={t('project.api_key_keep_placeholder')}
                                                                    />
                                                                    <div className="flex gap-2">
                                                                        <button className="btn btn-primary btn-sm" onClick={() => handleSaveProviderEdit(p.id)}>
                                                                            <Save size={12} /> {t('dashboard.save')}
                                                                        </button>
                                                                        <button className="btn btn-secondary btn-sm" onClick={() => handleCancelProviderEdit(p.id)}>
                                                                            <X size={12} /> {t('settings.btn_cancel')}
                                                                        </button>
                                                                    </div>
                                                                </div>
                                                            )}
                                                        </td>
                                                        <td>
                                                            {apiEdit ? (
                                                                <select
                                                                    value={apiEdit.billing_type}
                                                                    onChange={e => setProviderEdit(prev => ({ ...prev, [p.id]: { ...apiEdit, billing_type: e.target.value as BillingType } }))}
                                                                    style={{ minWidth: 120 }}
                                                                >
                                                                    <option value="paid">{t('project.billing_paid')}</option>
                                                                    <option value="free">{t('project.billing_free')}</option>
                                                                </select>
                                                            ) : (
                                                                <span className={`billing-badge ${p.billing_type === 'free' ? 'free' : 'paid'}`}>
                                                                    {p.billing_type === 'free' ? t('project.billing_free') : t('project.billing_paid')}
                                                                </span>
                                                            )}
                                                        </td>
                                                        <td>
                                                            <StatusBadge status={health.status} />
                                                            {health?.error && (
                                                                <div style={{ fontSize: '0.68rem', color: 'var(--status-error)', maxWidth: 140, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', marginTop: '0.2rem' }} title={health.error}>
                                                                    {health.error}
                                                                </div>
                                                            )}
                                                        </td>
                                                        <td>
                                                            {(() => {
                                                                const guardian = guardianStates[p.id];
                                                                const currentRpm = guardian?.rpm?.current ?? health.requestsPerMinute ?? 0;
                                                                const limitRpm = guardian?.rpm?.limit ?? (p.billing_type === 'free' ? 15 : 300);
                                                                const rpmPercent = Math.min(100, Math.round((currentRpm / Math.max(1, limitRpm)) * 100));
                                                                const color = rpmPercent > 85 ? '#ef4444' : rpmPercent > 65 ? '#f59e0b' : '#22c55e';

                                                                return (
                                                                    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.35rem', minWidth: 125 }}>
                                                                        <div className="flex items-center justify-between" style={{ fontSize: '0.72rem', fontFamily: 'var(--font-mono)' }}>
                                                                            <span style={{ color: 'var(--text-muted)' }}>RPM</span>
                                                                            <span style={{ fontWeight: 700, color }}>{currentRpm} / {limitRpm}</span>
                                                                        </div>
                                                                        <div style={{ width: '100%', height: 4, borderRadius: 2, background: 'var(--surface-2)', overflow: 'hidden' }}>
                                                                            <div style={{ width: `${Math.max(4, rpmPercent)}%`, height: '100%', background: color, transition: 'width 0.3s' }} />
                                                                        </div>
                                                                        <div className="flex items-center justify-between" style={{ fontSize: '0.68rem', color: 'var(--text-muted)' }}>
                                                                            <span style={{ display: 'inline-flex', alignItems: 'center', gap: '0.2rem' }}>
                                                                                {guardian?.hasKnownLimits ? (
                                                                                    <span style={{ color: '#22c55e', fontSize: '0.65rem', fontWeight: 700 }} title="Verified Provider Limits">✓ Known</span>
                                                                                ) : (
                                                                                    <span style={{ color: 'var(--brand-amber)', fontSize: '0.65rem', fontWeight: 700 }} title="Unverified / Adaptive Probing">⚠ Adapt</span>
                                                                                )}
                                                                                <span>• {guardian?.daily?.requestsToday ?? health.requestsPerDay ?? 0}/{guardian?.daily?.rpdLimit ?? '∞'}</span>
                                                                            </span>
                                                                            <button
                                                                                onClick={() => openRateLimitModal(p)}
                                                                                style={{ background: 'none', border: 'none', color: 'var(--accent-primary)', cursor: 'pointer', padding: 0, textDecoration: 'underline', fontSize: '0.68rem', fontWeight: 600 }}
                                                                            >
                                                                                Limits ✎
                                                                            </button>
                                                                        </div>
                                                                        {guardian?.dynamicSafeRpm && (
                                                                            <div style={{ fontSize: '0.62rem', color: 'var(--brand-amber)', fontWeight: 600, fontFamily: 'var(--font-mono)' }}>
                                                                                Safe RPM: {guardian.dynamicSafeRpm} (Derated)
                                                                            </div>
                                                                        )}
                                                                    </div>
                                                                );
                                                            })()}
                                                        </td>
                                                        <td>
                                                            {isEditing ? (
                                                                <div className="ctx-edit-row">
                                                                    <input
                                                                        className="ctx-edit-input"
                                                                        type="number" min={100} step={500}
                                                                        autoFocus
                                                                        value={ctxLimitEdit[p.id] ?? ''}
                                                                        onChange={e => setCtxLimitEdit(prev => ({ ...prev, [p.id]: e.target.value }))}
                                                                        onKeyDown={e => {
                                                                            if (e.key === 'Enter') handleSaveContextLimit(p.id);
                                                                            if (e.key === 'Escape') setCtxLimitEdit(prev => ({ ...prev, [p.id]: null }));
                                                                        }}
                                                                        placeholder="e.g. 8000"
                                                                    />
                                                                    <button className="ctx-edit-save" onClick={() => handleSaveContextLimit(p.id)} title="Save">✓</button>
                                                                    <button className="ctx-edit-cancel" onClick={() => setCtxLimitEdit(prev => ({ ...prev, [p.id]: null }))} title="Cancel">✕</button>
                                                                </div>
                                                            ) : (
                                                                <CtxPill
                                                                    value={p.max_context_tokens}
                                                                    onClick={() => setCtxLimitEdit(prev => ({ ...prev, [p.id]: p.max_context_tokens != null ? String(p.max_context_tokens) : '' }))}
                                                                />
                                                            )}
                                                        </td>
                                                        <td>
                                                            {/* Output Token Limit pill */}
                                                            <button
                                                                className={`ctx-pill ${p.max_output_tokens != null && p.max_output_tokens > 0 ? 'has-limit' : ''}`}
                                                                onClick={() => openTokenLimitModal('single', p.id, p.provider)}
                                                                title={p.max_output_tokens ? `Output cap: ${p.max_output_tokens.toLocaleString()} tokens — click to edit` : 'No cap (uses gateway default 16k) — click to set'}
                                                            >
                                                                {p.max_output_tokens && p.max_output_tokens > 0
                                                                    ? `${(p.max_output_tokens / 1000).toFixed(0)}K out`
                                                                    : '∞ Default'}
                                                                <span style={{ fontSize: '0.6rem', opacity: 0.7 }}>✎</span>
                                                            </button>
                                                        </td>
                                                        <td>
                                                            <div className="flex gap-2">
                                                                <button
                                                                    onClick={() => handlePingSingleKey(p.id)}
                                                                    className="btn btn-secondary btn-icon btn-sm"
                                                                    title="Ping Latency Test (1 token)"
                                                                    disabled={testProviderResults[p.id]?.testing}
                                                                >
                                                                    {testProviderResults[p.id]?.testing ? (
                                                                        <span className="spinner-ring" style={{ width: 12, height: 12, borderWidth: 1.5 }} />
                                                                    ) : (
                                                                        <Zap size={13} style={{ color: 'var(--brand-amber)' }} />
                                                                    )}
                                                                </button>
                                                                <button onClick={() => handleStartProviderEdit(p)} className="btn btn-secondary btn-icon btn-sm" title={t('project.edit_provider')}>
                                                                    <Edit2 size={13} />
                                                                </button>
                                                                {health.status === 'paused' ? (
                                                                    <button onClick={() => handleResetProvider(p.id)} className="btn btn-success btn-sm" title="Resume provider">
                                                                        <Play size={13} /> Resume
                                                                    </button>
                                                                ) : (
                                                                    <button onClick={() => handlePauseProvider(p.id)} className="btn btn-warning btn-sm" title="Pause provider">
                                                                        <Pause size={13} /> Pause
                                                                    </button>
                                                                )}
                                                                <button onClick={() => handleResetProvider(p.id)} className="btn btn-secondary btn-icon btn-sm" title="Force Reset">
                                                                    <RefreshCw size={13} />
                                                                </button>
                                                                <button onClick={() => handleDeleteProvider(p.id)} className="btn btn-danger btn-icon btn-sm" title="Delete">
                                                                    <Trash2 size={13} />
                                                                </button>
                                                            </div>
                                                        </td>
                                                    </tr>
                                                );
                                            })}
                                        </tbody>
                                    </table>
                                </div>
                            </>
                            )}
                        </div>
                    </div>
                </div>
            )}

            {/* ═══ TAB: GATEWAY KEYS ═══ */}
            {activeTab === 'gateway' && (
                <div className="side-panel-layout">
                    {/* Create Gateway Form */}
                    <div className="glass-panel">
                        <div className="section-label" style={{ marginBottom: '1.25rem' }}>
                            <KeyRound size={11} /> {t('project.create_gateway')}
                        </div>
                        <form onSubmit={handleCreateGateway}>
                            <div className="form-group">
                                <label>{t('project.key_name')}</label>
                                <input
                                    type="text"
                                    value={newGateway.key_name}
                                    onChange={e => setNewGateway({ ...newGateway, key_name: e.target.value })}
                                    placeholder="Agent Rocky"
                                    required
                                />
                            </div>
                            <div className="form-group">
                                <label>{t('project.custom_key')} <span style={{ color: 'var(--text-muted)', fontWeight: 400 }}>(optional)</span></label>
                                <input
                                    type="text"
                                    value={newGateway.custom_key}
                                    onChange={e => setNewGateway({ ...newGateway, custom_key: e.target.value })}
                                    placeholder={t('project.custom_key_ph')}
                                />
                            </div>

                            <div style={{ marginBottom: '1.25rem' }}>
                                <label style={{ display: 'block', marginBottom: '0.5rem', fontSize: '0.78rem', fontWeight: 700, color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.07em' }}>
                                    {t('project.select_models')}
                                </label>
                                {renderModelSelector()}
                            </div>

                            <button type="submit" className="btn btn-primary w-full">
                                <Plus size={15} /> {t('project.btn_create_key')}
                            </button>
                        </form>
                    </div>

                    {/* Gateway Keys List */}
                    <div>
                        <div className="glass-panel">
                            <div className="flex justify-between items-center" style={{ marginBottom: '1.25rem' }}>
                                <div className="section-label" style={{ marginBottom: 0 }}>
                                    <Zap size={11} /> {t('project.active_gateways')} ({gateways.length})
                                </div>
                                <input
                                    type="text"
                                    placeholder="Buscar claves gateway..."
                                    value={gatewaySearch}
                                    onChange={e => setGatewaySearch(e.target.value)}
                                    style={{ width: '200px', padding: '0.4rem 0.6rem', borderRadius: 'var(--radius-md)', border: '1px solid var(--border-default)', background: 'var(--bg-primary)', color: 'var(--text-primary)', fontSize: '0.8rem' }}
                                />
                            </div>

                            {gateways.length === 0 ? (
                                <div className="empty-state">
                                    <div className="empty-state-icon"><KeyRound size={24} /></div>
                                    <h3>{t('project.no_gateways')}</h3>
                                    <p>Create your first gateway key to start routing requests.</p>
                                </div>
                            ) : (
                                <div style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
                                    {gateways.filter(g => g.key_name.toLowerCase().includes(gatewaySearch.toLowerCase())).map((g, index) => (
                                        <div key={g.id} style={{
                                            border: '1px solid var(--border-default)', borderRadius: 'var(--radius-lg)',
                                            padding: '1.25rem', background: 'var(--bg-secondary)', position: 'relative', overflow: 'hidden',
                                            transition: 'border-color 0.2s',
                                        }}
                                            onMouseEnter={e => (e.currentTarget.style.borderColor = 'rgba(99, 102, 241, 0.35)')}
                                            onMouseLeave={e => (e.currentTarget.style.borderColor = 'var(--border-default)')}
                                        >
                                            <div style={{ position: 'absolute', top: 0, left: 0, right: 0, height: 2, background: 'var(--accent-gradient)', opacity: 0.5 }} />

                                            {/* Header */}
                                            <div className="flex justify-between items-center" style={{ marginBottom: '1rem' }}>
                                                <div className="flex items-center gap-2">
                                                    <div style={{
                                                        width: 28, height: 28, borderRadius: 'var(--radius-sm)',
                                                        background: 'rgba(99, 102, 241, 0.1)', border: '1px solid rgba(99, 102, 241, 0.25)',
                                                        display: 'flex', alignItems: 'center', justifyContent: 'center',
                                                        fontSize: '0.65rem', fontWeight: 800, fontFamily: 'var(--font-mono)', color: 'var(--accent-primary)',
                                                    }}>
                                                        {index + 1}
                                                    </div>
                                                    <h4 style={{ margin: 0, fontSize: '1rem', fontWeight: 700 }}>{g.key_name}</h4>
                                                </div>
                                                <button onClick={() => handleDeleteGateway(g.id)} className="btn btn-danger btn-sm">
                                                    <Trash2 size={13} /> Delete
                                                </button>
                                            </div>

                                            {/* API Key */}
                                            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '1rem' }}>
                                                <code className="key-display" style={{ flex: 1, margin: 0 }}>{g.api_key || g.key_preview || '•••'}</code>
                                                <button
                                                    type="button"
                                                    className="btn btn-secondary btn-sm"
                                                    style={{ padding: '0.35rem 0.6rem', fontSize: '0.75rem', display: 'flex', alignItems: 'center', gap: '0.3rem' }}
                                                    onClick={async () => {
                                                        let keyToCopy = g.api_key;
                                                        if (!keyToCopy) {
                                                            try {
                                                                const rev = await fetchApi(`/gateway-keys/${g.id}/reveal`);
                                                                keyToCopy = rev?.api_key;
                                                            } catch { /* skip */ }
                                                        }
                                                        if (keyToCopy) {
                                                            navigator.clipboard.writeText(keyToCopy);
                                                            toast.success('Clave copiada al portapapeles');
                                                        } else {
                                                            toast.error('No se pudo copiar la clave');
                                                        }
                                                    }}
                                                    title="Copiar API Key"
                                                >
                                                    <Copy size={13} />
                                                </button>
                                            </div>

                                            {/* Models */}
                                            <div style={{ marginBottom: '1rem' }}>
                                                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '0.5rem', marginBottom: '0.5rem' }}>
                                                    <div style={{ fontSize: '0.72rem', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.08em' }}>
                                                        {t('project.allowed_models')} ({Array.from(new Set(g.gateway_key_models?.map(m => m.model_name))).length})
                                                    </div>
                                                    <button
                                                        id={`btn-sync-models-${g.id}`}
                                                        type="button"
                                                        onClick={handleAutoDiscover}
                                                        disabled={discovering}
                                                        className="btn btn-secondary btn-sm"
                                                        style={{ display: 'inline-flex', alignItems: 'center', gap: '0.4rem', borderColor: 'var(--accent-primary)', color: 'var(--accent-primary)', fontSize: '0.72rem', padding: '0.2rem 0.6rem' }}
                                                        title="Sondea y auto-agrega los modelos activos de las llaves del proyecto"
                                                    >
                                                        <Zap size={11} className={discovering ? 'spin' : ''} />
                                                        {discovering ? t('healing.discovering') : t('healing.btn_auto_discover')}
                                                    </button>
                                                </div>
                                                <div style={{ display: 'flex', gap: '0.4rem', flexWrap: 'wrap' }}>
                                                    {Array.from(new Set(g.gateway_key_models?.map(m => m.model_name))).map((modelName: any, i) => (
                                                        <span key={i} className="model-tag">
                                                            {modelName}
                                                            <button className="model-tag-remove" onClick={() => handleDeleteModelFromGateway(g.id, modelName)}>✕</button>
                                                        </span>
                                                    ))}
                                                </div>

                                                {(availableModels.length > 0 || providers.length > 0) && (
                                                    <div style={{ marginTop: '0.75rem' }}>
                                                        {!expandedAddModels[g.id] ? (
                                                            <button onClick={() => setExpandedAddModels(prev => ({ ...prev, [g.id]: true }))} className="btn btn-ghost btn-sm">
                                                                <Plus size={12} /> Add Models
                                                            </button>
                                                        ) : (
                                                            <div className="flex gap-2" style={{ alignItems: 'flex-start', flexDirection: 'column' }}>
                                                                <input
                                                                    type="text"
                                                                    placeholder="Buscar o escribir nombre de modelo (ej. fusion, mimo-v2.6-flash)..."
                                                                    value={addModelSearch[g.id] || ''}
                                                                    onChange={e => setAddModelSearch(prev => ({ ...prev, [g.id]: e.target.value }))}
                                                                    onKeyDown={e => {
                                                                        if (e.key === 'Enter' && addModelSearch[g.id]?.trim()) {
                                                                            e.preventDefault();
                                                                            handleAddCustomModelToGateway(g.id);
                                                                        }
                                                                    }}
                                                                    style={{ width: '100%', padding: '0.5rem', borderRadius: 'var(--radius-md)', border: '1px solid var(--border-default)', background: 'var(--bg-primary)', color: 'var(--text-primary)', fontSize: '0.8rem' }}
                                                                />
                                                                {addModelSearch[g.id]?.trim() && (
                                                                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', width: '100%', marginTop: '0.2rem' }}>
                                                                        <button
                                                                            type="button"
                                                                            onClick={() => handleAddCustomModelToGateway(g.id)}
                                                                            className="btn btn-secondary btn-sm"
                                                                            style={{ fontSize: '0.75rem', borderColor: 'var(--accent-primary)', color: 'var(--accent-primary)' }}
                                                                        >
                                                                            ➕ Agregar "{addModelSearch[g.id]?.trim()}" manualmente
                                                                        </button>
                                                                    </div>
                                                                )}
                                                                {availableModels.length > 0 && (
                                                                    <div className="flex gap-2" style={{ width: '100%', alignItems: 'flex-start', marginTop: '0.25rem' }}>
                                                                        <select multiple
                                                                            value={gatewayKeyBulkModels[g.id] || []}
                                                                            onChange={e => setGatewayKeyBulkModels(prev => ({ ...prev, [g.id]: Array.from(e.target.selectedOptions, o => o.value) }))}
                                                                            style={{ flex: 1, height: 110, padding: '0.4rem', borderRadius: 'var(--radius-md)', border: '1px solid var(--border-default)', background: 'var(--bg-tertiary)', color: 'var(--text-primary)', fontSize: '0.8rem', fontFamily: 'var(--font-mono)' }}
                                                                        >
                                                                            {Array.from(new Set(availableModels.flatMap(am => am.models?.map((m: any) => m.id || m) || []))).sort()
                                                                                .filter(mid => !g.gateway_key_models?.some(gm => gm.model_name === mid))
                                                                                .filter(mid => mid.toLowerCase().includes((addModelSearch[g.id] || '').toLowerCase()))
                                                                                .map(mid => <option key={mid} value={mid}>{mid}</option>)}
                                                                        </select>
                                                                        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem' }}>
                                                                            <button onClick={() => { handleAddModelsToGateway(g.id); setExpandedAddModels(prev => ({ ...prev, [g.id]: false })); }} className="btn btn-primary btn-sm">Add Selected</button>
                                                                            <button onClick={() => setExpandedAddModels(prev => ({ ...prev, [g.id]: false }))} className="btn btn-secondary btn-sm">Close</button>
                                                                        </div>
                                                                    </div>
                                                                )}
                                                            </div>
                                                        )}
                                                    </div>
                                                )}
                                            </div>

                                            {/* Test section */}
                                            <div style={{ borderTop: '1px solid var(--border-subtle)', paddingTop: '1rem' }}>
                                                <div className="section-label" style={{ marginBottom: '0.75rem' }}>
                                                    <Zap size={10} /> {t('project.test_gateway')}
                                                </div>
                                                {/* Model selector */}
                                                <select
                                                    value={testModels[g.id] || ''}
                                                    onChange={e => setTestModels(prev => ({ ...prev, [g.id]: e.target.value }))}
                                                    style={{ width: '100%', marginBottom: '0.5rem', padding: '0.5rem 0.75rem', borderRadius: 'var(--radius-md)', border: '1px solid var(--border-default)', background: 'var(--bg-primary)', color: 'var(--text-primary)', fontSize: '0.82rem', fontFamily: 'var(--font-mono)', outline: 'none' }}
                                                >
                                                    <option value="">{t('project.select_model_ph')}</option>
                                                    {Array.from(new Set(g.gateway_key_models?.map(m => m.model_name))).map((mn: any, i) => (
                                                        <option key={i} value={mn}>{mn}</option>
                                                    ))}
                                                </select>

                                                {/* ── STT: record or upload audio ── */}
                                                {isSttModel(testModels[g.id] || g.gateway_key_models?.[0]?.model_name || '') ? (
                                                    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem', marginBottom: '0.5rem' }}>
                                                        <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
                                                            {/* Mic button */}
                                                            {!audioRecording[g.id] ? (
                                                                <button
                                                                    onClick={() => startRecording(g.id)}
                                                                    className="btn btn-sm"
                                                                    style={{ background: 'rgba(239,68,68,0.12)', border: '1px solid rgba(239,68,68,0.35)', color: '#f87171', display: 'flex', alignItems: 'center', gap: '0.4rem', whiteSpace: 'nowrap' }}
                                                                >
                                                                    🎙️ Grabar
                                                                </button>
                                                            ) : (
                                                                <button
                                                                    onClick={() => stopRecording(g.id)}
                                                                    className="btn btn-sm"
                                                                    style={{ background: 'rgba(239,68,68,0.25)', border: '1px solid rgba(239,68,68,0.6)', color: '#ef4444', display: 'flex', alignItems: 'center', gap: '0.4rem', animation: 'pulse 1s infinite', whiteSpace: 'nowrap' }}
                                                                >
                                                                    ⏹ Detener
                                                                </button>
                                                            )}
                                                            {/* File upload */}
                                                            <label style={{ flex: 1, cursor: 'pointer', border: '1px dashed var(--border-default)', borderRadius: 'var(--radius-md)', padding: '0.45rem 0.75rem', fontSize: '0.78rem', color: 'var(--text-muted)', background: 'var(--bg-primary)', textAlign: 'center', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                                                {audioFiles[g.id] ? `📎 ${audioFiles[g.id]!.name}` : '+ Subir audio (mp3/wav/webm)'}
                                                                <input type="file" accept="audio/*" style={{ display: 'none' }} onChange={e => {
                                                                    const file = e.target.files?.[0] || null;
                                                                    setAudioFiles(prev => ({ ...prev, [g.id]: file }));
                                                                }} />
                                                            </label>
                                                        </div>
                                                        {/* Audio preview */}
                                                        {audioFiles[g.id] && (
                                                            <audio controls src={URL.createObjectURL(audioFiles[g.id]!)} style={{ width: '100%', height: 32 }} />
                                                        )}
                                                    </div>
                                                ) : isTtsModel(testModels[g.id] || g.gateway_key_models?.[0]?.model_name || '') ? (
                                                    /* ── TTS: text input + voice selector ── */
                                                    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem', marginBottom: '0.5rem' }}>
                                                        <textarea
                                                            placeholder="Texto a convertir en voz..."
                                                            value={testPrompts[g.id] || ''}
                                                            onChange={e => setTestPrompts(prev => ({ ...prev, [g.id]: e.target.value }))}
                                                            style={{ width: '100%', padding: '0.625rem 0.75rem', borderRadius: 'var(--radius-md)', border: '1px solid var(--border-default)', background: 'var(--bg-primary)', color: 'var(--text-primary)', minHeight: 64, fontSize: '0.875rem', fontFamily: 'var(--font-sans)', resize: 'vertical', outline: 'none' }}
                                                        />
                                                        <select
                                                            value={ttsVoice[g.id] || 'alloy'}
                                                            onChange={e => setTtsVoice(prev => ({ ...prev, [g.id]: e.target.value }))}
                                                            style={{ width: '100%', padding: '0.45rem 0.75rem', borderRadius: 'var(--radius-md)', border: '1px solid var(--border-default)', background: 'var(--bg-primary)', color: 'var(--text-primary)', fontSize: '0.82rem', outline: 'none' }}
                                                        >
                                                            <option value="alloy">alloy</option>
                                                            <option value="echo">echo</option>
                                                            <option value="fable">fable</option>
                                                            <option value="onyx">onyx</option>
                                                            <option value="nova">nova</option>
                                                            <option value="shimmer">shimmer</option>
                                                        </select>
                                                    </div>
                                                ) : (
                                                    /* ── Chat: text prompt ── */
                                                    <textarea
                                                        placeholder={t('project.test_prompt_ph')}
                                                        value={testPrompts[g.id] || ''}
                                                        onChange={e => setTestPrompts(prev => ({ ...prev, [g.id]: e.target.value }))}
                                                        style={{ width: '100%', padding: '0.625rem 0.75rem', borderRadius: 'var(--radius-md)', border: '1px solid var(--border-default)', background: 'var(--bg-primary)', color: 'var(--text-primary)', minHeight: 64, marginBottom: '0.5rem', fontSize: '0.875rem', fontFamily: 'var(--font-sans)', resize: 'vertical', outline: 'none' }}
                                                    />
                                                )}

                                                <button onClick={() => handleTestKey(g)} className="btn btn-primary w-full" disabled={testLoading[g.id]}>
                                                    {testLoading[g.id] ? <><span className="spinner-ring" style={{ width: 14, height: 14, borderWidth: 2 }} /> {t('project.btn_testing')}</> : <><Zap size={14} /> {t('project.btn_test')}</>}
                                                </button>

                                                {/* ── Test results ── */}
                                                {testResults[g.id] && renderTestResult(g.id)}
                                            </div>
                                        </div>
                                    ))}
                                </div>
                            )}
                        </div>
                    </div>
                </div>
            )}

            {/* ═══ TAB: ANALYTICS ═══ */}
            {activeTab === 'analytics' && (
                <div>
                    <div className="flex justify-end gap-2" style={{ marginBottom: '1.5rem' }}>
                        <button onClick={handleExportAnalytics} className="btn btn-secondary">
                            <Download size={14} /> {t('project.analytics.export')}
                        </button>
                        <button onClick={handleClearAnalytics} className="btn btn-danger">
                            <AlertTriangle size={14} /> {t('project.analytics.clear')}
                        </button>
                    </div>

                    <div className="stats-row" style={{ marginBottom: '1.5rem' }}>
                        <div className="stat-card">
                            <div className="stat-label"><Activity size={10} /> {t('project.analytics.total_reqs')}</div>
                            <div className="stat-value white">{analyticsData?.stats?.totalRequests || 0}</div>
                        </div>
                        <div className="stat-card">
                            <div className="stat-label"><CheckCircle2 size={10} /> {t('project.analytics.success_rate')}</div>
                            <div className="stat-value green">{analyticsData?.stats?.successRate || 0}%</div>
                        </div>
                        <div className="stat-card">
                            <div className="stat-label"><Cpu size={10} /> {t('project.analytics.tokens')}</div>
                            <div className="stat-value amber">{(analyticsData?.stats?.totalTokens || 0).toLocaleString()}</div>
                        </div>
                        <div className="stat-card">
                            <div className="stat-label"><Shield size={10} /> {t('project.analytics.cost')}</div>
                            <div className="stat-value white">${Number(analyticsData?.stats?.totalCostUsd || 0).toFixed(4)}</div>
                        </div>
                        <div className="stat-card">
                            <div className="stat-label"><Clock size={10} /> {t('project.analytics.latency')}</div>
                            <div className="stat-value orange">{analyticsData?.stats?.averageLatency || 0}<span style={{ fontSize: '1rem', fontWeight: 500, color: 'var(--text-muted)' }}>ms</span></div>
                        </div>
                    </div>

                    {(isBudgetWarning || isBudgetExceeded) && (
                        <div
                            style={{
                                marginBottom: '1.5rem',
                                padding: '0.9rem 1rem',
                                borderRadius: '12px',
                                border: isBudgetExceeded ? '1px solid rgba(239,68,68,0.35)' : '1px solid rgba(255,170,0,0.35)',
                                background: isBudgetExceeded ? 'rgba(239,68,68,0.10)' : 'rgba(255,170,0,0.10)',
                                color: isBudgetExceeded ? '#fecaca' : '#fde68a',
                            }}
                        >
                            <div style={{ fontWeight: 700, marginBottom: '0.2rem' }}>
                                {isBudgetExceeded ? t('project.analytics.limit_reached') : t('project.analytics.warning_threshold')}
                            </div>
                            <div style={{ fontFamily: 'var(--font-mono)', fontSize: '0.82rem' }}>
                                Spent ${totalCostUsd.toFixed(4)} / ${budgetUsd?.toFixed(2)} ({budgetUsagePct.toFixed(1)}%)
                            </div>
                        </div>
                    )}

                    <div className="flex gap-4" style={{ marginBottom: '1.5rem', flexWrap: 'wrap' }}>
                        <div className="glass-panel" style={{ flex: 1, minWidth: 260 }}>
                            <div className="section-label"><Shield size={11} /> {t('project.analytics.budget')}</div>
                            <div style={{ display: 'grid', gap: '0.8rem' }}>
                                <div className="flex gap-3 items-end" style={{ flexWrap: 'wrap' }}>
                                    <div style={{ flex: 1, minWidth: 180 }}>
                                        <label style={{ display: 'block', fontSize: '0.75rem', color: 'var(--text-muted)', marginBottom: '0.35rem' }}>
                                            USD
                                        </label>
                                        <input
                                            type="number"
                                            min="0"
                                            step="0.01"
                                            value={budgetInput}
                                            onChange={e => setBudgetInput(e.target.value)}
                                            placeholder="0.00"
                                            style={{ marginBottom: 0 }}
                                        />
                                    </div>
                                    <div style={{ width: 160 }}>
                                        <label style={{ display: 'block', fontSize: '0.75rem', color: 'var(--text-muted)', marginBottom: '0.35rem' }}>
                                            {t('project.analytics.alert_threshold')}
                                        </label>
                                        <input
                                            type="number"
                                            min="1"
                                            max="100"
                                            step="1"
                                            value={budgetAlertThresholdInput}
                                            onChange={e => setBudgetAlertThresholdInput(e.target.value)}
                                            placeholder="80"
                                            style={{ marginBottom: 0 }}
                                        />
                                    </div>
                                    <button className="btn btn-secondary" onClick={handleSaveBudget}>
                                        {t('project.analytics.save_budget')}
                                    </button>
                                </div>
                                <div style={{ display: 'flex', gap: '1rem', flexWrap: 'wrap', fontFamily: 'var(--font-mono)', fontSize: '0.82rem' }}>
                                    <span>Spent: ${totalCostUsd.toFixed(4)}</span>
                                    <span>Budget: {budgetUsd != null ? `$${budgetUsd.toFixed(2)}` : '—'}</span>
                                    <span>{t('project.analytics.remaining')}: {budgetUsd != null ? `$${Math.max(budgetUsd - totalCostUsd, 0).toFixed(4)}` : '—'}</span>
                                    <span>Usage: {budgetUsd != null ? `${budgetUsagePct.toFixed(1)}%` : '—'}</span>
                                </div>
                            </div>
                        </div>

                        <div className="glass-panel" style={{ flex: 2, minWidth: 320 }}>
                            <div className="flex justify-between items-center" style={{ marginBottom: '0.75rem', gap: '0.75rem', flexWrap: 'wrap' }}>
                                <div className="section-label" style={{ marginBottom: 0 }}><Cpu size={11} /> {t('project.analytics.model_pricing')}</div>
                                <button className="btn btn-secondary btn-sm" type="button" onClick={handleSyncLiteLlmPricing} disabled={pricingSyncing}>
                                    <RefreshCw size={14} className={pricingSyncing ? 'spin' : ''} />
                                    {pricingSyncing ? 'Syncing...' : 'Sync LiteLLM'}
                                </button>
                            </div>
                            {pricingSyncSummary && (
                                <div style={{ color: 'var(--text-muted)', fontSize: '0.78rem', marginBottom: '0.75rem' }}>
                                    {pricingSyncSummary}
                                </div>
                            )}
                            <form onSubmit={handleSavePricing} style={{ display: 'grid', gridTemplateColumns: '1fr 1.5fr 1fr 1fr auto', gap: '0.65rem', marginBottom: '1rem', alignItems: 'end' }}>
                                <div>
                                    <label style={{ display: 'block', fontSize: '0.75rem', color: 'var(--text-muted)', marginBottom: '0.35rem' }}>Provider</label>
                                    <input value={pricingForm.provider} onChange={e => setPricingForm(prev => ({ ...prev, provider: e.target.value }))} placeholder="*" style={{ marginBottom: 0 }} />
                                </div>
                                <div>
                                    <label style={{ display: 'block', fontSize: '0.75rem', color: 'var(--text-muted)', marginBottom: '0.35rem' }}>Model</label>
                                    <input value={pricingForm.model_name} onChange={e => setPricingForm(prev => ({ ...prev, model_name: e.target.value }))} placeholder="gpt-4o-mini" style={{ marginBottom: 0 }} />
                                </div>
                                <div>
                                    <label style={{ display: 'block', fontSize: '0.75rem', color: 'var(--text-muted)', marginBottom: '0.35rem' }}>{t('project.analytics.input_price')}</label>
                                    <input type="number" min="0" step="0.000001" value={pricingForm.input_price_per_1m} onChange={e => setPricingForm(prev => ({ ...prev, input_price_per_1m: e.target.value }))} placeholder="0.150000" style={{ marginBottom: 0 }} />
                                </div>
                                <div>
                                    <label style={{ display: 'block', fontSize: '0.75rem', color: 'var(--text-muted)', marginBottom: '0.35rem' }}>{t('project.analytics.output_price')}</label>
                                    <input type="number" min="0" step="0.000001" value={pricingForm.output_price_per_1m} onChange={e => setPricingForm(prev => ({ ...prev, output_price_per_1m: e.target.value }))} placeholder="0.600000" style={{ marginBottom: 0 }} />
                                </div>
                                <button className="btn btn-secondary" type="submit">
                                    {t('project.analytics.add_pricing')}
                                </button>
                            </form>

                            <div className="table-wrapper" style={{ maxHeight: 260 }}>
                                <table className="data-table">
                                    <thead>
                                        <tr>
                                            <th>Provider</th>
                                            <th>Model</th>
                                            <th>{t('project.analytics.input_price')}</th>
                                            <th>{t('project.analytics.output_price')}</th>
                                            <th>Source</th>
                                            <th>Actions</th>
                                        </tr>
                                    </thead>
                                    <tbody>
                                        {pricingEntries.length === 0 ? (
                                            <tr>
                                                <td colSpan={6} style={{ textAlign: 'center', color: 'var(--text-muted)', padding: '1.25rem' }}>No pricing rules yet.</td>
                                            </tr>
                                        ) : pricingEntries.map((entry) => (
                                            <tr key={entry.id}>
                                                <td>{entry.provider === '*' ? t('project.analytics.any_provider') : entry.provider}</td>
                                                <td style={{ fontFamily: 'var(--font-mono)', fontSize: '0.75rem' }}>{entry.model_name}</td>
                                                <td style={{ fontFamily: 'var(--font-mono)' }}>{Number(entry.input_price_per_1m || 0).toFixed(6)}</td>
                                                <td style={{ fontFamily: 'var(--font-mono)' }}>{Number(entry.output_price_per_1m || 0).toFixed(6)}</td>
                                                <td style={{ color: 'var(--text-muted)', fontSize: '0.75rem' }}>
                                                    {entry.is_manual_override ? 'manual' : (entry.source || 'manual')}
                                                </td>
                                                <td>
                                                    <div className="flex gap-2">
                                                        <button className="btn btn-secondary" style={{ padding: '0.35rem 0.55rem' }} onClick={() => handleEditPricing(entry)}>Edit</button>
                                                        <button className="btn btn-danger" style={{ padding: '0.35rem 0.55rem' }} onClick={() => handleDeletePricing(entry.id)}>Delete</button>
                                                    </div>
                                                </td>
                                            </tr>
                                        ))}
                                    </tbody>
                                </table>
                            </div>
                        </div>
                    </div>

                    <div className="flex gap-4" style={{ marginBottom: '1.5rem', flexWrap: 'wrap' }}>
                        <div className="glass-panel" style={{ flex: 1, minWidth: 240 }}>
                            <div className="section-label"><Server size={11} /> {t('project.analytics.top_providers')}</div>
                            {analyticsData?.providerUsage ? (
                                <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
                                    {Object.entries(analyticsData.providerUsage).map(([prov, count]: any) => {
                                        const total = Object.values(analyticsData.providerUsage).reduce((a: any, b: any) => a + b, 0) as number;
                                        const pct = total > 0 ? Math.round((count / total) * 100) : 0;
                                        return (
                                            <li key={prov} style={{ marginBottom: '0.875rem' }}>
                                                <div className="flex justify-between items-center" style={{ marginBottom: '0.3rem' }}>
                                                    <ProviderChip provider={prov} />
                                                    <span style={{ fontFamily: 'var(--font-mono)', fontSize: '0.8rem', color: 'var(--accent-primary)', fontWeight: 600 }}>
                                                        {count} <span style={{ color: 'var(--text-muted)', fontWeight: 400 }}>reqs</span>
                                                    </span>
                                                </div>
                                                <div className="progress-bar"><div className="progress-fill" style={{ width: `${pct}%` }} /></div>
                                            </li>
                                        );
                                    })}
                                </ul>
                            ) : <p style={{ color: 'var(--text-muted)', fontSize: '0.875rem' }}>{t('project.analytics.no_provider_data')}</p>}
                        </div>

                        <div className="glass-panel" style={{ flex: 1, minWidth: 240 }}>
                            <div className="section-label"><Cpu size={11} /> {t('project.analytics.top_models')}</div>
                            {analyticsData?.modelUsage ? (
                                <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
                                    {Object.entries(analyticsData.modelUsage).map(([mod, count]: any) => {
                                        const total = Object.values(analyticsData.modelUsage).reduce((a: any, b: any) => a + b, 0) as number;
                                        const pct = total > 0 ? Math.round((count / total) * 100) : 0;
                                        return (
                                            <li key={mod} style={{ marginBottom: '0.875rem' }}>
                                                <div className="flex justify-between items-center" style={{ marginBottom: '0.3rem' }}>
                                                    <span style={{ fontFamily: 'var(--font-mono)', fontSize: '0.75rem', color: 'var(--text-secondary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '60%' }}>{mod}</span>
                                                    <span style={{ fontFamily: 'var(--font-mono)', fontSize: '0.8rem', color: 'var(--brand-amber)', fontWeight: 600, flexShrink: 0 }}>
                                                        {count} <span style={{ color: 'var(--text-muted)', fontWeight: 400 }}>reqs</span>
                                                    </span>
                                                </div>
                                                <div className="progress-bar">
                                                    <div className="progress-fill" style={{ width: `${pct}%`, background: 'linear-gradient(90deg, #6366f1, #06b6d4)' }} />
                                                </div>
                                            </li>
                                        );
                                    })}
                                </ul>
                            ) : <p style={{ color: 'var(--text-muted)', fontSize: '0.875rem' }}>{t('project.analytics.no_model_data')}</p>}
                        </div>
                    </div>

                    {/* Recent requests */}
                    <div className="glass-panel">
                        <div className="section-label"><Activity size={11} /> {t('project.analytics.recent_requests') || 'Recent Requests'}</div>
                        <div className="table-wrapper" style={{ maxHeight: 380 }}>
                            <table className="data-table">
                                <thead>
                                    <tr>
                                        <th>Time</th>
                                        <th>Provider</th>
                                        <th>Model</th>
                                        <th>Status</th>
                                        <th>Input</th>
                                        <th>Output</th>
                                        <th>Latency</th>
                                        <th>Tokens</th>
                                        <th>Cost</th>
                                        <th>Error</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {recentRequests.length === 0 ? (
                                        <tr>
                                            <td colSpan={10} style={{ textAlign: 'center', color: 'var(--text-muted)', padding: '2.5rem' }}>No recent requests.</td>
                                        </tr>
                                    ) : recentRequests.map((req: any) => (
                                        <tr key={req.id}>
                                            <td style={{ fontFamily: 'var(--font-mono)', whiteSpace: 'nowrap', color: 'var(--text-muted)', fontSize: '0.75rem' }}>
                                                {new Date(req.created_at).toLocaleString([], { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })}
                                            </td>
                                            <td>{req.provider ? <ProviderChip provider={req.provider} /> : '—'}</td>
                                            <td style={{ fontFamily: 'var(--font-mono)', fontSize: '0.75rem', color: 'var(--text-secondary)', maxWidth: 160, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{req.model}</td>
                                            <td>
                                                <span style={{
                                                    display: 'inline-flex', alignItems: 'center',
                                                    padding: '0.15rem 0.5rem', borderRadius: 'var(--radius-pill)',
                                                    fontSize: '0.72rem', fontWeight: 700, fontFamily: 'var(--font-mono)',
                                                    background: (req.status_code || 200) < 400 ? 'rgba(34,197,94,0.1)' : 'rgba(239,68,68,0.1)',
                                                    color: (req.status_code || 200) < 400 ? '#22c55e' : '#ef4444',
                                                    border: `1px solid ${(req.status_code || 200) < 400 ? 'rgba(34,197,94,0.25)' : 'rgba(239,68,68,0.25)'}`,
                                                }}>
                                                    {req.status_code || (req.status === 'success' ? 200 : 500)}
                                                </span>
                                            </td>
                                            <td style={{ fontFamily: 'var(--font-mono)', fontSize: '0.8rem', color: 'var(--text-muted)' }}>
                                                {typeof req.prompt_tokens === 'number' ? req.prompt_tokens.toLocaleString() : '—'}
                                            </td>
                                            <td style={{ fontFamily: 'var(--font-mono)', fontSize: '0.8rem', color: 'var(--text-muted)' }}>
                                                {typeof req.completion_tokens === 'number' ? req.completion_tokens.toLocaleString() : '—'}
                                            </td>
                                            <td style={{ fontFamily: 'var(--font-mono)', fontSize: '0.8rem', color: req.latency_ms > 5000 ? 'var(--brand-amber)' : 'var(--text-secondary)' }}>{req.latency_ms}ms</td>
                                            <td style={{ fontFamily: 'var(--font-mono)', fontSize: '0.8rem', color: 'var(--text-muted)' }}>{req.total_tokens ? req.total_tokens.toLocaleString() : '—'}</td>
                                            <td style={{ fontFamily: 'var(--font-mono)', fontSize: '0.8rem', color: 'var(--text-muted)' }}>
                                                ${Number(req.total_cost_usd || 0).toFixed(6)}
                                            </td>
                                            <td style={{ maxWidth: 160, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: '#ef4444', fontSize: '0.72rem', fontFamily: 'var(--font-mono)' }} title={req.error_message || ''}>
                                                {req.error_message || '—'}
                                            </td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>
                    </div>
                </div>
            )}

            {/* ═══ TAB: HEALING & HEALTH ═══ */}
            {activeTab === 'healing' && (
                <div>
                    {/* Header with Diagnostic Button */}
                    <div className="flex justify-between items-center" style={{ marginBottom: '1.5rem', flexWrap: 'wrap', gap: '1rem' }}>
                        <div>
                            <h2 style={{ fontSize: '1.25rem', fontWeight: 800, color: 'var(--text-primary)', margin: 0, display: 'flex', alignItems: 'center', gap: '0.6rem' }}>
                                <DualEngineGlyph size={18} color="var(--accent-primary)" />
                                {t('healing.title')}
                            </h2>
                            <p style={{ margin: '0.25rem 0 0', fontSize: '0.85rem', color: 'var(--text-muted)' }}>
                                {t('healing.subtitle')}
                            </p>
                        </div>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', flexWrap: 'wrap' }}>
                            <button
                                id="btn-run-repair"
                                className="btn btn-secondary"
                                onClick={handleRunRepair}
                                disabled={repairing || discovering}
                                style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}
                            >
                                <RefreshCw size={14} className={repairing ? 'spin' : ''} />
                                {repairing ? t('healing.repairing') : t('healing.btn_repair')}
                            </button>
                            <button
                                id="btn-auto-discover-healing"
                                className="btn btn-primary"
                                onClick={handleAutoDiscover}
                                disabled={discovering || repairing}
                                style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}
                            >
                                <Zap size={14} className={discovering ? 'spin' : ''} />
                                {discovering ? t('healing.discovering') : t('healing.btn_auto_discover')}
                            </button>
                        </div>
                    </div>

                    {/* Stats Row */}
                    {(() => {
                        const totalUpstream = providers.length;
                        const healthyKeysCount = repairReport?.summary?.healthyKeys ?? providers.filter(p => (providerHealth[p.id]?.status ?? 'healthy') === 'healthy').length;
                        const degradedKeysCount = repairReport?.summary?.degradedKeys ?? Math.max(0, totalUpstream - healthyKeysCount);
                        const totalConfiguredModelsCount = repairReport?.summary?.totalConfiguredModels ?? availableModels.reduce((acc, curr) => acc + (curr.models?.length || 0), 0);
                        const autoHealedCount = projectHistory.filter((e: any) => e.eventType === 'auto_healed').length;

                        return (
                            <div className="stats-row" style={{ marginBottom: '1.5rem' }}>
                                <div className="stat-card">
                                    <div className="stat-label"><CheckCircle2 size={10} /> {t('healing.summary_healthy')}</div>
                                    <div className="stat-value green">{healthyKeysCount} / {totalUpstream}</div>
                                </div>
                                <div className="stat-card">
                                    <div className="stat-label"><AlertTriangle size={10} /> {t('healing.summary_degraded')}</div>
                                    <div className="stat-value" style={{ color: degradedKeysCount > 0 ? '#ef4444' : 'var(--text-secondary)' }}>{degradedKeysCount}</div>
                                </div>
                                <div className="stat-card">
                                    <div className="stat-label"><Cpu size={10} /> {t('healing.summary_models')}</div>
                                    <div className="stat-value amber">{totalConfiguredModelsCount}</div>
                                </div>
                                <div className="stat-card">
                                    <div className="stat-label"><Zap size={10} /> Auto-Remediations</div>
                                    <div className="stat-value" style={{ color: 'var(--accent-primary)' }}>{autoHealedCount}</div>
                                </div>
                            </div>
                        );
                    })()}

                    {/* Discovery & Model Sync Report (if auto-discovery run) */}
                    {discoveryReport && (
                        <div className="glass-panel" style={{ marginBottom: '1.5rem', border: '1px solid rgba(99, 102, 241, 0.35)' }}>
                            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '1rem', flexWrap: 'wrap', gap: '0.5rem' }}>
                                <div className="section-label" style={{ margin: 0, display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                                    <Zap size={14} color="var(--accent-primary)" />
                                    {t('healing.modal_title')}
                                </div>
                                <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
                                    <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)', fontFamily: 'var(--font-mono)' }}>
                                        {discoveryReport.timestamp ? new Date(discoveryReport.timestamp).toLocaleTimeString() : ''}
                                    </span>
                                    <button
                                        type="button"
                                        onClick={() => setDiscoveryReport(null)}
                                        className="btn btn-ghost btn-sm"
                                        style={{ padding: '0.2rem 0.5rem', fontSize: '0.75rem', height: 'auto' }}
                                    >
                                        ✕
                                    </button>
                                </div>
                            </div>

                            {/* Summary Badges */}
                            <div style={{ display: 'flex', gap: '0.6rem', flexWrap: 'wrap', marginBottom: '1rem' }}>
                                <span className="badge badge-healthy" style={{ padding: '0.35rem 0.75rem', fontSize: '0.8rem' }}>
                                    <CheckCircle2 size={12} style={{ marginRight: '0.3rem' }} />
                                    {discoveryReport.summary?.workingCount ?? 0} {t('healing.discovered_models')}
                                </span>
                                {(discoveryReport.summary?.prunedCount ?? 0) > 0 && (
                                    <span className="badge badge-error" style={{ padding: '0.35rem 0.75rem', fontSize: '0.8rem' }}>
                                        <XCircle size={12} style={{ marginRight: '0.3rem' }} />
                                        {discoveryReport.summary?.prunedCount} {t('healing.pruned_models')}
                                    </span>
                                )}
                                {(discoveryReport.summary?.healedCount ?? 0) > 0 && (
                                    <span className="badge badge-warning" style={{ padding: '0.35rem 0.75rem', fontSize: '0.8rem' }}>
                                        <Zap size={12} style={{ marginRight: '0.3rem' }} />
                                        {discoveryReport.summary?.healedCount} {t('healing.healed_models')}
                                    </span>
                                )}
                                <span className="badge badge-paused" style={{ padding: '0.35rem 0.75rem', fontSize: '0.8rem', marginLeft: 'auto' }}>
                                    {discoveryReport.summary?.activeModelsCount ?? 0} {t('healing.active_models')}
                                </span>
                            </div>

                            {/* Healed Migrations Cards */}
                            {discoveryReport.healedMigrations && discoveryReport.healedMigrations.length > 0 && (
                                <div style={{ marginBottom: '1.25rem' }}>
                                    <div style={{ fontSize: '0.78rem', fontWeight: 700, color: 'var(--brand-amber)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: '0.5rem' }}>
                                        🔄 {t('healing.healed_models')}
                                    </div>
                                    <div style={{ display: 'grid', gap: '0.5rem' }}>
                                        {discoveryReport.healedMigrations.map((hm: any, idx: number) => (
                                            <div
                                                key={idx}
                                                style={{
                                                    padding: '0.75rem 1rem',
                                                    borderRadius: 'var(--radius-md)',
                                                    background: 'rgba(245,158,11,0.08)',
                                                    border: '1px solid rgba(245,158,11,0.25)',
                                                    display: 'flex',
                                                    alignItems: 'center',
                                                    justifyContent: 'space-between',
                                                    gap: '0.75rem',
                                                    flexWrap: 'wrap'
                                                }}
                                            >
                                                <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap' }}>
                                                    <span style={{ textDecoration: 'line-through', color: '#f87171', fontFamily: 'var(--font-mono)', fontSize: '0.82rem' }}>
                                                        {hm.originalModel}
                                                    </span>
                                                    <ArrowRight size={13} style={{ color: 'var(--text-muted)' }} />
                                                    <span style={{ fontWeight: 700, color: '#34d399', fontFamily: 'var(--font-mono)', fontSize: '0.85rem' }}>
                                                        {hm.replacementModel}
                                                    </span>
                                                </div>
                                                <span style={{ fontSize: '0.78rem', color: 'var(--text-secondary)' }}>
                                                    {hm.reason}
                                                </span>
                                            </div>
                                        ))}
                                    </div>
                                </div>
                            )}

                            {/* Verified Working Models Tags */}
                            {discoveryReport.discoveredWorkingModels && discoveryReport.discoveredWorkingModels.length > 0 && (
                                <div style={{ marginBottom: '1.25rem' }}>
                                    <div style={{ fontSize: '0.78rem', fontWeight: 700, color: '#10b981', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: '0.5rem' }}>
                                        ✓ {t('healing.discovered_models')} ({discoveryReport.discoveredWorkingModels.length})
                                    </div>
                                    <div style={{ display: 'flex', gap: '0.45rem', flexWrap: 'wrap' }}>
                                        {discoveryReport.discoveredWorkingModels.map((wm: any, idx: number) => (
                                            <span
                                                key={idx}
                                                className="badge badge-healthy"
                                                style={{ padding: '0.3rem 0.6rem', fontSize: '0.78rem', fontFamily: 'var(--font-mono)', display: 'inline-flex', alignItems: 'center', gap: '0.35rem' }}
                                            >
                                                <span>{wm.model}</span>
                                                {wm.latencyMs > 0 && (
                                                    <span style={{ opacity: 0.8, fontSize: '0.7rem' }}>⚡{wm.latencyMs}ms</span>
                                                )}
                                            </span>
                                        ))}
                                    </div>
                                </div>
                            )}

                            {/* Pruned Dead Models List */}
                            {discoveryReport.prunedDeadModels && discoveryReport.prunedDeadModels.length > 0 && (
                                <div>
                                    <div style={{ fontSize: '0.78rem', fontWeight: 700, color: '#ef4444', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: '0.5rem' }}>
                                        ✕ {t('healing.pruned_models')} ({discoveryReport.prunedDeadModels.length})
                                    </div>
                                    <div style={{ display: 'grid', gap: '0.35rem' }}>
                                        {discoveryReport.prunedDeadModels.slice(0, 10).map((pm: any, idx: number) => (
                                            <div
                                                key={idx}
                                                style={{
                                                    padding: '0.4rem 0.75rem',
                                                    borderRadius: 'var(--radius-sm)',
                                                    background: 'rgba(239,68,68,0.06)',
                                                    border: '1px solid rgba(239,68,68,0.15)',
                                                    display: 'flex',
                                                    alignItems: 'center',
                                                    justifyContent: 'space-between',
                                                    fontSize: '0.78rem'
                                                }}
                                            >
                                                <span style={{ fontFamily: 'var(--font-mono)', color: '#f87171' }}>{pm.model}</span>
                                                <span style={{ color: 'var(--text-muted)', fontSize: '0.72rem' }}>{pm.reason}</span>
                                            </div>
                                        ))}
                                    </div>
                                </div>
                            )}
                        </div>
                    )}

                    {/* Diagnostic Findings & Actions (if diagnostic run) */}
                    {repairReport && (
                        <div className="glass-panel" style={{ marginBottom: '1.5rem' }}>
                            <div className="section-label" style={{ marginBottom: '1rem', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                                <Shield size={12} color="#10b981" /> {t('healing.remediation_title')}
                            </div>

                            {repairReport.remediationActions && repairReport.remediationActions.length > 0 ? (
                                <div style={{ display: 'grid', gap: '0.75rem', marginBottom: '1.25rem' }}>
                                    {repairReport.remediationActions.map((act: any, idx: number) => (
                                        <div
                                            key={idx}
                                            style={{
                                                padding: '0.85rem 1rem',
                                                borderRadius: 'var(--radius-md)',
                                                background: act.type === 'action_required' ? 'rgba(239,68,68,0.08)' : 'rgba(245,158,11,0.08)',
                                                border: act.type === 'action_required' ? '1px solid rgba(239,68,68,0.3)' : '1px solid rgba(245,158,11,0.3)',
                                                display: 'flex',
                                                alignItems: 'center',
                                                justifyContent: 'space-between',
                                                gap: '1rem',
                                                flexWrap: 'wrap'
                                            }}
                                        >
                                            <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', flexWrap: 'wrap' }}>
                                                <span className={`badge ${act.type === 'action_required' ? 'badge-error' : 'badge-warning'}`}>
                                                    {act.type === 'action_required' ? 'Action Required' : 'Failover Ready'}
                                                </span>
                                                <span style={{ fontWeight: 600, color: 'var(--text-primary)', fontFamily: 'var(--font-mono)', fontSize: '0.85rem' }}>
                                                    {act.target}
                                                </span>
                                                <span style={{ fontSize: '0.82rem', color: 'var(--text-secondary)' }}>
                                                    {act.details}
                                                </span>
                                            </div>
                                        </div>
                                    ))}
                                </div>
                            ) : (
                                <div style={{
                                    padding: '0.85rem 1.25rem',
                                    borderRadius: 'var(--radius-md)',
                                    background: 'rgba(16,185,129,0.08)',
                                    border: '1px solid rgba(16,185,129,0.25)',
                                    color: '#34d399',
                                    fontSize: '0.85rem',
                                    display: 'flex',
                                    alignItems: 'center',
                                    gap: '0.6rem',
                                    marginBottom: '1.25rem'
                                }}>
                                    <CheckCircle2 size={16} />
                                    <span>{t('healing.healthy_all')}</span>
                                </div>
                            )}

                            {/* Channel Health Probes Table */}
                            {repairReport.channelHealth && repairReport.channelHealth.length > 0 && (
                                <div className="table-wrapper">
                                    <table className="data-table">
                                        <thead>
                                            <tr>
                                                <th>Provider</th>
                                                <th>Tested Model</th>
                                                <th>Status</th>
                                                <th>Latency</th>
                                                <th>Details</th>
                                            </tr>
                                        </thead>
                                        <tbody>
                                            {repairReport.channelHealth.map((ch: any) => (
                                                <tr key={ch.keyId}>
                                                    <td><ProviderChip provider={ch.provider} /></td>
                                                    <td style={{ fontFamily: 'var(--font-mono)', fontSize: '0.8rem' }}>{ch.modelTested || 'default'}</td>
                                                    <td>
                                                        <span className={`badge ${ch.ok ? 'badge-healthy' : 'badge-error'}`}>
                                                            <span className="badge-dot" />
                                                            {ch.ok ? 'Online (200)' : `HTTP ${ch.statusCode || 'Err'}`}
                                                        </span>
                                                    </td>
                                                    <td style={{ fontFamily: 'var(--font-mono)', fontSize: '0.85rem' }}>
                                                        {ch.latencyMs > 0 ? (
                                                            <span style={{ color: ch.latencyMs < 500 ? '#10b981' : ch.latencyMs < 1200 ? '#f59e0b' : '#ef4444' }}>
                                                                ⚡ {ch.latencyMs}ms
                                                            </span>
                                                        ) : '—'}
                                                    </td>
                                                    <td style={{ fontSize: '0.78rem', color: ch.error ? '#f87171' : 'var(--text-muted)' }}>
                                                        {ch.error || 'Channel nominal'}
                                                    </td>
                                                </tr>
                                            ))}
                                        </tbody>
                                    </table>
                                </div>
                            )}
                        </div>
                    )}

                    {/* Timeline of Events */}
                    <div className="glass-panel">
                        <div className="section-label" style={{ marginBottom: '1.25rem', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                            <History size={12} color="var(--accent-primary)" />
                            {t('healing.timeline_title')}
                            {projectHistory.length > 0 && (
                                <span className="badge badge-paused" style={{ marginLeft: 'auto', fontSize: '0.72rem' }}>
                                    {projectHistory.length} {projectHistory.length === 1 ? 'event' : 'events'}
                                </span>
                            )}
                        </div>

                        {loadingHistory ? (
                            <div style={{ textAlign: 'center', padding: '2rem', color: 'var(--text-muted)' }}>
                                <RefreshCw size={18} className="spin" style={{ margin: '0 auto 0.5rem' }} />
                                <div>Cargando historial...</div>
                            </div>
                        ) : projectHistory.length === 0 ? (
                            <div style={{ textAlign: 'center', padding: '2.5rem 1rem', color: 'var(--text-muted)', fontSize: '0.88rem' }}>
                                <History size={24} style={{ opacity: 0.35, margin: '0 auto 0.75rem', display: 'block' }} />
                                {t('healing.no_events')}
                            </div>
                        ) : (
                            <div style={{ display: 'grid', gap: '0.85rem' }}>
                                {projectHistory.map((item: any) => {
                                    const isAutoHealed = item.eventType === 'auto_healed';
                                    const isRepaired = item.eventType === 'repaired';
                                    const isDeprecated = item.eventType === 'model_deprecated';

                                    const badgeCls = isAutoHealed ? 'badge-warning' : isRepaired ? 'badge-healthy' : isDeprecated ? 'badge-error' : 'badge-paused';
                                    const badgeLabel = isAutoHealed ? t('healing.event_auto_healed') : isRepaired ? t('healing.event_channel_repaired') : isDeprecated ? t('healing.event_model_deprecated') : item.eventType;

                                    return (
                                        <div
                                            key={item.id}
                                            style={{
                                                padding: '0.95rem 1.15rem',
                                                borderRadius: 'var(--radius-md)',
                                                background: 'var(--surface-1)',
                                                border: isAutoHealed ? '1px solid rgba(245,158,11,0.3)' : '1px solid var(--border-subtle)',
                                                display: 'flex',
                                                flexDirection: 'column',
                                                gap: '0.5rem',
                                                transition: 'all 0.15s ease'
                                            }}
                                        >
                                            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '0.5rem' }}>
                                                <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem' }}>
                                                    <span className={`badge ${badgeCls}`}>
                                                        <span className="badge-dot" />
                                                        {badgeLabel}
                                                    </span>
                                                    {item.originalModel && item.resolvedModel && (
                                                        <div style={{ display: 'inline-flex', alignItems: 'center', gap: '0.4rem', fontFamily: 'var(--font-mono)', fontSize: '0.82rem' }}>
                                                            <span style={{ color: 'var(--text-muted)', textDecoration: isAutoHealed ? 'line-through' : 'none' }}>
                                                                {item.originalModel}
                                                            </span>
                                                            <ArrowRight size={12} style={{ color: 'var(--accent-primary)' }} />
                                                            <span style={{ color: '#10b981', fontWeight: 600 }}>
                                                                {item.resolvedModel}
                                                            </span>
                                                        </div>
                                                    )}
                                                </div>
                                                <span style={{ fontFamily: 'var(--font-mono)', fontSize: '0.75rem', color: 'var(--text-muted)' }}>
                                                    {new Date(item.timestamp).toLocaleString()}
                                                </span>
                                            </div>

                                            {item.reason && (
                                                <p style={{ margin: 0, fontSize: '0.82rem', color: 'var(--text-secondary)', lineHeight: 1.5 }}>
                                                    {item.reason}
                                                </p>
                                            )}
                                        </div>
                                    );
                                })}
                            </div>
                        )}
                    </div>
                </div>
            )}

            {/* ═══ TOKEN LIMIT MODAL ═══ */}
            {tokenLimitModal && (
                <div style={{
                    position: 'fixed', inset: 0, zIndex: 9999,
                    background: 'rgba(0,0,0,0.7)', backdropFilter: 'blur(6px)',
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    animation: 'fadeIn 0.2s ease-out',
                }} onClick={() => setTokenLimitModal(null)}>
                    <div style={{
                        background: 'var(--bg-secondary)',
                        border: '1px solid rgba(139,92,246,0.35)',
                        borderRadius: 'var(--radius-xl)',
                        padding: '2rem',
                        width: '100%', maxWidth: 420,
                        boxShadow: '0 24px 80px rgba(0,0,0,0.6), 0 0 0 1px rgba(139,92,246,0.2)',
                        position: 'relative',
                    }} onClick={e => e.stopPropagation()}>
                        {/* Header */}
                        <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', marginBottom: '1.5rem' }}>
                            <div style={{
                                width: 40, height: 40, borderRadius: 'var(--radius-md)',
                                background: 'rgba(139,92,246,0.12)', border: '1px solid rgba(139,92,246,0.3)',
                                display: 'flex', alignItems: 'center', justifyContent: 'center',
                            }}>
                                <Sliders size={18} style={{ color: '#a78bfa' }} />
                            </div>
                            <div>
                                <h3 style={{ margin: 0, fontSize: '1rem', fontWeight: 800, color: 'var(--text-primary)' }}>
                                    {tokenLimitModal.mode === 'global' ? 'Global Output Token Limit' : `Token Limit — ${tokenLimitModal.providerName}`}
                                </h3>
                                <p style={{ margin: 0, fontSize: '0.75rem', color: 'var(--text-muted)', marginTop: '0.15rem' }}>
                                    {tokenLimitModal.mode === 'global'
                                        ? 'Applies to ALL providers in this project'
                                        : 'Applies only to this provider'}
                                </p>
                            </div>
                        </div>

                        {/* Info box */}
                        <div style={{
                            background: 'rgba(139,92,246,0.08)', border: '1px solid rgba(139,92,246,0.2)',
                            borderRadius: 'var(--radius-md)', padding: '0.75rem 1rem',
                            marginBottom: '1.25rem', fontSize: '0.76rem', color: 'var(--text-muted)', lineHeight: 1.6,
                        }}>
                            <strong style={{ color: '#a78bfa' }}>max_tokens cap</strong> — {t('project.token_limit_info')}
                        </div>

                        {/* Presets */}
                        <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap', marginBottom: '1rem' }}>
                            {[null, 4096, 8192, 16000, 32000, 65536, 131072].map(v => (
                                <button
                                    key={v ?? 'default'}
                                    onClick={() => setTokenLimitInput(v === null ? '' : String(v))}
                                    style={{
                                        padding: '0.3rem 0.65rem',
                                        borderRadius: 'var(--radius-pill)',
                                        fontSize: '0.72rem', fontWeight: 700, fontFamily: 'var(--font-mono)',
                                        background: tokenLimitInput === (v === null ? '' : String(v))
                                            ? 'rgba(139,92,246,0.25)' : 'var(--surface-2)',
                                        border: tokenLimitInput === (v === null ? '' : String(v))
                                            ? '1px solid rgba(139,92,246,0.5)' : '1px solid var(--border-subtle)',
                                        color: tokenLimitInput === (v === null ? '' : String(v))
                                            ? '#c4b5fd' : 'var(--text-secondary)',
                                        cursor: 'pointer', transition: 'all 0.15s',
                                    }}
                                >
                                    {v === null ? '∞ Default' : v >= 1000 ? `${v / 1024 >= 1 ? (v / 1024).toFixed(0) + 'k' : v}` : v}
                                </button>
                            ))}
                        </div>

                        {/* Input */}
                        <div style={{ marginBottom: '1.25rem' }}>
                            <label style={{ display: 'block', fontSize: '0.75rem', fontWeight: 700, color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: '0.4rem' }}>
                                Custom value (tokens)
                            </label>
                            <input
                                type="number"
                                min={100}
                                step={512}
                                value={tokenLimitInput}
                                onChange={e => setTokenLimitInput(e.target.value)}
                                onKeyDown={e => { if (e.key === 'Enter') handleSaveTokenLimit(); if (e.key === 'Escape') setTokenLimitModal(null); }}
                                placeholder="Blank = use gateway default (16,000)"
                                autoFocus
                                style={{ width: '100%', marginBottom: 0, fontFamily: 'var(--font-mono)', fontSize: '1rem', padding: '0.65rem 0.85rem', borderColor: 'rgba(139,92,246,0.4)' }}
                            />
                        </div>

                        {/* Actions */}
                        <div style={{ display: 'flex', gap: '0.75rem' }}>
                            <button
                                onClick={() => setTokenLimitModal(null)}
                                className="btn btn-secondary"
                                style={{ flex: 1 }}
                            >
                                Cancel
                            </button>
                            <button
                                onClick={handleSaveTokenLimit}
                                className="btn btn-sm"
                                style={{ flex: 2, background: 'rgba(139,92,246,0.2)', border: '1px solid rgba(139,92,246,0.4)', color: '#c4b5fd', fontSize: '0.9rem', padding: '0.65rem 1rem', borderRadius: 'var(--radius-md)', cursor: 'pointer', fontWeight: 700, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '0.5rem' }}
                            >
                                <Sliders size={14} />
                                {tokenLimitModal.mode === 'global' ? 'Apply to All Providers' : 'Save Token Limit'}
                            </button>
                        </div>
                    </div>
                </div>
            )}

            {/* ═══ RATE LIMIT (FREE TIER GUARDIAN) MODAL ═══ */}
            {rateLimitModal && (
                <div style={{
                    position: 'fixed', inset: 0, zIndex: 9999,
                    background: 'rgba(0,0,0,0.7)', backdropFilter: 'blur(6px)',
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    animation: 'fadeIn 0.2s ease-out',
                }} onClick={() => setRateLimitModal(null)}>
                    <div style={{
                        background: 'var(--bg-secondary)',
                        border: '1px solid rgba(99, 102, 241, 0.35)',
                        borderRadius: 'var(--radius-xl)',
                        padding: '2rem',
                        width: '100%', maxWidth: 440,
                        boxShadow: '0 24px 80px rgba(0,0,0,0.6), 0 0 0 1px rgba(99, 102, 241, 0.2)',
                        position: 'relative',
                    }} onClick={e => e.stopPropagation()}>
                        {/* Header */}
                        <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', marginBottom: '1.25rem' }}>
                            <div style={{
                                width: 40, height: 40, borderRadius: 'var(--radius-md)',
                                background: 'rgba(99, 102, 241, 0.12)', border: '1px solid rgba(99, 102, 241, 0.3)',
                                display: 'flex', alignItems: 'center', justifyContent: 'center',
                            }}>
                                <Shield size={18} style={{ color: 'var(--accent-primary)' }} />
                            </div>
                            <div>
                                <h3 style={{ margin: 0, fontSize: '1.05rem', fontWeight: 800, color: 'var(--text-primary)' }}>
                                    {t('project.limits_modal_title')}
                                </h3>
                                <p style={{ margin: 0, fontSize: '0.75rem', color: 'var(--text-muted)', marginTop: '0.15rem' }}>
                                    Provider: <strong style={{ textTransform: 'capitalize', color: 'var(--accent-primary)' }}>{rateLimitModal.providerName}</strong> ({rateLimitModal.billingType})
                                </p>
                            </div>
                        </div>

                        {/* Presets */}
                        <div style={{ marginBottom: '1rem' }}>
                            <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)', marginBottom: '0.35rem' }}>Quick Presets:</div>
                            <div style={{ display: 'flex', gap: '0.4rem', flexWrap: 'wrap' }}>
                                <button
                                    type="button"
                                    onClick={() => setRateLimitModal(m => m ? { ...m, rpm: 5, tpm: 250000, rpd: 20, hasKnownLimits: true, limitSource: 'verified' } : null)}
                                    className="btn btn-secondary btn-sm"
                                    style={{ fontSize: '0.7rem', padding: '0.25rem 0.55rem' }}
                                >
                                    Gemini 3.8 Flash (5 RPM / 20 RPD)
                                </button>
                                <button
                                    type="button"
                                    onClick={() => setRateLimitModal(m => m ? { ...m, rpm: 15, tpm: 250000, rpd: 1000, hasKnownLimits: true, limitSource: 'verified' } : null)}
                                    className="btn btn-secondary btn-sm"
                                    style={{ fontSize: '0.7rem', padding: '0.25rem 0.55rem' }}
                                >
                                    Gemini 3.5 Lite (15 RPM / 1k RPD)
                                </button>
                                <button
                                    type="button"
                                    onClick={() => setRateLimitModal(m => m ? { ...m, rpm: 10, tpm: 250000, rpd: 250, hasKnownLimits: true, limitSource: 'verified' } : null)}
                                    className="btn btn-secondary btn-sm"
                                    style={{ fontSize: '0.7rem', padding: '0.25rem 0.55rem' }}
                                >
                                    Gemini 3.5 Flash (10 RPM / 250 RPD)
                                </button>
                                <button
                                    type="button"
                                    onClick={() => setRateLimitModal(m => m ? { ...m, rpm: 30, tpm: 14400, rpd: 14400, hasKnownLimits: true, limitSource: 'verified' } : null)}
                                    className="btn btn-secondary btn-sm"
                                    style={{ fontSize: '0.7rem', padding: '0.25rem 0.55rem' }}
                                >
                                    Groq (30 RPM)
                                </button>
                                <button
                                    type="button"
                                    onClick={() => setRateLimitModal(m => m ? { ...m, rpm: 300, tpm: 500000, rpd: 100000, hasKnownLimits: false, limitSource: 'unverified' } : null)}
                                    className="btn btn-secondary btn-sm"
                                    style={{ fontSize: '0.7rem', padding: '0.25rem 0.55rem' }}
                                >
                                    Paid (High Quota)
                                </button>
                            </div>
                        </div>

                        {/* Limits Verification & Policy Mode */}
                        <div style={{ marginBottom: '1rem', padding: '0.65rem 0.85rem', background: 'var(--surface-2)', borderRadius: 6, border: '1px solid var(--border-default)' }}>
                            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '0.45rem' }}>
                                <span style={{ fontSize: '0.74rem', fontWeight: 600 }}>Limits Policy & Verification:</span>
                                <span style={{
                                    fontSize: '0.66rem',
                                    padding: '0.12rem 0.45rem',
                                    borderRadius: 4,
                                    background: rateLimitModal.hasKnownLimits ? 'rgba(34,197,94,0.15)' : 'rgba(245,158,11,0.15)',
                                    color: rateLimitModal.hasKnownLimits ? '#22c55e' : '#f59e0b',
                                    fontWeight: 700
                                }}>
                                    {rateLimitModal.hasKnownLimits ? '✓ Known / Documented Limits' : '⚠ Unknown / Adaptive Probing'}
                                </span>
                            </div>
                            <div style={{ display: 'flex', gap: '0.4rem' }}>
                                <button
                                    type="button"
                                    onClick={() => setRateLimitModal(m => m ? { ...m, hasKnownLimits: true, limitSource: 'verified' } : null)}
                                    className={`btn btn-sm ${rateLimitModal.hasKnownLimits ? 'btn-primary' : 'btn-secondary'}`}
                                    style={{ fontSize: '0.68rem', padding: '0.25rem 0.55rem' }}
                                >
                                    Known Limits (Strict 20 RPD & Auto-Fallback)
                                </button>
                                <button
                                    type="button"
                                    onClick={() => setRateLimitModal(m => m ? { ...m, hasKnownLimits: false, limitSource: 'unverified' } : null)}
                                    className={`btn btn-sm ${!rateLimitModal.hasKnownLimits ? 'btn-primary' : 'btn-secondary'}`}
                                    style={{ fontSize: '0.68rem', padding: '0.25rem 0.55rem' }}
                                >
                                    Unknown Limits (Adaptive Early-Protection)
                                </button>
                            </div>
                            <p style={{ margin: '0.35rem 0 0', fontSize: '0.67rem', color: 'var(--text-muted)' }}>
                                {rateLimitModal.hasKnownLimits
                                    ? 'Gateway enforces known company quota (e.g. 20 RPD on 3.8). When exhausted, it seamlessly substitutes to fallback and shows restabilization date.'
                                    : 'Provider policy is not documented or varies. Gateway dynamically derates safe limits on early 429/503 anomalies and rotates instantly.'}
                            </p>
                        </div>

                        {/* Form Inputs */}
                        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.75rem', marginBottom: '1.25rem' }}>
                            <div className="form-group" style={{ margin: 0 }}>
                                <label style={{ fontSize: '0.74rem' }}>{t('project.rpm_limit')}</label>
                                <input
                                    type="number"
                                    min={1}
                                    value={rateLimitModal.rpm}
                                    onChange={e => setRateLimitModal(m => m ? { ...m, rpm: parseInt(e.target.value, 10) || 1 } : null)}
                                    style={{ width: '100%', padding: '0.5rem', fontFamily: 'var(--font-mono)' }}
                                />
                            </div>
                            <div className="form-group" style={{ margin: 0 }}>
                                <label style={{ fontSize: '0.74rem' }}>{t('project.tpm_limit')}</label>
                                <input
                                    type="number"
                                    min={100}
                                    step={1000}
                                    value={rateLimitModal.tpm}
                                    onChange={e => setRateLimitModal(m => m ? { ...m, tpm: parseInt(e.target.value, 10) || 1000 } : null)}
                                    style={{ width: '100%', padding: '0.5rem', fontFamily: 'var(--font-mono)' }}
                                />
                            </div>
                            <div className="form-group" style={{ margin: 0 }}>
                                <label style={{ fontSize: '0.74rem' }}>{t('project.rpd_limit')}</label>
                                <input
                                    type="number"
                                    min={1}
                                    value={rateLimitModal.rpd}
                                    onChange={e => setRateLimitModal(m => m ? { ...m, rpd: parseInt(e.target.value, 10) || 1 } : null)}
                                    style={{ width: '100%', padding: '0.5rem', fontFamily: 'var(--font-mono)' }}
                                />
                            </div>
                            <div className="form-group" style={{ margin: 0 }}>
                                <label style={{ fontSize: '0.74rem' }}>{t('project.tpd_limit')}</label>
                                <input
                                    type="number"
                                    min={1000}
                                    step={10000}
                                    value={rateLimitModal.tpd}
                                    onChange={e => setRateLimitModal(m => m ? { ...m, tpd: parseInt(e.target.value, 10) || 10000 } : null)}
                                    style={{ width: '100%', padding: '0.5rem', fontFamily: 'var(--font-mono)' }}
                                />
                            </div>
                        </div>

                        {/* Actions */}
                        <div style={{ display: 'flex', gap: '0.75rem' }}>
                            <button
                                onClick={() => setRateLimitModal(null)}
                                className="btn btn-secondary"
                                style={{ flex: 1 }}
                            >
                                Cancel
                            </button>
                            <button
                                onClick={handleSaveRateLimits}
                                className="btn btn-primary"
                                style={{ flex: 1.5, justifyContent: 'center' }}
                            >
                                <Save size={14} /> {t('project.save_limits')}
                            </button>
                        </div>
                    </div>
                </div>
            )}

            {/* ═══ MODAL: GATEWAY OPERATING MODES ═══ */}
            {modesModalOpen && (
                <div className="modal-backdrop" onClick={() => setModesModalOpen(false)}>
                    <div
                        className="modal-card"
                        onClick={e => e.stopPropagation()}
                        style={{ maxWidth: '680px', width: '92vw', maxHeight: '85vh', overflowY: 'auto' }}
                    >
                        {/* Header */}
                        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: '1.25rem' }}>
                            <div>
                                <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.25rem' }}>
                                    <Shield size={18} style={{ color: 'var(--accent-primary)' }} />
                                    <h3 style={{ margin: 0, fontSize: '1.2rem', fontWeight: 800, color: 'var(--text-primary)' }}>
                                        {t('modes.modal_title')}
                                    </h3>
                                </div>
                                <p style={{ margin: 0, fontSize: '0.8rem', color: 'var(--text-muted)' }}>
                                    {t('modes.modal_subtitle')}
                                </p>
                            </div>
                            <button
                                onClick={() => setModesModalOpen(false)}
                                className="btn-icon"
                                aria-label="Close modal"
                                style={{ opacity: 0.7, padding: '0.25rem' }}
                            >
                                <X size={18} />
                            </button>
                        </div>

                        {/* Modes Stack */}
                        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.85rem', marginBottom: '1.5rem' }}>
                            {/* Mode 1: SOAT */}
                            <div style={{
                                padding: '1rem',
                                borderRadius: 'var(--radius-md)',
                                background: 'var(--surface-card)',
                                border: '1px solid var(--border-default)',
                            }}>
                                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '0.4rem' }}>
                                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.45rem' }}>
                                        <PromptAnchorGlyph size={15} color="var(--text-primary)" />
                                        <strong style={{ fontSize: '0.88rem', color: 'var(--text-primary)' }}>{t('modes.soat_title')}</strong>
                                    </div>
                                    <span style={{
                                        fontSize: '0.65rem', fontWeight: 800, letterSpacing: '0.06em',
                                        background: 'var(--surface-2)', color: 'var(--text-secondary)',
                                        padding: '0.15rem 0.5rem', borderRadius: 'var(--radius-pill)',
                                    }}>
                                        {t('modes.active_badge')}
                                    </span>
                                </div>
                                <p style={{ margin: '0 0 0.5rem 0', fontSize: '0.78rem', color: 'var(--text-secondary)', lineHeight: 1.4 }}>
                                    {t('modes.soat_desc')}
                                </p>
                                <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap', fontSize: '0.68rem', fontFamily: 'var(--font-mono)', color: 'var(--text-muted)' }}>
                                    <span style={{ background: 'var(--surface-1)', padding: '0.15rem 0.4rem', borderRadius: '4px' }}>System Prompt: Index [0]</span>
                                    <span style={{ background: 'var(--surface-1)', padding: '0.15rem 0.4rem', borderRadius: '4px' }}>Gemini/Claude Cache: ~50% Off</span>
                                    <span style={{ background: 'var(--surface-1)', padding: '0.15rem 0.4rem', borderRadius: '4px' }}>Semantic Cache: SHA-256</span>
                                </div>
                            </div>

                            {/* Mode 2: Rate Limit Guardian */}
                            <div style={{
                                padding: '1rem',
                                borderRadius: 'var(--radius-md)',
                                background: 'var(--surface-card)',
                                border: '1px solid rgba(16,185,129,0.25)',
                            }}>
                                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '0.4rem' }}>
                                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.45rem' }}>
                                        <RateGuardianGlyph size={15} color="#10b981" />
                                        <strong style={{ fontSize: '0.88rem', color: 'var(--text-primary)' }}>{t('modes.guardian_title')}</strong>
                                    </div>
                                    <span style={{
                                        fontSize: '0.65rem', fontWeight: 800, letterSpacing: '0.06em',
                                        background: 'rgba(16,185,129,0.15)', color: '#10b981',
                                        padding: '0.15rem 0.5rem', borderRadius: 'var(--radius-pill)',
                                    }}>
                                        {t('modes.active_badge')}
                                    </span>
                                </div>
                                <p style={{ margin: '0 0 0.5rem 0', fontSize: '0.78rem', color: 'var(--text-secondary)', lineHeight: 1.4 }}>
                                    {t('modes.guardian_desc')}
                                </p>
                                <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap', fontSize: '0.68rem', fontFamily: 'var(--font-mono)', color: 'var(--text-muted)' }}>
                                    <span style={{ background: 'var(--surface-1)', padding: '0.15rem 0.4rem', borderRadius: '4px' }}>Sliding Windows: RPM / TPM / RPD / TPD</span>
                                    <span style={{ background: 'var(--surface-1)', padding: '0.15rem 0.4rem', borderRadius: '4px' }}>Backoff Delay: ≤ 6000ms</span>
                                    <span style={{ background: 'var(--surface-1)', padding: '0.15rem 0.4rem', borderRadius: '4px' }}>Passive Headers Ingestion: Enabled</span>
                                </div>
                            </div>

                            {/* Mode 3: Dual Engine */}
                            <div style={{
                                padding: '1rem',
                                borderRadius: 'var(--radius-md)',
                                background: 'var(--surface-card)',
                                border: '1px solid var(--border-default)',
                            }}>
                                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '0.4rem' }}>
                                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.45rem' }}>
                                        <DualEngineGlyph size={15} color="var(--text-secondary)" />
                                        <strong style={{ fontSize: '0.88rem', color: 'var(--text-primary)' }}>{t('modes.engine_title')}</strong>
                                    </div>
                                    <span style={{
                                        fontSize: '0.65rem', fontWeight: 800, letterSpacing: '0.06em',
                                        background: 'var(--surface-2)', color: 'var(--text-secondary)',
                                        padding: '0.15rem 0.5rem', borderRadius: 'var(--radius-pill)',
                                    }}>
                                        {t('modes.active_badge')}
                                    </span>
                                </div>
                                <p style={{ margin: '0 0 0.5rem 0', fontSize: '0.78rem', color: 'var(--text-secondary)', lineHeight: 1.4 }}>
                                    {t('modes.engine_desc')}
                                </p>
                                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '0.5rem' }}>
                                    <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap', fontSize: '0.68rem', fontFamily: 'var(--font-mono)', color: 'var(--text-muted)' }}>
                                        <span style={{ background: 'var(--surface-1)', padding: '0.15rem 0.4rem', borderRadius: '4px' }}>System 1: TypeSafe Jev (800ms cap)</span>
                                        <span style={{ background: 'var(--surface-1)', padding: '0.15rem 0.4rem', borderRadius: '4px' }}>System 2: Manager LLM</span>
                                    </div>
                                    <Link
                                        to="/engines"
                                        onClick={() => setModesModalOpen(false)}
                                        style={{ fontSize: '0.72rem', color: 'var(--text-primary)', fontWeight: 600, textDecoration: 'underline' }}
                                    >
                                        {t('modes.config_engine')} →
                                    </Link>
                                </div>
                            </div>

                            {/* Mode 4: Atlas Smart Router */}
                            <div style={{
                                padding: '1rem',
                                borderRadius: 'var(--radius-md)',
                                background: 'var(--surface-card)',
                                border: '1px solid var(--border-default)',
                            }}>
                                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '0.4rem' }}>
                                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.45rem' }}>
                                        <RouterCascadeGlyph size={15} color="var(--text-secondary)" />
                                        <strong style={{ fontSize: '0.88rem', color: 'var(--text-primary)' }}>{t('modes.router_title')}</strong>
                                    </div>
                                    <span style={{
                                        fontSize: '0.65rem', fontWeight: 800, letterSpacing: '0.06em',
                                        background: 'var(--surface-2)', color: 'var(--text-secondary)',
                                        padding: '0.15rem 0.5rem', borderRadius: 'var(--radius-pill)',
                                    }}>
                                        {t('modes.active_badge')}
                                    </span>
                                </div>
                                <p style={{ margin: '0 0 0.5rem 0', fontSize: '0.78rem', color: 'var(--text-secondary)', lineHeight: 1.4 }}>
                                    {t('modes.router_desc')}
                                </p>
                                <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap', fontSize: '0.68rem', fontFamily: 'var(--font-mono)', color: 'var(--text-muted)' }}>
                                    <span style={{ background: 'var(--surface-1)', padding: '0.15rem 0.4rem', borderRadius: '4px' }}>Tier 1: Economy (Cerebras, Groq)</span>
                                    <span style={{ background: 'var(--surface-1)', padding: '0.15rem 0.4rem', borderRadius: '4px' }}>Tier 2: Standard (DeepSeek, Puter)</span>
                                    <span style={{ background: 'var(--surface-1)', padding: '0.15rem 0.4rem', borderRadius: '4px' }}>Tier 3: Premium (OpenAI, Google)</span>
                                </div>
                            </div>

                            {/* Mode 5: Fusion Consensus Engine */}
                            <div style={{
                                padding: '1rem',
                                borderRadius: 'var(--radius-md)',
                                background: 'var(--surface-card)',
                                border: '1px solid rgba(16,185,129,0.25)',
                            }}>
                                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '0.4rem' }}>
                                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.45rem' }}>
                                        <Activity size={14} style={{ color: 'var(--status-healthy)' }} />
                                        <strong style={{ fontSize: '0.88rem', color: 'var(--text-primary)' }}>{t('modes.fusion_title')}</strong>
                                    </div>
                                    <span style={{
                                        fontSize: '0.65rem', fontWeight: 800, letterSpacing: '0.06em',
                                        background: 'rgba(16,185,129,0.15)', color: 'var(--status-healthy)',
                                        padding: '0.15rem 0.5rem', borderRadius: 'var(--radius-pill)',
                                    }}>
                                        READY
                                    </span>
                                </div>
                                <p style={{ margin: '0 0 0.5rem 0', fontSize: '0.78rem', color: 'var(--text-secondary)', lineHeight: 1.4 }}>
                                    {t('modes.fusion_desc')}
                                </p>
                                <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap', fontSize: '0.68rem', fontFamily: 'var(--font-mono)', color: 'var(--text-muted)' }}>
                                    <span style={{ background: 'var(--surface-1)', padding: '0.15rem 0.4rem', borderRadius: '4px' }}>Model: "fusion"</span>
                                    <span style={{ background: 'var(--surface-1)', padding: '0.15rem 0.4rem', borderRadius: '4px' }}>Panel: 3 Diverse Models</span>
                                    <span style={{ background: 'var(--surface-1)', padding: '0.15rem 0.4rem', borderRadius: '4px' }}>Synthesis: Dialectical Judge</span>
                                </div>
                            </div>
                        </div>

                        {/* Modal Footer */}
                        <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
                            <button
                                onClick={() => setModesModalOpen(false)}
                                className="btn btn-primary"
                                style={{ minWidth: '100px', justifyContent: 'center' }}
                            >
                                OK
                            </button>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}
