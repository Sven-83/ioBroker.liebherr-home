/*
 * Tile of the widget (docs/vis2-widget.md 5.1): icon, name, status dot, temperature, setpoint, chips.
 */
import React from 'react';

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

export function Tile(props: TileProps): React.JSX.Element {
    const clickable = !!props.onClick;
    // a div in the editor: a disabled button would swallow the clicks VIS-2 needs to select the widget
    const Root = clickable ? 'button' : 'div';
    return (
        <Root
            {...(clickable ? { type: 'button' as const, onClick: props.onClick, 'aria-label': props.title } : {})}
            style={{
                all: 'unset',
                width: '100%',
                height: '100%',
                boxSizing: 'border-box',
                borderRadius: 18,
                background: colors.surface,
                border: `1px solid ${colors.border}`,
                padding: 20,
                display: 'flex',
                flexDirection: 'column',
                justifyContent: 'space-between',
                gap: 8,
                color: colors.text,
                fontFamily: fonts.text,
                cursor: clickable ? 'pointer' : 'default',
                overflow: 'hidden',
            }}
        >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
                    {props.icon === 'freezer' ? <FreezerIcon /> : <FridgeIcon />}
                    <span
                        style={{
                            fontSize: 16,
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
                            width: 10,
                            height: 10,
                            borderRadius: 5,
                            background: DOT_COLORS[props.dot],
                        }}
                    />
                ) : null}
            </div>

            {props.hint ? (
                <div style={{ fontSize: 13, color: colors.muted }}>{props.hint}</div>
            ) : (
                <div style={{ display: 'flex', alignItems: 'baseline', gap: 10 }}>
                    <span style={{ fontFamily: fonts.numbers, fontSize: 56, fontWeight: 600, lineHeight: 1 }}>
                        {props.current}
                    </span>
                    {props.setpoint ? (
                        <span style={{ fontSize: 14, color: colors.muted }}>{props.setpoint}</span>
                    ) : null}
                </div>
            )}

            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, minHeight: 24 }}>
                {props.chips.map(chip => (
                    <span
                        key={`${chip.name}-${chip.value ?? ''}`}
                        style={{
                            fontSize: 12,
                            padding: '4px 8px',
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
