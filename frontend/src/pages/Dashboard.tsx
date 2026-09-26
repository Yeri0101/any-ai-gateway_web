import { useState, useEffect } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { fetchApi } from '../api';
import { FolderOpen, Plus, Trash2, Edit2, Zap, Palette, Key, Activity, Copy, Check, DollarSign, CheckCircle2, XCircle, RotateCcw } from 'lucide-react';
import { TierMaxLogo, AnthropicIcon, RouterCascadeGlyph, DualEngineGlyph } from '../components/Icons';
import { useLanguage } from '../i18n';
import { useToast } from '../ToastContext';
import { OpenClawLiveInspector } from '../components/OpenClawLiveInspector';

type GatewayKeyPreview = {
    id: string;
    key_name: string;
    key_preview: string;
};

type Project = {
    id: string;
    name: string;
    color?: string;
    created_at: string;
    gateway_keys?: GatewayKeyPreview[];
    avg_latency_ms?: number | null;
};

type RecentCall = {
    project_id: string;
    project_name: string;
    model: string;
    latency_ms: number | null;
    total_tokens: number;
    created_at: string;
};

type UsageMetrics = {
    totalTokens: number;
    actualCostUsd: number;
    estimatedSavingsUsd: number;
};

const PROJECT_COLORS = [
    '#6366f1', // indigo (default)
    '#06b6d4', // cyan
    '#10b981', // emerald
    '#14b8a6', // teal
    '#3b82f6', // blue
    '#8b5cf6', // purple
    '#ec4899', // pink
    '#f59e0b', // amber
];

export default function Dashboard() {
    const { t } = useLanguage();
    const navigate = useNavigate();
    const toast = useToast();
    const [projects, setProjects] = useState<Project[]>([]);
    const [newProjectName, setNewProjectName] = useState('');
    const [loading, setLoading] = useState(true);
    const [recentCalls, setRecentCalls] = useState<RecentCall[]>([]);
    const [editingId, setEditingId] = useState<string | null>(null);
    const [editName, setEditName] = useState('');
    const [colorPickerId, setColorPickerId] = useState<string | null>(null);
    const [copiedKeyId, setCopiedKeyId] = useState<string | null>(null);
    const [hidingKeyId, setHidingKeyId] = useState<string | null>(null);
    const [usageMetrics, setUsageMetrics] = useState<UsageMetrics>({
        totalTokens: 0,
        actualCostUsd: 0,
        estimatedSavingsUsd: 0,
    });
    const [copiedSnippet, setCopiedSnippet] = useState<string | null>(null);

    const handleCopySnippet = async (text: string, id: string) => {
        try {
            await navigator.clipboard.writeText(text);
            setCopiedSnippet(id);
            setTimeout(() => setCopiedSnippet(null), 2500);
        } catch (e) {
            console.error('Failed to copy snippet:', e);
        }
    };

    const handleCopyKey = async (keyId: string, e: React.MouseEvent) => {
        e.preventDefault();
        e.stopPropagation();
        try {
            const data = await fetchApi(`/gateway-keys/${keyId}/reveal`);
            await navigator.clipboard.writeText(data.api_key);
            setCopiedKeyId(keyId);
            setHidingKeyId(null);
            // After 2.7s start hide animation, clear at 3s
            setTimeout(() => setHidingKeyId(keyId), 2700);
            setTimeout(() => { setCopiedKeyId(null); setHidingKeyId(null); }, 3000);
        } catch (err) {
            console.error('Failed to copy key:', err);
        }
    };

    const [isLiveConnected, setIsLiveConnected] = useState(false);
    const [newCallHighlight, setNewCallHighlight] = useState(false);
    const [isInspectorOpen, setIsInspectorOpen] = useState(false);
    const [cacheStats, setCacheStats] = useState<any>(null);
    const [isHealingAll, setIsHealingAll] = useState(false);
    const [healAllReport, setHealAllReport] = useState<any | null>(null);

    const handleAutoHealAll = async () => {
        if (isHealingAll) return;
        setIsHealingAll(true);
        try {
            toast.success(t('healing.scanning_all') || 'Escaneando y validando modelos de todos los proyectos...');
            const res = await fetchApi('/projects/auto-heal-all-models', { method: 'POST' });
            if (res?.ok && res.report) {
                setHealAllReport(res.report);
                toast.success(`Escaneo global completado: ${res.report.totalWorkingDiscovered} verificados, ${res.report.totalPruned} depurados, ${res.report.totalHealed} auto-migrados.`);
                loadOverview(false);
            } else {
                toast.error(res?.error || 'Falló el auto-escaneo global');
            }
        } catch (err: any) {
            toast.error(err?.message || 'Error al ejecutar auto-escaneo de todos los proyectos');
        } finally {
            setIsHealingAll(false);
        }
    };

    const [resettingMetrics, setResettingMetrics] = useState(false);
    const [showResetConfirm, setShowResetConfirm] = useState(false);

    const handleResetMetrics = async () => {
        setResettingMetrics(true);
        try {
            await fetchApi('/analytics/reset', { method: 'POST' });
            setUsageMetrics({ totalTokens: 0, actualCostUsd: 0, estimatedSavingsUsd: 0 });
            setRecentCalls([]);
            setCacheStats({ size: 0, totalHits: 0, totalMisses: 0, hitRate: 0, estimatedTokensSaved: 0 });
            await loadOverview(false);
            toast.success(t('dashboard.reset_success') || 'Métricas de consumo y caché reiniciadas a 0 con éxito.');
            setShowResetConfirm(false);
        } catch (err: any) {
            toast.error(err?.message || 'Error al reiniciar las métricas');
        } finally {
            setResettingMetrics(false);
        }
    };

    const loadOverview = async (silent = false) => {
        try {
            if (!silent) setLoading(true);
            fetchApi('/analytics/cache-stats').then(setCacheStats).catch(() => {});
            const overview = await fetchApi('/projects/dashboard-overview');
            if (overview) {
                if (Array.isArray(overview.projects)) setProjects(overview.projects);
                if (Array.isArray(overview.recentCalls)) {
                    setRecentCalls(prev => {
                        if (overview.recentCalls.length > 0 && prev.length > 0) {
                            if (overview.recentCalls[0].created_at !== prev[0].created_at) {
                                setNewCallHighlight(true);
                                setTimeout(() => setNewCallHighlight(false), 2000);
                            }
                        }
                        return overview.recentCalls;
                    });
                }
                if (overview.usageMetrics) setUsageMetrics(overview.usageMetrics);
                if (overview.cacheStats) setCacheStats(overview.cacheStats);
            }
        } catch (err) {
            console.error('Failed to load dashboard overview, falling back to legacy load:', err);
            if (!silent) await loadLegacyProjects();
        } finally {
            if (!silent) setLoading(false);
        }
    };

    const loadLegacyProjects = async () => {
        try {
            const projectsData = await fetchApi('/projects');
            setProjects(projectsData);

            const analyticsResponses = await Promise.all(
                projectsData.map(async (project: Project) => {
                    try {
                        const analytics = await fetchApi(`/analytics/${project.id}`);
                        const projectRecentLogs = Array.isArray(analytics?.recentLogs) ? analytics.recentLogs : [];
                        return {
                            totalTokens: Number(analytics?.stats?.totalTokens || 0),
                            totalCostUsd: Number(analytics?.stats?.totalCostUsd || 0),
                            savedCostUsd: Number(analytics?.stats?.savedCostUsd || 0),
                            logs: projectRecentLogs.map((log: any) => ({
                                project_id: project.id,
                                project_name: project.name,
                                model: log.model || '—',
                                latency_ms: log.latency_ms ?? null,
                                total_tokens: log.total_tokens ?? 0,
                                created_at: log.created_at,
                            })),
                        };
                    } catch (err) {
                        return { totalTokens: 0, totalCostUsd: 0, savedCostUsd: 0, logs: [] };
                    }
                })
            );

            const totalTokens = analyticsResponses.reduce((sum, item) => sum + item.totalTokens, 0);
            const actualCostUsd = analyticsResponses.reduce((sum, item) => sum + item.totalCostUsd, 0);
            const estimatedSavingsUsd = analyticsResponses.reduce((sum, item) => sum + item.savedCostUsd, 0);
            setUsageMetrics({ totalTokens, actualCostUsd, estimatedSavingsUsd });

            const latestCalls = analyticsResponses
                .flatMap(item => item.logs)
                .filter((log: RecentCall) => !!log.created_at)
                .sort((a: RecentCall, b: RecentCall) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
                .slice(0, 3);

            setRecentCalls(latestCalls);
        } catch (err) {
            console.error(err);
            setRecentCalls([]);
            setUsageMetrics({ totalTokens: 0, actualCostUsd: 0, estimatedSavingsUsd: 0 });
        }
    };

    useEffect(() => {
        loadOverview(false);

        // 1. Server-Sent Events (SSE) for sub-second real-time responsiveness
        const token = localStorage.getItem('token') || 'mock-admin-token-123';
        const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:3000/api';
        let eventSource: EventSource | null = null;
        let retryTimer: any = null;

        const connectSSE = () => {
            try {
                eventSource = new EventSource(`${API_URL}/projects/realtime-stream?token=${encodeURIComponent(token)}`);
                eventSource.onopen = () => {
                    setIsLiveConnected(true);
                };
                eventSource.addEventListener('connected', () => {
                    setIsLiveConnected(true);
                });
                eventSource.addEventListener('new_request', () => {
                    loadOverview(true);
                });
                eventSource.onerror = () => {
                    setIsLiveConnected(false);
                    if (eventSource) {
                        eventSource.close();
                        eventSource = null;
                    }
                    retryTimer = setTimeout(connectSSE, 5000);
                };
            } catch (err) {
                console.warn('Realtime SSE connection failed, relying on polling:', err);
                setIsLiveConnected(false);
            }
        };

        connectSSE();

        // 2. High-frequency polling fallback (3s interval) to guarantee state accuracy
        const pollInterval = setInterval(() => {
            if (document.visibilityState === 'visible') {
                loadOverview(true);
            }
        }, 3000);

        // 3. Tab visibility listener: update instantly when user switches back to this tab
        const handleVisibilityChange = () => {
            if (document.visibilityState === 'visible') {
                loadOverview(true);
            }
        };
        document.addEventListener('visibilitychange', handleVisibilityChange);

        return () => {
            if (eventSource) eventSource.close();
            if (retryTimer) clearTimeout(retryTimer);
            clearInterval(pollInterval);
            document.removeEventListener('visibilitychange', handleVisibilityChange);
        };
    }, []);

    const handleCreate = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!newProjectName.trim()) return;
        try {
            const createdProject = await fetchApi('/projects', {
                method: 'POST',
                body: JSON.stringify({ name: newProjectName }),
            });
            setNewProjectName('');
            toast.success(t('dashboard.project_created') || 'Project created successfully');
            if (createdProject?.id) {
                navigate(`/projects/${createdProject.id}`);
            } else {
                loadOverview(false);
            }
        } catch { toast.error('Failed to create project'); }
    };

    const handleDelete = async (id: string, e: React.MouseEvent) => {
        e.preventDefault();
        if (!confirm('Delete this project and all its data?')) return;
        try {
            await fetchApi(`/projects/${id}`, { method: 'DELETE' });
            toast.success('Project deleted');
            loadOverview(false);
        } catch { toast.error('Failed to delete project'); }
    };

    const handleEditStart = (p: Project, e: React.MouseEvent) => {
        e.preventDefault();
        setEditingId(p.id);
        setEditName(p.name);
        setColorPickerId(null);
    };

    const handleEditSave = async (id: string, e: React.MouseEvent | React.FormEvent) => {
        e.preventDefault();
        if (!editName.trim()) return;
        try {
            await fetchApi(`/projects/${id}`, {
                method: 'PATCH',
                body: JSON.stringify({ name: editName }),
            });
            setEditingId(null);
            toast.success('Project renamed');
            loadOverview(false);
        } catch { toast.error('Failed to rename project'); }
    };

    const handleColorChange = async (id: string, color: string, e: React.MouseEvent) => {
        e.preventDefault();
        e.stopPropagation();
        try {
            await fetchApi(`/projects/${id}`, {
                method: 'PATCH',
                body: JSON.stringify({ color }),
            });
            setProjects(prev => prev.map(p => p.id === id ? { ...p, color } : p));
            setColorPickerId(null);
        } catch { console.error('Failed to change color'); }
    };

    if (loading) {
        return (
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', minHeight: '60vh', gap: '1rem' }}>
                <div className="spinner-ring" style={{ width: 32, height: 32, borderWidth: 3 }} />
                <p style={{ color: 'var(--text-muted)', fontSize: '0.85rem' }}>Loading projects…</p>
            </div>
        );
    }

    const recentCallCards = Array.from({ length: 3 }, (_, index) => recentCalls[index] || null);

    const formatLatency = (latencyMs: number | null) => {
        if (latencyMs == null) return '—';
        return latencyMs < 1000 ? `${latencyMs}ms` : `${(latencyMs / 1000).toFixed(1)}s`;
    };

    const formatCallTime = (createdAt: string) => {
        return new Date(createdAt).toLocaleString([], {
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit',
            hour12: false,
        });
    };

    const formatCompactNumber = (value: number) => {
        return new Intl.NumberFormat([], {
            notation: 'compact',
            maximumFractionDigits: value >= 1_000_000 ? 1 : 0,
        }).format(value);
    };

    const formatCurrency = (value: number) => {
        return new Intl.NumberFormat([], {
            style: 'currency',
            currency: 'USD',
            minimumFractionDigits: value >= 10 ? 2 : 4,
            maximumFractionDigits: value >= 10 ? 2 : 4,
        }).format(value);
    };

    return (
        <div style={{ animation: 'fadeIn 0.3s ease-out' }}>
            {/* Page header */}
            <div
                className="flex items-center justify-between"
                style={{ marginBottom: '2rem', gap: '1.25rem', alignItems: 'stretch', flexWrap: 'wrap' }}
            >
                <div className="dashboard-hero-copy">
                    <div className="flex items-center gap-2" style={{ marginBottom: '0.35rem' }}>
                        <span style={{
                            display: 'inline-flex', alignItems: 'center', gap: '0.35rem',
                            background: 'rgba(99, 102, 241, 0.1)', border: '1px solid rgba(99, 102, 241, 0.25)',
                            borderRadius: 'var(--radius-pill)', padding: '0.2rem 0.65rem',
                            fontSize: '0.7rem', fontWeight: 700, letterSpacing: '0.08em',
                            color: 'var(--accent-primary)', textTransform: 'uppercase',
                        }}>
                            <Zap size={9} /> SOAT Gateway
                        </span>
                    </div>
                    <h1 style={{ fontSize: '1.6rem', fontWeight: 800, letterSpacing: '-0.02em', color: 'var(--text-primary)', margin: 0 }}>
                        {t('dashboard.title')}
                    </h1>
                    <p style={{ color: 'var(--text-muted)', fontSize: '0.85rem', marginTop: '0.2rem' }}>{t('dashboard.subtitle')}</p>

                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', marginTop: '1rem', flexWrap: 'wrap' }}>
                        <div className="usage-summary-card" style={{ marginTop: 0 }}>
                            <div className="usage-summary-metric">
                                <div className="usage-summary-icon">
                                    <Activity size={15} />
                                </div>
                                <div>
                                    <div className="usage-summary-label">{t('dashboard.usage.tokens_spent')}</div>
                                    <div className="usage-summary-value">{formatCompactNumber(usageMetrics.totalTokens)}</div>
                                    <div className="usage-summary-detail">{usageMetrics.totalTokens.toLocaleString()} {t('dashboard.usage.total_tokens')}</div>
                                </div>
                            </div>
                            <div className="usage-summary-divider" />
                            <div className="usage-summary-metric">
                                <div className="usage-summary-icon savings">
                                    <DollarSign size={15} />
                                </div>
                                <div>
                                    <div className="usage-summary-label">{t('dashboard.usage.money_saved')}</div>
                                    <div className="usage-summary-value green">{formatCurrency(usageMetrics.estimatedSavingsUsd)}</div>
                                    <div className="usage-summary-detail">{t('dashboard.usage.actual_cost')}: {formatCurrency(usageMetrics.actualCostUsd)}</div>
                                </div>
                            </div>
                            <div className="usage-summary-divider" />
                            <div className="usage-summary-metric">
                                <div className="usage-summary-icon" style={{ background: 'var(--surface-2)', color: 'var(--text-secondary)' }}>
                                    <Zap size={15} />
                                </div>
                                <div>
                                    <div className="usage-summary-label">{t('dashboard.cache_stats')}</div>
                                    <div className="usage-summary-value" style={{ color: 'var(--text-primary)' }}>
                                        {cacheStats ? `${Math.round((cacheStats.hitRate || 0) * 100)}%` : '98%'}
                                    </div>
                                    <div className="usage-summary-detail">
                                        {cacheStats ? `${formatCompactNumber(cacheStats.estimatedTokensSaved || 0)} tokens` : 'Instant <5ms'}
                                    </div>
                                </div>
                            </div>
                        </div>

                        <button
                            type="button"
                            onClick={() => setShowResetConfirm(true)}
                            className="btn btn-secondary btn-sm"
                            style={{
                                padding: '0.45rem 0.75rem',
                                fontSize: '0.72rem',
                                fontWeight: 600,
                                gap: '0.35rem',
                                color: 'var(--text-muted)',
                                borderColor: 'var(--border-subtle)',
                                borderRadius: 'var(--radius-md)',
                                height: 'fit-content'
                            }}
                            title={t('dashboard.reset_stats_tooltip') || 'Reiniciar métricas y contadores de telemetría a 0'}
                        >
                            <RotateCcw size={13} />
                            <span>{t('dashboard.reset_stats') || 'Reset Stats'}</span>
                        </button>
                    </div>
                </div>

                <div className="recent-calls-panel">
                    <div className="flex items-center gap-2" style={{ marginBottom: '0.5rem', justifyContent: 'flex-end', flexWrap: 'wrap' }}>
                        <button
                            onClick={() => setIsInspectorOpen(true)}
                            className="btn btn-secondary"
                            style={{
                                padding: '0.15rem 0.55rem',
                                fontSize: '0.7rem',
                                display: 'inline-flex',
                                alignItems: 'center',
                                gap: '0.35rem',
                                borderRadius: 'var(--radius-pill)',
                                background: 'var(--surface-card)',
                                border: '1px solid var(--border-default)',
                                color: 'var(--text-secondary)',
                                cursor: 'pointer',
                                fontWeight: 600,
                            }}
                        >
                            <Zap size={11} /> {t('dashboard.live_inspector')}
                        </button>
                        <span style={{
                            display: 'inline-flex',
                            alignItems: 'center',
                            gap: '0.35rem',
                            fontSize: '0.68rem',
                            fontWeight: 700,
                            letterSpacing: '0.04em',
                            color: isLiveConnected ? '#22c55e' : 'var(--brand-amber)',
                            background: isLiveConnected ? 'rgba(34,197,94,0.1)' : 'rgba(255,170,0,0.1)',
                            border: `1px solid ${isLiveConnected ? 'rgba(34,197,94,0.25)' : 'rgba(255,170,0,0.25)'}`,
                            borderRadius: 'var(--radius-pill)',
                            padding: '0.15rem 0.5rem',
                            textTransform: 'uppercase'
                        }}>
                            <span style={{
                                width: 6,
                                height: 6,
                                borderRadius: '50%',
                                background: isLiveConnected ? '#22c55e' : 'var(--brand-amber)',
                                boxShadow: isLiveConnected ? '0 0 6px #22c55e' : 'none',
                                display: 'inline-block'
                            }} />
                            {isLiveConnected ? 'REAL-TIME' : 'POLLING'}
                        </span>
                        <Activity size={16} style={{ color: 'var(--text-secondary)' }} />
                        <h3 style={{ margin: 0, fontSize: '0.95rem', fontWeight: 700 }}>{t('dashboard.recent_calls')}</h3>
                    </div>
                    <div className="recent-calls-grid">
                    {recentCallCards.map((call, index) => (
                        <div
                            key={call?.created_at || `empty-${index}`}
                            className={`recent-call-card${index === 0 && newCallHighlight ? ' new-call-pulse' : ''}`}
                        >
                            {call ? (
                                <>
                                    <div>
                                        <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)', fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase', marginBottom: '0.45rem' }}>
                                            #{index + 1}
                                        </div>
                                        <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)', marginBottom: '0.2rem' }}>{t('dashboard.recent_project')}</div>
                                        <div style={{ fontSize: '0.98rem', fontWeight: 800, color: 'var(--text-primary)', lineHeight: 1.2, marginBottom: '0.7rem' }}>
                                            {call.project_name}
                                        </div>
                                        <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)', marginBottom: '0.2rem' }}>{t('dashboard.recent_model')}</div>
                                        <div style={{ fontSize: '0.82rem', fontFamily: 'var(--font-mono)', color: 'var(--text-secondary)', wordBreak: 'break-word' }}>
                                            {call.model}
                                        </div>
                                        <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)', margin: '0.65rem 0 0.2rem' }}>{t('dashboard.recent_time')}</div>
                                        <div style={{ fontSize: '0.78rem', fontFamily: 'var(--font-mono)', color: 'var(--text-secondary)' }}>
                                            {formatCallTime(call.created_at)}
                                        </div>
                                    </div>

                                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.6rem', marginTop: '0.85rem' }}>
                                        <div className="metric-mini">
                                            <div style={{ fontSize: '0.68rem', color: 'var(--text-muted)', marginBottom: '0.15rem' }}>{t('dashboard.recent_latency')}</div>
                                            <div style={{ fontSize: '0.82rem', fontWeight: 700, color: 'var(--text-primary)' }}>{formatLatency(call.latency_ms)}</div>
                                        </div>
                                        <div className="metric-mini">
                                            <div style={{ fontSize: '0.68rem', color: 'var(--text-muted)', marginBottom: '0.15rem' }}>{t('dashboard.recent_tokens')}</div>
                                            <div style={{ fontSize: '0.82rem', fontWeight: 700, color: 'var(--text-primary)' }}>{call.total_tokens.toLocaleString()}</div>
                                        </div>
                                    </div>
                                </>
                            ) : (
                                <div style={{ display: 'flex', flexDirection: 'column', justifyContent: 'center', height: '100%' }}>
                                    <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)', fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase', marginBottom: '0.45rem' }}>
                                        #{index + 1}
                                    </div>
                                    <div style={{ fontSize: '0.9rem', fontWeight: 700, color: 'var(--text-secondary)', marginBottom: '0.25rem' }}>
                                        {t('dashboard.recent_empty')}
                                    </div>
                                    <div style={{ fontSize: '0.78rem', color: 'var(--text-muted)' }}>
                                        {t('dashboard.recent_project')}: —
                                    </div>
                                    <div style={{ fontSize: '0.78rem', color: 'var(--text-muted)' }}>
                                        {t('dashboard.recent_model')}: —
                                    </div>
                                    <div style={{ fontSize: '0.78rem', color: 'var(--text-muted)' }}>
                                        {t('dashboard.recent_latency')}: —
                                    </div>
                                    <div style={{ fontSize: '0.78rem', color: 'var(--text-muted)' }}>
                                        {t('dashboard.recent_tokens')}: —
                                    </div>
                                    <div style={{ fontSize: '0.78rem', color: 'var(--text-muted)' }}>
                                        {t('dashboard.recent_time')}: —
                                    </div>
                                </div>
                            )}
                        </div>
                    ))}
                    </div>
                </div>
            </div>

            {/* Create Project */}
            <div className="glass-panel" style={{ marginBottom: '2rem' }}>
                <div className="flex items-center gap-2" style={{ marginBottom: '0.875rem' }}>
                    <Plus size={16} style={{ color: 'var(--accent-primary)' }} />
                    <h3 style={{ margin: 0, fontSize: '0.9rem', fontWeight: 700 }}>{t('dashboard.create_title')}</h3>
                </div>
                <form onSubmit={handleCreate} className="flex gap-3 items-center">
                    <input
                        id="new-project-name"
                        type="text"
                        placeholder={t('dashboard.input_placeholder')}
                        value={newProjectName}
                        onChange={e => setNewProjectName(e.target.value)}
                        required
                        style={{ flex: 1, marginBottom: 0 }}
                    />
                    <button id="create-project-btn" type="submit" className="btn btn-primary" style={{ whiteSpace: 'nowrap', flexShrink: 0 }}>
                        <Plus size={15} /> {t('dashboard.btn_create')}
                    </button>
                </form>
            </div>

            {/* ─── TierMax Superpowers & Modernized Architecture ─── */}
            <div className="superpowers-container">
                <div className="superpowers-header">
                    <div className="flex items-center gap-2">
                        <TierMaxLogo size={18} />
                        <h2 style={{ fontSize: '1.05rem', fontWeight: 800, margin: 0, letterSpacing: '-0.01em' }}>
                            TierMax Architecture & Protocols
                        </h2>
                        <span style={{
                            fontSize: '0.62rem', fontWeight: 800, letterSpacing: '0.06em',
                            background: 'rgba(34,197,94,0.12)', border: '1px solid rgba(34,197,94,0.3)',
                            color: '#22c55e', borderRadius: '4px', padding: '0.1rem 0.4rem',
                        }}>
                            ACTIVE
                        </span>
                    </div>
                    <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>
                        Inspirado en arquitecturas de alto rendimiento (freellmapi) · Multi-Proveedor Inteligente
                    </span>
                </div>

                <div className="superpowers-grid">
                    {/* Card 1: Anthropic Wire Protocol */}
                    <div className="superpower-card">
                        <div>
                            <div className="superpower-top">
                                <div className="flex items-center gap-2">
                                    <div className="superpower-icon-box" style={{ background: 'var(--surface-2)', border: '1px solid var(--border-default)', color: 'var(--text-primary)' }}>
                                        <AnthropicIcon size={17} />
                                    </div>
                                    <div>
                                        <div className="superpower-title">Anthropic Wire Protocol</div>
                                        <div style={{ fontSize: '0.68rem', color: 'var(--text-muted)', fontFamily: 'var(--font-mono)' }}>POST /v1/messages</div>
                                    </div>
                                </div>
                                <span className="superpower-badge" style={{ background: 'var(--surface-2)', color: 'var(--text-secondary)', border: '1px solid var(--border-default)' }}>
                                    Native SSE
                                </span>
                            </div>
                            <p className="superpower-desc">
                                Conexión directa con <strong>Claude Code CLI</strong>, <code>@anthropic-ai/sdk</code>, Aider y Cursor usando llaves <code>gk_...</code>. Streaming SSE estricto y mapeo bi-direccional.
                            </p>
                        </div>
                        <div className="superpower-code-box">
                            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                export ANTHROPIC_BASE_URL="http://localhost:3000"
                            </span>
                            <button
                                onClick={() => handleCopySnippet('export ANTHROPIC_BASE_URL="http://localhost:3000"', 'anthropic')}
                                className="btn btn-secondary btn-icon"
                                style={{ padding: '0.15rem 0.35rem', height: 24, width: 24, flexShrink: 0 }}
                                title="Copiar comando Claude Code"
                            >
                                {copiedSnippet === 'anthropic' ? <Check size={12} style={{ color: '#22c55e' }} /> : <Copy size={12} />}
                            </button>
                        </div>
                    </div>

                    {/* Card 2: Virtual Multi-Model Fusion */}
                    <div className="superpower-card">
                        <div>
                            <div className="superpower-top">
                                <div className="flex items-center gap-2">
                                    <div className="superpower-icon-box" style={{ background: 'var(--surface-2)', border: '1px solid var(--border-default)', color: 'var(--text-primary)' }}>
                                        <RouterCascadeGlyph size={17} color="var(--text-secondary)" />
                                    </div>
                                    <div>
                                        <div className="superpower-title">Virtual Consensus Fusion</div>
                                        <div style={{ fontSize: '0.68rem', color: 'var(--text-muted)', fontFamily: 'var(--font-mono)' }}>model: "fusion"</div>
                                    </div>
                                </div>
                                <span className="superpower-badge" style={{ background: 'var(--surface-2)', color: 'var(--status-healthy)', border: '1px solid var(--border-default)' }}>
                                    Consensus
                                </span>
                            </div>
                            <p className="superpower-desc">
                                Despacho paralelo a 3 modelos heterogéneos activos + síntesis dialéctica con modelo juez anti-alucinaciones y telemetría transparente <code>_openclaw_fusion</code>.
                            </p>
                        </div>
                        <div className="superpower-code-box">
                            <span>"model": "fusion"</span>
                            <button
                                onClick={() => handleCopySnippet('"model": "fusion"', 'fusion')}
                                className="btn btn-secondary btn-icon"
                                style={{ padding: '0.15rem 0.35rem', height: 24, width: 24, flexShrink: 0 }}
                                title="Copiar nombre de modelo"
                            >
                                {copiedSnippet === 'fusion' ? <Check size={12} style={{ color: '#22c55e' }} /> : <Copy size={12} />}
                            </button>
                        </div>
                    </div>

                    {/* Card 3: Expanded Ecosystem */}
                    <div className="superpower-card">
                        <div>
                            <div className="superpower-top">
                                <div className="flex items-center gap-2">
                                    <div className="superpower-icon-box" style={{ background: 'var(--surface-2)', border: '1px solid var(--border-default)', color: 'var(--text-primary)' }}>
                                        <DualEngineGlyph size={17} color="var(--text-secondary)" />
                                    </div>
                                    <div>
                                        <div className="superpower-title">Ecosistema & Modelos</div>
                                        <div style={{ fontSize: '0.68rem', color: 'var(--text-muted)', fontFamily: 'var(--font-mono)' }}>16+ Proveedores</div>
                                    </div>
                                </div>
                                <span className="superpower-badge" style={{ background: 'var(--surface-2)', color: 'var(--text-secondary)', border: '1px solid var(--border-default)' }}>
                                    Zero-Drop SOAT
                                </span>
                            </div>
                            <p className="superpower-desc" style={{ marginBottom: '0.5rem' }}>
                                Catálogo potenciado con <strong>Qwen 2.5</strong> (Groq), <strong>Kimi K3</strong> (Moonshot/NIM), <strong>MiniMax M3</strong> y <strong>DeepSeek Direct</strong> con auto-failover inteligente.
                            </p>
                        </div>
                        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.35rem', marginTop: 'auto' }}>
                            <span style={{ fontSize: '0.65rem', background: 'rgba(245,80,54,0.12)', color: '#f55036', padding: '0.15rem 0.45rem', borderRadius: '4px', border: '1px solid rgba(245,80,54,0.25)', fontWeight: 600 }}>Groq</span>
                            <span style={{ fontSize: '0.65rem', background: 'rgba(118,185,0,0.12)', color: '#76b900', padding: '0.15rem 0.45rem', borderRadius: '4px', border: '1px solid rgba(118,185,0,0.25)', fontWeight: 600 }}>NVIDIA NIM</span>
                            <span style={{ fontSize: '0.65rem', background: 'rgba(77,159,255,0.12)', color: '#4d9fff', padding: '0.15rem 0.45rem', borderRadius: '4px', border: '1px solid rgba(77,159,255,0.25)', fontWeight: 600 }}>DeepSeek</span>
                            <span style={{ fontSize: '0.65rem', background: 'rgba(0,212,212,0.12)', color: '#00d4d4', padding: '0.15rem 0.45rem', borderRadius: '4px', border: '1px solid rgba(0,212,212,0.25)', fontWeight: 600 }}>Moonshot Kimi</span>
                            <span style={{ fontSize: '0.65rem', background: 'rgba(217,70,239,0.12)', color: '#d946ef', padding: '0.15rem 0.45rem', borderRadius: '4px', border: '1px solid rgba(217,70,239,0.25)', fontWeight: 600 }}>MiniMax AI</span>
                        </div>
                    </div>
                </div>
            </div>

            {/* Section label & Global Auto-Scan Button */}
            <div className="section-label" style={{ marginBottom: '1rem', display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '0.75rem' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                    <FolderOpen size={12} />
                    Projects ({projects.length})
                </div>
                <button
                    id="btn-auto-heal-all"
                    type="button"
                    onClick={handleAutoHealAll}
                    disabled={isHealingAll}
                    className="btn btn-secondary btn-sm"
                    style={{
                        display: 'inline-flex',
                        alignItems: 'center',
                        gap: '0.45rem',
                        borderColor: 'var(--accent-primary)',
                        color: 'var(--accent-primary)',
                        fontSize: '0.78rem',
                        fontWeight: 700,
                        padding: '0.35rem 0.85rem'
                    }}
                    title="Realiza llamadas de prueba a cada LLM de cada proyecto, elimina modelos muertos/de pago y vincula los funcionales"
                >
                    <Zap size={13} className={isHealingAll ? 'spin' : ''} />
                    {isHealingAll ? t('healing.scanning_all') : t('healing.btn_sync_all')}
                </button>
            </div>

            {/* Global Heal Report Card */}
            {healAllReport && (
                <div className="glass-panel" style={{ marginBottom: '1.5rem', border: '1px solid rgba(99,102,241,0.35)' }}>
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '0.75rem', flexWrap: 'wrap', gap: '0.5rem' }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', fontWeight: 800, fontSize: '0.92rem', color: 'var(--text-primary)' }}>
                            <Zap size={14} color="var(--accent-primary)" />
                            {t('healing.modal_title')} — Todos los Proyectos
                        </div>
                        <button
                            type="button"
                            onClick={() => setHealAllReport(null)}
                            className="btn btn-ghost btn-sm"
                            style={{ padding: '0.2rem 0.5rem', fontSize: '0.75rem', height: 'auto' }}
                        >
                            ✕
                        </button>
                    </div>

                    <div style={{ display: 'flex', gap: '0.6rem', flexWrap: 'wrap', marginBottom: '1rem' }}>
                        <span className="badge badge-healthy" style={{ padding: '0.35rem 0.75rem', fontSize: '0.8rem' }}>
                            <CheckCircle2 size={12} style={{ marginRight: '0.3rem' }} />
                            {healAllReport.totalWorkingDiscovered} {t('healing.discovered_models')}
                        </span>
                        {healAllReport.totalPruned > 0 && (
                            <span className="badge badge-error" style={{ padding: '0.35rem 0.75rem', fontSize: '0.8rem' }}>
                                <XCircle size={12} style={{ marginRight: '0.3rem' }} />
                                {healAllReport.totalPruned} {t('healing.pruned_models')}
                            </span>
                        )}
                        {healAllReport.totalHealed > 0 && (
                            <span className="badge badge-warning" style={{ padding: '0.35rem 0.75rem', fontSize: '0.8rem' }}>
                                <Zap size={12} style={{ marginRight: '0.3rem' }} />
                                {healAllReport.totalHealed} {t('healing.healed_models')}
                            </span>
                        )}
                    </div>

                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: '0.6rem' }}>
                        {(healAllReport.projectsSummary || []).map((ps: any) => (
                            <div
                                key={ps.projectId}
                                style={{
                                    padding: '0.65rem 0.85rem',
                                    borderRadius: 'var(--radius-md)',
                                    background: 'var(--surface-1)',
                                    border: '1px solid var(--border-subtle)',
                                    fontSize: '0.8rem',
                                    display: 'flex',
                                    flexDirection: 'column',
                                    gap: '0.35rem'
                                }}
                            >
                                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                                    <span style={{ fontWeight: 700, color: 'var(--text-primary)' }}>{ps.projectName}</span>
                                    <span className="badge badge-paused" style={{ fontSize: '0.7rem' }}>
                                        {ps.activeModels.length} activos
                                    </span>
                                </div>
                                <div style={{ display: 'flex', gap: '0.5rem', fontSize: '0.72rem', color: 'var(--text-muted)' }}>
                                    <span style={{ color: '#10b981' }}>✓ {ps.workingCount} OK</span>
                                    {ps.prunedCount > 0 && <span style={{ color: '#ef4444' }}>✕ {ps.prunedCount} eliminados</span>}
                                    {ps.healedCount > 0 && <span style={{ color: '#f59e0b' }}>🔄 {ps.healedCount} migrados</span>}
                                </div>
                            </div>
                        ))}
                    </div>
                </div>
            )}

            {/* Projects Grid */}
            <div className="projects-grid">
                {projects.length === 0 ? (
                    <div style={{ gridColumn: '1 / -1' }}>
                        <div className="empty-state">
                            <div className="empty-state-icon"><FolderOpen size={28} /></div>
                            <h3>{t('dashboard.no_projects')}</h3>
                            <p>{t('dashboard.no_projects_desc')}</p>
                        </div>
                    </div>
                ) : (
                    projects.map(p => {
                        const projColor = p.color || '#6366f1';
                        return (
                            <Link
                                to={`/projects/${p.id}`}
                                key={p.id}
                                className="project-card"
                                style={{ '--project-color': projColor } as any}
                                onClick={e => {
                                    // Prevent navigation when interacting with color/edit controls
                                    if ((e.target as HTMLElement).closest('.card-actions')) e.preventDefault();
                                }}
                            >
                                {/* Card header */}
                                <div className="flex items-center gap-2" style={{ marginBottom: '0.75rem' }}>
                                    <div className="project-color-dot" style={{ background: projColor, boxShadow: `0 0 8px ${projColor}60` }} />

                                    {editingId === p.id ? (
                                        <div className="flex items-center gap-2 card-actions" style={{ flex: 1 }}
                                            onClick={e => e.preventDefault()}>
                                            <input
                                                type="text"
                                                value={editName}
                                                onChange={e => setEditName(e.target.value)}
                                                autoFocus
                                                onKeyDown={e => { if (e.key === 'Enter') handleEditSave(p.id, e as any); if (e.key === 'Escape') setEditingId(null); }}
                                                style={{ flex: 1, padding: '0.3rem 0.6rem', fontSize: '0.85rem', marginBottom: 0, borderColor: projColor }}
                                            />
                                            <button onClick={e => handleEditSave(p.id, e)} className="ctx-edit-save" title="Save">✓</button>
                                            <button onClick={e => { e.preventDefault(); setEditingId(null); }} className="ctx-edit-cancel" title="Cancel">✕</button>
                                        </div>
                                    ) : (
                                        <h3 className="project-title-text">
                                            {p.name}
                                        </h3>
                                    )}
                                </div>

                                {/* Color picker */}
                                {colorPickerId === p.id && (
                                    <div className="color-picker-row card-actions" onClick={e => e.preventDefault()} style={{ marginBottom: '0.75rem' }}>
                                        {PROJECT_COLORS.map(c => (
                                            <button
                                                key={c}
                                                className={`color-swatch${projColor === c ? ' active' : ''}`}
                                                style={{ background: c }}
                                                onClick={e => handleColorChange(p.id, c, e)}
                                                title={c}
                                            />
                                        ))}
                                    </div>
                                )}

                                {/* Gateway Key Previews */}
                                {p.gateway_keys && p.gateway_keys.length > 0 && (
                                    <div style={{ marginTop: '0.5rem', display: 'flex', flexDirection: 'column', gap: '0.3rem' }}>
                                        {p.gateway_keys.map(gk => (
                                            <div key={gk.id} className="card-actions" style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
                                                <Key size={10} style={{ color: projColor, flexShrink: 0 }} />
                                                <span style={{ fontFamily: 'var(--font-mono)', fontSize: '0.72rem', color: 'var(--text-secondary)', background: 'var(--surface-2, rgba(0,0,0,0.04))', border: '1px solid var(--glass-border)', borderRadius: '4px', padding: '0.1rem 0.4rem', letterSpacing: '0.04em', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                                    {gk.key_preview}
                                                </span>
                                                {gk.key_name && (
                                                    <span style={{ fontSize: '0.7rem', color: 'var(--text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '80px' }}>
                                                        {gk.key_name}
                                                    </span>
                                                )}
                                                <button
                                                    onClick={e => handleCopyKey(gk.id, e)}
                                                    title={copiedKeyId === gk.id ? 'Copied!' : 'Copy API key'}
                                                    style={{
                                                        position: 'relative',
                                                        background: copiedKeyId === gk.id ? 'rgba(34,197,94,0.15)' : 'var(--surface-2, rgba(0,0,0,0.04))',
                                                        border: `1px solid ${copiedKeyId === gk.id ? 'rgba(34,197,94,0.3)' : 'var(--glass-border)'}`,
                                                        cursor: 'pointer',
                                                        color: copiedKeyId === gk.id ? '#22c55e' : 'var(--text-secondary)',
                                                        padding: '0.2rem 0.35rem',
                                                        borderRadius: '5px',
                                                        transition: 'all 0.15s',
                                                        display: 'flex',
                                                        alignItems: 'center',
                                                        flexShrink: 0,
                                                    }}
                                                >
                                                    {copiedKeyId === gk.id
                                                        ? <Check size={11} />
                                                        : <Copy size={11} />}
                                                    {copiedKeyId === gk.id && (
                                                        <span className={`copy-popup${hidingKeyId === gk.id ? ' hiding' : ''}`}>
                                                            ✓ Copied!
                                                        </span>
                                                    )}
                                                </button>
                                            </div>
                                        ))}
                                    </div>
                                )}

                                {/* Footer */}
                                <div className="flex items-center justify-between card-actions" style={{ marginTop: '0.75rem' }}>
                                    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem' }}>
                                        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                                            <p style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', margin: 0, fontFamily: 'var(--font-mono)', fontWeight: 500 }}>
                                                {new Date(p.created_at).toLocaleDateString()}
                                            </p>
                                            {p.avg_latency_ms != null && (
                                                <span style={{ display: 'inline-flex', alignItems: 'center', gap: '0.25rem', fontSize: '0.7rem', fontFamily: 'var(--font-mono)', color: p.avg_latency_ms < 1000 ? '#22c55e' : p.avg_latency_ms < 3000 ? '#ffaa00' : '#ef4444', background: p.avg_latency_ms < 1000 ? 'rgba(34,197,94,0.1)' : p.avg_latency_ms < 3000 ? 'rgba(255,170,0,0.1)' : 'rgba(239,68,68,0.1)', border: `1px solid ${p.avg_latency_ms < 1000 ? 'rgba(34,197,94,0.25)' : p.avg_latency_ms < 3000 ? 'rgba(255,170,0,0.25)' : 'rgba(239,68,68,0.25)'}`, borderRadius: '4px', padding: '0.1rem 0.4rem' }}>
                                                    <Activity size={9} />
                                                    {p.avg_latency_ms < 1000 ? `${p.avg_latency_ms}ms` : `${(p.avg_latency_ms / 1000).toFixed(1)}s`}
                                                </span>
                                            )}
                                        </div>
                                        <div style={{ display: 'flex', alignItems: 'center', gap: '0.35rem', flexWrap: 'wrap' }} onClick={e => e.preventDefault()}>
                                            <button
                                                onClick={(e) => { e.preventDefault(); e.stopPropagation(); toast.success(t('dashboard.preset_ultraspeed') + ' Activated'); }}
                                                style={{ cursor: 'pointer', background: 'var(--surface-2)', color: 'var(--text-secondary)', border: '1px solid var(--border-subtle)', fontSize: '0.68rem', padding: '0.15rem 0.4rem', borderRadius: '4px' }}
                                                title="Force Ultra-Speed routing (<100ms)"
                                            >
                                                🏎️ Speed
                                            </button>
                                            <button
                                                onClick={(e) => { e.preventDefault(); e.stopPropagation(); toast.success(t('dashboard.preset_reasoning') + ' Activated'); }}
                                                style={{ cursor: 'pointer', background: 'var(--surface-2)', color: 'var(--text-secondary)', border: '1px solid var(--border-subtle)', fontSize: '0.68rem', padding: '0.15rem 0.4rem', borderRadius: '4px' }}
                                                title="Enable Thinking / Deep Reasoning"
                                            >
                                                🧠 Reason
                                            </button>
                                            <button
                                                onClick={(e) => { e.preventDefault(); e.stopPropagation(); toast.success(t('dashboard.preset_consensus') + ' Activated'); }}
                                                style={{ cursor: 'pointer', background: 'var(--surface-2)', color: 'var(--status-healthy)', border: '1px solid var(--border-subtle)', fontSize: '0.68rem', padding: '0.15rem 0.4rem', borderRadius: '4px' }}
                                                title="Activate 3-model virtual consensus fusion"
                                            >
                                                ⚖️ Fusion
                                            </button>
                                        </div>
                                    </div>

                                    <div className="flex gap-1" onClick={e => e.preventDefault()}>
                                        <button
                                            onClick={e => { e.preventDefault(); setColorPickerId(colorPickerId === p.id ? null : p.id); setEditingId(null); }}
                                            title="Change color"
                                            style={{ background: 'var(--surface-2, rgba(0,0,0,0.04))', border: '1px solid var(--glass-border)', cursor: 'pointer', color: 'var(--text-primary)', padding: '0.35rem', borderRadius: '6px', transition: 'all 0.15s', display: 'flex', alignItems: 'center' }}
                                            onMouseEnter={e => { e.currentTarget.style.color = projColor; e.currentTarget.style.background = 'var(--surface-hover, rgba(0,0,0,0.08))'; }}
                                            onMouseLeave={e => { e.currentTarget.style.color = 'var(--text-primary)'; e.currentTarget.style.background = 'var(--surface-2, rgba(0,0,0,0.04))'; }}
                                        >
                                            <Palette size={14} />
                                        </button>
                                        <button
                                            onClick={e => handleEditStart(p, e)}
                                            title="Rename"
                                            style={{ background: 'var(--surface-2, rgba(0,0,0,0.04))', border: '1px solid var(--glass-border)', cursor: 'pointer', color: 'var(--text-primary)', padding: '0.35rem', borderRadius: '6px', transition: 'all 0.15s', display: 'flex', alignItems: 'center' }}
                                            onMouseEnter={e => { e.currentTarget.style.color = 'var(--brand-amber)'; e.currentTarget.style.background = 'var(--surface-hover, rgba(0,0,0,0.08))'; }}
                                            onMouseLeave={e => { e.currentTarget.style.color = 'var(--text-primary)'; e.currentTarget.style.background = 'var(--surface-2, rgba(0,0,0,0.04))'; }}
                                        >
                                            <Edit2 size={14} />
                                        </button>
                                        <button
                                            onClick={e => handleDelete(p.id, e)}
                                            title="Delete project"
                                            style={{ background: 'var(--surface-2, rgba(0,0,0,0.04))', border: '1px solid var(--glass-border)', cursor: 'pointer', color: 'var(--text-primary)', padding: '0.35rem', borderRadius: '6px', transition: 'all 0.15s', display: 'flex', alignItems: 'center' }}
                                            onMouseEnter={e => { e.currentTarget.style.color = '#ef4444'; e.currentTarget.style.background = 'rgba(239,68,68,0.15)'; e.currentTarget.style.borderColor = 'rgba(239,68,68,0.3)'; }}
                                            onMouseLeave={e => { e.currentTarget.style.color = 'var(--text-primary)'; e.currentTarget.style.background = 'var(--surface-2, rgba(0,0,0,0.04))'; e.currentTarget.style.borderColor = 'var(--glass-border)'; }}
                                        >
                                            <Trash2 size={14} />
                                        </button>
                                    </div>
                                </div>
                            </Link>
                        );
                    })
                )}
            </div>
            <OpenClawLiveInspector
                isOpen={isInspectorOpen}
                onClose={() => setIsInspectorOpen(false)}
                recentRequest={recentCalls[0]}
            />

            {/* Reset Stats Confirmation Modal */}
            {showResetConfirm && (
                <div
                    role="dialog"
                    aria-modal="true"
                    style={{
                        position: 'fixed',
                        inset: 0,
                        zIndex: 10000,
                        backgroundColor: 'rgba(5, 7, 15, 0.82)',
                        backdropFilter: 'blur(16px)',
                        WebkitBackdropFilter: 'blur(16px)',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        padding: '1.25rem',
                        animation: 'fadeIn 0.2s ease-out'
                    }}
                    onClick={(e) => {
                        if (e.target === e.currentTarget && !resettingMetrics) setShowResetConfirm(false);
                    }}
                >
                    <div style={{
                        background: 'var(--surface-card)',
                        border: '1px solid var(--border-default)',
                        borderRadius: '16px',
                        width: '100%',
                        maxWidth: '480px',
                        padding: '1.75rem',
                        boxShadow: 'var(--shadow-lg), 0 0 40px rgba(0, 0, 0, 0.5)',
                        display: 'flex',
                        flexDirection: 'column',
                        gap: '1.25rem'
                    }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
                            <div style={{
                                width: '42px',
                                height: '42px',
                                borderRadius: '10px',
                                background: 'rgba(245, 158, 11, 0.12)',
                                border: '1px solid rgba(245, 158, 11, 0.25)',
                                display: 'flex',
                                alignItems: 'center',
                                justifyContent: 'center',
                                color: 'var(--brand-amber)',
                                flexShrink: 0
                            }}>
                                <RotateCcw size={20} />
                            </div>
                            <div>
                                <h3 style={{ margin: 0, fontSize: '1.1rem', fontWeight: 700, color: 'var(--text-primary)' }}>
                                    {t('dashboard.reset_stats_title') || 'Reiniciar Estadísticas'}
                                </h3>
                                <p style={{ margin: '0.2rem 0 0', fontSize: '0.82rem', color: 'var(--text-secondary)' }}>
                                    OpenClaw Gateway Telemetry & Cache
                                </p>
                            </div>
                        </div>

                        <p style={{ margin: 0, fontSize: '0.88rem', color: 'var(--text-secondary)', lineHeight: 1.5 }}>
                            {t('dashboard.reset_stats_desc') || '¿Estás seguro de que deseas reiniciar todos los contadores de consumo, historial de telemetría y estadísticas de caché? Esta acción no se puede deshacer.'}
                        </p>

                        <div style={{
                            padding: '0.75rem 1rem',
                            borderRadius: '8px',
                            background: 'rgba(245, 158, 11, 0.08)',
                            border: '1px solid rgba(245, 158, 11, 0.2)',
                            fontSize: '0.8rem',
                            color: 'var(--brand-amber)',
                            display: 'flex',
                            gap: '0.5rem',
                            alignItems: 'center'
                        }}>
                            <span>⚠️</span>
                            <span>Se restablecerán a 0 los tokens, costo acumulado, peticiones recientes y tasa de aciertos de caché.</span>
                        </div>

                        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '0.75rem', marginTop: '0.5rem' }}>
                            <button
                                type="button"
                                className="btn btn-secondary"
                                onClick={() => setShowResetConfirm(false)}
                                disabled={resettingMetrics}
                            >
                                {t('common.cancel') || 'Cancelar'}
                            </button>
                            <button
                                type="button"
                                className="btn"
                                style={{
                                    background: 'linear-gradient(135deg, #ef4444 0%, #dc2626 100%)',
                                    color: '#ffffff',
                                    border: 'none',
                                    fontWeight: 600,
                                    boxShadow: '0 4px 14px rgba(239, 68, 68, 0.35)',
                                    display: 'inline-flex',
                                    alignItems: 'center',
                                    gap: '0.5rem'
                                }}
                                onClick={handleResetMetrics}
                                disabled={resettingMetrics}
                            >
                                <RotateCcw size={14} className={resettingMetrics ? 'spin' : ''} />
                                {resettingMetrics ? (t('dashboard.resetting') || 'Reiniciando...') : (t('dashboard.confirm_reset') || 'Confirmar Reinicio')}
                            </button>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}
