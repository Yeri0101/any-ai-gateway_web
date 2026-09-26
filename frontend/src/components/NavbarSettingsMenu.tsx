import React, { useState, useRef, useEffect } from 'react';
import { 
    Settings, 
    X, 
    Globe, 
    Sun, 
    Moon, 
    KeyRound, 
    LogOut, 
    Server, 
    ChevronDown, 
    Database, 
    User
} from 'lucide-react';
import { useLanguage } from '../i18n';
import { TenantSwitcher } from './aaa/TenantSwitcher';

interface NavbarSettingsMenuProps {
    dbMode: { is_local: boolean; db_type: string } | null;
    onOpenWelcomeModal: () => void;
    onOpenPasswordModal: () => void;
    onLogout: () => void;
    theme: 'dark' | 'light';
    toggleTheme: () => void;
    language: 'en' | 'es';
    toggleLanguage: () => void;
    username: string;
}

export const NavbarSettingsMenu: React.FC<NavbarSettingsMenuProps> = ({
    dbMode,
    onOpenWelcomeModal,
    onOpenPasswordModal,
    onLogout,
    theme,
    toggleTheme,
    language,
    toggleLanguage,
    username,
}) => {
    const { t } = useLanguage();
    const [isOpen, setIsOpen] = useState(false);
    const menuRef = useRef<HTMLDivElement>(null);

    // Close on outside click
    useEffect(() => {
        const handleClickOutside = (e: MouseEvent) => {
            if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
                setIsOpen(false);
            }
        };
        if (isOpen) {
            document.addEventListener('mousedown', handleClickOutside);
        }
        return () => {
            document.removeEventListener('mousedown', handleClickOutside);
        };
    }, [isOpen]);

    // Close on ESC key
    useEffect(() => {
        const handleKeyDown = (e: KeyboardEvent) => {
            if (e.key === 'Escape' && isOpen) {
                setIsOpen(false);
            }
        };
        window.addEventListener('keydown', handleKeyDown);
        return () => window.removeEventListener('keydown', handleKeyDown);
    }, [isOpen]);

    return (
        <div className="relative inline-block" ref={menuRef} style={{ position: 'relative' }}>
            {/* Trigger Button */}
            <button
                type="button"
                onClick={() => setIsOpen(!isOpen)}
                className={`btn btn-secondary ${isOpen ? 'active' : ''}`}
                title={t('nav.settings') || 'Ajustes'}
                style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: '0.45rem',
                    padding: '0.4rem 0.75rem',
                    fontSize: '0.75rem',
                    fontWeight: 600,
                    borderRadius: 'var(--radius-pill)',
                    background: isOpen ? 'rgba(99, 102, 241, 0.12)' : 'var(--surface-card)',
                    border: `1px solid ${isOpen ? 'var(--accent-primary)' : 'var(--border-subtle)'}`,
                    color: isOpen ? 'var(--accent-primary)' : 'var(--text-primary)',
                    cursor: 'pointer',
                    transition: 'all 0.2s ease',
                }}
            >
                <Settings 
                    size={14} 
                    style={{ 
                        color: isOpen ? 'var(--accent-primary)' : 'var(--text-secondary)', 
                        transform: isOpen ? 'rotate(45deg)' : 'none', 
                        transition: 'transform 0.25s ease, color 0.2s' 
                    }} 
                />
                <span>{t('nav.settings') || 'Ajustes'}</span>
                <ChevronDown 
                    size={11} 
                    style={{ 
                        opacity: 0.7, 
                        transform: isOpen ? 'rotate(180deg)' : 'none', 
                        transition: 'transform 0.2s' 
                    }} 
                />
            </button>

            {/* Dropdown Popover */}
            {isOpen && (
                <div
                    style={{
                        position: 'absolute',
                        top: 'calc(100% + 8px)',
                        right: 0,
                        width: '310px',
                        background: 'var(--surface-card)',
                        border: '1px solid var(--border-default)',
                        borderRadius: '14px',
                        boxShadow: 'var(--shadow-lg), 0 0 24px rgba(0, 0, 0, 0.2)',
                        backdropFilter: 'blur(20px)',
                        WebkitBackdropFilter: 'blur(20px)',
                        zIndex: 1000,
                        padding: '1rem',
                        display: 'flex',
                        flexDirection: 'column',
                        gap: '0.9rem',
                        animation: 'fadeIn 0.18s cubic-bezier(0.16, 1, 0.3, 1)',
                    }}
                >
                    {/* Header: User & Version */}
                    <div style={{
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        paddingBottom: '0.75rem',
                        borderBottom: '1px solid var(--border-subtle)',
                    }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                            <div style={{
                                width: 28,
                                height: 28,
                                borderRadius: '50%',
                                background: 'var(--surface-2)',
                                border: '1px solid var(--border-default)',
                                display: 'flex',
                                alignItems: 'center',
                                justifyContent: 'center',
                                color: 'var(--text-secondary)'
                            }}>
                                <User size={14} />
                            </div>
                            <div>
                                <div style={{ fontSize: '0.8rem', fontWeight: 700, color: 'var(--text-primary)' }}>
                                    {username || 'Admin'}
                                </div>
                                <div style={{ fontSize: '0.65rem', color: 'var(--text-muted)' }}>
                                    TierMax SOAT Gateway
                                </div>
                            </div>
                        </div>
                        <button
                            type="button"
                            onClick={() => setIsOpen(false)}
                            style={{
                                background: 'transparent',
                                border: 'none',
                                color: 'var(--text-muted)',
                                cursor: 'pointer',
                                padding: '0.2rem',
                                borderRadius: '4px',
                                display: 'flex',
                                alignItems: 'center',
                                justifyContent: 'center',
                            }}
                            title="Cerrar"
                        >
                            <X size={15} />
                        </button>
                    </div>

                    {/* Section 1: Organization (Tenant) */}
                    <div>
                        <div style={{ 
                            fontSize: '0.68rem', 
                            fontWeight: 700, 
                            textTransform: 'uppercase', 
                            letterSpacing: '0.06em', 
                            color: 'var(--text-muted)', 
                            marginBottom: '0.4rem' 
                        }}>
                            {t('nav.org_env') || 'Organización & Entorno'}
                        </div>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap' }}>
                            <TenantSwitcher />
                            {dbMode && (
                                <div style={{
                                    display: 'flex',
                                    alignItems: 'center',
                                    gap: '0.35rem',
                                    padding: '0.28rem 0.6rem',
                                    borderRadius: 'var(--radius-pill)',
                                    fontSize: '0.72rem',
                                    fontWeight: 600,
                                    background: 'var(--surface-2)',
                                    border: '1px solid var(--border-subtle)',
                                    color: 'var(--text-secondary)',
                                }}>
                                    <Database size={11} style={{ opacity: 0.8 }} />
                                    <span>{dbMode.is_local ? 'SQLite Local' : 'Supabase Cloud'}</span>
                                </div>
                            )}
                        </div>
                    </div>

                    {/* Section 2: Server Startup Guide */}
                    <div>
                        <div style={{ 
                            fontSize: '0.68rem', 
                            fontWeight: 700, 
                            textTransform: 'uppercase', 
                            letterSpacing: '0.06em', 
                            color: 'var(--text-muted)', 
                            marginBottom: '0.4rem' 
                        }}>
                            {t('nav.server_guide') || 'Servidor'}
                        </div>
                        <button
                            type="button"
                            onClick={() => {
                                setIsOpen(false);
                                onOpenWelcomeModal();
                            }}
                            style={{
                                width: '100%',
                                display: 'flex',
                                alignItems: 'center',
                                justifyContent: 'space-between',
                                padding: '0.5rem 0.75rem',
                                borderRadius: '8px',
                                border: '1px solid var(--border-subtle)',
                                background: 'var(--surface-2)',
                                color: 'var(--text-primary)',
                                fontSize: '0.75rem',
                                fontWeight: 600,
                                cursor: 'pointer',
                                transition: 'all 0.15s ease',
                            }}
                            onMouseEnter={e => {
                                e.currentTarget.style.borderColor = 'var(--border-default)';
                                e.currentTarget.style.background = 'var(--surface-hover)';
                            }}
                            onMouseLeave={e => {
                                e.currentTarget.style.borderColor = 'var(--border-subtle)';
                                e.currentTarget.style.background = 'var(--surface-2)';
                            }}
                        >
                            <span style={{ display: 'flex', alignItems: 'center', gap: '0.45rem' }}>
                                <Server size={13} style={{ color: 'var(--text-secondary)' }} />
                                {t('nav.how_to_start') || '¿Cómo iniciar servidor?'}
                            </span>
                            <span style={{
                                fontSize: '0.62rem',
                                padding: '0.1rem 0.35rem',
                                borderRadius: '4px',
                                background: 'var(--surface-card)',
                                color: 'var(--text-secondary)',
                                border: '1px solid var(--border-default)',
                                fontWeight: 700,
                            }}>
                                Guía
                            </span>
                        </button>
                    </div>

                    {/* Section 3: Preferences (Language & Theme) */}
                    <div>
                        <div style={{ 
                            fontSize: '0.68rem', 
                            fontWeight: 700, 
                            textTransform: 'uppercase', 
                            letterSpacing: '0.06em', 
                            color: 'var(--text-muted)', 
                            marginBottom: '0.4rem' 
                        }}>
                            {t('nav.preferences') || 'Preferencias'}
                        </div>
                        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.4rem' }}>
                            {/* Language Switch */}
                            <button
                                type="button"
                                onClick={toggleLanguage}
                                style={{
                                    display: 'flex',
                                    alignItems: 'center',
                                    justifyContent: 'center',
                                    gap: '0.4rem',
                                    padding: '0.45rem',
                                    borderRadius: '8px',
                                    border: '1px solid var(--border-subtle)',
                                    background: 'var(--surface-card)',
                                    color: 'var(--text-primary)',
                                    fontSize: '0.74rem',
                                    fontWeight: 600,
                                    cursor: 'pointer',
                                    transition: 'all 0.15s ease',
                                }}
                                onMouseEnter={e => e.currentTarget.style.background = 'var(--surface-hover)'}
                                onMouseLeave={e => e.currentTarget.style.background = 'var(--surface-card)'}
                            >
                                <Globe size={13} style={{ color: 'var(--text-secondary)' }} />
                                <span>{language === 'en' ? 'English (US)' : 'Español (ES)'}</span>
                            </button>

                            {/* Theme Switch */}
                            <button
                                type="button"
                                onClick={toggleTheme}
                                style={{
                                    display: 'flex',
                                    alignItems: 'center',
                                    justifyContent: 'center',
                                    gap: '0.4rem',
                                    padding: '0.45rem',
                                    borderRadius: '8px',
                                    border: '1px solid var(--border-subtle)',
                                    background: 'var(--surface-card)',
                                    color: 'var(--text-primary)',
                                    fontSize: '0.74rem',
                                    fontWeight: 600,
                                    cursor: 'pointer',
                                    transition: 'all 0.15s ease',
                                }}
                                onMouseEnter={e => e.currentTarget.style.background = 'var(--surface-hover)'}
                                onMouseLeave={e => e.currentTarget.style.background = 'var(--surface-card)'}
                            >
                                {theme === 'dark' ? (
                                    <>
                                        <Moon size={13} style={{ color: 'var(--text-muted)' }} />
                                        <span>{t('nav.theme_dark') || 'Oscuro'}</span>
                                    </>
                                ) : (
                                    <>
                                        <Sun size={13} style={{ color: 'var(--brand-amber)' }} />
                                        <span>{t('nav.theme_light') || 'Claro'}</span>
                                    </>
                                )}
                            </button>
                        </div>
                    </div>

                    {/* Section 4: Account & Security */}
                    <div style={{
                        paddingTop: '0.65rem',
                        borderTop: '1px solid var(--border-subtle)',
                        display: 'flex',
                        flexDirection: 'column',
                        gap: '0.35rem',
                    }}>
                        <button
                            type="button"
                            onClick={() => {
                                setIsOpen(false);
                                onOpenPasswordModal();
                            }}
                            style={{
                                display: 'flex',
                                alignItems: 'center',
                                gap: '0.5rem',
                                padding: '0.45rem 0.65rem',
                                borderRadius: '7px',
                                border: 'none',
                                background: 'transparent',
                                color: 'var(--text-secondary)',
                                fontSize: '0.75rem',
                                fontWeight: 500,
                                cursor: 'pointer',
                                textAlign: 'left',
                                transition: 'background 0.15s ease',
                            }}
                            onMouseEnter={e => e.currentTarget.style.background = 'var(--surface-hover)'}
                            onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
                        >
                            <KeyRound size={13} style={{ color: 'var(--accent-primary)' }} />
                            <span>{t('nav.change_password') || 'Cambiar Contraseña'}</span>
                        </button>

                        <button
                            type="button"
                            onClick={() => {
                                setIsOpen(false);
                                onLogout();
                            }}
                            style={{
                                display: 'flex',
                                alignItems: 'center',
                                gap: '0.5rem',
                                padding: '0.45rem 0.65rem',
                                borderRadius: '7px',
                                border: 'none',
                                background: 'transparent',
                                color: 'var(--status-error)',
                                fontSize: '0.75rem',
                                fontWeight: 600,
                                cursor: 'pointer',
                                textAlign: 'left',
                                transition: 'background 0.15s ease',
                            }}
                            onMouseEnter={e => e.currentTarget.style.background = 'rgba(239, 68, 68, 0.08)'}
                            onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
                        >
                            <LogOut size={13} />
                            <span>{t('nav.logout') || 'Cerrar Sesión'}</span>
                        </button>
                    </div>
                </div>
            )}
        </div>
    );
};
