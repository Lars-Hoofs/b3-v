/**
 * Widget Renderer — Server-Side HTML Generation
 * 
 * Single source of truth for widget HTML. This function takes a widget config
 * object and produces a complete HTML string. Used by:
 * - /api/widgets/render/:installCode endpoint (for the live widget)
 * - Dashboard preview iframe (for the editor)
 * 
 * NO template literals inside template literals. NO escaping hell.
 * Just clean string concatenation.
 */

// ─── TYPES ───────────────────────────────────────────────────────────
interface WidgetConfig {
    [key: string]: any;
}

interface LauncherBlock {
    id: string;
    type: string;
    content?: string;
    children?: LauncherBlock[];
    style?: Record<string, string>;
    onClick?: string;
    url?: string;
    mobileHidden?: boolean;
    splitRatio?: number;
    statusType?: string;
}

interface ChatBlock {
    id: string;
    type: string;
    content?: string;
    placeholder?: string;
    children?: ChatBlock[];
    style?: Record<string, string>;
    onClick?: string;
    url?: string;
    mobileHidden?: boolean;
    splitRatio?: number;
    statusType?: string;
}

// ─── HELPERS ─────────────────────────────────────────────────────────

function escapeHtml(str: string): string {
    return str
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

function styleObj(styles: Record<string, string | number | undefined>): string {
    return Object.entries(styles)
        .filter(([, v]) => v !== undefined && v !== null && v !== '')
        .map(([k, v]) => {
            // camelCase to kebab-case
            const prop = k.replace(/[A-Z]/g, m => '-' + m.toLowerCase());
            return `${prop}: ${v}`;
        })
        .join('; ');
}

/**
 * Convert a React icon name like "RiChat1Line" to a Remixicon CSS class like "ri-chat-1-line"
 */
function getRemixiconClass(iconName: string): string | null {
    if (!iconName || !iconName.startsWith('Ri')) return null;

    const hasFill = iconName.endsWith('Fill');
    const suffix = hasFill ? '-fill' : '-line';

    let baseName = iconName.replace(/^Ri/, '').replace(/Line$|Fill$/, '');

    baseName = baseName
        .replace(/([a-z])([A-Z])/g, '$1-$2')
        .replace(/([A-Z])([A-Z][a-z])/g, '$1-$2')
        .replace(/([a-z])([0-9])/g, '$1-$2')
        .replace(/([0-9])([A-Z])/g, '$1-$2')
        .toLowerCase();

    return 'ri-' + baseName + suffix;
}

function iconHtml(iconName: string | undefined, size: number = 24, color: string = 'currentColor'): string {
    if (!iconName) {
        // Default chat icon SVG
        return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="currentColor" style="color: ${color};"><path d="M10 3h4a8 8 0 1 1 0 16v3.5c-5-2-12-5-12-11.5a8 8 0 0 1 8-8Z"/></svg>`;
    }

    const cls = getRemixiconClass(iconName);
    if (cls) {
        return `<i class="${cls}" style="font-size: ${size}px; color: ${color}; display: inline-block; line-height: 1;"></i>`;
    }

    // Fallback SVG
    return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="currentColor" style="color: ${color};"><path d="M10 3h4a8 8 0 1 1 0 16v3.5c-5-2-12-5-12-11.5a8 8 0 0 1 8-8Z"/></svg>`;
}

function sendIconSvg(color: string = 'currentColor'): string {
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="20" height="20" fill="${color}"><path d="M1.94619 9.31543C1.42365 9.14125 1.41953 8.86022 1.95694 8.68108L21.0431 2.31901C21.5716 2.14285 21.8747 2.43866 21.7266 2.95694L16.2734 22.0432C16.1224 22.5716 15.8178 22.59 15.5945 22.0876L12 14L18 6.00005L10 12L1.94619 9.31543Z"></path></svg>`;
}

function closeIconSvg(color: string = 'currentColor'): string {
    return `<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="${color}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>`;
}

// ─── LAUNCHER RENDERING ──────────────────────────────────────────────

function renderLauncherBlock(block: LauncherBlock, depth: number = 0): string {
    if (!block || !block.id) return '';

    const blockId = 'launcher-block-' + block.id;

    // Build inline styles from block.style
    const userStyles = block.style ? styleObj(block.style) : '';

    // Base styles based on block type
    let baseStyles = '';
    let content = '';

    switch (block.type) {
        case 'container':
        case 'row':
        case 'column':
            baseStyles = 'display: flex; align-items: center;';
            if (block.type === 'column') baseStyles = 'display: flex; flex-direction: column;';
            if (block.children && block.children.length > 0) {
                content = block.children.map(c => renderLauncherBlock(c, depth + 1)).join('');
            }
            break;

        case 'icon':
            const iconColor = (block.style && block.style.color) || 'currentColor';
            const iconSize = (block.style && block.style.fontSize) ? parseInt(block.style.fontSize) : 24;
            content = iconHtml(block.content, iconSize, iconColor);
            break;

        case 'text':
            content = escapeHtml(block.content || '');
            break;

        case 'image':
            content = `<img src="${escapeHtml(block.content || '')}" style="display: block; max-width: 100%; height: auto;" alt="" />`;
            break;

        case 'split':
            const lRatio = block.splitRatio || 50;
            baseStyles = 'display: flex; flex-direction: row; width: 100%;';
            if (block.children && block.children.length === 2) {
                const left = renderLauncherBlock(block.children[0], depth + 1);
                const right = renderLauncherBlock(block.children[1], depth + 1);
                content = `<div style="flex: ${lRatio}; min-width: 0;">${left}</div><div style="flex: ${100 - lRatio}; min-width: 0;">${right}</div>`;
            } else if (block.children) {
                content = block.children.map(c => renderLauncherBlock(c, depth + 1)).join('');
            }
            break;

        case 'status':
            const typeClass = block.statusType || 'online';
            const color = typeClass === 'online' ? '#10b981' : typeClass === 'away' ? '#f59e0b' : '#9ca3af';
            content = `<span style="width: 10px; height: 10px; background: ${color}; border-radius: 50%; display: inline-block; box-shadow: 0 0 0 2px #fff;"></span>`;
            break;

        default:
            content = escapeHtml(block.content || '');
    }

    // Click action as data attributes
    let clickAttrs = '';
    if (block.onClick) {
        clickAttrs += ` data-click-action="${escapeHtml(block.onClick)}"`;
        if (block.onClick === 'open-url' && block.url) {
            clickAttrs += ` data-click-url="${escapeHtml(block.url)}"`;
        }
        clickAttrs += ' style="cursor: pointer;' + (userStyles ? ' ' + userStyles : '') + '"';
    } else if (userStyles) {
        clickAttrs += ` style="${userStyles}"`;
    }

    const mobileHidden = block.mobileHidden ? ' class="launcher-mobile-hidden"' : '';

    // If no click attrs set style separately
    if (!block.onClick && !userStyles && baseStyles) {
        clickAttrs = ` style="${baseStyles}"`;
    } else if (!block.onClick && !userStyles) {
        clickAttrs = '';
    } else if (block.onClick) {
        // Style already included in clickAttrs above, prepend base
        clickAttrs = clickAttrs.replace('style="', `style="${baseStyles} `);
    } else {
        clickAttrs = ` style="${baseStyles} ${userStyles}"`;
    }

    return `<div id="${blockId}"${mobileHidden}${clickAttrs}>${content}</div>`;
}

function renderSimpleLauncher(cfg: WidgetConfig): string {
    const bgColor = cfg.bubbleBackgroundColor || '#000000';
    const textColor = cfg.bubbleTextColor || '#ffffff';
    const bIconColor = cfg.bubbleIconColor || textColor;

    // Size
    let width = 64, height = 64;
    if (cfg.bubbleSize === 'small') { width = 48; height = 48; }
    if (cfg.bubbleSize === 'large') { width = 80; height = 80; }
    if (cfg.bubbleSize === 'custom' && cfg.bubbleWidth && cfg.bubbleHeight) {
        width = cfg.bubbleWidth; height = cfg.bubbleHeight;
    }

    let widthStr = width + 'px';
    let heightStr = height + 'px';
    let borderRadius = '50%';

    if (cfg.bubbleShape === 'square') borderRadius = '0';
    if (cfg.bubbleShape === 'rounded-square') borderRadius = '16px';

    // Auto-width for text or side-by-side
    if ((cfg.bubbleText && !cfg.bubbleIcon && !cfg.bubbleImageUrl) || cfg.imageIconRelation === 'side-by-side') {
        widthStr = 'auto';
        borderRadius = '32px';
    }

    // Background (gradient vs solid)
    let background = bgColor;
    if (cfg.backgroundGradient && cfg.backgroundGradient.from && cfg.backgroundGradient.to) {
        const dir = cfg.backgroundGradient.direction || '135deg';
        background = `linear-gradient(${dir}, ${cfg.backgroundGradient.from}, ${cfg.backgroundGradient.to})`;
    }

    // Glass effect
    let glassStyle = '';
    if (cfg.glassEffect) {
        const blur = cfg.backdropBlur || 8;
        glassStyle = `backdrop-filter: blur(${blur}px); -webkit-backdrop-filter: blur(${blur}px); border: 1px solid rgba(255,255,255,0.2);`;
    }

    const bubbleStyle = [
        `width: ${widthStr}`,
        `height: ${heightStr}`,
        `min-width: ${height}px`,
        `background: ${background}`,
        `color: ${textColor}`,
        `border-radius: ${borderRadius}`,
        'display: flex',
        'align-items: center',
        'justify-content: center',
        'cursor: pointer',
        `box-shadow: ${cfg.bubbleShadow || '0 8px 24px rgba(0,0,0,0.12), 0 2px 8px rgba(0,0,0,0.08)'}`,
        'transition: all 0.3s cubic-bezier(0.25, 0.8, 0.25, 1)',
        "font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
        'font-weight: 600',
        'font-size: 14px',
        `padding: ${widthStr === 'auto' ? '0 20px' : '0'}`,
        glassStyle,
    ].filter(Boolean).join('; ');

    // Bubble content
    let bubbleContent = '';
    if (cfg.bubbleImageUrl) {
        const fit = cfg.bubbleImageFit || 'cover';
        if (cfg.imageIconRelation === 'side-by-side') {
            bubbleContent = `<img src="${escapeHtml(cfg.bubbleImageUrl)}" style="width: 32px; height: 32px; border-radius: 50%; object-fit: cover; margin-right: 12px; border: 2px solid rgba(255,255,255,0.2);">`;
            if (cfg.bubbleText) bubbleContent += `<span class="ai-bubble-text">${escapeHtml(cfg.bubbleText)}</span>`;
        } else {
            bubbleContent = `<img src="${escapeHtml(cfg.bubbleImageUrl)}" style="width: 100%; height: 100%; object-fit: ${fit}; border-radius: inherit; display: block;">`;
        }
    } else if (cfg.bubbleText) {
        if (cfg.bubbleIcon) {
            bubbleContent = `<div style="display: flex; align-items: center; gap: 8px;">${iconHtml(cfg.bubbleIcon, 24, bIconColor)}<span class="ai-bubble-text">${escapeHtml(cfg.bubbleText)}</span></div>`;
        } else {
            bubbleContent = `<span class="ai-bubble-text">${escapeHtml(cfg.bubbleText)}</span>`;
        }
    } else {
        bubbleContent = iconHtml(cfg.bubbleIcon, 24, bIconColor);
    }

    return `<div id="ai-chat-bubble" style="${bubbleStyle}">${bubbleContent}</div>`;
}

function renderAdvancedLauncher(cfg: WidgetConfig): string {
    const blocks: LauncherBlock[] = cfg.launcherStructure || [];
    let html = '';
    for (const block of blocks) {
        html += renderLauncherBlock(block, 0);
    }
    return `<div id="ai-chat-bubble" style="display: flex; flex-direction: column; gap: 0; position: relative; cursor: pointer;">${html}</div>`;
}

function renderLauncher(cfg: WidgetConfig): string {
    const useAdvanced = cfg.launcherMode === 'advanced' &&
        cfg.launcherStructure &&
        Array.isArray(cfg.launcherStructure) &&
        cfg.launcherStructure.length > 0;

    if (useAdvanced) {
        return renderAdvancedLauncher(cfg);
    }
    return renderSimpleLauncher(cfg);
}

// ─── CHAT WINDOW RENDERING ──────────────────────────────────────────

function renderChatBlock(block: ChatBlock, cfg: WidgetConfig, depth: number = 0): string {
    if (!block || !block.id) return '';

    const blockId = 'chat-block-' + block.id;
    const userStyles = block.style ? styleObj(block.style) : '';
    const mobileHidden = block.mobileHidden ? ' class="chat-mobile-hidden"' : '';
    const childrenHtml = (block.children || []).map(c => renderChatBlock(c, cfg, depth + 1)).join('');

    let content = '';

    switch (block.type) {
        case 'header': {
            const headerBg = (block.style && block.style.background) ? '' : `background: ${cfg.headerBackgroundColor || '#ffffff'}; color: ${cfg.headerTextColor || '#000000'};`;
            const headerBorder = (block.style && block.style.borderBottom) ? '' : 'border-bottom: 1px solid rgba(0,0,0,0.05);';
            const headerStyle = `padding: 20px 24px; display: flex; align-items: center; justify-content: space-between; ${headerBorder} ${headerBg} ${userStyles}`;

            // Avatar
            let avatarHtml = '';
            if (cfg.showAgentAvatar !== false) {
                let avContent = '';
                if (cfg.headerAvatarUrl) {
                    avContent = `<img src="${escapeHtml(cfg.headerAvatarUrl)}" alt="Avatar" style="width: 100%; height: 100%; object-fit: cover;">`;
                } else if (cfg.headerAvatarEmoji) {
                    avContent = `<div style="font-size: 24px;">${cfg.headerAvatarEmoji}</div>`;
                } else {
                    avContent = '<div style="width: 100%; height: 100%; background: linear-gradient(135deg, #e0c3fc 0%, #8ec5fc 100%);"></div>';
                }
                avatarHtml = `<div style="width: 48px; height: 48px; border-radius: 16px; margin-right: 16px; overflow: hidden; display: flex; align-items: center; justify-content: center; box-shadow: 0 4px 12px rgba(0,0,0,0.05); background: ${cfg.avatarBackgroundColor || 'transparent'}; flex-shrink: 0;">${avContent}</div>`;
            }

            // Text info
            let textsHtml = '<div>';
            textsHtml += `<div style="font-weight: 700; font-size: 18px; letter-spacing: -0.02em;">${escapeHtml(cfg.headerTitle || 'Chat')}</div>`;
            if (cfg.headerSubtitle) {
                textsHtml += `<div style="font-size: 13px; opacity: 0.6; margin-top: 2px;">${escapeHtml(cfg.headerSubtitle)}</div>`;
            }
            if (cfg.showOnlineStatus) {
                textsHtml += `<div style="display: flex; align-items: center; gap: 6px; font-size: 12px; opacity: 0.8; margin-top: 4px;"><span style="width: 8px; height: 8px; background: ${cfg.onlineStatusColor || '#10b981'}; border-radius: 50%; display: inline-block; border: 1.5px solid #fff;"></span> Online</div>`;
            }
            textsHtml += '</div>';

            const leftHtml = `<div style="display: flex; align-items: center;">${avatarHtml}${textsHtml}</div>`;

            const closeIconColor = cfg.headerCloseIconColor || (cfg.headerBackgroundColor === '#ffffff' ? '#000000' : cfg.headerTextColor || '#000000');
            const closeBtnHtml = cfg.headerCloseIcon
                ? iconHtml(cfg.headerCloseIcon, 24, closeIconColor)
                : closeIconSvg(closeIconColor);
            const closeBtn = `<button id="ai-chat-close" style="background: ${cfg.headerCloseIconBackgroundColor || 'transparent'}; border: none; color: ${closeIconColor}; font-size: 20px; cursor: pointer; padding: 0; width: 40px; height: 40px; border-radius: 50%; display: flex; align-items: center; justify-content: center; transition: all 0.2s;">${closeBtnHtml}</button>`;

            content = `<div id="${blockId}"${mobileHidden} style="${headerStyle}">${leftHtml}${closeBtn}</div>`;
            break;
        }

        case 'messages': {
            const msgBg = (block.style && block.style.background) ? '' : `background: ${cfg.chatBackgroundColor || '#ffffff'};`;
            const msgStyle = `flex: 1; overflow-y: auto; padding: 24px; display: flex; flex-direction: column; gap: 24px; ${msgBg} ${userStyles}`;
            content = `<div id="ai-chat-messages"${mobileHidden} style="${msgStyle}">${childrenHtml}</div>`;
            break;
        }

        case 'input': {
            const inputAreaBg = (block.style && block.style.background) ? '' : `background: ${cfg.inputAreaBackgroundColor || '#ffffff'};`;
            const inputAreaTop = (block.style && block.style.borderTop) ? '' : `border-top: 1px solid ${cfg.inputAreaBorderColor || 'transparent'};`;
            const inputAreaStyle = `padding: 20px 24px; ${inputAreaTop} ${inputAreaBg} ${userStyles}`;

            const inputBg = cfg.inputBackgroundColor || '#f3f4f6';
            const inputBorder = cfg.inputBorderColor || 'transparent';
            const inputInnerStyle = `display: flex; gap: 12px; align-items: center; background: ${inputBg}; border-radius: 32px; padding: 6px 6px 6px 20px; border: 1px solid ${inputBorder}; transition: all 0.2s;`;

            const placeholder = escapeHtml(block.placeholder || cfg.placeholder || 'Type a message...');
            const sendBtnBg = cfg.sendButtonBackgroundColor || cfg.primaryColor || '#000000';
            const sendBtnColor = cfg.sendButtonIconColor || '#ffffff';

            content = `<div id="${blockId}"${mobileHidden} style="${inputAreaStyle}">
        <div id="ai-chat-typing" style="display: none; color: ${cfg.typingIndicatorColor || '#9ca3af'}; font-size: 12px; margin-bottom: 12px; padding-left: 4px; font-weight: 500;">AI is typing...</div>
        <div style="${inputInnerStyle}">
          <input id="ai-chat-input" type="text" placeholder="${placeholder}" style="flex: 1; border: none; font-size: 15px; outline: none; background: transparent; color: ${cfg.inputTextColor || '#1f2937'}; padding: 10px 0;">
          <button id="ai-chat-send" style="background: ${sendBtnBg}; color: ${sendBtnColor}; border: none; padding: 0; width: 42px; height: 42px; border-radius: 50%; cursor: pointer; display: flex; align-items: center; justify-content: center; flex-shrink: 0; transition: all 0.2s;">
            ${sendIconSvg(sendBtnColor)}
          </button>
        </div>
      </div>`;
            break;
        }

        case 'container':
            content = `<div id="${blockId}"${mobileHidden} style="${userStyles}">${childrenHtml}</div>`;
            break;

        case 'split': {
            const ratio = block.splitRatio || 50;
            const splitStyle = `display: flex; flex-direction: row; width: 100%; ${userStyles}`;
            if (block.children && block.children.length === 2) {
                const left = renderChatBlock(block.children[0], cfg, depth + 1);
                const right = renderChatBlock(block.children[1], cfg, depth + 1);
                content = `<div id="${blockId}"${mobileHidden} style="${splitStyle}"><div style="flex: ${ratio}; min-width: 0;">${left}</div><div style="flex: ${100 - ratio}; min-width: 0;">${right}</div></div>`;
            } else {
                content = `<div id="${blockId}"${mobileHidden} style="${splitStyle}">${childrenHtml}</div>`;
            }
            break;
        }

        case 'status': {
            const typeClass = block.statusType || 'online';
            const color = typeClass === 'online' ? '#10b981' : typeClass === 'away' ? '#f59e0b' : '#9ca3af';
            content = `<div id="${blockId}"${mobileHidden} style="width: 10px; height: 10px; background: ${color}; border-radius: 50%; display: inline-block; box-shadow: 0 0 0 2px inherit; flex-shrink: 0; ${userStyles}"></div>`;
            break;
        }

        case 'text':
            content = `<div id="${blockId}"${mobileHidden} style="padding: 0; margin: 0; ${userStyles}">${escapeHtml(block.content || '')}${childrenHtml}</div>`;
            break;

        case 'icon': {
            const iconColor = (block.style && block.style.color) || 'currentColor';
            const iconSize = (block.style && block.style.fontSize) ? parseInt(block.style.fontSize) : 24;
            content = `<div id="${blockId}"${mobileHidden} style="display: flex; align-items: center; justify-content: center; ${userStyles}">${iconHtml(block.content, iconSize, iconColor)}</div>`;
            break;
        }

        case 'image':
            content = `<img id="${blockId}"${mobileHidden} src="${escapeHtml(block.content || '')}" style="display: block; max-width: 100%; height: auto; ${userStyles}" alt="" />`;
            break;

        case 'button': {
            let clickData = '';
            if (block.onClick === 'close-chat') clickData = ' data-chat-action="close-chat"';
            else if (block.onClick === 'open-url' && block.url) clickData = ` data-chat-action="open-url" data-chat-url="${escapeHtml(block.url)}"`;
            content = `<button id="${blockId}"${mobileHidden}${clickData} style="padding: 8px 16px; border: none; cursor: pointer; border-radius: 8px; ${userStyles}">${escapeHtml(block.content || 'Button')}</button>`;
            break;
        }

        case 'divider':
            content = `<div id="${blockId}" style="height: 1px; background: rgba(0,0,0,0.1); ${userStyles}"></div>`;
            break;

        case 'branding':
            if (cfg.showBranding) {
                const brandBg = (block.style && block.style.background) ? '' : `background: ${cfg.chatBackgroundColor || '#fff'};`;
                content = `<div id="${blockId}" style="padding: 8px; text-align: center; font-size: 11px; color: #d1d5db; ${brandBg} ${userStyles}"><a href="${escapeHtml(cfg.brandingUrl || 'https://bonsaimedia.nl')}" target="_blank" style="color: inherit; text-decoration: none;">${escapeHtml(cfg.brandingText || 'Powered by Bonsai')}</a></div>`;
            }
            break;

        default:
            content = `<div id="${blockId}"${mobileHidden} style="${userStyles}">${childrenHtml}</div>`;
    }

    return content;
}

function renderSimpleChatWindow(cfg: WidgetConfig): string {
    const closeIconColor = cfg.headerCloseIconColor || (cfg.headerBackgroundColor === '#ffffff' ? '#000000' : cfg.headerTextColor || '#000000');
    const closeBtnHtml = cfg.headerCloseIcon
        ? iconHtml(cfg.headerCloseIcon, 24, closeIconColor)
        : closeIconSvg(closeIconColor);

    // Avatar
    let avatarContent = '';
    if (cfg.headerAvatarUrl) {
        avatarContent = `<img src="${escapeHtml(cfg.headerAvatarUrl)}" alt="Avatar" style="width: 100%; height: 100%; object-fit: cover;" />`;
    } else if (cfg.headerAvatarEmoji) {
        avatarContent = cfg.headerAvatarEmoji;
    } else {
        avatarContent = '<div style="width: 100%; height: 100%; background: linear-gradient(135deg, #e0c3fc 0%, #8ec5fc 100%);"></div>';
    }

    const headerBg = cfg.headerBackgroundColor || '#ffffff';
    const chatBg = cfg.chatBackgroundColor || '#ffffff';
    const inputAreaBg = cfg.inputAreaBackgroundColor || '#ffffff';
    const inputBg = cfg.inputBackgroundColor || '#f3f4f6';
    const inputBorder = cfg.inputBorderColor || 'transparent';
    const inputText = cfg.inputTextColor || '#1f2937';
    const typingColor = cfg.typingIndicatorColor || '#9ca3af';
    const sendBtnBg = cfg.sendButtonBackgroundColor || 'transparent';
    const sendBtnColor = cfg.sendButtonIconColor || (cfg.primaryColor || '#000000');
    const sendBtnHtml = cfg.sendButtonIcon ? iconHtml(cfg.sendButtonIcon, 24, sendBtnColor) : sendIconSvg(sendBtnColor);

    let html = '';

    // Header
    html += `<div style="background: ${headerBg}; color: ${cfg.headerTextColor || '#000000'}; padding: 20px 24px; display: flex; align-items: center; justify-content: space-between;">`;
    html += '<div style="display: flex; align-items: center; gap: 16px;">';
    if (cfg.showAgentAvatar !== false) {
        html += `<div style="width: 48px; height: 48px; border-radius: 16px; background: ${cfg.avatarBackgroundColor || 'transparent'}; display: flex; align-items: center; justify-content: center; overflow: hidden; box-shadow: 0 4px 12px rgba(0,0,0,0.05);">${avatarContent}</div>`;
    }
    html += '<div>';
    if (cfg.headerTitle) html += `<div style="font-weight: 700; font-size: 18px; letter-spacing: -0.02em;">${escapeHtml(cfg.headerTitle)}</div>`;
    if (cfg.headerSubtitle) html += `<div style="font-size: 13px; opacity: 0.6; margin-top: 2px;">${escapeHtml(cfg.headerSubtitle)}</div>`;
    if (cfg.showOnlineStatus) html += `<div style="display: flex; align-items: center; gap: 6px; font-size: 12px; opacity: 0.8; margin-top: 4px;"><span style="width: 8px; height: 8px; background: ${cfg.onlineStatusColor || '#10b981'}; border-radius: 50%; display: inline-block; border: 1.5px solid #fff;"></span> Online</div>`;
    html += '</div></div>';
    html += `<button id="ai-chat-close" style="background: ${cfg.headerCloseIconBackgroundColor || 'transparent'}; border: none; color: ${closeIconColor}; font-size: 20px; cursor: pointer; padding: 0; width: 40px; height: 40px; border-radius: 50%; display: flex; align-items: center; justify-content: center; transition: all 0.2s;">${closeBtnHtml}</button>`;
    html += '</div>';

    // Messages area
    html += `<div id="ai-chat-messages" style="flex: 1; overflow-y: auto; padding: 24px; display: flex; flex-direction: column; gap: 24px; background: ${chatBg};"></div>`;

    // Input area
    html += `<div style="padding: 20px 24px; border-top: 1px solid ${cfg.inputAreaBorderColor || 'transparent'}; background: ${inputAreaBg};">`;
    html += `<div id="ai-chat-typing" style="display: none; color: ${typingColor}; font-size: 12px; margin-bottom: 12px; padding-left: 4px; font-weight: 500;">AI is typing...</div>`;
    html += `<div style="display: flex; gap: 12px; align-items: center; background: ${inputBg}; border-radius: 32px; padding: 6px 6px 6px 20px; border: 1px solid ${inputBorder}; transition: all 0.2s; box-shadow: 0 2px 6px rgba(0,0,0,0.02);">`;
    html += `<input id="ai-chat-input" type="text" placeholder="${escapeHtml(cfg.placeholder || 'Type here...')}" style="flex: 1; border: none; font-size: 15px; outline: none; background: transparent; color: ${inputText}; padding: 10px 0;" />`;
    html += `<button id="ai-chat-send" style="background: ${sendBtnBg}; color: ${sendBtnColor}; border: none; padding: 0; width: 42px; height: 42px; border-radius: 50%; font-weight: 600; cursor: pointer; display: flex; align-items: center; justify-content: center; flex-shrink: 0; transition: all 0.2s;">${sendBtnHtml}</button>`;
    html += '</div></div>';

    // Branding
    if (cfg.showBranding) {
        html += `<div style="padding: 8px; text-align: center; font-size: 11px; color: #d1d5db; background: ${chatBg};"><a href="${escapeHtml(cfg.brandingUrl || 'https://bonsaimedia.nl')}" target="_blank" style="color: inherit; text-decoration: none;">${escapeHtml(cfg.brandingText || 'Powered by Bonsai')}</a></div>`;
    }

    return html;
}

function renderChatWindow(cfg: WidgetConfig): string {
    const useAdvanced = cfg.chatMode === 'advanced' &&
        cfg.chatStructure &&
        Array.isArray(cfg.chatStructure) &&
        cfg.chatStructure.length > 0;

    let chatInner = '';
    if (useAdvanced) {
        for (const block of cfg.chatStructure) {
            chatInner += renderChatBlock(block, cfg, 0);
        }
    } else {
        chatInner = renderSimpleChatWindow(cfg);
    }

    // Chat window container styles
    const chatWidth = cfg.chatWidth || 380;
    let chatHeightStr = `${cfg.chatHeight || 650}px`;
    let maxHeightStr = `calc(100dvh - ${40 + (cfg.offsetY || 0)}px)`;
    let chatRadiusStr = `${cfg.chatBorderRadius !== undefined ? cfg.chatBorderRadius : 24}px`;

    if (cfg.layoutMode === 'full-height') {
        chatHeightStr = '100dvh';
        maxHeightStr = '100dvh';
        chatRadiusStr = '0px';
    }

    const fontFamilyStr = cfg.fontFamily ? `'${cfg.fontFamily}', sans-serif` : "'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif";

    const chatWindowStyle = [
        `width: ${chatWidth}px`,
        `height: ${chatHeightStr}`,
        `max-height: ${maxHeightStr}`,
        `max-width: calc(100vw - 40px)`,
        `border-radius: ${chatRadiusStr}`,
        'overflow: hidden',
        'display: none',
        'flex-direction: column',
        'box-shadow: 0 20px 60px rgba(0,0,0,0.15), 0 8px 20px rgba(0,0,0,0.1)',
        `font-family: ${fontFamilyStr}`,
        `background: ${cfg.chatBackgroundColor || '#ffffff'}`,
        `z-index: ${cfg.zIndex || 999999}`,
    ].join('; ');

    return `<div id="ai-chat-window" style="${chatWindowStyle}">${chatInner}</div>`;
}

// ─── STYLES ──────────────────────────────────────────────────────────

function renderStyles(cfg: WidgetConfig): string {
    let css = '';

    // Base animations
    css += `
    @keyframes slideIn {
      from { opacity: 0; transform: translateY(10px); }
      to { opacity: 1; transform: translateY(0); }
    }
    @keyframes fadeIn {
      from { opacity: 0; }
      to { opacity: 1; }
    }
    @keyframes scaleIn {
      from { opacity: 0; transform: scale(0.8); }
      to { opacity: 1; transform: scale(1); }
    }
    [class^="ri-"], [class*=" ri-"] {
      font-weight: 100 !important;
    }
    #ai-chat-messages::-webkit-scrollbar { width: 6px; }
    #ai-chat-messages::-webkit-scrollbar-track { background: transparent; }
    #ai-chat-messages::-webkit-scrollbar-thumb { background-color: rgba(0,0,0,0.1); border-radius: 3px; }
    #ai-chat-messages::-webkit-scrollbar-thumb:hover { background-color: rgba(0,0,0,0.2); }
  `;

    // Bubble hover
    const hoverScale = cfg.bubbleHoverScale || 1.05;
    let hoverTransform = `scale(${hoverScale})`;
    if (cfg.hoverAnimation === 'lift') hoverTransform += ' translateY(-4px)';
    if (cfg.hoverAnimation === 'rotate') hoverTransform += ' rotate(10deg)';

    css += `
    #ai-chat-bubble:hover {
      ${cfg.bubbleHoverBackgroundColor ? `background: ${cfg.bubbleHoverBackgroundColor} !important;` : ''}
      transform: ${hoverTransform} !important;
      box-shadow: 0 12px 24px rgba(0,0,0,0.2) !important;
    }
  `;

    if (cfg.bubbleHoverTextColor) css += `#ai-chat-bubble:hover .ai-bubble-text { color: ${cfg.bubbleHoverTextColor} !important; }`;
    if (cfg.bubbleHoverIconColor) css += `#ai-chat-bubble:hover .ai-bubble-icon { color: ${cfg.bubbleHoverIconColor} !important; }`;

    // Close button hover
    css += `
    #ai-chat-close:hover {
      background: ${cfg.headerCloseIconHoverBackgroundColor || 'rgba(0,0,0,0.05)'} !important;
      transform: scale(1.1);
    }
  `;

    // Send button hover
    css += `
    #ai-chat-send:hover {
      background: ${cfg.sendButtonHoverBackgroundColor || 'rgba(0,0,0,0.05)'} !important;
      transform: scale(1.1) rotate(-10deg);
    }
  `;

    // Placeholder color
    if (cfg.inputPlaceholderColor) {
        css += `#ai-chat-input::placeholder { color: ${cfg.inputPlaceholderColor}; }`;
    }

    // Mobile hidden
    css += `@media (max-width: 768px) { .launcher-mobile-hidden, .chat-mobile-hidden { display: none !important; } }`;

    // Custom CSS from user
    if (cfg.customCss) {
        css += '\n' + cfg.customCss;
    }

    return `<style id="ai-chat-styles">${css}</style>`;
}

// ─── MAIN EXPORT ─────────────────────────────────────────────────────

/**
 * Render the complete widget HTML from a config object.
 * Returns a self-contained HTML fragment ready for DOM injection.
 */
export function renderWidgetHTML(cfg: WidgetConfig): string {
    // Position
    const offsetX = cfg.offsetX || 0;
    const offsetY = cfg.offsetY || 0;
    const positions: Record<string, string> = {
        'bottom-right': `bottom: ${20 - offsetY}px; right: ${20 - offsetX}px;`,
        'bottom-left': `bottom: ${20 - offsetY}px; left: ${20 + offsetX}px;`,
        'bottom-center': `bottom: ${20 - offsetY}px; left: 50%; transform: translateX(calc(-50% + ${offsetX}px));`,
        'top-right': `top: ${20 + offsetY}px; right: ${20 - offsetX}px;`,
        'top-left': `top: ${20 + offsetY}px; left: ${20 + offsetX}px;`,
        'top-center': `top: ${20 + offsetY}px; left: 50%; transform: translateX(calc(-50% + ${offsetX}px));`,
        'middle-left': `top: 50%; left: ${20 + offsetX}px; transform: translateY(calc(-50% + ${offsetY}px));`,
        'middle-center': `top: 50%; left: 50%; transform: translate(calc(-50% + ${offsetX}px), calc(-50% + ${offsetY}px));`,
        'middle-right': `top: 50%; right: ${20 - offsetX}px; transform: translateY(calc(-50% + ${offsetY}px));`,
    };

    let positionStyle = positions[cfg.position] || positions['bottom-right'];

    // Auto adjust wrapper if Chat is full-height
    if (cfg.layoutMode === 'full-height') {
        if (cfg.position.includes('right')) positionStyle = `bottom: 0; right: ${offsetX}px;`;
        else if (cfg.position.includes('left')) positionStyle = `bottom: 0; left: ${offsetX}px;`;
        else positionStyle = `bottom: 0; right: ${offsetX}px;`;
    }

    const containerStyle = `position: fixed; z-index: ${cfg.zIndex || 999999}; ${positionStyle}`;

    // Data attributes for runtime behavior (read by widget loader script)
    const dataAttrs = [
        `data-user-msg-color="${escapeHtml(cfg.userMessageColor || '#000000')}"`,
        `data-user-msg-text-color="${escapeHtml(cfg.userMessageTextColor || '#ffffff')}"`,
        `data-bot-msg-color="${escapeHtml(cfg.botMessageColor || '#f3f4f6')}"`,
        `data-bot-msg-text-color="${escapeHtml(cfg.botMessageTextColor || '#111827')}"`,
        `data-msg-radius="${cfg.messageBorderRadius || 18}"`,
        `data-primary-color="${escapeHtml(cfg.primaryColor || '#000000')}"`,
        cfg.greeting ? `data-greeting="${escapeHtml(cfg.greeting)}"` : '',
        cfg.suggestedQuestions && cfg.suggestedQuestions.length > 0
            ? `data-suggested="${escapeHtml(JSON.stringify(cfg.suggestedQuestions))}"` : '',
        cfg.autoOpen ? 'data-auto-open="true"' : '',
        cfg.autoOpenDelay ? `data-auto-open-delay="${cfg.autoOpenDelay}"` : '',
    ].filter(Boolean).join(' ');

    let html = '';
    html += `<link href="https://cdn.jsdelivr.net/npm/remixicon@3.5.0/fonts/remixicon.css" rel="stylesheet">`;
    if (cfg.fontFamily) {
        const familyStr = cfg.fontFamily.replace(/ /g, '+');
        html += `<link href="https://fonts.googleapis.com/css2?family=${familyStr}:wght@400;500;600;700&display=swap" rel="stylesheet">`;
    } else {
        html += `<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">`;
    }

    html += renderStyles(cfg);
    html += `<div id="ai-chat-widget-container" style="${containerStyle}" ${dataAttrs}>`;
    html += renderLauncher(cfg);
    html += renderChatWindow(cfg);
    html += '</div>';

    return html;
}
