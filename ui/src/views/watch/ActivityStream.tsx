/**
 * TITAN — Activity Stream (v4.5.0)
 *
 * Scrolling list of humanized events, newest first. Staggered slide-in
 * animation via motion/react when new events arrive. Colored left-border
 * per event kind (drive / tool / goal / channel / etc).
 */
import { useEffect, useMemo, useState } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import type { WatchEvent, WatchVoice, WatchKind } from './types';
import { timeAgo } from './types';

interface Props {
    events: WatchEvent[];
    voice: WatchVoice;
    onEventClick?: (event: WatchEvent) => void;
}

const KIND_COLORS: Record<WatchKind, string> = {
    drive: 'var(--color-purple-light)',
    soma: '#c084fc',
    tool: '#60a5fa',
    goal: 'var(--color-emerald)',
    channel: '#fb7185',
    agent: '#c084fc',
    health: '#fbbf24',
    memory: '#e879f9',
    system: '#9ca3af',
};

export function ActivityStream({ events, voice, onEventClick }: Props) {
    // Force re-render every 20s so the "time ago" labels stay fresh
    const [, setTick] = useState(0);
    useEffect(() => {
        const id = setInterval(() => setTick((x) => x + 1), 20_000);
        return () => clearInterval(id);
    }, []);

    const rows = useMemo(() => events.slice(0, 80), [events]);

    if (rows.length === 0) {
        return (
            <div style={{
                color: 'rgba(255,255,255,0.35)',
                fontSize: 13,
                fontStyle: 'italic',
                padding: '24px 16px',
                textAlign: 'center',
            }}>
                Listening for TITAN to do something…
            </div>
        );
    }

    return (
        <div style={{
            display: 'flex',
            flexDirection: 'column',
            gap: 4,
            overflow: 'hidden',
        }}>
            <AnimatePresence initial={false}>
                {rows.map((evt, i) => {
                    const caption = voice === 'titan' ? evt.captionTitan : evt.captionControl;
                    const leftColor = KIND_COLORS[evt.kind] || '#9ca3af';
                    const isNewest = i === 0;
                    return (
                        <motion.div
                            key={evt.id}
                            initial={{ opacity: 0, y: -6 }}
                            animate={{ opacity: 1, y: 0 }}
                            exit={{ opacity: 0, y: 4 }}
                            transition={{ duration: 0.35, ease: 'easeOut' }}
                            onClick={() => onEventClick?.(evt)}
                            style={{
                                display: 'flex',
                                alignItems: 'flex-start',
                                gap: 12,
                                padding: '10px 12px',
                                borderRadius: 10,
                                background: isNewest
                                    ? `${leftColor}14`
                                    : 'rgba(255, 255, 255, 0.015)',
                                borderLeft: `2px solid ${leftColor}`,
                                fontSize: 13,
                                lineHeight: 1.35,
                                transition: 'background 0.2s, transform 0.15s',
                                cursor: onEventClick ? 'pointer' : 'default',
                            }}
                            onMouseEnter={(e) => {
                                if (onEventClick) e.currentTarget.style.background = `${leftColor}22`;
                            }}
                            onMouseLeave={(e) => {
                                e.currentTarget.style.background = isNewest ? `${leftColor}14` : 'rgba(255, 255, 255, 0.015)';
                            }}
                            title={`Click for details · ${evt.topic}`}
                        >
                            <div style={{
                                fontSize: 15,
                                flexShrink: 0,
                                width: 20,
                                textAlign: 'center',
                                marginTop: 1,
                            }}>
                                {evt.icon}
                            </div>
                            <div style={{ flex: 1, minWidth: 0 }}>
                                <div style={{ color: 'rgba(255,255,255,0.92)' }}>
                                    {caption}
                                </div>
                                {evt.detail && (
                                    <div style={{
                                        color: 'rgba(255,255,255,0.45)',
                                        fontSize: 11,
                                        marginTop: 2,
                                        lineHeight: 1.3,
                                    }}>
                                        {evt.detail}
                                    </div>
                                )}
                            </div>
                            <div style={{
                                color: 'rgba(255,255,255,0.35)',
                                fontSize: 11,
                                flexShrink: 0,
                                fontVariantNumeric: 'tabular-nums',
                                whiteSpace: 'nowrap',
                                marginTop: 1,
                            }}>
                                {timeAgo(evt.timestamp)}
                            </div>
                        </motion.div>
                    );
                })}
            </AnimatePresence>
        </div>
    );
}
