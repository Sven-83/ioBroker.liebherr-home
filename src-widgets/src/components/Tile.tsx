/*
 * Tile of the widget (docs/vis2-widget.md 5.1): icon, name, status dot, temperature, setpoint, chips.
 */
import React, { useLayoutEffect, useRef, useState } from 'react';

import type { Chip, DotState } from '../model';
import { colors, fonts } from '../theme';
import { FreezerIcon, FridgeIcon } from './Icons';

export interface TileProps {
    title: string;
    icon: 'fridge' | 'freezer';
    /** undefined: no dot (no device yet) */
    dot?: DotState;
    dotTitle: string;
    /** Formatted current temperature, e.g. "3°" */
    current: string;
    /** "Soll 3°" or empty */
    setpoint: string;
    chips: (Chip & { text: string })[];
    /** Hint instead of values (no device chosen, loading, ...) */
    hint?: string;
    onClick?: () => void;
}

const DOT_COLORS: Record<DotState, string> = {
    ok: colors.ok,
    pending: colors.accent,
    polling: colors.accent,
    unreachable: colors.alarm,
};

/** Size the tile is designed for (visDefaultStyle); other sizes scale all measures */
const BASE_WIDTH = 280;
const BASE_HEIGHT = 220;
const MIN_SCALE = 0.4;
const MAX_SCALE = 2;

/**
 * Scale factor from the size of the element, so the tile can be made smaller or larger in VIS-2.
 *
 * @param ref - Element to measure
 */
function useScale(ref: React.RefObject<HTMLElement | null>): number {
    const [scale, setScale] = useState(1);
    useLayoutEffect(() => {
        const el = ref.current;
        if (!el || typeof ResizeObserver === 'undefined') {
            return;
        }
        const update = (): void => {
            // layout size, unaffected by the zoom of the VIS-2 editor (CSS transform)
            const width = el.offsetWidth;
            const height = el.offsetHeight;
            if (width > 0 && height > 0) {
                const next = Math.min(width / BASE_WIDTH, height / BASE_HEIGHT);
                // rounded, so sub-pixel changes do not re-render
                setScale(Math.round(Math.min(Math.max(next, MIN_SCALE), MAX_SCALE) * 100) / 100);
            }
        };
        update();
        const observer = new ResizeObserver(update);
        observer.observe(el);
        return () => observer.disconnect();
    }, [ref]);
    return scale;
}

export function Tile(props: TileProps): React.JSX.Element {
    const clickable = !!props.onClick;
    const ref = useRef<HTMLElement>(null);
    const scale = useScale(ref);
    const px = (n: number): number => Math.round(n * scale * 10) / 10;
    // a div in the editor: a disabled button would swallow the clicks VIS-2 needs to select the widget
    const Root = clickable ? 'button' : 'div';
    return (
        <Root
            ref={ref as React.RefObject<HTMLButtonElement & HTMLDivElement>}
            {...(clickable ? { type: 'button' as const, onClick: props.onClick, 'aria-label': props.title } : {})}
            style={{
                all: 'unset',
                width: '100%',
                height: '100%',
                boxSizing: 'border-box',
                borderRadius: px(18),
                background: colors.surface,
                border: `1px solid ${colors.border}`,
                padding: px(20),
                display: 'flex',
                flexDirection: 'column',
                justifyContent: 'space-between',
                gap: px(8),
                color: colors.text,
                fontFamily: fonts.text,
                cursor: clickable ? 'pointer' : 'default',
                overflow: 'hidden',
            }}
        >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: px(10) }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: px(10), minWidth: 0 }}>
                    {props.icon === 'freezer' ? <FreezerIcon size={px(22)} /> : <FridgeIcon size={px(22)} />}
                    <span
                        style={{
                            fontSize: px(16),
                            fontWeight: 600,
                            whiteSpace: 'nowrap',
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                        }}
                    >
                        {props.title}
                    </span>
                </div>
                {props.dot ? (
                    <span
                        title={props.dotTitle}
                        aria-label={props.dotTitle}
                        role="img"
                        style={{
                            flex: 'none',
                            width: px(10),
                            height: px(10),
                            borderRadius: px(5),
                            background: DOT_COLORS[props.dot],
                        }}
                    />
                ) : null}
            </div>

            {props.hint ? (
                <div style={{ fontSize: px(13), color: colors.muted }}>{props.hint}</div>
            ) : (
                <div style={{ display: 'flex', alignItems: 'baseline', gap: px(10) }}>
                    <span style={{ fontFamily: fonts.numbers, fontSize: px(56), fontWeight: 600, lineHeight: 1 }}>
                        {props.current}
                    </span>
                    {props.setpoint ? (
                        <span style={{ fontSize: px(14), color: colors.muted }}>{props.setpoint}</span>
                    ) : null}
                </div>
            )}

            <div style={{ display: 'flex', flexWrap: 'wrap', gap: px(6), minHeight: px(24) }}>
                {props.chips.map(chip => (
                    <span
                        key={`${chip.name}-${chip.value ?? ''}`}
                        style={{
                            fontSize: px(12),
                            padding: `${px(4)}px ${px(8)}px`,
                            borderRadius: 999,
                            background: chip.accent ? colors.chipAccent : colors.chip,
                            color: chip.accent
                                ? colors.chipAccentText
                                : chip.name === 'hydrobreeze'
                                  ? colors.chipCold
                                  : colors.chipText,
                        }}
                    >
                        {chip.text}
                    </span>
                ))}
            </div>
        </Root>
    );
}
