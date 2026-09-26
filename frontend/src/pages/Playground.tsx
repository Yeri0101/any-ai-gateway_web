import { useState, useEffect, useRef } from 'react';
import { Link } from 'react-router-dom';
import { fetchApi } from '../api';
import {
    Send, Copy, Check, Cpu, Activity,
    Shield, RefreshCw, Terminal, AlertCircle, Square
} from 'lucide-react';
import { useLanguage } from '../i18n';
import { CyberTerminalGlyph, OpenAIIcon, AnthropicIcon, RouterCascadeGlyph } from '../components/Icons';

interface GatewayKey {
    id: string;
    key_name: string;
    api_key?: string;
    key_preview?: string;
    project_id?: string;
    gateway_key_models?: any[];
}

interface Project {
    id: string;
    name: string;
    gateway_keys?: GatewayKey[];
}

export default function Playground() {
    const { t } = useLanguage();
    const [projects, setProjects] = useState<Project[]>([]);
    const [selectedProject, setSelectedProject] = useState<string>('');
    const [selectedKey, setSelectedKey] = useState<string>('');
    const [model, setModel] = useState<string>('');
    const [projectModels, setProjectModels] = useState<string[]>([]);
    const [modelsLoading, setModelsLoading] = useState<boolean>(false);
    const [customModel, setCustomModel] = useState<string>('');
    const [systemPrompt, setSystemPrompt] = useState<string>('You are an intelligent, helpful, and concise AI assistant.');
    const [userPrompt, setUserPrompt] = useState<string>('Explain how semantic caching and rate limiting protect AI gateways in 3 bullet points.');
    const [temperature, setTemperature] = useState<number>(0.7);
    const [maxTokens, setMaxTokens] = useState<number>(1000);
    const [stream, setStream] = useState<boolean>(true);

    const [loading, setLoading] = useState<boolean>(false);
    const [responseContent, setResponseContent] = useState<string>('');
    const [copied, setCopied] = useState<boolean>(false);
    const [executionMeta, setExecutionMeta] = useState<any>(null);
    const [errorMsg, setErrorMsg] = useState<string>('');
    const responseEndRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        loadProjects();
    }, []);

    const loadModelsForProject = async (projId: string, currentProjects?: Project[]) => {
        if (!projId) {
            setProjectModels([]);
            return;
        }
        setModelsLoading(true);
        const projs = currentProjects || projects;
        const proj = projs.find(p => p.id === projId);

        // Immediate models extracted from already-loaded gateway keys
        const immediateModels = Array.from(new Set(
            (proj?.gateway_keys || []).flatMap((k: any) =>
                (k.gateway_key_models || []).map((m: any) => m.model_name)
            ).filter(Boolean)
        )) as string[];

        if (immediateModels.length > 0) {
            setProjectModels(immediateModels);
            setModel(prev => (immediateModels.includes(prev) ? prev : immediateModels[0]));
        }

        try {
            const res = await fetchApi(`/projects/${projId}/models`);
            const fetchedModels: string[] = res?.models || [];
            const merged = Array.from(new Set([...immediateModels, ...fetchedModels]));
            if (merged.length > 0) {
                setProjectModels(merged);
                setModel(prev => (merged.includes(prev) ? prev : merged[0]));
            } else if (immediateModels.length > 0) {
                setProjectModels(immediateModels);
                setModel(prev => (immediateModels.includes(prev) ? prev : immediateModels[0]));
            } else {
                setProjectModels([]);
            }
        } catch (e) {
            console.warn('Could not fetch project models from API, using key models:', e);
            if (immediateModels.length > 0) {
                setProjectModels(immediateModels);
                setModel(prev => (immediateModels.includes(prev) ? prev : immediateModels[0]));
            }
        } finally {
            setModelsLoading(false);
        }
    };

    const loadProjects = async () => {
        try {
            const [projData, gwKeys] = await Promise.all([
                fetchApi('/projects'),
                fetchApi('/gateway-keys').catch(() => [])
            ]);

            const keysList = Array.isArray(gwKeys) ? gwKeys : [];
            const enrichedProjects = (projData || []).map((proj: any) => {
                const projKeys = keysList.filter((k: any) => k.project_id === proj.id);
                const keys = projKeys.length > 0 ? projKeys : (proj.gateway_keys || []);
                return { ...proj, gateway_keys: keys };
            });

            setProjects(enrichedProjects);
            if (enrichedProjects.length > 0) {
                const firstProj = enrichedProjects[0];
                setSelectedProject(firstProj.id);
                if (firstProj.gateway_keys && firstProj.gateway_keys.length > 0) {
                    const firstKey = firstProj.gateway_keys[0];
                    setSelectedKey(firstKey.api_key || firstKey.key_preview || '');
                }
                loadModelsForProject(firstProj.id, enrichedProjects);
            }
        } catch (err: any) {
            console.error('Failed to load projects for playground:', err);
        }
    };

    const handleProjectChange = (projId: string) => {
        setSelectedProject(projId);
        const proj = projects.find(p => p.id === projId);
        if (proj && proj.gateway_keys && proj.gateway_keys.length > 0) {
            const firstKey = proj.gateway_keys[0];
            setSelectedKey(firstKey.api_key || firstKey.key_preview || '');
        } else {
            setSelectedKey('');
        }
        loadModelsForProject(projId);
    };

    const activeProject = projects.find(p => p.id === selectedProject);
    const availableKeys = activeProject?.gateway_keys || [];

    const abortControllerRef = useRef<AbortController | null>(null);

    const handleStop = () => {
        if (abortControllerRef.current) {
            abortControllerRef.current.abort();
            abortControllerRef.current = null;
        }
        setLoading(false);
    };

    const handleSend = async () => {
        if (!selectedKey) {
            setErrorMsg(t('playground.key_required') || 'Please select or configure a Gateway Key first');
            return;
        }
        if (!userPrompt.trim()) return;

        setLoading(true);
        setErrorMsg('');
        setResponseContent('');
        setExecutionMeta(null);

        const abortController = new AbortController();
        abortControllerRef.current = abortController;

        const effectiveModel = customModel.trim() || model;
        const messages: any[] = [];
        if (systemPrompt.trim()) {
            messages.push({ role: 'system', content: systemPrompt.trim() });
        }
        messages.push({ role: 'user', content: userPrompt.trim() });

        const payload = {
            model: effectiveModel,
            messages,
            temperature,
            max_tokens: maxTokens,
            stream,
        };

        const startTime = Date.now();
        const endpoint = window.location.port === '5173' ? 'http://localhost:3000/v1/chat/completions' : '/v1/chat/completions';

        try {
            const response = await fetch(endpoint, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${selectedKey}`,
                },
                body: JSON.stringify(payload),
                signal: abortController.signal,
            });

            const latencyMs = Date.now() - startTime;
            const engineHeader = response.headers.get('x-tiermax-engine') || 'standard';
            const tierHeader = response.headers.get('x-tiermax-tier') || 'economy';
            const confidenceHeader = response.headers.get('x-tiermax-confidence') || '95';
            const cacheHeader = response.headers.get('x-cache') || 'MISS';

            if (!response.ok) {
                const errData = await response.json().catch(() => ({}));
                throw new Error(errData.error?.message || `HTTP ${response.status}: ${response.statusText}`);
            }

            if (stream && response.body) {
                const reader = response.body.getReader();
                const decoder = new TextDecoder();
                let accumulated = '';
                let lineBuffer = '';

                setExecutionMeta({
                    latencyMs,
                    statusCode: 200,
                    provider: 'Streaming',
                    engine: engineHeader,
                    tier: tierHeader,
                    confidence: confidenceHeader,
                    cache: cacheHeader,
                });

                while (true) {
                    const { done, value } = await reader.read();
                    if (done) break;
                    const chunk = decoder.decode(value, { stream: true });
                    lineBuffer += chunk;
                    const lines = lineBuffer.split('\n');
                    lineBuffer = lines.pop() || '';

                    for (const line of lines) {
                        const trimmed = line.trim();
                        if (trimmed.startsWith('data: ')) {
                            const dataStr = trimmed.slice(6).trim();
                            if (dataStr === '[DONE]') continue;
                            try {
                                const parsed = JSON.parse(dataStr);
                                const delta = parsed.choices?.[0]?.delta?.content || '';
                                accumulated += delta;
                                setResponseContent(accumulated);
                            } catch { }
                        }
                    }
                }

                setExecutionMeta((prev: any) => ({
                    ...prev,
                    latencyMs: Date.now() - startTime,
                    tokens: Math.round(accumulated.length / 3.5),
                }));
            } else {
                const data = await response.json();
                const text = data.choices?.[0]?.message?.content || '';
                setResponseContent(text);
                setExecutionMeta({
                    latencyMs,
                    statusCode: 200,
                    provider: data._openclaw_metadata?.provider || 'Upstream',
                    engine: engineHeader,
                    tier: tierHeader,
                    confidence: confidenceHeader,
                    cache: cacheHeader,
                    promptTokens: data.usage?.prompt_tokens ?? 0,
                    completionTokens: data.usage?.completion_tokens ?? 0,
                    totalTokens: data.usage?.total_tokens ?? 0,
                });
            }
        } catch (err: any) {
            if (err.name !== 'AbortError') {
                setErrorMsg(err.message || 'Request failed');
            }
        } finally {
            setLoading(false);
            abortControllerRef.current = null;
        }
    };

    const copyResponse = () => {
        if (!responseContent) return;
        navigator.clipboard.writeText(responseContent);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
    };

    return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
            {/* Header */}
            <div className="flex items-center justify-between" style={{ flexWrap: 'wrap', gap: '1rem' }}>
                <div>
                    <h1 style={{ margin: 0, fontSize: '1.75rem', fontWeight: 800, display: 'flex', alignItems: 'center', gap: '0.65rem' }}>
                        <CyberTerminalGlyph size={26} color="var(--accent-primary)" />
                        {t('playground.title')}
                    </h1>
                    <p style={{ margin: '0.3rem 0 0', color: 'var(--text-muted)', fontSize: '0.88rem' }}>
                        {t('playground.subtitle')}
                    </p>
                </div>

                <div className="flex items-center gap-2">
                    <span className="badge badge-healthy" style={{ padding: '0.35rem 0.75rem', fontSize: '0.75rem', display: 'inline-flex', alignItems: 'center', gap: '0.45rem' }}>
                        <OpenAIIcon size={13} style={{ color: '#10a37f' }} />
                        <AnthropicIcon size={13} style={{ color: '#d97706' }} />
                        <span>OpenAI & Anthropic Wire Compatible</span>
                    </span>
                </div>
            </div>

            {/* Split layout: Controls & Prompts vs Output & Inspector */}
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(420px, 1fr))', gap: '1.5rem' }}>
                {/* Left Panel: Request Configuration & Inputs */}
                <div className="glass-panel" style={{ padding: '1.5rem', display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
                    <div className="flex items-center justify-between" style={{ borderBottom: '1px solid var(--border-subtle)', paddingBottom: '0.75rem' }}>
                        <div className="flex items-center gap-2" style={{ fontWeight: 700, fontSize: '0.95rem' }}>
                            <RouterCascadeGlyph size={17} color="var(--accent-primary)" />
                            <span>{t('playground.req_params')}</span>
                        </div>
                        <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>POST /v1/chat/completions</span>
                    </div>

                    {/* Project & Key Selectors */}
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem' }}>
                        <div className="form-group" style={{ margin: 0 }}>
                            <label style={{ fontSize: '0.78rem' }}>{t('playground.select_project')}</label>
                            <select
                                value={selectedProject}
                                onChange={e => handleProjectChange(e.target.value)}
                                style={{ width: '100%', padding: '0.5rem 0.75rem', fontSize: '0.85rem' }}
                            >
                                {projects.map(p => (
                                    <option key={p.id} value={p.id}>{p.name}</option>
                                ))}
                            </select>
                        </div>

                        <div className="form-group" style={{ margin: 0 }}>
                            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '0.2rem' }}>
                                <label style={{ fontSize: '0.78rem', margin: 0 }}>{t('playground.select_key')}</label>
                                {selectedProject && (
                                    <Link
                                        to={`/project/${selectedProject}`}
                                        style={{ fontSize: '0.7rem', color: 'var(--accent-primary)', textDecoration: 'none' }}
                                    >
                                        + {t('project.tab_gateway')}
                                    </Link>
                                )}
                            </div>
                            {availableKeys.length === 0 ? (
                                <input
                                    type="password"
                                    value={selectedKey}
                                    onChange={e => setSelectedKey(e.target.value)}
                                    placeholder="gk_... (Enter Gateway Key)"
                                    style={{ width: '100%', padding: '0.5rem 0.75rem', fontSize: '0.85rem' }}
                                />
                            ) : (
                                <select
                                    value={selectedKey}
                                    onChange={e => setSelectedKey(e.target.value)}
                                    style={{ width: '100%', padding: '0.5rem 0.75rem', fontSize: '0.85rem' }}
                                >
                                    {availableKeys.map(k => {
                                        const raw = k.api_key || k.key_preview || '';
                                        const preview = raw ? (raw.length > 10 ? `${raw.slice(0, 4)}...${raw.slice(-4)}` : raw) : '';
                                        return (
                                            <option key={k.id} value={k.api_key || k.key_preview || ''}>
                                                {k.key_name} {preview ? `(${preview})` : ''}
                                            </option>
                                        );
                                    })}
                                </select>
                            )}
                        </div>
                    </div>

                    {/* Model Selector & Custom input */}
                    <div style={{ display: 'grid', gridTemplateColumns: '1.2fr 1fr', gap: '1rem' }}>
                        <div className="form-group" style={{ margin: 0 }}>
                            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '0.2rem' }}>
                                <label style={{ fontSize: '0.78rem', margin: 0 }}>{t('playground.select_model')}</label>
                                {modelsLoading && (
                                    <span style={{ fontSize: '0.68rem', color: 'var(--text-muted)' }}>
                                        {t('playground.loading_models')}
                                    </span>
                                )}
                            </div>
                            <select
                                value={model}
                                onChange={e => { setModel(e.target.value); setCustomModel(''); }}
                                style={{ width: '100%', padding: '0.5rem 0.75rem', fontSize: '0.85rem' }}
                                disabled={projectModels.length === 0 && !modelsLoading}
                            >
                                {projectModels.length === 0 ? (
                                    <option value="">
                                        {modelsLoading ? t('playground.loading_models') : t('playground.no_project_models')}
                                    </option>
                                ) : (
                                    <>
                                        <optgroup label="Virtual Consensus Meta-Models">
                                            <option value="fusion">🔬 fusion (Multi-Model Consensus & Arbiter)</option>
                                        </optgroup>
                                        <optgroup label={`${activeProject?.name || t('playground.project_models')} (${projectModels.length})`}>
                                            {projectModels.map(m => (
                                                <option key={m} value={m}>{m}</option>
                                            ))}
                                        </optgroup>
                                    </>
                                )}
                            </select>
                        </div>

                        <div className="form-group" style={{ margin: 0 }}>
                            <label style={{ fontSize: '0.78rem' }}>Custom Model ID</label>
                            <input
                                type="text"
                                value={customModel}
                                onChange={e => setCustomModel(e.target.value)}
                                placeholder="e.g. claude-3-7-sonnet"
                                style={{ width: '100%', padding: '0.5rem 0.75rem', fontSize: '0.85rem' }}
                            />
                        </div>
                    </div>

                    {/* Hyperparameters */}
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '1rem', alignItems: 'center' }}>
                        <div className="form-group" style={{ margin: 0 }}>
                            <div className="flex justify-between" style={{ fontSize: '0.78rem', marginBottom: '0.2rem' }}>
                                <span>{t('playground.temperature')}</span>
                                <span style={{ fontFamily: 'var(--font-mono)', fontWeight: 600 }}>{temperature}</span>
                            </div>
                            <input
                                type="range"
                                min="0"
                                max="1.5"
                                step="0.05"
                                value={temperature}
                                onChange={e => setTemperature(parseFloat(e.target.value))}
                                style={{ width: '100%', accentColor: 'var(--accent-primary)' }}
                            />
                        </div>

                        <div className="form-group" style={{ margin: 0 }}>
                            <div className="flex justify-between" style={{ fontSize: '0.78rem', marginBottom: '0.2rem' }}>
                                <span>Max Tokens</span>
                                <span style={{ fontFamily: 'var(--font-mono)', fontWeight: 600 }}>{maxTokens}</span>
                            </div>
                            <input
                                type="range"
                                min="100"
                                max="8000"
                                step="100"
                                value={maxTokens}
                                onChange={e => setMaxTokens(parseInt(e.target.value, 10))}
                                style={{ width: '100%', accentColor: 'var(--accent-primary)' }}
                            />
                        </div>

                        <div className="form-group" style={{ margin: 0, display: 'flex', flexDirection: 'column', gap: '0.3rem' }}>
                            <span style={{ fontSize: '0.78rem' }}>{t('playground.stream')}</span>
                            <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', cursor: 'pointer', fontSize: '0.85rem' }}>
                                <input
                                    type="checkbox"
                                    checked={stream}
                                    onChange={e => setStream(e.target.checked)}
                                    style={{ accentColor: 'var(--accent-primary)', width: 16, height: 16 }}
                                />
                                <span>{t('playground.sse_typewriter')}</span>
                            </label>
                        </div>
                    </div>

                    {/* System Prompt */}
                    <div className="form-group" style={{ margin: 0 }}>
                        <label style={{ fontSize: '0.78rem', display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
                            <Shield size={13} style={{ color: 'var(--brand-amber)' }} />
                            <span>{t('playground.system_prompt')} (SOAT Anchored at [0])</span>
                        </label>
                        <textarea
                            value={systemPrompt}
                            onChange={e => setSystemPrompt(e.target.value)}
                            rows={2}
                            style={{
                                width: '100%', resize: 'vertical', fontSize: '0.82rem',
                                fontFamily: 'var(--font-mono)', padding: '0.6rem',
                            }}
                        />
                    </div>

                    {/* User Prompt */}
                    <div className="form-group" style={{ margin: 0, flex: 1, display: 'flex', flexDirection: 'column' }}>
                        <label style={{ fontSize: '0.78rem' }}>{t('playground.user_prompt')}</label>
                        <textarea
                            value={userPrompt}
                            onChange={e => setUserPrompt(e.target.value)}
                            onKeyDown={e => {
                                if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
                                    handleSend();
                                }
                            }}
                            rows={4}
                            placeholder={t('playground.prompt_placeholder') || 'Type your prompt here... (Ctrl+Enter to send)'}
                            style={{
                                width: '100%', flex: 1, resize: 'vertical', fontSize: '0.88rem',
                                padding: '0.75rem', lineHeight: 1.5,
                            }}
                        />
                    </div>

                    {/* Action button */}
                    <div className="flex items-center justify-between" style={{ marginTop: '0.5rem' }}>
                        <span style={{ fontSize: '0.72rem', color: 'var(--text-muted)' }}>
                            Shortcut: <kbd style={{ padding: '0.15rem 0.4rem', borderRadius: 4, background: 'var(--surface-2)', border: '1px solid var(--border-subtle)' }}>Ctrl+Enter</kbd>
                        </span>
                        <div style={{ display: 'flex', gap: '0.5rem' }}>
                            {loading && (
                                <button
                                    type="button"
                                    onClick={handleStop}
                                    className="btn btn-danger"
                                    style={{ padding: '0.65rem 1rem', fontWeight: 700, gap: '0.4rem', display: 'flex', alignItems: 'center' }}
                                >
                                    <Square size={13} />
                                    <span>{t('playground.btn_stop') || 'Stop'}</span>
                                </button>
                            )}
                            <button
                                onClick={handleSend}
                                disabled={loading || !selectedKey}
                                className="btn btn-primary"
                                style={{ padding: '0.65rem 1.4rem', fontWeight: 700, gap: '0.5rem' }}
                            >
                                {loading ? (
                                    <>
                                        <RefreshCw size={15} className="spin" />
                                        <span>{t('playground.sending')}</span>
                                    </>
                                ) : (
                                    <>
                                        <Send size={15} />
                                        <span>{t('playground.send')}</span>
                                    </>
                                )}
                            </button>
                        </div>
                    </div>
                </div>

                {/* Right Panel: Inspector & Live Output */}
                <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
                    {/* Execution Inspector Bar */}
                    <div className="glass-panel" style={{ padding: '1rem 1.25rem' }}>
                        <div className="flex items-center justify-between" style={{ marginBottom: '0.75rem' }}>
                            <div className="flex items-center gap-2" style={{ fontSize: '0.85rem', fontWeight: 700 }}>
                                <Cpu size={15} style={{ color: '#22c55e' }} />
                                <span>{t('playground.inspector_title')}</span>
                            </div>
                            {executionMeta && (
                                <span className="badge badge-healthy" style={{ fontSize: '0.72rem' }}>
                                    <Activity size={11} /> {executionMeta.latencyMs} ms
                                </span>
                            )}
                        </div>

                        {executionMeta ? (
                            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(110px, 1fr))', gap: '0.75rem', fontSize: '0.78rem' }}>
                                <div style={{ background: 'var(--surface-2)', padding: '0.5rem 0.75rem', borderRadius: 6 }}>
                                    <div style={{ color: 'var(--text-muted)', fontSize: '0.68rem' }}>ENGINE</div>
                                    <div style={{ fontWeight: 700, color: 'var(--text-primary)' }}>{executionMeta.engine}</div>
                                </div>
                                <div style={{ background: 'var(--surface-2)', padding: '0.5rem 0.75rem', borderRadius: 6 }}>
                                    <div style={{ color: 'var(--text-muted)', fontSize: '0.68rem' }}>TIER</div>
                                    <div style={{ fontWeight: 700, textTransform: 'capitalize', color: 'var(--text-primary)' }}>
                                        {executionMeta.tier}
                                    </div>
                                </div>
                                <div style={{ background: 'var(--surface-2)', padding: '0.5rem 0.75rem', borderRadius: 6 }}>
                                    <div style={{ color: 'var(--text-muted)', fontSize: '0.68rem' }}>PROVIDER</div>
                                    <div style={{ fontWeight: 700, textTransform: 'capitalize' }}>
                                        {executionMeta.provider}
                                    </div>
                                </div>
                                <div style={{ background: 'var(--surface-2)', padding: '0.5rem 0.75rem', borderRadius: 6 }}>
                                    <div style={{ color: 'var(--text-muted)', fontSize: '0.68rem' }}>CACHE</div>
                                    <div style={{ fontWeight: 700, color: executionMeta.cache === 'HIT' ? '#22c55e' : 'var(--text-muted)' }}>
                                        {executionMeta.cache}
                                    </div>
                                </div>
                                {executionMeta.totalTokens !== undefined && (
                                    <div style={{ background: 'var(--surface-2)', padding: '0.5rem 0.75rem', borderRadius: 6 }}>
                                        <div style={{ color: 'var(--text-muted)', fontSize: '0.68rem' }}>TOKENS</div>
                                        <div style={{ fontWeight: 700, fontFamily: 'var(--font-mono)' }}>
                                            {executionMeta.totalTokens}
                                        </div>
                                    </div>
                                )}
                            </div>
                        ) : (
                            <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)', textAlign: 'center', padding: '0.5rem' }}>
                                {t('playground.inspector_ready')}
                            </div>
                        )}
                    </div>

                    {/* Error Banner if any */}
                    {errorMsg && (
                        <div className="alert alert-error" style={{ display: 'flex', alignItems: 'center', gap: '0.6rem' }}>
                            <AlertCircle size={16} />
                            <span>{errorMsg}</span>
                        </div>
                    )}

                    {/* Output Terminal Viewport */}
                    <div className="glass-panel" style={{
                        flex: 1, padding: '1.25rem', display: 'flex', flexDirection: 'column',
                        minHeight: 380, position: 'relative',
                    }}>
                        <div className="flex items-center justify-between" style={{ borderBottom: '1px solid var(--border-subtle)', paddingBottom: '0.6rem', marginBottom: '1rem' }}>
                            <div className="flex items-center gap-2" style={{ fontSize: '0.82rem', fontWeight: 600, color: 'var(--text-muted)' }}>
                                <Terminal size={14} />
                                <span>{t('playground.output_console')}</span>
                                {loading && (
                                    <span style={{ fontSize: '0.72rem', color: 'var(--accent-primary)', display: 'flex', alignItems: 'center', gap: '0.3rem' }}>
                                        <span className="spinner-ring" style={{ width: 10, height: 10, borderWidth: 1.5 }} /> Streaming…
                                    </span>
                                )}
                            </div>

                            {responseContent && (
                                <button
                                    onClick={copyResponse}
                                    className="btn btn-secondary btn-icon"
                                    title="Copy response"
                                    style={{ width: 28, height: 28 }}
                                >
                                    {copied ? <Check size={14} style={{ color: '#22c55e' }} /> : <Copy size={14} />}
                                </button>
                            )}
                        </div>

                        <div style={{
                            flex: 1, overflowY: 'auto', whiteSpace: 'pre-wrap', wordBreak: 'break-word',
                            fontFamily: 'var(--font-sans)', fontSize: '0.92rem', lineHeight: 1.65,
                            color: responseContent ? 'var(--text-primary)' : 'var(--text-muted)',
                        }}>
                            {responseContent || (
                                <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '100%', minHeight: 220, gap: '0.75rem', opacity: 0.6 }}>
                                    <CyberTerminalGlyph size={36} color="var(--accent-primary)" />
                                    <span>{t('playground.output_placeholder')}</span>
                                </div>
                            )}
                            <div ref={responseEndRef} />
                        </div>
                    </div>
                </div>
            </div>
        </div>
    );
}
