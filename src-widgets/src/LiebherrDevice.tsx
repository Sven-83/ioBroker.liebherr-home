/*
 * VIS-2 widget "Liebherr appliance": tile + dialog for one device folder of liebherr-home.
 * Concept: docs/vis2-widget.md. Phase 8.2: tile with live values (dialog follows in 8.3).
 */
import React from 'react';

import type { RxRenderWidgetProps, RxWidgetInfo, VisRxWidgetProps, VisRxWidgetState } from '@iobroker/types-vis-2';
import type VisRxWidget from '@iobroker/types-vis-2/visRxWidget';

import { Tile } from './components/Tile';
import {
    activeChips,
    buildLayout,
    dotState,
    formatDegrees,
    iconKind,
    subscribedIds,
    type Chip,
    type ChannelObjectLike,
    type DeviceLayout,
    type StateObjectLike,
    type ValueLike,
} from './model';
import { ensureFonts } from './theme';

interface LiebherrDeviceRxData {
    /** Object ID of the device folder, e.g. liebherr-home.0.fridge_db4c8f36 */
    device: string;
    /** Display name; empty = info.name of the device */
    title: string;
}

interface LiebherrDeviceState extends VisRxWidgetState {
    /** Structure of the configured device; null while loading or without device */
    layout: DeviceLayout | null;
    /** The device folder has no liebherr-home states */
    notFound: boolean;
    /** Values of the subscribed states */
    lhValues: Record<string, ValueLike | undefined>;
}

/** Accepts the device folder or any state inside it */
function deviceFolder(id: string | undefined): string {
    const m = /^(liebherr-home\.\d+\.[^.]+)/.exec((id || '').trim());
    return m ? m[1] : '';
}

export default class LiebherrDevice extends (window.visRxWidget as typeof VisRxWidget)<
    LiebherrDeviceRxData,
    LiebherrDeviceState
> {
    /** Set by VIS-2 when loading the set (adapter name) */
    static adapter: string;

    /** Device the subscriptions belong to */
    private subscribedDevice = '';
    private subscribedIds: string[] = [];
    /** Increments on every device change, so a late answer for an old device is dropped */
    private loadGeneration = 0;

    constructor(props: VisRxWidgetProps) {
        super(props);
        this.state = { ...this.state, layout: null, notFound: false, lhValues: {} };
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

    componentDidMount(): void {
        super.componentDidMount();
        ensureFonts();
        void this.loadDevice();
    }

    componentWillUnmount(): void {
        this.unsubscribe();
        super.componentWillUnmount();
    }

    onRxDataChanged(): void {
        void this.loadDevice();
    }

    private onValue = (id: string, state: ioBroker.State | null | undefined): void => {
        this.setState(prev => ({
            lhValues: { ...prev.lhValues, [id]: state ? { val: state.val, ack: state.ack, ts: state.ts } : undefined },
        }));
    };

    private unsubscribe(): void {
        if (this.subscribedIds.length) {
            this.props.context.socket.unsubscribeState(this.subscribedIds, this.onValue);
        }
        this.subscribedIds = [];
        this.subscribedDevice = '';
    }

    /** Reads the objects of the device folder, subscribes its states and loads their values */
    private async loadDevice(): Promise<void> {
        const device = deviceFolder(this.state.rxData.device);
        if (device === this.subscribedDevice) {
            return;
        }
        const generation = ++this.loadGeneration;
        this.unsubscribe();
        this.setState({ layout: null, notFound: false, lhValues: {} });
        if (!device) {
            return;
        }
        const socket = this.props.context.socket;
        try {
            const [states, channels] = await Promise.all([
                socket.getObjectViewSystem('state', `${device}.`, `${device}.香`),
                socket.getObjectViewSystem('channel', `${device}.`, `${device}.香`),
            ]);
            if (generation !== this.loadGeneration) {
                return;
            }
            const layout = buildLayout(
                device,
                Object.values(states) as unknown as StateObjectLike[],
                Object.values(channels) as unknown as ChannelObjectLike[],
            );
            if (!layout.zones.length && !layout.switches.length) {
                this.setState({ notFound: true });
                return;
            }
            const ids = subscribedIds(layout);
            this.subscribedDevice = device;
            this.subscribedIds = ids;
            this.setState({ layout });
            await socket.subscribeState(ids, this.onValue);
            const values = await socket.getStates(ids);
            if (generation !== this.loadGeneration) {
                return;
            }
            const lhValues: Record<string, ValueLike | undefined> = {};
            for (const id of ids) {
                const s = values[id];
                lhValues[id] = s ? { val: s.val, ack: s.ack, ts: s.ts } : undefined;
            }
            this.setState({ lhValues });
        } catch (e) {
            console.warn(`liebherr-home widget: cannot load ${device}: ${String(e)}`);
            if (generation === this.loadGeneration) {
                this.setState({ notFound: true });
            }
        }
    }

    /** Translation, or the fallback if the key is unknown */
    private static label(key: string, fallback: string): string {
        const text = LiebherrDevice.t(key);
        return text && text !== key && text !== `${LiebherrDevice.getI18nPrefix()}${key}` ? text : fallback;
    }

    private static chipText(chip: Chip): string {
        const t = (k: string, f: string): string => LiebherrDevice.label(k, f);
        switch (chip.name) {
            case 'hydrobreeze':
                return `HydroBreeze ${t(`mode_${chip.value}`, chip.value || '')}`;
            case 'icemaker':
                return chip.value === 'MAX_ICE' ? 'MaxIce' : 'IceMaker';
            case 'biofreshplus':
                return 'BioFresh';
            default:
                return t(`chip_${chip.name}`, chip.label || chip.name);
        }
    }

    renderWidgetBody(props: RxRenderWidgetProps): React.JSX.Element {
        super.renderWidgetBody(props);
        const { layout, lhValues, notFound } = this.state;
        const lang = LiebherrDevice.getLanguage();
        const device = deviceFolder(this.state.rxData.device);
        const name = lhValues[layout?.nameId || '']?.val;
        const title = this.state.rxData.title || (typeof name === 'string' && name) || LiebherrDevice.t('widget_label');

        let hint: string | undefined;
        if (!device) {
            hint = LiebherrDevice.t('no_device');
        } else if (notFound) {
            hint = LiebherrDevice.t('not_found');
        } else if (!layout) {
            hint = LiebherrDevice.t('loading');
        }

        const zone = layout?.zones.find(z => z.temperatureId || z.setpoint);
        const current = formatDegrees(zone?.temperatureId ? lhValues[zone.temperatureId]?.val : undefined, lang);
        const target = zone?.setpoint ? lhValues[zone.setpoint.id]?.val : undefined;
        const dot = layout
            ? dotState(lhValues[layout.reachableId]?.val, lhValues[layout.realtimeId]?.val, false)
            : undefined;

        return (
            <Tile
                title={title}
                icon={iconKind(layout ? lhValues[layout.typeId]?.val : undefined)}
                dot={dot}
                dotTitle={dot ? LiebherrDevice.t(`dot_${dot}`) : ''}
                current={current}
                setpoint={
                    typeof target === 'number'
                        ? `${LiebherrDevice.t('setpoint_short')} ${formatDegrees(target, lang)}`
                        : ''
                }
                chips={
                    layout ? activeChips(layout, lhValues).map(c => ({ ...c, text: LiebherrDevice.chipText(c) })) : []
                }
                hint={hint}
            />
        );
    }
}
