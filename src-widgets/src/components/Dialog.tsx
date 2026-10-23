/*
 * Modal dialog over the whole VIS page (portal into document.body, so no widget frame clips it).
 * Closes with the X, a click on the backdrop and Escape. Below 500 px it becomes a full-screen sheet.
 */
import React from 'react';
import { createPortal } from 'react-dom';

import { colors, fonts } from '../theme';

export interface DialogProps {
    title: string;
    /** Sync line under the title */
    sync: string;
    syncColor: string;
    closeLabel: string;
    onClose: () => void;
    children: React.ReactNode;
}

export class Dialog extends React.Component<DialogProps, { narrow: boolean }> {
    private closeButton = React.createRef<HTMLButtonElement>();

    constructor(props: DialogProps) {
        super(props);
        this.state = { narrow: Dialog.isNarrow() };
    }

    private static isNarrow(): boolean {
        return typeof window !== 'undefined' && window.innerWidth < 500;
    }

    componentDidMount(): void {
        document.addEventListener('keydown', this.onKeyDown);
        window.addEventListener('resize', this.onResize);
        this.closeButton.current?.focus();
    }

    componentWillUnmount(): void {
        document.removeEventListener('keydown', this.onKeyDown);
        window.removeEventListener('resize', this.onResize);
    }

    private onKeyDown = (e: KeyboardEvent): void => {
        if (e.key === 'Escape') {
            e.stopPropagation();
            this.props.onClose();
        }
    };

    private onResize = (): void => {
        const narrow = Dialog.isNarrow();
        if (narrow !== this.state.narrow) {
            this.setState({ narrow });
        }
    };

    render(): React.ReactNode {
        const { narrow } = this.state;
        return createPortal(
            <div
                style={{
                    position: 'fixed',
                    inset: 0,
                    zIndex: 10000,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    fontFamily: fonts.text,
                    color: colors.text,
                }}
                // the widget must not see these clicks (VIS-2 would act on its own mouse handlers)
                onMouseDown={e => e.stopPropagation()}
                onClick={e => e.stopPropagation()}
            >
                <button
                    type="button"
                    aria-label={this.props.closeLabel}
                    tabIndex={-1}
                    onClick={this.props.onClose}
                    style={{
                        position: 'absolute',
                        inset: 0,
                        border: 'none',
                        background: 'rgba(5, 10, 7, 0.72)',
                        cursor: 'pointer',
                    }}
                />
                <div
                    role="dialog"
                    aria-modal="true"
                    aria-label={this.props.title}
                    style={{
                        position: 'relative',
                        boxSizing: 'border-box',
                        width: narrow ? '100%' : 'min(660px, calc(100vw - 32px))',
                        height: narrow ? '100%' : undefined,
                        maxHeight: narrow ? '100%' : 'calc(100vh - 32px)',
                        display: 'flex',
                        flexDirection: 'column',
                        background: colors.dialog,
                        border: narrow ? 'none' : `1px solid ${colors.border}`,
                        borderRadius: narrow ? 0 : 22,
                        overflow: 'hidden',
                    }}
                >
                    <div
                        style={{
                            display: 'flex',
                            justifyContent: 'space-between',
                            alignItems: 'center',
                            gap: 12,
                            padding: narrow ? '18px 16px 12px' : '28px 28px 0',
                        }}
                    >
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, minWidth: 0 }}>
                            <h2
                                style={{
                                    margin: 0,
                                    fontFamily: fonts.numbers,
                                    fontSize: 32,
                                    fontWeight: 600,
                                    lineHeight: 1.1,
                                }}
                            >
                                {this.props.title}
                            </h2>
                            <span
                                aria-live="polite"
                                style={{ fontSize: 13, color: this.props.syncColor }}
                            >
                                {this.props.sync}
                            </span>
                        </div>
                        <button
                            ref={this.closeButton}
                            type="button"
                            aria-label={this.props.closeLabel}
                            onClick={this.props.onClose}
                            style={{
                                flex: 'none',
                                width: 48,
                                height: 48,
                                borderRadius: 24,
                                border: `1px solid ${colors.border}`,
                                background: colors.control,
                                color: colors.text,
                                cursor: 'pointer',
                                display: 'flex',
                                alignItems: 'center',
                                justifyContent: 'center',
                            }}
                        >
                            <svg
                                width="18"
                                height="18"
                                viewBox="0 0 24 24"
                                fill="none"
                                stroke="currentColor"
                                strokeWidth="2"
                                strokeLinecap="round"
                                aria-hidden="true"
                            >
                                <line
                                    x1="5"
                                    y1="5"
                                    x2="19"
                                    y2="19"
                                />
                                <line
                                    x1="19"
                                    y1="5"
                                    x2="5"
                                    y2="19"
                                />
                            </svg>
                        </button>
                    </div>
                    <div
                        style={{
                            overflowY: 'auto',
                            padding: narrow ? '8px 16px 20px' : '22px 28px 28px',
                            display: 'flex',
                            flexDirection: 'column',
                            gap: 22,
                        }}
                    >
                        {this.props.children}
                    </div>
                </div>
            </div>,
            document.body,
        );
    }
}
