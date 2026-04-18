/**
 * TITAN — Focus Card (v4.5.0)
 *
 * Large card showing "What I'm doing right now" in plain English.
 * Animates text changes with motion. Shows the most recent event that
 * passes FOCUS_TOPICS; falls back to a calm idle message.
 */
import { useMemo } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import type { WatchEvent, WatchVoice } from './types';
import { FOCUS_TOPICS, timeAgo } from './types';

interface Props {
    events: WatchEvent[];
    voice: WatchVoice;
}

function pickFocus(events: WatchEvent[]): WatchEvent | null {
    // Newest event whose topic deserves promotion. Falls back to newest of any kind.
    for (const e of events) {
        if (FOCUS_TOPICS.has(e.topic)) return e;
    }
    return events[0] || null;
}

export function FocusCard({ events, voice }: Props) {
    const focus = useMemo(() => pickFocus(events), [events]);
    const caption = focus ? (voice === 'titan' ? focus.captionTitan : focus.captionControl) : null;

    return (
        <div style={{ position: 'relative', minHeight: 80 }}>
            <div style={{
                fontSize: 10,
                textTransform: 'uppercase',
                letterSpacing: '0.15em',
                color: 'rgba(255, 255, 255, 0.35)',
                marginBottom: 10,
                fontWeight: 600,
            }}>
                What I'm doing
            </div>

            <AnimatePresence mode="wait" initial={false}>
                <motion.div
                    key={focus?.id || 'idle'}
                    initial={{ opacity: 0, y: 4 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: -4 }}
                    transition={{ duration: 0.3 }}
                    style={{
                        fontSize: 'clamp(18px, 2.4vw, 24px)',
                        fontWeight: 500,
                        lineHeight: 1.35,
                        color: caption ? 'rgba(255, 255, 255, 0.95)' : 'rgba(255, 255, 255, 0.45)',
                    }}
                >
                    {caption || 'Standing by.'}
                </motion.div>
            </AnimatePresence>

            {focus && (
                <div style={{
                    display: 'flex',
                    gap: 12,
                    marginTop: 12,
                    fontSize: 11,
                    color: 'rgba(255, 255, 255, 0.35)',
                    flexWrap: 'wrap',
                }}>
                    <span>{timeAgo(focus.timestamp)}</span>
                    {focus.detail && <span>· {focus.detail}</span>}
                </div>
            )}
        </div>
    );
}
