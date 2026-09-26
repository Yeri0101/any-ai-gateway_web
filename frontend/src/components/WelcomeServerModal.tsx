import React, { useState, useEffect } from 'react';
import { 
    Terminal, 
    X, 
    Copy, 
    CheckCircle2, 
    Server, 
    Play, 
    Cpu, 
    Layers, 
    Info
} from 'lucide-react';
import { useLanguage } from '../i18n';

interface WelcomeServerModalProps {
    isOpen: boolean;
    onClose: () => void;
}

export const WelcomeServerModal: React.FC<WelcomeServerModalProps> = ({ isOpen, onClose }) => {
    const { t } = useLanguage();
    const [activeTab, setActiveTab] = useState<'quickstart' | 'npm' | 'pm2' | 'docker'>('quickstart');
    const [copiedKey, setCopiedKey] = useState<string | null>(null);
    const [backendOnline, setBackendOnline] = useState<boolean | null>(null);
    const [checkingBackend, setCheckingBackend] = useState(false);
    const [dontShowAgain, setDontShowAgain] = useState<boolean>(() => {
        return localStorage.getItem('tiermax_hide_welcome') === 'true';
    });

    const checkBackendHealth = async () => {
        setCheckingBackend(true);
        try {
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), 2000);
            const res = await fetch('http://localhost:3000/api/system/info', {
                signal: controller.signal
            });
            clearTimeout(timeout);
            setBackendOnline(res.ok);
        } catch (_) {
            setBackendOnline(false);
        } finally {
            setCheckingBackend(false);
        }
    };

    useEffect(() => {
        if (isOpen) {
            checkBackendHealth();
            const interval = setInterval(checkBackendHealth, 4000);
            return () => clearInterval(interval);
        }
    }, [isOpen]);

    // Handle ESC key
    useEffect(() => {
        const handleKeyDown = (e: KeyboardEvent) => {
            if (e.key === 'Escape' && isOpen) handleClose();
        };
        window.addEventListener('keydown', handleKeyDown);
        return () => window.removeEventListener('keydown', handleKeyDown);
    }, [isOpen]);

    const handleCopy = (cmd: string, key: string) => {
        navigator.clipboard.writeText(cmd);
        setCopiedKey(key);
        setTimeout(() => setCopiedKey(null), 2500);
    };

    const handleClose = () => {
        if (dontShowAgain) {
            localStorage.setItem('tiermax_hide_welcome', 'true');
        } else {
            localStorage.removeItem('tiermax_hide_welcome');
        }
        onClose();
    };

    if (!isOpen) return null;

    return (
        <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="welcome-modal-title"
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
                if (e.target === e.currentTarget) handleClose();
            }}
        >
            <div style={{
                background: 'var(--surface-card)',
                border: '1px solid var(--border-default)',
                borderRadius: '16px',
                width: '100%',
                maxWidth: '720px',
                maxHeight: '92vh',
                display: 'flex',
                flexDirection: 'column',
                boxShadow: 'var(--shadow-lg), 0 0 40px rgba(0, 0, 0, 0.3)',
                overflow: 'hidden'
            }}>
                {/* Header */}
                <div style={{
                    padding: '1.25rem 1.5rem',
                    borderBottom: '1px solid var(--border-subtle)',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    background: 'transparent'
                }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
                        <div style={{
                            width: 40,
                            height: 40,
                            borderRadius: '10px',
                            background: 'var(--surface-2)',
                            border: '1px solid var(--border-subtle)',
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                            color: 'var(--accent-primary)'
                        }}>
                            <Server size={22} />
                        </div>
                        <div>
                            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                                <h3 id="welcome-modal-title" style={{ margin: 0, fontSize: '1.15rem', fontWeight: 700, color: 'var(--text-primary)' }}>
                                    {t('welcome.title') || '🚀 ¿Cómo Iniciar el Servidor de TierMax?'}
                                </h3>
                                <span style={{
                                    fontSize: '0.62rem',
                                    fontWeight: 700,
                                    padding: '0.1rem 0.4rem',
                                    borderRadius: '4px',
                                    background: 'var(--surface-2)',
                                    color: 'var(--text-secondary)',
                                    border: '1px solid var(--border-default)'
                                }}>
                                    {t('welcome.badge') || 'Guía Rápida'}
                                </span>
                            </div>
                            <p style={{ margin: 0, fontSize: '0.78rem', color: 'var(--text-muted)' }}>
                                {t('welcome.subtitle') || 'Aprende cómo arrancar el backend y los servicios en segundo plano al clonar el repositorio.'}
                            </p>
                        </div>
                    </div>
                    <button
                        type="button"
                        onClick={handleClose}
                        style={{
                            background: 'transparent',
                            border: 'none',
                            color: 'var(--text-muted, #94a3b8)',
                            cursor: 'pointer',
                            padding: '0.4rem',
                            borderRadius: '8px'
                        }}
                    >
                        <X size={20} />
                    </button>
                </div>

                {/* Body */}
                <div style={{ padding: '1.5rem', overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
                    {/* Live Server Status Bar */}
                    <div style={{
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        padding: '0.75rem 1rem',
                        borderRadius: '10px',
                        background: backendOnline 
                            ? 'rgba(34, 197, 94, 0.08)' 
                            : 'rgba(239, 68, 68, 0.08)',
                        border: `1px solid ${backendOnline ? 'rgba(34, 197, 94, 0.25)' : 'rgba(239, 68, 68, 0.25)'}`,
                        fontSize: '0.82rem'
                    }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem' }}>
                            <span style={{
                                width: 9,
                                height: 9,
                                borderRadius: '50%',
                                background: backendOnline ? '#22c55e' : '#ef4444',
                                boxShadow: `0 0 8px ${backendOnline ? '#22c55e' : '#ef4444'}`,
                                animation: backendOnline ? 'pulseGlow 2s infinite' : 'none'
                            }} />
                            <span style={{ fontWeight: 600, color: backendOnline ? '#4ade80' : '#f87171' }}>
                                {backendOnline 
                                    ? (t('welcome.backend_online') || 'Servidor Backend EN LÍNEA (Puerto 3000 Activo)')
                                    : (t('welcome.backend_offline') || 'Servidor Backend NO DETECTADO (Puerto 3000 Inactivo)')}
                            </span>
                        </div>
                        <span style={{ fontSize: '0.72rem', color: 'var(--text-muted, #94a3b8)', fontFamily: 'var(--font-mono, monospace)' }}>
                            {checkingBackend ? (t('welcome.checking') || 'Comprobando…') : (t('welcome.auto_ping') || 'Auto-ping cada 4s')}
                        </span>
                    </div>

                    {/* Explanatory Alert */}
                    <div style={{
                        padding: '0.85rem 1rem',
                        borderRadius: '10px',
                        background: 'var(--surface-2)',
                        border: '1px solid var(--border-default)',
                        display: 'flex',
                        gap: '0.75rem',
                        fontSize: '0.8rem',
                        color: 'var(--text-secondary)',
                        lineHeight: 1.5
                    }}>
                        <Info size={18} style={{ color: 'var(--text-muted)', flexShrink: 0, marginTop: 2 }} />
                        <div>
                            <strong>{t('welcome.important_note') || '¿Se ejecuta PM2 automáticamente al descargar el repo?'}</strong>
                            <p style={{ margin: '0.25rem 0 0 0', opacity: 0.9 }}>
                                {t('welcome.note_body') || 'No. Un repositorio descargado o clonado solo contiene el código. Ningún navegador ni descarga arranca procesos en tu sistema por seguridad. Para ejecutar el servidor en cualquier máquina, elige uno de los siguientes métodos:'}
                            </p>
                        </div>
                    </div>

                    {/* Startup Methods Tabs */}
                    <div>
                        <div style={{ display: 'flex', gap: '0.4rem', borderBottom: '1px solid var(--border-subtle)', paddingBottom: '0.5rem', marginBottom: '1rem', flexWrap: 'wrap' }}>
                            <button
                                type="button"
                                onClick={() => setActiveTab('quickstart')}
                                style={{
                                    padding: '0.4rem 0.8rem',
                                    borderRadius: '6px',
                                    border: activeTab === 'quickstart' ? '1px solid var(--border-default)' : '1px solid transparent',
                                    background: activeTab === 'quickstart' ? 'var(--surface-2)' : 'transparent',
                                    color: activeTab === 'quickstart' ? 'var(--text-primary)' : 'var(--text-muted)',
                                    fontWeight: activeTab === 'quickstart' ? 700 : 500,
                                    fontSize: '0.78rem',
                                    cursor: 'pointer',
                                    display: 'flex',
                                    alignItems: 'center',
                                    gap: '0.35rem'
                                }}
                            >
                                <Play size={13} /> {t('welcome.tab_quickstart') || '1-Clic Script (Recomendado)'}
                            </button>
                            <button
                                type="button"
                                onClick={() => setActiveTab('npm')}
                                style={{
                                    padding: '0.4rem 0.8rem',
                                    borderRadius: '6px',
                                    border: activeTab === 'npm' ? '1px solid var(--border-default)' : '1px solid transparent',
                                    background: activeTab === 'npm' ? 'var(--surface-2)' : 'transparent',
                                    color: activeTab === 'npm' ? 'var(--text-primary)' : 'var(--text-muted)',
                                    fontWeight: activeTab === 'npm' ? 700 : 500,
                                    fontSize: '0.78rem',
                                    cursor: 'pointer',
                                    display: 'flex',
                                    alignItems: 'center',
                                    gap: '0.35rem'
                                }}
                            >
                                <Terminal size={13} /> {t('welcome.tab_npm') || 'NPM Dev Estándar'}
                            </button>
                            <button
                                type="button"
                                onClick={() => setActiveTab('pm2')}
                                style={{
                                    padding: '0.4rem 0.8rem',
                                    borderRadius: '6px',
                                    border: activeTab === 'pm2' ? '1px solid var(--border-default)' : '1px solid transparent',
                                    background: activeTab === 'pm2' ? 'var(--surface-2)' : 'transparent',
                                    color: activeTab === 'pm2' ? 'var(--text-primary)' : 'var(--text-muted)',
                                    fontWeight: activeTab === 'pm2' ? 700 : 500,
                                    fontSize: '0.78rem',
                                    cursor: 'pointer',
                                    display: 'flex',
                                    alignItems: 'center',
                                    gap: '0.35rem'
                                }}
                            >
                                <Cpu size={13} /> {t('welcome.tab_pm2') || 'Servicios PM2 (Background)'}
                            </button>
                            <button
                                type="button"
                                onClick={() => setActiveTab('docker')}
                                style={{
                                    padding: '0.4rem 0.8rem',
                                    borderRadius: '6px',
                                    border: activeTab === 'docker' ? '1px solid var(--border-default)' : '1px solid transparent',
                                    background: activeTab === 'docker' ? 'var(--surface-2)' : 'transparent',
                                    color: activeTab === 'docker' ? 'var(--text-primary)' : 'var(--text-muted)',
                                    fontWeight: activeTab === 'docker' ? 700 : 500,
                                    fontSize: '0.78rem',
                                    cursor: 'pointer',
                                    display: 'flex',
                                    alignItems: 'center',
                                    gap: '0.35rem'
                                }}
                            >
                                <Layers size={13} /> {t('welcome.tab_docker') || 'Docker Compose'}
                            </button>
                        </div>

                        {/* Tab Content */}
                        {activeTab === 'quickstart' && (
                            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
                                <p style={{ margin: 0, fontSize: '0.8rem', color: 'var(--text-muted)' }}>
                                    {t('welcome.quickstart_desc') || 'Instala dependencias, prepara el entorno local con SQLite y lanza el backend y frontend juntos:'}
                                </p>
                                <div style={{
                                    display: 'flex',
                                    alignItems: 'center',
                                    justifyContent: 'space-between',
                                    padding: '0.65rem 0.85rem',
                                    borderRadius: '8px',
                                    background: 'var(--surface-2)',
                                    border: '1px solid var(--border-subtle)',
                                    fontFamily: 'var(--font-mono, monospace)',
                                    fontSize: '0.82rem',
                                    color: 'var(--text-primary)'
                                }}>
                                    <code>chmod +x ./quickstart.sh && ./quickstart.sh</code>
                                    <button
                                        type="button"
                                        onClick={() => handleCopy('chmod +x ./quickstart.sh && ./quickstart.sh', 'quickstart')}
                                        style={{
                                            display: 'flex', alignItems: 'center', gap: '0.3rem',
                                            padding: '0.3rem 0.6rem', borderRadius: '5px',
                                            border: 'none', background: copiedKey === 'quickstart' ? 'var(--status-healthy)' : 'var(--accent-primary)',
                                            color: '#ffffff', fontSize: '0.72rem', fontWeight: 700, cursor: 'pointer'
                                        }}
                                    >
                                        {copiedKey === 'quickstart' ? <CheckCircle2 size={12} /> : <Copy size={12} />}
                                        <span>{copiedKey === 'quickstart' ? (t('welcome.btn_copied') || 'Copiado') : (t('welcome.btn_copy') || 'Copiar')}</span>
                                    </button>
                                </div>
                            </div>
                        )}

                        {activeTab === 'npm' && (
                            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
                                <p style={{ margin: 0, fontSize: '0.8rem', color: 'var(--text-muted)' }}>
                                    {t('welcome.npm_desc') || 'Modo multiplataforma para Windows, Mac y Linux usando npm directamente:'}
                                </p>
                                <div style={{
                                    display: 'flex',
                                    alignItems: 'center',
                                    justifyContent: 'space-between',
                                    padding: '0.65rem 0.85rem',
                                    borderRadius: '8px',
                                    background: 'var(--surface-2)',
                                    border: '1px solid var(--border-subtle)',
                                    fontFamily: 'var(--font-mono, monospace)',
                                    fontSize: '0.82rem',
                                    color: 'var(--text-primary)'
                                }}>
                                    <code>npm run install:all && npm run dev</code>
                                    <button
                                        type="button"
                                        onClick={() => handleCopy('npm run install:all && npm run dev', 'npm')}
                                        style={{
                                            display: 'flex', alignItems: 'center', gap: '0.3rem',
                                            padding: '0.3rem 0.6rem', borderRadius: '5px',
                                            border: 'none', background: copiedKey === 'npm' ? 'var(--status-healthy)' : 'var(--accent-primary)',
                                            color: '#ffffff', fontSize: '0.72rem', fontWeight: 700, cursor: 'pointer'
                                        }}
                                    >
                                        {copiedKey === 'npm' ? <CheckCircle2 size={12} /> : <Copy size={12} />}
                                        <span>{copiedKey === 'npm' ? (t('welcome.btn_copied') || 'Copiado') : (t('welcome.btn_copy') || 'Copiar')}</span>
                                    </button>
                                </div>
                            </div>
                        )}

                        {activeTab === 'pm2' && (
                            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
                                <p style={{ margin: 0, fontSize: '0.8rem', color: 'var(--text-muted)' }}>
                                    {t('welcome.pm2_desc') || 'Ejecuta el backend, frontend y batch worker como servicios demonio en segundo plano:'}
                                </p>
                                <div style={{
                                    display: 'flex',
                                    alignItems: 'center',
                                    justifyContent: 'space-between',
                                    padding: '0.65rem 0.85rem',
                                    borderRadius: '8px',
                                    background: 'var(--surface-2)',
                                    border: '1px solid var(--border-subtle)',
                                    fontFamily: 'var(--font-mono, monospace)',
                                    fontSize: '0.82rem',
                                    color: 'var(--text-primary)'
                                }}>
                                    <code>npm install -g pm2 && pm2 start ecosystem.config.js</code>
                                    <button
                                        type="button"
                                        onClick={() => handleCopy('npm install -g pm2 && pm2 start ecosystem.config.js', 'pm2')}
                                        style={{
                                            display: 'flex', alignItems: 'center', gap: '0.3rem',
                                            padding: '0.3rem 0.6rem', borderRadius: '5px',
                                            border: 'none', background: copiedKey === 'pm2' ? 'var(--status-healthy)' : 'var(--accent-primary)',
                                            color: '#ffffff', fontSize: '0.72rem', fontWeight: 700, cursor: 'pointer'
                                        }}
                                    >
                                        {copiedKey === 'pm2' ? <CheckCircle2 size={12} /> : <Copy size={12} />}
                                        <span>{copiedKey === 'pm2' ? (t('welcome.btn_copied') || 'Copiado') : (t('welcome.btn_copy') || 'Copiar')}</span>
                                    </button>
                                </div>
                            </div>
                        )}

                        {activeTab === 'docker' && (
                            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
                                <p style={{ margin: 0, fontSize: '0.8rem', color: 'var(--text-muted)' }}>
                                    {t('welcome.docker_desc') || 'Inicia todo contenerizado en producción con 1 comando Docker:'}
                                </p>
                                <div style={{
                                    display: 'flex',
                                    alignItems: 'center',
                                    justifyContent: 'space-between',
                                    padding: '0.65rem 0.85rem',
                                    borderRadius: '8px',
                                    background: 'var(--surface-2)',
                                    border: '1px solid var(--border-subtle)',
                                    fontFamily: 'var(--font-mono, monospace)',
                                    fontSize: '0.82rem',
                                    color: 'var(--text-primary)'
                                }}>
                                    <code>docker compose up -d</code>
                                    <button
                                        type="button"
                                        onClick={() => handleCopy('docker compose up -d', 'docker')}
                                        style={{
                                            display: 'flex', alignItems: 'center', gap: '0.3rem',
                                            padding: '0.3rem 0.6rem', borderRadius: '5px',
                                            border: 'none', background: copiedKey === 'docker' ? 'var(--status-healthy)' : 'var(--accent-primary)',
                                            color: '#ffffff', fontSize: '0.72rem', fontWeight: 700, cursor: 'pointer'
                                        }}
                                    >
                                        {copiedKey === 'docker' ? <CheckCircle2 size={12} /> : <Copy size={12} />}
                                        <span>{copiedKey === 'docker' ? (t('welcome.btn_copied') || 'Copiado') : (t('welcome.btn_copy') || 'Copiar')}</span>
                                    </button>
                                </div>
                            </div>
                        )}
                    </div>
                </div>

                {/* Footer */}
                <div style={{
                    padding: '1rem 1.5rem',
                    borderTop: '1px solid var(--border-subtle)',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    background: 'var(--surface-1)'
                }}>
                    <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', fontSize: '0.78rem', color: 'var(--text-muted)', cursor: 'pointer' }}>
                        <input
                            type="checkbox"
                            checked={dontShowAgain}
                            onChange={(e) => setDontShowAgain(e.target.checked)}
                            style={{ cursor: 'pointer' }}
                        />
                        <span>{t('welcome.dont_show_again') || 'No volver a mostrar al iniciar'}</span>
                    </label>

                    <button
                        type="button"
                        onClick={handleClose}
                        className="btn btn-primary"
                        style={{ padding: '0.45rem 1.4rem', fontSize: '0.82rem' }}
                    >
                        {t('welcome.got_it') || '¡Entendido, Comenzar!'}
                    </button>
                </div>
            </div>
        </div>
    );
};
