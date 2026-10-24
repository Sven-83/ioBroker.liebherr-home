/*
 * VIS-2 widget "Liebherr appliance": tile + dialog for one device folder of liebherr-home.
 * Concept: docs/vis2-widget.md.
 *
 * Commands: setValue (ack=false) right away, no confirm button. A command is pending until the
 * adapter writes ack=true for that state (readback, or the restored value after a failure).
 * Without ack after ACK_TIMEOUT_MS the widget shows "not confirmed" and the last confirmed value.
 */
import React from 'react';

import type { RxRenderWidgetProps, RxWidgetInfo, VisRxWidgetProps, VisRxWidgetState } from '@iobroker/types-vis-2';
import type VisRxWidget from '@iobroker/types-vis-2/visRxWidget';

import { SectionLabel, Segments, Stepper, ToggleTile } from './components/Controls';
import { Dialog } from './components/Dialog';
import { Tile } from './components/Tile';
import {
    SELF_ENDING,
    activeChips,
    buildLayout,
    dotState,
    formatDegrees,
    iconKind,
    stepValue,
    subscribedIds,
    type Chip,
    type DeviceLayout,
    type ModeControl,
    type ValueLike,
    type Zone,
} from './model';
import { colors, ensureFonts, fonts } from './theme';

/** Adapter: 0.5 s debounce + readback after 2 s and, if needed, 8 s (~10.5 s) plus requests */
const ACK_TIMEOUT_MS = 15_000;

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
    /** Latest values of the subscribed states (also own commands with ack=false) */
    lhValues: Record<string, ValueLike | undefined>;
    /** Last confirmed value per state */
    lhAcked: Record<string, ioBroker.StateValue | undefined>;
    /** Sent commands waiting for ack: state ID -> sent value */
    lhPending: Record<string, ioBroker.StateValue>;
    /** The last command was rejected or not confirmed in time */
    lhUnconfirmed: boolean;
    lhOpen: boolean;
    /** Re-render tick for "x s ago" while the dialog is open */
    lhTick: number;
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
    private ackTimers = new Map<string, ReturnType<typeof setTimeout>>();
    private tickTimer?: ReturnType<typeof setInterval>;

    constructor(props: VisRxWidgetProps) {
        super(props);
        this.state = {
            ...this.state,
            layout: null,
            notFound: false,
            lhValues: {},
            lhAcked: {},
            lhPending: {},
            lhUnconfirmed: false,
            lhOpen: false,
            lhTick: 0,
        };
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
    // eslint-disable-next-line class-methods-use-this
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
        this.clearAckTimers();
        this.stopTick();
        super.componentWillUnmount();
    }

    onRxDataChanged(): void {
        void this.loadDevice();
    }

    // ---------------------------------------------------------------- data

    private onValue = (id: string, state: ioBroker.State | null | undefined): void => {
        this.setState(prev => {
            const lhValues = {
                ...prev.lhValues,
                [id]: state ? { val: state.val, ack: state.ack, ts: state.ts } : undefined,
            };
            if (!state) {
                return { ...prev, lhValues };
            }
            if (!state.ack) {
                // our own command (or one from elsewhere) - only the confirmation counts
                return { ...prev, lhValues };
            }
            const lhAcked = { ...prev.lhAcked, [id]: state.val };
            if (!(id in prev.lhPending)) {
                return { ...prev, lhValues, lhAcked };
            }
            const lhPending = { ...prev.lhPending };
            const sent = lhPending[id];
            delete lhPending[id];
            this.clearAckTimer(id);
            // the adapter confirms with the value the cloud reports; a different one means rejected/restored
            return { ...prev, lhValues, lhAcked, lhPending, lhUnconfirmed: state.val !== sent };
        });
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
        this.clearAckTimers();
        this.setState({
            layout: null,
            notFound: false,
            lhValues: {},
            lhAcked: {},
            lhPending: {},
            lhUnconfirmed: false,
        });
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
            const layout = buildLayout(device, Object.values(states), Object.values(channels));
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
            const lhAcked: Record<string, ioBroker.StateValue | undefined> = {};
            for (const id of ids) {
                const s = values[id];
                lhValues[id] = s ? { val: s.val, ack: s.ack, ts: s.ts } : undefined;
                lhAcked[id] = s?.val;
            }
            this.setState({ lhValues, lhAcked });
        } catch (e) {
            console.warn(`liebherr-home widget: cannot load ${device}: ${String(e)}`);
            if (generation === this.loadGeneration) {
                this.setState({ notFound: true });
            }
        }
    }

    // ---------------------------------------------------------------- commands

    private clearAckTimer(id: string): void {
        const timer = this.ackTimers.get(id);
        if (timer) {
            clearTimeout(timer);
            this.ackTimers.delete(id);
        }
    }

    private clearAckTimers(): void {
        this.ackTimers.forEach(timer => clearTimeout(timer));
        this.ackTimers.clear();
    }

    /** Sends a command and waits for the confirmation of the adapter */
    private send(id: string, value: ioBroker.StateValue): void {
        if (this.props.editMode) {
            return;
        }
        this.props.context.setValue(id, value);
        this.setState(prev => ({ lhPending: { ...prev.lhPending, [id]: value }, lhUnconfirmed: false }));
        this.clearAckTimer(id);
        this.ackTimers.set(
            id,
            setTimeout(() => {
                this.ackTimers.delete(id);
                this.setState(prev => {
                    if (!(id in prev.lhPending)) {
                        return prev;
                    }
                    const lhPending = { ...prev.lhPending };
                    delete lhPending[id];
                    return { ...prev, lhPending, lhUnconfirmed: true };
                });
            }, ACK_TIMEOUT_MS),
        );
    }

    /** Value to show: the sent one while pending, else the last confirmed one */
    private shown(id: string | undefined): ioBroker.StateValue | undefined {
        if (!id) {
            return undefined;
        }
        return id in this.state.lhPending ? this.state.lhPending[id] : this.state.lhAcked[id];
    }

    // ---------------------------------------------------------------- dialog

    private open = (): void => {
        this.setState({ lhOpen: true, lhUnconfirmed: false });
        this.stopTick();
        this.tickTimer = setInterval(() => this.setState(prev => ({ lhTick: prev.lhTick + 1 })), 5_000);
    };

    private close = (): void => {
        this.stopTick();
        this.setState({ lhOpen: false });
    };

    private stopTick(): void {
        if (this.tickTimer) {
            clearInterval(this.tickTimer);
            this.tickTimer = undefined;
        }
    }

    /** Translation, or the fallback if the key is unknown */
    private static label(key: string, fallback: string, ...args: string[]): string {
        const text = LiebherrDevice.t(key, ...args);
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

    private static modeText(mode: ModeControl, value: string): string {
        if (mode.name === 'biofreshplus') {
            // ZERO_MINUS_TWO -> "0 / −2 °C"
            const part = (p: string): string => (p === 'ZERO' ? '0' : p === 'MINUS_TWO' ? '−2' : p);
            const m = /^(ZERO|MINUS_TWO)_(ZERO|MINUS_TWO)$/.exec(value);
            return m ? `${part(m[1])} / ${part(m[2])} °C` : value;
        }
        if (value === 'MAX_ICE') {
            return 'MaxIce';
        }
        return LiebherrDevice.label(`mode_${value}`, value);
    }

    private zoneTitle(zone: Zone, layout: DeviceLayout): string {
        const base = LiebherrDevice.t(
            iconKind(this.state.lhAcked[layout.typeId]) === 'freezer' ? 'zone_freezer' : 'zone_fridge',
        );
        return layout.zones.length > 1 && zone.position
            ? `${base} ${LiebherrDevice.label(`pos_${zone.position}`, zone.position)}`
            : base;
    }

    private static agoText(ts: unknown): string {
        if (typeof ts !== 'number' || !ts) {
            return '–';
        }
        const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
        if (s < 90) {
            return LiebherrDevice.t('ago_s', String(s));
        }
        if (s < 90 * 60) {
            return LiebherrDevice.t('ago_min', String(Math.round(s / 60)));
        }
        return LiebherrDevice.t('ago_h', String(Math.round(s / 3600)));
    }

    private renderZone(zone: Zone, layout: DeviceLayout, lang: string): React.JSX.Element {
        const sp = zone.setpoint;
        const target = this.shown(sp?.id);
        const t = typeof target === 'number' ? target : undefined;
        return (
            <div
                key={zone.zoneId}
                style={{
                    background: colors.section,
                    borderRadius: 16,
                    padding: 20,
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 18,
                }}
            >
                <div
                    style={{
                        display: 'flex',
                        justifyContent: 'space-between',
                        alignItems: 'center',
                        flexWrap: 'wrap',
                        gap: 16,
                    }}
                >
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                        <SectionLabel>{this.zoneTitle(zone, layout)}</SectionLabel>
                        <span style={{ fontFamily: fonts.numbers, fontSize: 48, fontWeight: 600, lineHeight: 1 }}>
                            {formatDegrees(
                                zone.temperatureId ? this.state.lhAcked[zone.temperatureId] : undefined,
                                lang,
                            )}
                        </span>
                        <span style={{ fontSize: 13, color: colors.muted }}>{LiebherrDevice.t('current')}</span>
                    </div>
                    {sp ? (
                        <Stepper
                            text={t === undefined ? '–' : `${formatDegrees(t, lang).replace('°', '')} °C`}
                            caption={
                                sp.min !== undefined && sp.max !== undefined
                                    ? LiebherrDevice.t(
                                          'target_range',
                                          formatDegrees(sp.min, lang).replace('°', ''),
                                          formatDegrees(sp.max, lang).replace('°', ''),
                                      )
                                    : LiebherrDevice.t('target')
                            }
                            canDown={t !== undefined && stepValue(t, -1, sp) !== t}
                            canUp={t !== undefined && stepValue(t, 1, sp) !== t}
                            onDown={() => t !== undefined && this.send(sp.id, stepValue(t, -1, sp))}
                            onUp={() => t !== undefined && this.send(sp.id, stepValue(t, 1, sp))}
                            labelDown={LiebherrDevice.t('lower')}
                            labelUp={LiebherrDevice.t('raise')}
                            pending={sp.id in this.state.lhPending}
                        />
                    ) : null}
                </div>
                {zone.modes.map(mode => (
                    <div
                        key={mode.id}
                        style={{
                            display: 'flex',
                            flexDirection: 'column',
                            gap: 10,
                            borderTop: `1px solid ${colors.borderFine}`,
                            paddingTop: 16,
                        }}
                    >
                        <SectionLabel>{LiebherrDevice.label(`ctl_${mode.name}`, mode.name)}</SectionLabel>
                        <Segments
                            label={LiebherrDevice.label(`ctl_${mode.name}`, mode.name)}
                            options={mode.values.map(v => ({ value: v, text: LiebherrDevice.modeText(mode, v) }))}
                            value={this.shown(mode.id)}
                            onPick={v => this.send(mode.id, v)}
                        />
                    </div>
                ))}
            </div>
        );
    }

    private renderDialog(layout: DeviceLayout, title: string, lang: string): React.JSX.Element {
        const { lhAcked, lhPending, lhUnconfirmed } = this.state;
        const reachable = lhAcked[layout.reachableId];
        const realtime = lhAcked[layout.realtimeId];
        const pending = Object.keys(lhPending).length > 0;

        let sync = LiebherrDevice.t(realtime === true ? 'sync_realtime' : 'sync_polling');
        let syncColor: string = realtime === true ? colors.okText : colors.accent;
        if (reachable === false) {
            sync = LiebherrDevice.t('sync_unreachable');
            syncColor = colors.alarm;
        }
        if (pending) {
            sync = LiebherrDevice.t('sync_pending');
            syncColor = colors.accent;
        } else if (lhUnconfirmed) {
            sync = LiebherrDevice.t('sync_unconfirmed');
            syncColor = colors.alarm;
        }

        const names = new Set(layout.switches.map(s => s.name));
        const status = (label: string, value: string): React.JSX.Element => (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                <span style={{ fontSize: 12, color: colors.muted }}>{label}</span>
                <span style={{ fontSize: 15, fontWeight: 600 }}>{value}</span>
            </div>
        );

        return (
            <Dialog
                title={title}
                sync={sync}
                syncColor={syncColor}
                closeLabel={LiebherrDevice.t('close')}
                onClose={this.close}
            >
                {layout.zones
                    .filter(z => z.temperatureId || z.setpoint || z.modes.length)
                    .map(z => this.renderZone(z, layout, lang))}

                {layout.switches.length ? (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                        <SectionLabel>{LiebherrDevice.t('functions')}</SectionLabel>
                        <div
                            style={{
                                display: 'grid',
                                gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))',
                                gap: 10,
                            }}
                        >
                            {layout.switches.map(s => {
                                const on = this.shown(s.id) === true;
                                return (
                                    <ToggleTile
                                        key={s.id}
                                        label={LiebherrDevice.label(`fn_${s.name}`, s.label)}
                                        state={LiebherrDevice.t(
                                            on
                                                ? SELF_ENDING.has(s.name)
                                                    ? 'state_self_ending'
                                                    : 'state_on'
                                                : 'state_off',
                                        )}
                                        on={on}
                                        onToggle={() => this.send(s.id, !on)}
                                    />
                                );
                            })}
                        </div>
                        {names.has('partymode') && names.has('supercool') ? (
                            <span style={{ fontSize: 12, color: colors.muted }}>{LiebherrDevice.t('note_party')}</span>
                        ) : null}
                    </div>
                ) : null}

                <div
                    style={{
                        display: 'grid',
                        gridTemplateColumns: 'repeat(3, minmax(0, 1fr))',
                        gap: 10,
                        borderTop: `1px solid ${colors.borderFine}`,
                        paddingTop: 16,
                    }}
                >
                    {status(
                        LiebherrDevice.t('status_device'),
                        LiebherrDevice.t(reachable === false ? 'status_unreachable' : 'status_reachable'),
                    )}
                    {status(
                        LiebherrDevice.t('status_link'),
                        LiebherrDevice.t(
                            reachable === false ? 'link_offline' : realtime === true ? 'link_realtime' : 'link_polling',
                        ),
                    )}
                    {status(LiebherrDevice.t('status_last'), LiebherrDevice.agoText(lhAcked[layout.lastUpdateId]))}
                </div>
            </Dialog>
        );
    }

    // ---------------------------------------------------------------- render

    renderWidgetBody(props: RxRenderWidgetProps): React.JSX.Element {
        super.renderWidgetBody(props);
        const { layout, lhAcked, lhPending, notFound, lhOpen } = this.state;
        const lang = LiebherrDevice.getLanguage();
        const device = deviceFolder(this.state.rxData.device);
        const name = layout ? lhAcked[layout.nameId] : undefined;
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
        const current = formatDegrees(zone?.temperatureId ? lhAcked[zone.temperatureId] : undefined, lang);
        const target = this.shown(zone?.setpoint?.id);
        const dot = layout
            ? dotState(lhAcked[layout.reachableId], lhAcked[layout.realtimeId], Object.keys(lhPending).length > 0)
            : undefined;
        const shownValues = layout
            ? Object.fromEntries(subscribedIds(layout).map(id => [id, { val: this.shown(id) ?? null, ack: true }]))
            : {};

        return (
            <>
                <Tile
                    title={title}
                    icon={iconKind(layout ? lhAcked[layout.typeId] : undefined)}
                    dot={dot}
                    dotTitle={dot ? LiebherrDevice.t(`dot_${dot}`) : ''}
                    current={current}
                    setpoint={
                        typeof target === 'number'
                            ? `${LiebherrDevice.t('setpoint_short')} ${formatDegrees(target, lang)}`
                            : ''
                    }
                    chips={
                        layout
                            ? activeChips(layout, shownValues).map(c => ({ ...c, text: LiebherrDevice.chipText(c) }))
                            : []
                    }
                    hint={hint}
                    onClick={layout && !this.props.editMode ? this.open : undefined}
                />
                {lhOpen && layout && !this.props.editMode ? this.renderDialog(layout, title, lang) : null}
            </>
        );
    }
}
