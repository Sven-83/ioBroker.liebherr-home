/*
 * Compact tile "Gerät breit" (about 240 x 88) for dashboards with 88 px tiles: icon left, name and one chip,
 * current temperature large and setpoint small on the right, status LED top right.
 * Colours come from the CSS variables of the project (--st-on-bg ...) with the dark defaults of the
 * tablet design, so the tile matches the other 88 px tiles of the page.
 */
import React, { useLayoutEffect, useRef, useState } from 'react';

import type { Chip, DotState } from '../model';
import { fonts } from '../theme';
import { FreezerIcon, FridgeIcon } from './Icons';

export interface TileCompactProps {
    title: string;
    icon: 'fridge' | 'freezer';
    dot?: DotState;
    dotTitle: string;
    current: string;
    setpoint: string;
    chips: (Chip & { text: string })[];
    /** text under the name without a chip, e.g. "online" */
    statusText: string;
    hint?: string;
    onClick?: () => void;
}

const BASE_WIDTH = 240;
const BASE_HEIGHT = 88;

const css = (name: string, fallback: string): string => `var(--${name}, ${fallback})`;

const ONLINE = {
    bg: css('st-on-bg', '#183323'),
    border: css('st-on-bd', '#3f8f57'),
    accent: css('st-on-fg', '#9fe0b2'),
    led: css('st-led', '#6fe08a'),
};
const LED: Record<DotState, string> = {
    ok: ONLINE.led,
    pending: css('sw-on', '#f2c14e'),
    polling: css('sw-on', '#f2c14e'),
    unreachable: css('warn-bd', '#e5484d'),
};

function useScale(ref: React.RefObject<HTMLElement | null>): number {
    const [scale, setScale] = useState(1);
    useLayoutEffect(() => {
        const el = ref.current;
        if (!el || typeof ResizeObserver === 'undefined') {
            return;
        }
        const update = (): void => {
            const width = el.offsetWidth;
            const height = el.offsetHeight;
            if (width > 0 && height > 0) {
                // the height decides; extra width only gives the name more room
                const next = Math.min(height / BASE_HEIGHT, (width / BASE_WIDTH) * 1.25);
                setScale(Math.round(Math.min(Math.max(next, 0.5), 2) * 100) / 100);
            }
        };
        update();
        const observer = new ResizeObserver(update);
        observer.observe(el);
        return () => observer.disconnect();
    }, [ref]);
    return scale;
}

export function TileCompact(props: TileCompactProps): React.JSX.Element {
    const clickable = !!props.onClick;
    const ref = useRef<HTMLElement>(null);
    const scale = useScale(ref);
    const px = (n: number): number => Math.round(n * scale * 10) / 10;
    const offline = props.dot === 'unreachable';
    const chip = props.chips[0];
    const Root = clickable ? 'button' : 'div';
    return (
        <Root
            ref={ref as React.RefObject<HTMLButtonElement & HTMLDivElement>}
            {...(clickable ? { type: 'button' as const, onClick: props.onClick, 'aria-label': props.title } : {})}
            style={{
                all: 'unset',
                position: 'relative',
                width: '100%',
                height: '100%',
                boxSizing: 'border-box',
                borderRadius: px(14),
                background: offline ? 'transparent' : ONLINE.bg,
                border: offline ? `1.5px dashed ${css('st-off-bd', '#4f4f56')}` : `1.5px solid ${ONLINE.border}`,
                padding: `0 ${px(14)}px`,
                display: 'flex',
                alignItems: 'center',
                gap: px(12),
                color: css('text', '#ece9e1'),
                fontFamily: fonts.text,
                cursor: clickable ? 'pointer' : 'default',
                overflow: 'hidden',
            }}
        >
            {props.icon === 'freezer' ? (
                <FreezerIcon
                    size={px(30)}
                    color={offline ? css('text-2', '#a3a19a') : ONLINE.accent}
                />
            ) : (
                <FridgeIcon
                    size={px(30)}
                    color={offline ? css('text-2', '#a3a19a') : ONLINE.accent}
                />
            )}
            <span style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: px(5) }}>
                <span
                    style={{
                        fontSize: px(13),
                        fontWeight: 600,
                        color: offline ? css('text-2', '#a3a19a') : ONLINE.accent,
                        whiteSpace: 'nowrap',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                    }}
                >
                    {props.title}
                </span>
                {props.hint ? (
                    <span style={{ fontSize: px(11), color: css('text-2', '#a3a19a') }}>{props.hint}</span>
                ) : chip ? (
                    <span
                        style={{
                            alignSelf: 'flex-start',
                            maxWidth: '100%',
                            background: '#24412e',
                            color: '#b6dcc1',
                            fontSize: px(11),
                            padding: `${px(3)}px ${px(8)}px`,
                            borderRadius: 999,
                            whiteSpace: 'nowrap',
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                            boxSizing: 'border-box',
                        }}
                    >
                        {chip.text}
                    </span>
                ) : (
                    <span style={{ fontSize: px(11), color: offline ? css('text-2', '#a3a19a') : '#b5c9bb' }}>
                        {props.statusText}
                    </span>
                )}
            </span>
            {props.hint ? null : (
                <span style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end' }}>
                    <span style={{ fontFamily: fonts.numbers, fontSize: px(38), fontWeight: 600, lineHeight: 1 }}>
                        {props.current}
                    </span>
                    {props.setpoint ? (
                        <span style={{ fontSize: px(12), color: offline ? css('text-2', '#a3a19a') : '#b5c9bb' }}>
                            {props.setpoint}
                        </span>
                    ) : null}
                </span>
            )}
            {props.dot ? (
                <span
                    title={props.dotTitle}
                    aria-label={props.dotTitle}
                    role="img"
                    style={{
                        position: 'absolute',
                        right: px(9),
                        top: px(9),
                        width: px(8),
                        height: px(8),
                        borderRadius: '50%',
                        background: LED[props.dot],
                        boxShadow: props.dot === 'ok' ? `0 0 6px ${ONLINE.led}` : undefined,
                    }}
                />
            ) : null}
        </Root>
    );
}
