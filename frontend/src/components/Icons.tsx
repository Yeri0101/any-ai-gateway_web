import React from 'react';

interface IconProps extends React.SVGProps<SVGSVGElement> {
    size?: number | string;
    className?: string;
    color?: string;
}

/**
 * TierMax Brand Glyph
 * Bespoke isometric gateway portal with dual converging flux claws and a luminescent central aperture.
 */
export const TierMaxLogo: React.FC<IconProps> = ({ size = 20, className = '', ...props }) => (
    <svg
        width={size}
        height={size}
        viewBox="0 0 32 32"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
        className={className}
        {...props}
    >
        <defs>
            <linearGradient id="tm-grad-1" x1="2" y1="2" x2="30" y2="30" gradientUnits="userSpaceOnUse">
                <stop offset="0%" stopColor="#818cf8" />
                <stop offset="50%" stopColor="#6366f1" />
                <stop offset="100%" stopColor="#4338ca" />
            </linearGradient>
            <linearGradient id="tm-core" x1="10" y1="10" x2="22" y2="22" gradientUnits="userSpaceOnUse">
                <stop offset="0%" stopColor="#ffffff" />
                <stop offset="100%" stopColor="#c7d2fe" />
            </linearGradient>
        </defs>
        {/* Outer hexagonal gateway ring */}
        <path
            d="M16 2L28.5 9.2V22.8L16 30L3.5 22.8V9.2L16 2Z"
            stroke="url(#tm-grad-1)"
            strokeWidth="2.2"
            strokeLinejoin="round"
            fill="rgba(99, 102, 241, 0.08)"
        />
        {/* Converging angular energy teeth / claws */}
        <path
            d="M7 11.5L16 16.5L25 11.5"
            stroke="url(#tm-grad-1)"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
        />
        <path
            d="M7 20.5L16 15.5L25 20.5"
            stroke="url(#tm-grad-1)"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
        />
        {/* Center Quantum Conduit Core */}
        <circle cx="16" cy="16" r="3" fill="url(#tm-core)" />
        <circle cx="16" cy="16" r="4.5" stroke="#818cf8" strokeWidth="0.75" strokeDasharray="2 2" />
    </svg>
);

/**
 * SOAT / PromptAnchor Glyph
 * High-tech magnetic prefix anchor for prompt-cache stability.
 */
export const PromptAnchorGlyph: React.FC<IconProps> = ({ size = 16, color = 'currentColor', ...props }) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" {...props}>
        <path
            d="M12 2V9M12 9C9.79086 9 8 10.7909 8 13V15C8 17.2091 9.79086 19 12 19C14.2091 19 16 17.2091 16 15V13C16 10.7909 14.2091 9 12 9ZM12 9V5"
            stroke={color}
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
        />
        <path d="M5 12H7M17 12H19" stroke={color} strokeWidth="2" strokeLinecap="round" />
        <path d="M9 22H15" stroke={color} strokeWidth="1.8" strokeLinecap="round" />
        <circle cx="12" cy="14" r="1.5" fill={color} />
    </svg>
);

/**
 * Rate Limit Guardian Glyph
 * Kinetic shield with frequency wave anti-surge dampener.
 */
export const RateGuardianGlyph: React.FC<IconProps> = ({ size = 16, color = 'currentColor', ...props }) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" {...props}>
        <path
            d="M12 2.5L20 6.5V12C20 17 16.5 20.8 12 22C7.5 20.8 4 17 4 12V6.5L12 2.5Z"
            stroke={color}
            strokeWidth="1.75"
            strokeLinejoin="round"
        />
        {/* Oscilloscope anti-surge frequency bars */}
        <path d="M8 12.5H9.5L11 9.5L13 14.5L14.5 11.5L16 12.5" stroke={color} strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
);

/**
 * Dual Engine Glyph
 * Interconnected dual-core synchronized neural coprocessor.
 */
export const DualEngineGlyph: React.FC<IconProps> = ({ size = 16, color = 'currentColor', ...props }) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" {...props}>
        <rect x="3" y="6" width="7" height="12" rx="2" stroke={color} strokeWidth="1.6" />
        <rect x="14" y="6" width="7" height="12" rx="2" stroke={color} strokeWidth="1.6" />
        <path d="M10 10H14M10 14H14" stroke={color} strokeWidth="1.8" strokeLinecap="round" />
        <circle cx="6.5" cy="12" r="1.2" fill={color} />
        <circle cx="17.5" cy="12" r="1.2" fill={color} />
        <path d="M6.5 3V6M17.5 3V6M6.5 18V21M17.5 18V21" stroke={color} strokeWidth="1.5" strokeLinecap="round" />
    </svg>
);

/**
 * Atlas Smart Router Glyph
 * Multi-tier cascading gateway prism.
 */
export const RouterCascadeGlyph: React.FC<IconProps> = ({ size = 16, color = 'currentColor', ...props }) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" {...props}>
        <path d="M4 6H13C15.2 6 17 7.8 17 10V18" stroke={color} strokeWidth="1.75" strokeLinecap="round" />
        <path d="M4 12H9C11.2 12 13 13.8 13 16V18" stroke={color} strokeWidth="1.75" strokeLinecap="round" />
        <path d="M4 18H8" stroke={color} strokeWidth="1.75" strokeLinecap="round" />
        <circle cx="17" cy="19" r="1.8" fill={color} />
        <circle cx="13" cy="19" r="1.8" fill={color} />
        <circle cx="4" cy="6" r="1.8" fill={color} />
    </svg>
);

/**
 * Cyber Console Glyph
 */
export const CyberTerminalGlyph: React.FC<IconProps> = ({ size = 16, color = 'currentColor', ...props }) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" {...props}>
        <rect x="2.5" y="4" width="19" height="16" rx="3" stroke={color} strokeWidth="1.75" />
        <path d="M6.5 9L10 12L6.5 15" stroke={color} strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" />
        <path d="M12 15H17.5" stroke={color} strokeWidth="2" strokeLinecap="round" />
    </svg>
);

/* ─────────────────────────────────────────────────────────────────────────────
   AUTHENTIC BESPOKE PROVIDER LOGOS
   ───────────────────────────────────────────────────────────────────────────── */

export const OpenAIIcon: React.FC<IconProps> = ({ size = 16, ...props }) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" {...props}>
        <path d="M21.5 10.3c-.2-1.5-1.1-2.8-2.4-3.5-.4-.2-.8-.4-1.3-.5-.4-1.5-1.5-2.6-3-3.1-1.9-.6-4 .1-5.1 1.8-.7-.2-1.4-.2-2.1 0-1.9.6-3.2 2.3-3.2 4.3 0 .4 0 .8.1 1.2-1.3.5-2.2 1.6-2.6 3-.5 1.9.2 4 1.8 5.1-.1.5 0 1.1.2 1.6.7 1.8 2.4 3.1 4.4 3.1.4 0 .8 0 1.2-.1.6 1.3 1.8 2.2 3.2 2.5 1.9.4 3.9-.4 4.9-2.1.5.2 1.1.2 1.6.1 1.9-.5 3.3-2.1 3.5-4.1.4-.4.8-.9 1-1.5.7-1.9 0-4-1.6-5.1.1-.9.1-1.8-.4-2.7zm-8.8 11.2c-1.1 0-2.1-.6-2.6-1.5l.1-.1 3.7-2.1c.2-.1.4-.4.4-.6v-5.2l1.6.9v4.3c0 2.4-1.4 4.3-3.2 4.3zm-7.6-4.6c-.6-1-.6-2.3 0-3.3l.1.1 3.7 2.1c.2.1.5.1.7 0l4.5-2.6v1.9l-3.8 2.2c-2.1 1.2-4.6.8-5.2-.4zm-1.2-8.3c.6-1 1.7-1.7 2.9-1.8v.2l-.1 4.3c0 .3.2.5.4.6l4.5 2.6-1.6.9-3.8-2.2c-2.1-1.2-2.9-3.5-2.3-4.6zm12.9 2.5l-4.5-2.6 1.6-.9 3.8 2.2c2.1 1.2 2.9 3.5 2.3 4.6-.6 1-1.7 1.7-2.9 1.8v-.2l.1-4.3c0-.2-.1-.5-.4-.6zm2.4 5.9c.6 1 .6 2.3 0 3.3l-.1-.1-3.7-2.1c-.2-.1-.5-.1-.7 0l-4.5 2.6v-1.9l3.8-2.2c2.1-1.2 4.6-.8 5.2.4zm-7.9-1.8l-1.9-1.1 1.9-1.1 1.9 1.1-1.9 1.1z" />
    </svg>
);

export const AnthropicIcon: React.FC<IconProps> = ({ size = 16, ...props }) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" {...props}>
        <path d="M14.5 3h3.8L12 21H8.2L14.5 3zM5.7 21h3.8l2-5.7H7.7L5.7 21z" />
    </svg>
);

export const GoogleGeminiIcon: React.FC<IconProps> = ({ size = 16, ...props }) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" {...props}>
        <defs>
            <linearGradient id="gemini-grad" x1="2" y1="2" x2="22" y2="22" gradientUnits="userSpaceOnUse">
                <stop offset="0%" stopColor="#4285F4" />
                <stop offset="40%" stopColor="#9B72CB" />
                <stop offset="100%" stopColor="#D96570" />
            </linearGradient>
        </defs>
        <path
            d="M12 2C12 7.52 7.52 12 2 12C7.52 12 12 16.48 12 22C12 16.48 16.48 12 22 12C16.48 12 12 7.52 12 2Z"
            fill="url(#gemini-grad)"
        />
    </svg>
);

export const GroqIcon: React.FC<IconProps> = ({ size = 16, ...props }) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" {...props}>
        <path d="M12 2C6.48 2 2 6.48 2 12C2 17.52 6.48 22 12 22C17.52 22 22 17.52 22 12H12V15.5H17.8C16.9 18.2 14.5 20 12 20C7.58 20 4 16.42 4 12C4 7.58 7.58 4 12 4C14.15 4 16.08 4.85 17.5 6.22L19.5 4.22C17.55 2.8 14.9 2 12 2Z" />
    </svg>
);

export const DeepSeekIcon: React.FC<IconProps> = ({ size = 16, ...props }) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" {...props}>
        <path d="M3.5 12C3.5 7.3 7.3 3.5 12 3.5C16.7 3.5 20.5 7.3 20.5 12C20.5 15.6 18.2 18.7 15 19.9V16.8C16.8 15.9 18 14.1 18 12C18 8.7 15.3 6 12 6C8.7 6 6 8.7 6 12C6 14.1 7.2 15.9 9 16.8V19.9C5.8 18.7 3.5 15.6 3.5 12ZM11 10.5V17H13V10.5H11Z" />
    </svg>
);

export const MistralIcon: React.FC<IconProps> = ({ size = 16, ...props }) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" {...props}>
        <rect x="2" y="4" width="4" height="4" rx="0.5" fill="#FF7000" />
        <rect x="18" y="4" width="4" height="4" rx="0.5" fill="#FF7000" />
        <rect x="6" y="8" width="4" height="4" rx="0.5" fill="#FF7000" />
        <rect x="14" y="8" width="4" height="4" rx="0.5" fill="#FF7000" />
        <rect x="10" y="12" width="4" height="4" rx="0.5" fill="#FF7000" />
        <rect x="2" y="16" width="4" height="4" rx="0.5" fill="#FF7000" />
        <rect x="18" y="16" width="4" height="4" rx="0.5" fill="#FF7000" />
    </svg>
);

export const CerebrasIcon: React.FC<IconProps> = ({ size = 16, ...props }) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" {...props}>
        <rect x="4" y="4" width="16" height="16" rx="2" stroke="#ff385c" fill="rgba(255,56,92,0.08)" />
        <path d="M9 4V20M15 4V20M4 9H20M4 15H20" stroke="#ff385c" strokeOpacity="0.5" />
        <circle cx="12" cy="12" r="2.5" fill="#ff385c" />
    </svg>
);

export const OpenRouterIcon: React.FC<IconProps> = ({ size = 16, ...props }) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" {...props}>
        <path d="M12 2L3 7V17L12 22L21 17V7L12 2ZM12 4.3L18.8 8.1L12 11.9L5.2 8.1L12 4.3ZM5 9.8L11 13.1V19.7L5 16.3V9.8ZM13 19.7V13.1L19 9.8V16.3L13 19.7Z" />
    </svg>
);

export const PuterIcon: React.FC<IconProps> = ({ size = 16, ...props }) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" {...props}>
        <path d="M4 16.5C3 15.5 2 13.8 2 12C2 8.7 4.7 6 8 6C9 4 11.5 2.5 14.5 2.5C18.5 2.5 22 5.8 22 10C22 10.5 21.9 11 21.8 11.5C22.5 12.3 23 13.3 23 14.5C23 17 21 19 18.5 19H5" stroke="#3b82f6" strokeLinecap="round" />
        <path d="M9 13L12 16L15 13" stroke="#3b82f6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
);

export const NvidiaIcon: React.FC<IconProps> = ({ size = 16, ...props }) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" {...props}>
        <path d="M6.5 12C6.5 9 8.9 6.5 11.9 6.5C13.8 6.5 15.4 7.5 16.3 9L18.5 7.5C17 5 14.6 3.5 11.9 3.5C7.2 3.5 3.5 7.3 3.5 12C3.5 16.7 7.2 20.5 11.9 20.5C15 20.5 17.7 18.8 19 16.2L16.8 14.8C15.8 16.5 14 17.5 11.9 17.5C8.9 17.5 6.5 15 6.5 12Z" fill="#76B900" />
    </svg>
);

export const MoonshotIcon: React.FC<IconProps> = ({ size = 16, ...props }) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" {...props}>
        <path d="M12 2C6.5 2 2 6.5 2 12C2 17.5 6.5 22 12 22C14.3 22 16.5 21.2 18.2 19.8C14.5 19.2 11.7 16 11.7 12C11.7 8 14.5 4.8 18.2 4.2C16.5 2.8 14.3 2 12 2Z" fill="#818cf8" />
    </svg>
);

export const MiniMaxIcon: React.FC<IconProps> = ({ size = 16, ...props }) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" {...props}>
        <path d="M4 18V6L9 12L12 9L15 12L20 6V18" stroke="#ec4899" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
);

export const GenericProviderIcon: React.FC<IconProps> = ({ size = 16, color = 'currentColor', ...props }) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="1.75" {...props}>
        <rect x="3" y="4" width="18" height="6" rx="1.5" />
        <rect x="3" y="14" width="18" height="6" rx="1.5" />
        <circle cx="7" cy="7" r="1" fill={color} />
        <circle cx="7" cy="17" r="1" fill={color} />
    </svg>
);

/**
 * Universal Provider Icon Resolver
 */
export const ProviderIcon: React.FC<{ provider: string; size?: number; className?: string }> = ({
    provider,
    size = 18,
    className = '',
}) => {
    const p = (provider || '').toLowerCase().trim();

    if (p === 'openai') return <OpenAIIcon size={size} className={className} style={{ color: '#10a37f' }} />;
    if (p === 'anthropic') return <AnthropicIcon size={size} className={className} style={{ color: '#d97706' }} />;
    if (p === 'google' || p === 'vertex') return <GoogleGeminiIcon size={size} className={className} />;
    if (p === 'groq') return <GroqIcon size={size} className={className} style={{ color: '#f55036' }} />;
    if (p === 'deepseek') return <DeepSeekIcon size={size} className={className} style={{ color: '#0ea5e9' }} />;
    if (p === 'mistral') return <MistralIcon size={size} className={className} />;
    if (p === 'cerebras') return <CerebrasIcon size={size} className={className} />;
    if (p === 'openrouter') return <OpenRouterIcon size={size} className={className} style={{ color: '#6366f1' }} />;
    if (p === 'puter') return <PuterIcon size={size} className={className} />;
    if (p === 'nvidia') return <NvidiaIcon size={size} className={className} />;
    if (p === 'moonshot') return <MoonshotIcon size={size} className={className} />;
    if (p === 'minimax') return <MiniMaxIcon size={size} className={className} />;

    return <GenericProviderIcon size={size} className={className} color="var(--text-muted)" />;
};
