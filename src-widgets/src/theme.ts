/*
 * Jäger design tokens (docs/vis2-widget.md, 5.5) and the bundled Barlow fonts.
 */
import barlow400 from './fonts/barlow-latin-400-normal.woff2';
import barlow500 from './fonts/barlow-latin-500-normal.woff2';
import barlow600 from './fonts/barlow-latin-600-normal.woff2';
import condensed500 from './fonts/barlow-condensed-latin-500-normal.woff2';
import condensed600 from './fonts/barlow-condensed-latin-600-normal.woff2';

export const colors = {
    surface: '#16241c',
    dialog: '#142019',
    section: '#1a2a21',
    control: '#1b2b22',
    controlStrong: '#213529',
    border: '#2f4a39',
    borderFine: '#24382b',
    chip: '#1f3328',
    chipText: '#cfe2d6',
    chipCold: '#9fd0de',
    chipAccent: '#3a2f17',
    chipAccentText: '#f2c46f',
    text: '#ece7da',
    muted: '#a3b0a5',
    accent: '#e0a43a',
    accentBg: 'rgba(224, 164, 58, 0.14)',
    cold: '#8cc3d4',
    ok: '#6fbf87',
    okText: '#8fc79f',
    alarm: '#e5675a',
} as const;

// Own family names, so a "Barlow" of the VIS project (or a missing one) never changes the widget
export const fonts = {
    text: "'LiebherrHome Barlow', Barlow, system-ui, sans-serif",
    numbers: "'LiebherrHome Barlow Condensed', 'Barlow Condensed', system-ui, sans-serif",
} as const;

const FONT_STYLE_ID = 'liebherr-home-fonts';

/** Registers the bundled fonts once per page (no request to Google) */
export function ensureFonts(): void {
    if (typeof document === 'undefined' || document.getElementById(FONT_STYLE_ID)) {
        return;
    }
    const face = (family: string, weight: number, url: string): string =>
        `@font-face{font-family:'${family}';font-style:normal;font-weight:${weight};font-display:swap;src:url(${url}) format('woff2');}`;
    const style = document.createElement('style');
    style.id = FONT_STYLE_ID;
    style.textContent = [
        face('LiebherrHome Barlow', 400, barlow400),
        face('LiebherrHome Barlow', 500, barlow500),
        face('LiebherrHome Barlow', 600, barlow600),
        face('LiebherrHome Barlow Condensed', 500, condensed500),
        face('LiebherrHome Barlow Condensed', 600, condensed600),
    ].join('\n');
    document.head.appendChild(style);
}
