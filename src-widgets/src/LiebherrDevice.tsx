/*
 * VIS-2 widget "Liebherr appliance": tile + dialog for one device folder of liebherr-home.
 * Concept: docs/vis2-widget.md. Phase 8.1: skeleton, the tile only shows the configured device.
 */
import React from 'react';

import type { RxRenderWidgetProps, RxWidgetInfo, VisRxWidgetProps } from '@iobroker/types-vis-2';
import type VisRxWidget from '@iobroker/types-vis-2/visRxWidget';

interface LiebherrDeviceRxData {
    /** Object ID of the device folder, e.g. liebherr-home.0.fridge_db4c8f36 */
    device: string;
    /** Display name; empty = info.name of the device */
    title: string;
}

export default class LiebherrDevice extends (window.visRxWidget as typeof VisRxWidget)<LiebherrDeviceRxData> {
    /** Set by VIS-2 when loading the set (adapter name) */
    static adapter: string;

    constructor(props: VisRxWidgetProps) {
        super(props);
    }

    static getWidgetInfo(): RxWidgetInfo {
        return {
            id: 'tplLiebherrHomeDevice',
            visSet: 'liebherr-home',
            visSetLabel: 'set_label',
            visSetIcon: 'widgets/liebherr-home/img/liebherr-home.png',
            visSetColor: '#e0a43a',
            visName: 'LiebherrDevice',
            visWidgetLabel: 'widget_label',
            visAttrs: [
                {
                    name: 'common',
                    label: 'group_common',
                    fields: [
                        { name: 'device', type: 'id', label: 'device' },
                        { name: 'title', type: 'text', label: 'title' },
                    ],
                },
            ],
            visDefaultStyle: { width: 280, height: 220 },
            visPrev: 'widgets/liebherr-home/img/liebherr-home.png',
        };
    }

    // Do not delete: VIS-2 reads the widget configuration through the instance
    getWidgetInfo(): RxWidgetInfo {
        return LiebherrDevice.getWidgetInfo();
    }

    static getI18nPrefix(): string {
        return `${LiebherrDevice.adapter}_`;
    }

    renderWidgetBody(props: RxRenderWidgetProps): React.JSX.Element {
        super.renderWidgetBody(props);
        const { device, title } = this.state.rxData;

        return (
            <div
                style={{
                    width: '100%',
                    height: '100%',
                    boxSizing: 'border-box',
                    borderRadius: 18,
                    background: '#16241c',
                    border: '1px solid #2f4a39',
                    color: '#ece7da',
                    padding: 20,
                    fontFamily: 'system-ui, sans-serif',
                }}
            >
                <div style={{ fontSize: 16, fontWeight: 600 }}>{title || LiebherrDevice.t('widget_label')}</div>
                <div style={{ fontSize: 13, color: '#a3b0a5', marginTop: 8 }}>
                    {device || LiebherrDevice.t('no_device')}
                </div>
            </div>
        );
    }
}
