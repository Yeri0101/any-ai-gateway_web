import React, { useState, useEffect } from 'react';
import { KeyRound, X, Copy, CheckCircle2, AlertTriangle } from 'lucide-react';
import { useLanguage } from '../../i18n';
import { fetchApi } from '../../api';

interface KeyCreationWizardProps {
    isOpen: boolean;
    onClose: () => void;
    projectId?: string;
    onKeyCreated?: (key: any) => void;
}

export const KeyCreationWizard: React.FC<KeyCreationWizardProps> = ({
    isOpen,
    onClose,
    projectId = 'proj_default',
    onKeyCreated
}) => {
    const { t } = useLanguage();
    const [name, setName] = useState('');
    const [env, setEnv] = useState<'live' | 'test' | 'dev'>('live');
    const [rpmLimit, setRpmLimit] = useState<number>(120);
    const [tpmLimit, setTpmLimit] = useState<number>(100000);
    const [maxTokensCeiling, setMaxTokensCeiling] = useState<number>(8192);
    const [allowedModels, setAllowedModels] = useState<string>('*');
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);

    // One-time key display state
    const [createdKey, setCreatedKey] = useState<{ rawKey: string; key: any } | null>(null);
    const [copied, setCopied] = useState(false);

    // ESC to close
    useEffect(() => {
        const handleKeyDown = (e: KeyboardEvent) => {
            if (e.key === 'Escape' && isOpen) onClose();
        };
        window.addEventListener('keydown', handleKeyDown);
        return () => window.removeEventListener('keydown', handleKeyDown);
    }, [isOpen, onClose]);

    if (!isOpen) return null;

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        setLoading(true);
        setError(null);

        try {
            const modelsArray = allowedModels.split(',').map(m => m.trim()).filter(Boolean);
            const res = await fetchApi('/api/aaa/keys', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    projectId,
                    name: name.trim() || 'API Key',
                    env,
                    rpmLimit: Number(rpmLimit) || 120,
                    tpmLimit: Number(tpmLimit) || 100000,
                    maxTokensCeiling: Number(maxTokensCeiling) || 8192,
                    allowedModels: modelsArray.length > 0 ? modelsArray : ['*']
                })
            });

            const data = await res.json();
            if (!res.ok || !data.success) {
                throw new Error(data.error || 'Failed to create hashed key');
            }

            setCreatedKey(data);
            if (onKeyCreated) {
                onKeyCreated(data.key);
            }
        } catch (err: any) {
            setError(err.message || 'An error occurred');
        } finally {
            setLoading(false);
        }
    };

    const handleCopy = () => {
        if (!createdKey?.rawKey) return;
        navigator.clipboard.writeText(createdKey.rawKey);
        setCopied(true);
        setTimeout(() => setCopied(false), 3000);
    };

    const handleDone = () => {
        setCreatedKey(null);
        setName('');
        onClose();
    };

    return (
        <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="key-wizard-title"
            style={{
                position: 'fixed',
                inset: 0,
                zIndex: 9999,
                backgroundColor: 'rgba(5, 7, 15, 0.8)',
                backdropFilter: 'blur(12px)',
                WebkitBackdropFilter: 'blur(12px)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                padding: '1.5rem',
                animation: 'fadeIn 0.2s ease-out'
            }}
            onClick={(e) => {
                if (e.target === e.currentTarget) onClose();
            }}
        >
            <div style={{
                background: 'var(--surface-card)',
                border: '1px solid var(--border-default)',
                borderRadius: '16px',
                width: '100%',
                maxWidth: '600px',
                maxHeight: '90vh',
                display: 'flex',
                flexDirection: 'column',
                boxShadow: 'var(--shadow-lg), 0 0 35px rgba(0, 0, 0, 0.3)',
                overflow: 'hidden'
            }}>
                {/* Header */}
                <div style={{
                    padding: '1.25rem 1.5rem',
                    borderBottom: '1px solid var(--border-subtle)',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between'
                }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
                        <div style={{
                            width: 36,
                            height: 36,
                            borderRadius: '10px',
                            background: 'var(--surface-2)',
                            border: '1px solid var(--border-subtle)',
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                            color: 'var(--accent-primary)'
                        }}>
                            <KeyRound size={20} />
                        </div>
                        <div>
                            <h3 id="key-wizard-title" style={{ margin: 0, fontSize: '1.1rem', fontWeight: 600, color: 'var(--text-primary)' }}>
                                {createdKey ? (t('aaa.key_ready') || 'Hashed Key Created') : (t('aaa.create_key_title') || 'Generate Secure Hashed API Key')}
                            </h3>
                            <p style={{ margin: 0, fontSize: '0.78rem', color: 'var(--text-muted)' }}>
                                {createdKey ? (t('aaa.key_ready_desc') || 'Copy your key now. It will never be shown again.') : (t('aaa.create_key_subtitle') || 'Enterprise SHA-256 hashed key with granular governance')}
                            </p>
                        </div>
                    </div>
                    <button
                        type="button"
                        onClick={onClose}
                        style={{
                            background: 'transparent',
                            border: 'none',
                            color: 'var(--text-muted, #94a3b8)',
                            cursor: 'pointer',
                            padding: '0.4rem',
                            borderRadius: '8px'
                        }}
                    >
                        <X size={18} />
                    </button>
                </div>

                {/* Content */}
                <div style={{ padding: '1.5rem', overflowY: 'auto' }}>
                    {error && (
                        <div style={{
                            padding: '0.75rem 1rem',
                            borderRadius: '8px',
                            background: 'rgba(239, 68, 68, 0.1)',
                            border: '1px solid rgba(239, 68, 68, 0.3)',
                            color: '#f87171',
                            fontSize: '0.85rem',
                            marginBottom: '1rem',
                            display: 'flex',
                            alignItems: 'center',
                            gap: '0.5rem'
                        }}>
                            <AlertTriangle size={16} />
                            <span>{error}</span>
                        </div>
                    )}

                    {createdKey ? (
                        <div style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
                            <div style={{
                                padding: '1rem',
                                borderRadius: '10px',
                                background: 'rgba(34, 197, 94, 0.08)',
                                border: '1px solid rgba(34, 197, 94, 0.25)',
                                color: '#86efac',
                                fontSize: '0.82rem',
                                display: 'flex',
                                alignItems: 'center',
                                gap: '0.6rem'
                            }}>
                                <CheckCircle2 size={20} style={{ color: '#22c55e', flexShrink: 0 }} />
                                <span>{t('aaa.key_safe_notice') || 'This raw secret is hashed with SHA-256 and cannot be retrieved later. Store it safely.'}</span>
                            </div>

                            <div>
                                <label style={{ display: 'block', fontSize: '0.75rem', fontWeight: 600, color: 'var(--text-muted)', marginBottom: '0.4rem' }}>
                                    {t('aaa.generated_key') || 'API Key Token'}
                                </label>
                                <div style={{
                                    display: 'flex',
                                    alignItems: 'center',
                                    background: 'var(--surface-2)',
                                    border: '1px solid var(--border-subtle)',
                                    borderRadius: '8px',
                                    padding: '0.5rem 0.75rem',
                                    gap: '0.5rem'
                                }}>
                                    <input
                                        type="text"
                                        readOnly
                                        value={createdKey.rawKey}
                                        style={{
                                            flex: 1,
                                            background: 'transparent',
                                            border: 'none',
                                            color: 'var(--text-primary)',
                                            fontFamily: 'var(--font-mono, monospace)',
                                            fontSize: '0.82rem',
                                            outline: 'none'
                                        }}
                                    />
                                    <button
                                        type="button"
                                        onClick={handleCopy}
                                        style={{
                                            display: 'flex',
                                            alignItems: 'center',
                                            gap: '0.35rem',
                                            padding: '0.35rem 0.75rem',
                                            borderRadius: '6px',
                                            border: 'none',
                                            background: copied ? 'var(--status-healthy)' : 'var(--accent-primary)',
                                            color: '#ffffff',
                                            fontWeight: 700,
                                            fontSize: '0.78rem',
                                            cursor: 'pointer',
                                            transition: 'all 0.2s'
                                        }}
                                    >
                                        {copied ? <CheckCircle2 size={13} /> : <Copy size={13} />}
                                        <span>{copied ? (t('common.copied') || 'Copied!') : (t('common.copy') || 'Copy')}</span>
                                    </button>
                                </div>
                            </div>

                            <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: '0.5rem' }}>
                                <button
                                    type="button"
                                    onClick={handleDone}
                                    className="btn btn-primary"
                                    style={{ padding: '0.5rem 1.5rem', fontSize: '0.85rem' }}
                                >
                                    {t('common.done') || 'Done'}
                                </button>
                            </div>
                        </div>
                    ) : (
                        <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
                            <div>
                                <label style={{ display: 'block', fontSize: '0.8rem', fontWeight: 600, marginBottom: '0.35rem' }}>
                                    {t('aaa.key_name') || 'Key Name'}
                                </label>
                                <input
                                    type="text"
                                    value={name}
                                    onChange={e => setName(e.target.value)}
                                    placeholder="e.g. Production Agent Rocky"
                                    required
                                    style={{
                                        width: '100%',
                                        padding: '0.5rem 0.75rem',
                                        borderRadius: '8px',
                                        border: '1px solid var(--border-subtle, rgba(255,255,255,0.15))',
                                        background: 'rgba(0,0,0,0.25)',
                                        color: 'var(--text-primary, #fff)',
                                        fontSize: '0.85rem'
                                    }}
                                />
                            </div>

                            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem' }}>
                                <div>
                                    <label style={{ display: 'block', fontSize: '0.8rem', fontWeight: 600, marginBottom: '0.35rem' }}>
                                        {t('aaa.environment') || 'Environment'}
                                    </label>
                                    <select
                                        value={env}
                                        onChange={e => setEnv(e.target.value as any)}
                                        style={{
                                            width: '100%',
                                            padding: '0.5rem 0.75rem',
                                            borderRadius: '8px',
                                            border: '1px solid var(--border-subtle, rgba(255,255,255,0.15))',
                                            background: 'rgba(15,23,42,0.9)',
                                            color: 'var(--text-primary, #fff)',
                                            fontSize: '0.85rem'
                                        }}
                                    >
                                        <option value="live">Live (Production)</option>
                                        <option value="test">Test</option>
                                        <option value="dev">Development</option>
                                    </select>
                                </div>

                                <div>
                                    <label style={{ display: 'block', fontSize: '0.8rem', fontWeight: 600, marginBottom: '0.35rem' }}>
                                        {t('aaa.max_tokens') || 'Max Tokens Ceiling'}
                                    </label>
                                    <input
                                        type="number"
                                        value={maxTokensCeiling}
                                        onChange={e => setMaxTokensCeiling(Number(e.target.value))}
                                        style={{
                                            width: '100%',
                                            padding: '0.5rem 0.75rem',
                                            borderRadius: '8px',
                                            border: '1px solid var(--border-subtle, rgba(255,255,255,0.15))',
                                            background: 'rgba(0,0,0,0.25)',
                                            color: 'var(--text-primary, #fff)',
                                            fontSize: '0.85rem'
                                        }}
                                    />
                                </div>
                            </div>

                            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem' }}>
                                <div>
                                    <label style={{ display: 'block', fontSize: '0.8rem', fontWeight: 600, marginBottom: '0.35rem' }}>
                                        {t('aaa.rpm_limit') || 'RPM Limit (req/min)'}
                                    </label>
                                    <input
                                        type="number"
                                        value={rpmLimit}
                                        onChange={e => setRpmLimit(Number(e.target.value))}
                                        style={{
                                            width: '100%',
                                            padding: '0.5rem 0.75rem',
                                            borderRadius: '8px',
                                            border: '1px solid var(--border-subtle, rgba(255,255,255,0.15))',
                                            background: 'rgba(0,0,0,0.25)',
                                            color: 'var(--text-primary, #fff)',
                                            fontSize: '0.85rem'
                                        }}
                                    />
                                </div>

                                <div>
                                    <label style={{ display: 'block', fontSize: '0.8rem', fontWeight: 600, marginBottom: '0.35rem' }}>
                                        {t('aaa.tpm_limit') || 'TPM Limit (tokens/min)'}
                                    </label>
                                    <input
                                        type="number"
                                        value={tpmLimit}
                                        onChange={e => setTpmLimit(Number(e.target.value))}
                                        style={{
                                            width: '100%',
                                            padding: '0.5rem 0.75rem',
                                            borderRadius: '8px',
                                            border: '1px solid var(--border-subtle, rgba(255,255,255,0.15))',
                                            background: 'rgba(0,0,0,0.25)',
                                            color: 'var(--text-primary, #fff)',
                                            fontSize: '0.85rem'
                                        }}
                                    />
                                </div>
                            </div>

                            <div>
                                <label style={{ display: 'block', fontSize: '0.8rem', fontWeight: 600, marginBottom: '0.35rem' }}>
                                    {t('aaa.allowed_models') || 'Allowed Models (comma separated, * for all)'}
                                </label>
                                <input
                                    type="text"
                                    value={allowedModels}
                                    onChange={e => setAllowedModels(e.target.value)}
                                    placeholder="* or gpt-4o, claude-3-5-sonnet*"
                                    style={{
                                        width: '100%',
                                        padding: '0.5rem 0.75rem',
                                        borderRadius: '8px',
                                        border: '1px solid var(--border-subtle, rgba(255,255,255,0.15))',
                                        background: 'rgba(0,0,0,0.25)',
                                        color: 'var(--text-primary, #fff)',
                                        fontSize: '0.85rem'
                                    }}
                                />
                            </div>

                            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '0.75rem', marginTop: '0.5rem' }}>
                                <button
                                    type="button"
                                    onClick={onClose}
                                    className="btn btn-secondary"
                                    style={{ padding: '0.5rem 1.25rem', fontSize: '0.85rem' }}
                                >
                                    {t('common.cancel') || 'Cancel'}
                                </button>
                                <button
                                    type="submit"
                                    disabled={loading}
                                    className="btn btn-primary"
                                    style={{ padding: '0.5rem 1.5rem', fontSize: '0.85rem' }}
                                >
                                    {loading ? 'Creating...' : (t('aaa.generate_key_btn') || 'Generate Hashed Key')}
                                </button>
                            </div>
                        </form>
                    )}
                </div>
            </div>
        </div>
    );
};
