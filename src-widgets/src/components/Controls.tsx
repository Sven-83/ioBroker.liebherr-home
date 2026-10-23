/*
 * Controls of the dialog (docs/vis2-widget.md 5.2/5.3): only buttons, no sliders.
 * Touch targets are at least 44 px.
 */
import React from 'react';

import { colors, fonts } from '../theme';

const sectionLabel: React.CSSProperties = {
    fontSize: 13,
    letterSpacing: '0.1em',
    textTransform: 'uppercase',
    color: colors.muted,
};

function choiceStyle(on: boolean, extra: React.CSSProperties = {}): React.CSSProperties {
    return {
        boxSizing: 'border-box',
        borderRadius: 12,
        cursor: 'pointer',
        font: 'inherit',
        textAlign: 'left',
        background: on ? colors.accentBg : colors.control,
        border: `1px solid ${on ? colors.accent : colors.border}`,
        color: on ? '#f6e7c8' : colors.text,
        ...extra,
    };
}

export function SectionLabel({ children }: { children: React.ReactNode }): React.JSX.Element {
    return <span style={sectionLabel}>{children}</span>;
}

export interface StepperProps {
    /** Shown value, e.g. "3 °C" */
    text: string;
    /** "Soll · 3 bis 9" */
    caption: string;
    canDown: boolean;
    canUp: boolean;
    onDown: () => void;
    onUp: () => void;
    labelDown: string;
    labelUp: string;
    pending: boolean;
}

export function Stepper(props: StepperProps): React.JSX.Element {
    const button = (label: string, sign: string, enabled: boolean, onClick: () => void): React.JSX.Element => (
        <button
            type="button"
            aria-label={label}
            disabled={!enabled}
            onClick={onClick}
            style={{
                width: 56,
                height: 56,
                borderRadius: 14,
                border: `1px solid ${colors.border}`,
                background: colors.controlStrong,
                color: colors.text,
                fontSize: 28,
                lineHeight: 1,
                cursor: enabled ? 'pointer' : 'default',
                opacity: enabled ? 1 : 0.35,
                font: 'inherit',
            }}
        >
            <span style={{ fontSize: 28 }}>{sign}</span>
        </button>
    );
    return (
        <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
            {button(props.labelDown, '−', props.canDown, props.onDown)}
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', minWidth: 84 }}>
                <span
                    aria-live="polite"
                    style={{
                        fontFamily: fonts.numbers,
                        fontSize: 34,
                        fontWeight: 600,
                        color: colors.accent,
                        opacity: props.pending ? 0.7 : 1,
                    }}
                >
                    {props.text}
                </span>
                <span style={{ fontSize: 12, color: colors.muted }}>{props.caption}</span>
            </div>
            {button(props.labelUp, '+', props.canUp, props.onUp)}
        </div>
    );
}

export interface SegmentsProps {
    label: string;
    options: { value: string; text: string }[];
    value: unknown;
    onPick: (value: string) => void;
}

export function Segments(props: SegmentsProps): React.JSX.Element {
    return (
        <div
            role="group"
            aria-label={props.label}
            style={{
                display: 'grid',
                gridTemplateColumns: `repeat(${Math.min(props.options.length, 4)}, minmax(0, 1fr))`,
                gap: 8,
            }}
        >
            {props.options.map(o => {
                const on = props.value === o.value;
                return (
                    <button
                        key={o.value}
                        type="button"
                        aria-pressed={on}
                        onClick={() => !on && props.onPick(o.value)}
                        style={choiceStyle(on, {
                            minHeight: 48,
                            padding: '8px 10px',
                            fontSize: 15,
                            fontWeight: 600,
                            textAlign: 'center',
                        })}
                    >
                        {o.text}
                    </button>
                );
            })}
        </div>
    );
}

export interface ToggleTileProps {
    label: string;
    state: string;
    on: boolean;
    onToggle: () => void;
}

export function ToggleTile(props: ToggleTileProps): React.JSX.Element {
    return (
        <button
            type="button"
            aria-pressed={props.on}
            onClick={props.onToggle}
            style={choiceStyle(props.on, { minHeight: 60, padding: '10px 12px' })}
        >
            <span style={{ display: 'block', fontSize: 15, fontWeight: 600 }}>{props.label}</span>
            <span style={{ display: 'block', fontSize: 12, opacity: 0.85 }}>{props.state}</span>
        </button>
    );
}
