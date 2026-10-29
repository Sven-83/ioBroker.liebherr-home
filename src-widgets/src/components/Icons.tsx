import React from 'react';

import { colors } from '../theme';

/** Fridge outline (same drawing as the design canvas) */
export function FridgeIcon({ size = 22, color = colors.cold }: { size?: number; color?: string }): React.JSX.Element {
    return (
        <svg
            width={size}
            height={size}
            viewBox="0 0 24 24"
            fill="none"
            stroke={color}
            strokeWidth={1.7}
            strokeLinecap="round"
            aria-hidden="true"
        >
            <rect
                x="5"
                y="2.5"
                width="14"
                height="19"
                rx="2.5"
            />
            <line
                x1="5"
                y1="10"
                x2="19"
                y2="10"
            />
            <line
                x1="8.5"
                y1="5.5"
                x2="8.5"
                y2="7.5"
            />
            <line
                x1="8.5"
                y1="13"
                x2="8.5"
                y2="16"
            />
        </svg>
    );
}

/** Snowflake (freezer) */
export function FreezerIcon({ size = 22, color = colors.cold }: { size?: number; color?: string }): React.JSX.Element {
    return (
        <svg
            width={size}
            height={size}
            viewBox="0 0 24 24"
            fill="none"
            stroke={color}
            strokeWidth={1.7}
            strokeLinecap="round"
            aria-hidden="true"
        >
            <line
                x1="12"
                y1="2.5"
                x2="12"
                y2="21.5"
            />
            <line
                x1="3.8"
                y1="7.25"
                x2="20.2"
                y2="16.75"
            />
            <line
                x1="3.8"
                y1="16.75"
                x2="20.2"
                y2="7.25"
            />
            <polyline points="9.5,4 12,6.5 14.5,4" />
            <polyline points="9.5,20 12,17.5 14.5,20" />
        </svg>
    );
}
