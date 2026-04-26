/**
 * TITAN — Watch View (v4.5.0)
 *
 * The "Pane" — a single glanceable page where Tony can watch TITAN
 * doing its thing. Four zones:
 *   1. Focus card (what I'm doing right now, animated)
 *   2. Organism canvas (5 drives breathing, hormone particles)
 *   3. Activity stream (scrolling plain-English feed)
 *   4. Ambient background (subtle, reacts to activity)
 *
 * Voice toggle: "TITAN" (first-person) vs "Mission" (neutral mission-control).
 * Query params:
 *   ?kiosk=1    — hide shell chrome, fullscreen, larger type for TV
 *   ?voice=...  — initial voice selection
 */
import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router';
import { useWatchStream } from '@/hooks/useWatchStream';
import { FocusCard } from '@/views/watch/FocusCard';
import { ActivityStream } from '@/views/watch/ActivityStream';
import { OrganismCanvas } from '@/views/watch/OrganismCanvas';
import { EventDetailPanel } from '@/views/watch/EventDetailPanel';
import { driveColor } from '@/views/watch/types';
import type { WatchVoice, WatchEvent } from '@/views/watch/types';

export default function WatchView() {
    const [params] = useSearchParams();
    const kiosk = params.get('kiosk') === '1';
    const initialVoice = (params.get('voice') as WatchVoice) === 'control' ? 'control' : 'titan';
    const [voice, setVoice] = useState<WatchVoice>(initialVoice);
    const [selectedEvent, setSelectedEvent] = useState<WatchEvent | null>(null);

    const { drives, events, connected, reconnecting, lastActivity } = useWatchStream();

    const excited = lastActivity > 0 && Date.now() - lastActivity < 10_000;
    const reducedMotion = typeof window !== 'undefined'
        && window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches;

    // Kiosk mode: request screen wake lock so TVs don't sleep
    useEffect(() => {
        if (!kiosk) return;
        let lock: WakeLockSentinel | null = null;
        const acquire = async () => {
            try {
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                if ('wakeLock' in navigator) lock = await (navigator as any).wakeLock.request('screen');
            } catch { /* best effort */ }
        };
        acquire();
        const onVis = () => { if (document.visibilityState === 'visible') acquire(); };
        document.addEventListener('visibilitychange', onVis);
        return () => {
            document.removeEventListener('visibilitychange', onVis);
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            (lock as any)?.release?.();
        };
    }, [kiosk]);

    const statusText = useMemo(() => {
        if (connected) return 'live';
        if (reconnecting) return 'reconnecting…';
        return 'connecting…';
    }, [connected, reconnecting]);

    const statusColor = connected ? 'var(--color-emerald)' : reconnecting ? '#fbbf24' : '#6b7280';

    return (
        <div
            style={{
                position: kiosk ? 'fixed' : 'relative',
                inset: kiosk ? 0 : undefined,
                height: '100%',
                width: '100%',
                minHeight: kiosk ? '100vh' : '100%',
                background: 'radial-gradient(ellipse at 20% 30%, rgba(167, 139, 250, 0.06) 0%, transparent 55%), radial-gradient(ellipse at 80% 70%, rgba(34, 211, 238, 0.05) 0%, transparent 55%), radial-gradient(ellipse at 50% 50%, rgba(52, 211, 153, 0.03) 0%, transparent 60%), #05060a',
                color: '#f8f9fc',
                overflow: 'hidden',
                fontFamily: '-apple-system, BlinkMacSystemFont, "SF Pro Text", Inter, system-ui, sans-serif',
                display: 'flex',
                flexDirection: 'column',
                zIndex: kiosk ? 9999 : undefined,
            }}
        >
            {/* Ambient subtle noise */}
            <div
                aria-hidden
                style={{
                    position: 'absolute',
                    inset: 0,
                    opacity: 0.03,
                    pointerEvents: 'none',
                    backgroundImage: "url(\"data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='200' height='200'><filter id='n'><feTurbulence type='fractalNoise' baseFrequency='0.85' numOctaves='2'/></filter><rect width='200' height='200' filter='url(%23n)' opacity='0.8'/></svg>\")",
                }}
            />

            <div
                style={{
                    flex: 1,
                    display: 'flex',
                    flexDirection: 'column',
                    padding: kiosk ? '32px 40px' : '20px 24px',
                    minHeight: 0,
                    zIndex: 1,
                }}
            >
                {/* Header */}
                {!kiosk && (
                    <header style={{
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        marginBottom: 16,
                        fontSize: 13,
                    }}>
                        <div style={{
                            display: 'flex',
                            alignItems: 'center',
                            gap: 10,
                            color: 'rgba(255,255,255,0.5)',
                            fontWeight: 600,
                            letterSpacing: '0.02em',
                        }}>
                            <div style={{
                                width: 8, height: 8, borderRadius: '50%',
                                background: statusColor,
                                boxShadow: `0 0 10px ${statusColor}`,
                                animation: 'watch-pulse 2s ease-in-out infinite',
                            }} />
                            <span>TITAN</span>
                            <span style={{ opacity: 0.4 }}>·</span>
                            <span>{statusText}</span>
                        </div>

                        <div style={{
                            display: 'flex',
                            gap: 2,
                            background: 'rgba(20, 24, 36, 0.6)',
                            border: '1px solid rgba(80, 90, 120, 0.25)',
                            borderRadius: 999,
                            padding: 2,
                        }}>
                            {(['titan', 'control'] as WatchVoice[]).map((v) => (
                                <button
                                    key={v}
                                    onClick={() => setVoice(v)}
                                    style={{
                                        background: voice === v ? '#f8f9fc' : 'transparent',
                                        color: voice === v ? '#05060a' : 'rgba(255,255,255,0.55)',
                                        border: 0,
                                        padding: '6px 14px',
                                        borderRadius: 999,
                                        cursor: 'pointer',
                                        fontSize: 11,
                                        fontWeight: 600,
                                        letterSpacing: '0.02em',
                                        transition: 'all 0.15s',
                                        textTransform: 'uppercase',
                                    }}
                                >
                                    {v === 'titan' ? 'TITAN' : 'Mission'}
                                </button>
                            ))}
                        </div>
                    </header>
                )}

                {/* Main grid */}
                <main
                    style={{
                        display: 'grid',
                        gridTemplateColumns: 'minmax(0, 1.05fr) minmax(0, 1fr)',
                        gridTemplateRows: 'auto 1fr',
                        gridTemplateAreas: '"focus activity" "organism activity"',
                        gap: kiosk ? 28 : 18,
                        flex: 1,
                        minHeight: 0,
                    }}
                    className="watch-grid"
                >
                    {/* Focus card */}
                    <Panel gridArea="focus" excited={excited}>
                        <FocusCard events={events} voice={voice} />
                    </Panel>

                    {/* Organism */}
                    <Panel gridArea="organism" excited={excited} padding={kiosk ? 24 : 16}>
                        <div style={{
                            fontSize: 10,
                            textTransform: 'uppercase',
                            letterSpacing: '0.15em',
                            color: 'rgba(255,255,255,0.35)',
                            fontWeight: 600,
                            marginBottom: 6,
                        }}>
                            How I'm feeling
                        </div>
                        <div style={{ flex: 1, minHeight: kiosk ? 320 : 220 }}>
                            <OrganismCanvas
                                drives={drives}
                                excited={excited}
                                reducedMotion={reducedMotion}
                            />
                        </div>
                        {/* Legend */}
                        <div style={{
                            display: 'grid',
                            gridTemplateColumns: 'repeat(auto-fit, minmax(90px, 1fr))',
                            gap: 8,
                            marginTop: 10,
                            fontSize: 11,
                        }}>
                            {drives.map((d) => {
                                const pressed = (d.pressure || 0) > 0.01;
                                return (
                                    <div
                                        key={d.id}
                                        style={{
                                            display: 'flex',
                                            alignItems: 'center',
                                            gap: 6,
                                            padding: '6px 10px',
                                            borderRadius: 8,
                                            background: pressed
                                                ? 'rgba(251, 191, 36, 0.08)'
                                                : 'rgba(255,255,255,0.02)',
                                            border: `1px solid ${pressed ? 'rgba(251, 191, 36, 0.3)' : 'rgba(255,255,255,0.04)'}`,
                                        }}
                                        title={d.description || `${d.label}: satisfaction ${d.satisfaction.toFixed(2)}, setpoint ${d.setpoint.toFixed(2)}`}
                                    >
                                        <div style={{
                                            width: 8, height: 8, borderRadius: '50%',
                                            background: driveColor(d.id),
                                            boxShadow: `0 0 8px ${driveColor(d.id)}`,
                                        }} />
                                        <div style={{
                                            flex: 1,
                                            color: 'rgba(255,255,255,0.65)',
                                            fontWeight: 500,
                                        }}>
                                            {d.label}
                                        </div>
                                        <div style={{
                                            color: 'rgba(255,255,255,0.35)',
                                            fontVariantNumeric: 'tabular-nums',
                                        }}>
                                            {Math.round((d.satisfaction || 0) * 100)}%
                                        </div>
                                    </div>
                                );
                            })}
                        </div>
                    </Panel>

                    {/* Activity stream */}
                    <Panel gridArea="activity" excited={excited}>
                        <div style={{
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'space-between',
                            marginBottom: 12,
                        }}>
                            <div style={{
                                fontSize: 10,
                                textTransform: 'uppercase',
                                letterSpacing: '0.15em',
                                color: 'rgba(255,255,255,0.35)',
                                fontWeight: 600,
                            }}>
                                Recent activity
                            </div>
                            <div style={{
                                fontSize: 11,
                                color: 'rgba(255,255,255,0.35)',
                                fontVariantNumeric: 'tabular-nums',
                            }}>
                                {events.length} {events.length === 1 ? 'event' : 'events'}
                            </div>
                        </div>
                        <div style={{
                            flex: 1,
                            overflowY: 'auto',
                            minHeight: 0,
                            // subtle fade at top/bottom
                            maskImage: 'linear-gradient(to bottom, transparent 0, black 16px, black calc(100% - 16px), transparent 100%)',
                            WebkitMaskImage: 'linear-gradient(to bottom, transparent 0, black 16px, black calc(100% - 16px), transparent 100%)',
                            paddingRight: 4,
                        }}>
                            <ActivityStream events={events} voice={voice} onEventClick={setSelectedEvent} />
                        </div>
                    </Panel>
                </main>
            </div>

            {/* Click-to-drill-in detail panel */}
            <EventDetailPanel event={selectedEvent} voice={voice} onClose={() => setSelectedEvent(null)} />

            {/* CSS keyframes + responsive grid fallback */}
            <style>{`
                @keyframes watch-pulse {
                    0%, 100% { opacity: 1; transform: scale(1); }
                    50% { opacity: 0.6; transform: scale(0.85); }
                }
                @media (max-width: 820px) {
                    .watch-grid {
                        grid-template-columns: 1fr !important;
                        grid-template-rows: auto auto 1fr !important;
                        grid-template-areas: "focus" "organism" "activity" !important;
                    }
                }
            `}</style>
        </div>
    );
}

interface PanelProps {
    gridArea: string;
    children: React.ReactNode;
    excited?: boolean;
    padding?: number;
}
function Panel({ gridArea, children, excited, padding = 20 }: PanelProps) {
    return (
        <section
            style={{
                gridArea,
                background: 'rgba(20, 24, 36, 0.6)',
                border: `1px solid ${excited ? 'rgba(167, 139, 250, 0.35)' : 'rgba(80, 90, 120, 0.25)'}`,
                borderRadius: 20,
                padding,
                backdropFilter: 'blur(10px)',
                WebkitBackdropFilter: 'blur(10px)',
                display: 'flex',
                flexDirection: 'column',
                minHeight: 0,
                transition: 'border-color 0.5s',
                position: 'relative',
                overflow: 'hidden',
            }}
        >
            {children}
        </section>
    );
}
