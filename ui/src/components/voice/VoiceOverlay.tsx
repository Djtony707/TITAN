import { useState, useEffect, useCallback, useRef } from 'react';
import { X, Mic, MicOff, PhoneOff, ChevronDown } from 'lucide-react';
import { FluidOrb } from './FluidOrb';
import { TranscriptView } from './TranscriptView';
import { VoicePicker, getVoiceInfo } from './VoicePicker';
import { apiFetch } from '@/api/client';
import { streamChat } from '@/titan2/llm/ollama';

interface VoiceOverlayProps {
  onClose: () => void;
}

interface TranscriptMessage {
  id: string;
  role: 'user' | 'assistant';
  text: string;
}

let msgCounter = 0;
const nextMsgId = () => `voice-msg-${Date.now()}-${++msgCounter}`;

/** Strip emotion tags for TTS cleanliness */
const stripEmotionTags = (text: string) =>
  text.replace(/<(?:laugh|chuckle|sigh|cough|sniffle|groan|yawn|gasp)>/gi, '').replace(/\s{2,}/g, ' ').trim();

/** Strip markdown formatting for voice responses */
const stripMarkdown = (text: string) =>
  text
    .replace(/```[\s\S]*?```/g, '')    // code blocks
    .replace(/\*\*(.*?)\*\*/g, '$1')   // bold
    .replace(/\*(.*?)\*/g, '$1')       // italic
    .replace(/^#+\s+/gm, '')           // headings
    .replace(/^[-*]\s+/gm, '')         // bullet points
    .replace(/\n{2,}/g, ' ')           // collapse newlines
    .trim();

/** Strip tool narration that LLMs leak despite prompt instructions */
const stripToolNarration = (text: string) =>
  text
    .replace(/(?:Let me |I'll |I will |I'm going to )(?:use|call|check|run|invoke|execute|try)(?: the)? \w[\w_]*(?: tool)?(?:\s+(?:to|for|and)\b[^.!?]*)?[.!]?\s*/gi, '')
    .replace(/\b(?:Using|Calling|Running|Checking|Invoking|Executing) (?:the )?\w[\w_]*(?: tool)?(?:\s+(?:to|for)\b[^.!?]*)?[.!]?\s*/gi, '')
    .replace(/\b\w[\w_]*(?:_\w+)+\b/g, '')  // bare tool_names like ha_setup, web_search
    .replace(/\s{2,}/g, ' ')
    .trim();

/* eslint-disable @typescript-eslint/no-explicit-any */

// Browser Speech Recognition types
interface SpeechRecognitionEvent {
  results: SpeechRecognitionResultList;
  resultIndex: number;
}

interface SpeechRecognitionResultList {
  length: number;
  [index: number]: SpeechRecognitionResult;
}

interface SpeechRecognitionResult {
  isFinal: boolean;
  [index: number]: SpeechRecognitionAlternative;
}

interface SpeechRecognitionAlternative {
  transcript: string;
  confidence: number;
}

/**
 * Direct voice mode — uses browser Web Speech API for STT and F5-TTS for speech.
 * No LiveKit required.
 */
export function VoiceOverlay({ onClose }: VoiceOverlayProps) {
  const [visible, setVisible] = useState(false);
  const savedVoice = localStorage.getItem('titan-voice') || '';
  const [phase, setPhase] = useState<'picking' | 'active'>(savedVoice ? 'active' : 'picking');
  const [selectedVoice, setSelectedVoice] = useState<string>(savedVoice);
  const selectedVoiceRef = useRef<string>(savedVoice);
  const [isMuted, setIsMuted] = useState(false);
  const [isListening, setIsListening] = useState(false);
  const [isSpeaking, setIsSpeaking] = useState(false);
  const [isThinking, setIsThinking] = useState(false);
  const [messages, setMessages] = useState<TranscriptMessage[]>([]);
  const [audioLevel, setAudioLevel] = useState(0);
  const [interimText, setInterimText] = useState('');
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [showVoiceMenu, setShowVoiceMenu] = useState(false);
  // F5-TTS is the only TTS engine. No fallback modes.
  const [availableVoices, setAvailableVoices] = useState<string[]>([]);

  const recognitionRef = useRef<any>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const micStreamRef = useRef<MediaStream | null>(null);
  const silenceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const currentTranscriptRef = useRef('');
  const levelAnimRef = useRef<number>(0);
  const sessionIdRef = useRef<string | undefined>(undefined);
  const currentAudioRef = useRef<HTMLAudioElement | null>(null);
  // Persistent reusable Audio element for desktop browsers
  const reusableAudioRef = useRef<HTMLAudioElement | null>(null);
  // Web Audio API context for iOS — once resumed during user gesture, stays unlocked
  const playbackCtxRef = useRef<AudioContext | null>(null);
  const currentSourceRef = useRef<AudioBufferSourceNode | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const interruptCheckRef = useRef<number>(0);
  const processingRef = useRef(false); // guard against overlapping handleUserMessage calls
  const synthIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const isIOSRef = useRef(typeof navigator !== 'undefined' && /iPad|iPhone|iPod/.test(navigator.userAgent));

  /** Play audio data — tries Web Audio API first (most reliable on iOS), then Audio element */
  const playAudioData = useCallback((blobUrl: string): Promise<void> => {
    return new Promise(async (resolve) => {
      // Path 1: Web Audio API — works on iOS once AudioContext is resumed during user gesture
      const ctx = playbackCtxRef.current;
      if (ctx && ctx.state !== 'closed') {
        try {
          if (ctx.state === 'suspended') await ctx.resume();
          const response = await fetch(blobUrl);
          const arrayBuffer = await response.arrayBuffer();
          const audioBuffer = await ctx.decodeAudioData(arrayBuffer);
          try { currentSourceRef.current?.stop(); } catch { /* ok */ }
          const source = ctx.createBufferSource();
          source.buffer = audioBuffer;
          source.connect(ctx.destination);
          currentSourceRef.current = source;
          source.onended = () => { URL.revokeObjectURL(blobUrl); resolve(); };
          source.start(0);
          try { recognitionRef.current?.stop(); } catch { /* ok */ }
          console.log('[Voice] Playing via Web Audio API');
          return;
        } catch (e) {
          console.warn('[Voice] Web Audio failed:', e);
        }
      }

      // Path 2: HTML Audio element (desktop fallback)
      try {
        const audio = reusableAudioRef.current || new Audio();
        reusableAudioRef.current = audio; // Cache for reuse — prevents element accumulation
        audio.setAttribute('playsinline', '');
        audio.setAttribute('autoplay', '');
        currentAudioRef.current = audio;
        audio.onplay = () => { try { recognitionRef.current?.stop(); } catch { /* ok */ } };
        audio.onended = () => { URL.revokeObjectURL(blobUrl); resolve(); };
        audio.onerror = (e) => { console.warn('[Voice] Audio element error:', e); URL.revokeObjectURL(blobUrl); resolve(); };
        audio.src = blobUrl;
        await audio.play();
        console.log('[Voice] Playing via Audio element');
      } catch (e) {
        console.warn('[Voice] Audio element play failed:', e);
        URL.revokeObjectURL(blobUrl);
        resolve();
      }
    });
  }, []);

  // Refs to avoid stale closures in recognition callbacks
  const isMutedRef = useRef(false);
  const isSpeakingRef = useRef(false);
  const phaseRef = useRef<'picking' | 'active'>('picking');

  // Keep refs in sync with state
  useEffect(() => { isMutedRef.current = isMuted; }, [isMuted]);
  useEffect(() => { isSpeakingRef.current = isSpeaking; }, [isSpeaking]);
  useEffect(() => { phaseRef.current = phase; }, [phase]);

  // Fetch available voices from API (respects current TTS engine)
  useEffect(() => {
    (async () => {
      try {
        const res = await apiFetch('/api/voice/voices');
        if (res.ok) {
          const data = await res.json();
          if (data.voices?.length) {
            setAvailableVoices(data.voices);
            // If saved voice isn't in the new list, switch to first available
            if (savedVoice && !data.voices.includes(savedVoice)) {
              const newVoice = data.voices[0];
              setSelectedVoice(newVoice);
              selectedVoiceRef.current = newVoice;
              localStorage.setItem('titan-voice', newVoice);
            }
          } else {
            setAvailableVoices(['default']);
          }
        }
      } catch {
        setAvailableVoices(['default']);
      }
    })();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Animate in
  useEffect(() => {
    requestAnimationFrame(() => setVisible(true));
  }, []);

  // Cleanup on unmount — ensures mic is released even if handleClose wasn't called
  useEffect(() => {
    return () => {
      phaseRef.current = 'picking';
      try { recognitionRef.current?.stop(); } catch { /* ok */ }
      recognitionRef.current = null;
      micStreamRef.current?.getTracks().forEach(t => t.stop());
      audioContextRef.current?.close();
      abortRef.current?.abort();
      if (silenceTimerRef.current) clearTimeout(silenceTimerRef.current);
      if (synthIntervalRef.current) { clearInterval(synthIntervalRef.current); synthIntervalRef.current = null; }
      cancelAnimationFrame(levelAnimRef.current);
      cancelAnimationFrame(interruptCheckRef.current);
    };
  }, []);

  // Close voice menu on outside click
  useEffect(() => {
    if (!showVoiceMenu) return;
    const handler = () => setShowVoiceMenu(false);
    // Delay so the toggle click doesn't immediately close
    const id = setTimeout(() => document.addEventListener('click', handler), 0);
    return () => { clearTimeout(id); document.removeEventListener('click', handler); };
  }, [showVoiceMenu]);

  // Mic level monitoring — mobile-safe (AudioContext must be created/resumed after user gesture)
  const startMicMonitor = useCallback(async () => {
    try {
      // On mobile browsers, getUserMedia requires a secure context and user gesture
      if (!navigator.mediaDevices?.getUserMedia) {
        console.warn('[Voice] getUserMedia not available — may need HTTPS on mobile');
        return;
      }
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
      micStreamRef.current = stream;
      // Reuse existing AudioContext if available, create new one otherwise
      // On iOS Safari, AudioContext must be resumed after user gesture
      let ctx = audioContextRef.current;
      if (!ctx || ctx.state === 'closed') {
        ctx = new (window.AudioContext || (window as unknown as Record<string, unknown>).webkitAudioContext as typeof AudioContext)();
      }
      if (ctx.state === 'suspended') {
        await ctx.resume();
      }
      audioContextRef.current = ctx;
      const source = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 256;
      analyser.smoothingTimeConstant = 0.8;
      source.connect(analyser);
      analyserRef.current = analyser;

      const dataArray = new Uint8Array(analyser.frequencyBinCount);
      function tick() {
        analyser.getByteFrequencyData(dataArray);
        let sum = 0;
        for (let i = 0; i < dataArray.length; i++) sum += dataArray[i];
        const avg = sum / dataArray.length / 255;
        setAudioLevel(avg);
        levelAnimRef.current = requestAnimationFrame(tick);
      }
      levelAnimRef.current = requestAnimationFrame(tick);
    } catch (e) {
      console.error('Mic access denied:', e);
    }
  }, []);

  const stopMicMonitor = useCallback(() => {
    cancelAnimationFrame(levelAnimRef.current);
    cancelAnimationFrame(interruptCheckRef.current);
    micStreamRef.current?.getTracks().forEach(t => t.stop());
    audioContextRef.current?.close();
    micStreamRef.current = null;
    audioContextRef.current = null;
    analyserRef.current = null;
    setAudioLevel(0);
  }, []);

  // Speech recognition setup — uses refs to avoid stale closure bug
  const startRecognition = useCallback(() => {
    const SpeechRecognition = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!SpeechRecognition) {
      console.error('Speech recognition not supported');
      return;
    }

    // Stop any existing recognition before creating new one
    try { recognitionRef.current?.stop(); } catch { /* ok */ }

    const recognition = new SpeechRecognition();
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = 'en-US';

    recognition.onresult = (event: SpeechRecognitionEvent) => {
      // Ignore speech recognition results while TITAN is speaking — it's echo
      if (isSpeakingRef.current) return;

      let interim = '';
      let final = '';

      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i];
        // Filter low-confidence results — likely echo artifacts from speaker bleed
        if (result[0].confidence > 0 && result[0].confidence < 0.5) continue;

        if (result.isFinal) {
          final += result[0].transcript;
        } else {
          interim += result[0].transcript;
        }
      }

      if (interim) {
        setInterimText(interim);
      }

      if (final) {
        currentTranscriptRef.current += final;
        setInterimText('');

        // Reset silence timer — adaptive: short utterances fire faster
        if (silenceTimerRef.current) clearTimeout(silenceTimerRef.current);
        const wordCount = currentTranscriptRef.current.trim().split(/\s+/).length;
        const silenceMs = wordCount < 10 ? 400 : 700;
        silenceTimerRef.current = setTimeout(() => {
          const text = currentTranscriptRef.current.trim();
          if (text) {
            currentTranscriptRef.current = '';
            handleUserMessage(text);
          }
        }, silenceMs);
      }
    };

    recognition.onend = () => {
      // Use refs (not state) to avoid stale closure — these always have current values
      // Don't auto-restart while TITAN is speaking — mic would pick up TTS audio
      if (!isMutedRef.current && !isSpeakingRef.current && phaseRef.current === 'active') {
        try { recognition.start(); } catch { /* already started */ }
      }
      setIsListening(false);
    };

    recognition.onstart = () => {
      setIsListening(true);
    };

    recognition.onerror = (e: any) => {
      console.error('Speech recognition error:', e.error);
      if (e.error === 'not-allowed') {
        setErrorMsg('Mic access denied — check browser permissions');
        setIsListening(false);
      } else if (e.error === 'network') {
        setErrorMsg('Speech recognition network error');
        setTimeout(() => {
          if (!isMutedRef.current && phaseRef.current === 'active') {
            try { recognition.start(); } catch { /* ok */ }
          }
        }, 2000);
      } else if (e.error === 'audio-capture') {
        setErrorMsg('Mic not available — is another app using it?');
        setIsListening(false);
      } else if (e.error !== 'no-speech') {
        console.error('STT error:', e.error);
      }
    };

    recognitionRef.current = recognition;
    try {
      recognition.start();
    } catch { /* already started */ }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Stop any currently playing audio (enables interruption)
  const stopCurrentAudio = useCallback(() => {
    // Stop Web Audio API source (iOS)
    try { currentSourceRef.current?.stop(); } catch { /* ok */ }
    currentSourceRef.current = null;
    // Stop HTML Audio element (desktop)
    const audio = currentAudioRef.current;
    if (audio) {
      audio.pause();
      audio.src = '';
      currentAudioRef.current = null;
    }
    // Also cancel browser speech synthesis
    if ('speechSynthesis' in window) window.speechSynthesis.cancel();
    setIsSpeaking(false);
    setAudioLevel(0);
  }, []);

  // Auto-start mic when resuming a saved voice (skipping picker)
  useEffect(() => {
    if (savedVoice && phase === 'active') {
      // iOS audio unlock on auto-start too
      try {
        const sa = new Audio('data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEARKwAAIhYAQACABAAZGF0YQAAAAA=');
        sa.play().catch(() => {});
      } catch { /* ok */ }
      startMicMonitor();
      startRecognition();
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  /**
   * Reactive audio queue player — pulls from a shared array as new items arrive.
   * Uses Web Audio API on iOS (AudioContext unlocked during user gesture).
   * Uses HTMLAudioElement on desktop.
   */
  const createAudioPlayer = useCallback(() => {
    const urls: string[] = [];
    let idx = 0;
    let cancelled = false;
    let streamDone = false;
    let onDone: (() => void) | null = null;
    let waitingForMore: (() => void) | null = null;

    const levelInterval = setInterval(() => {
      if (!cancelled) setAudioLevel(0.3 + Math.random() * 0.4);
    }, 100);

    const cleanup = () => {
      clearInterval(levelInterval);
      setAudioLevel(0);
    };

    const playNext = () => {
      if (cancelled) { cleanup(); return; }

      if (idx < urls.length) {
        const dataUrl = urls[idx++];
        playAudioData(dataUrl).then(() => playNext()).catch(() => playNext());
      } else if (streamDone) {
        cleanup();
        if (onDone) onDone();
      } else {
        waitingForMore = playNext;
      }
    };

    return {
      push(url: string) {
        urls.push(url);
        if (waitingForMore) {
          const resume = waitingForMore;
          waitingForMore = null;
          resume();
        }
      },
      finish() {
        streamDone = true;
        if (waitingForMore) {
          const resume = waitingForMore;
          waitingForMore = null;
          resume();
        }
      },
      start(done: () => void) {
        onDone = done;
        playNext();
      },
      cancel() {
        cancelled = true;
        try { currentSourceRef.current?.stop(); } catch { /* ok */ }
        if (currentAudioRef.current) {
          currentAudioRef.current.pause();
          currentAudioRef.current.src = '';
        }
        cleanup();
      },
      get length() { return urls.length; },
    };
  }, []);

  // Send user message to TITAN via Ollama and speak the response via F5-TTS
  const handleUserMessage = useCallback(async (text: string) => {
    if (processingRef.current) return;
    processingRef.current = true;

    stopCurrentAudio();
    abortRef.current?.abort();

    setMessages(prev => [...prev, { id: nextMsgId(), role: 'user', text }]);
    setIsThinking(true);
    setIsListening(false);
    setErrorMsg(null);

    try { recognitionRef.current?.stop(); } catch { /* ok */ }

    const controller = new AbortController();
    abortRef.current = controller;
    const voice = selectedVoiceRef.current || 'default';
    let assistantMsgId = '';
    let responseText = '';

    try {
      // 1. Stream LLM response from Ollama
      const chatHistory = messages.map(m => ({
        role: m.role as 'user' | 'assistant',
        content: m.text,
        timestamp: m.id ? Date.now() : Date.now(),
      }));
      await streamChat(
        [...chatHistory, { role: 'user', content: text, timestamp: Date.now() }],
        'You are TITAN, a helpful AI assistant. Keep responses concise and natural for voice conversation. Use short sentences.',
        {
          onToken: (token: string) => {
            responseText += token;
            const clean = stripToolNarration(stripEmotionTags(stripMarkdown(responseText)));
            if (!assistantMsgId) {
              assistantMsgId = nextMsgId();
              setMessages(prev => [...prev, { id: assistantMsgId, role: 'assistant', text: clean }]);
            } else {
              setMessages(prev => prev.map(m => m.id === assistantMsgId ? { ...m, text: clean } : m));
            }
            setIsThinking(false);
          },
        },
        { signal: controller.signal }
      );

      // 2. Synthesize audio with F5-TTS
      const cleanText = stripToolNarration(stripEmotionTags(stripMarkdown(responseText)));
      if (!cleanText) {
        processingRef.current = false;
        try { recognitionRef.current?.start(); } catch { /* ok */ }
        return;
      }

      setIsSpeaking(true);
      const ttsRes = await fetch('/api/voice/preview', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: cleanText.slice(0, 500), voice }),
        signal: AbortSignal.timeout(120000),
      });

      if (!ttsRes.ok) throw new Error(`F5-TTS error: ${ttsRes.status}`);

      const blob = await ttsRes.blob();
      const url = URL.createObjectURL(blob);
      await playAudioData(url);

      setIsSpeaking(false);
      setAudioLevel(0);
      currentTranscriptRef.current = '';
      setTimeout(() => {
        processingRef.current = false;
        if (!isMutedRef.current && phaseRef.current === 'active') {
          try { recognitionRef.current?.start(); } catch { /* ok */ }
        }
      }, 500);
    } catch (e: any) {
      if (e?.name === 'AbortError' && !abortRef.current) return;
      const msg = e?.name === 'AbortError' ? 'Request timed out' : 'Connection error';
      setErrorMsg(msg);
      setTimeout(() => setErrorMsg(null), 4000);
      console.error('Voice processing error:', e);
      setMessages(prev => [...prev, { id: nextMsgId(), role: 'assistant', text: 'Sorry, something went wrong.' }]);
      setIsThinking(false);
      setIsSpeaking(false);
      currentTranscriptRef.current = '';
      processingRef.current = false;
      try { recognitionRef.current?.start(); } catch { /* ok */ }
    }
  }, [stopCurrentAudio, playAudioData, messages]);

  // Voice selection handler
  const handleVoiceSelect = useCallback(async (voiceId: string) => {
    setSelectedVoice(voiceId);
    selectedVoiceRef.current = voiceId;
    localStorage.setItem('titan-voice', voiceId);

    // Update voice config on server
    try {
      await apiFetch('/api/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ voice: { ttsVoice: voiceId } }),
      });
    } catch { /* non-critical */ }

    setPhase('active');

    // iOS Safari audio unlock: create AudioContext + resume() during this user gesture.
    // Once resumed during a tap, the AudioContext stays unlocked for ALL future playback.
    // This is the most reliable iOS audio pattern (confirmed by mediasoup, MDN, Apple docs).
    if (!playbackCtxRef.current || playbackCtxRef.current.state === 'closed') {
      const Ctx = window.AudioContext || (window as unknown as Record<string, unknown>).webkitAudioContext as typeof AudioContext;
      playbackCtxRef.current = new Ctx();
    }
    if (playbackCtxRef.current.state === 'suspended') {
      playbackCtxRef.current.resume().catch(() => {});
    }
    // Also play a silent buffer to fully prime the context
    try {
      const ctx = playbackCtxRef.current;
      const buf = ctx.createBuffer(1, 1, 22050);
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.connect(ctx.destination);
      src.start(0);
    } catch { /* ok */ }

    // Desktop fallback: reusable Audio element
    if (!reusableAudioRef.current) {
      reusableAudioRef.current = new Audio();
      reusableAudioRef.current.preload = 'auto';
    }

    startMicMonitor();
    startRecognition();
  }, [startMicMonitor, startRecognition]);

  // Switch voice during active chat (no need to go back to picker)
  const switchVoice = useCallback((voiceId: string) => {
    setSelectedVoice(voiceId);
    selectedVoiceRef.current = voiceId;
    localStorage.setItem('titan-voice', voiceId);
    setShowVoiceMenu(false);
    // Update server config
    apiFetch('/api/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ voice: { ttsVoice: voiceId } }),
    }).catch(() => {/* non-critical */});
  }, []);

  // Preview voice
  const handlePreview = useCallback(async (voiceId: string) => {
    try {
      const res = await fetch('/api/voice/preview', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: "Hey! I'm TITAN, your AI assistant.", voice: voiceId }),
      });
      if (!res.ok) return;
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const audio = reusableAudioRef.current || new Audio();
      const cleanup = () => {
        URL.revokeObjectURL(url);
        audio.src = '';
      };
      audio.onended = cleanup;
      audio.onerror = cleanup;
      audio.play();
    } catch { /* preview not available */ }
  }, []);

  // Close handler — abort in-flight requests, stop audio, stop mic
  const handleClose = useCallback(() => {
    setVisible(false);
    // Set phase BEFORE stopping recognition — onend handler checks phaseRef
    // to decide whether to auto-restart. Without this, recognition restarts
    // immediately after stop(), keeping the mic active.
    phaseRef.current = 'picking';
    setPhase('picking');
    // Abort any in-flight fetches
    abortRef.current?.abort();
    abortRef.current = null;
    try { recognitionRef.current?.stop(); } catch { /* ok */ }
    recognitionRef.current = null; // prevent any further restarts
    stopCurrentAudio();
    stopMicMonitor();
    if (silenceTimerRef.current) clearTimeout(silenceTimerRef.current);
    processingRef.current = false;
    setTimeout(onClose, 200);
  }, [onClose, stopMicMonitor, stopCurrentAudio]);

  // Toggle mute — also stops/starts mic stream so browser indicator reflects state
  const toggleMute = useCallback(() => {
    setIsMuted(prev => {
      const newMuted = !prev;
      isMutedRef.current = newMuted;
      if (newMuted) {
        try { recognitionRef.current?.stop(); } catch { /* ok */ }
        stopMicMonitor();
        setIsListening(false);
      } else {
        startMicMonitor();
        try { recognitionRef.current?.start(); } catch { /* ok */ }
      }
      return newMuted;
    });
  }, [startMicMonitor, stopMicMonitor]);

  // Determine speaker state for the orb
  const activeSpeaker = isSpeaking ? 'assistant' : isThinking ? 'thinking' : isListening ? 'user' : 'idle';

  // Status text
  const statusText = isMuted
    ? 'Muted'
    : isSpeaking
      ? 'TITAN is speaking...'
      : isThinking
        ? 'Thinking...'
        : isListening
          ? (interimText ? `"${interimText}"` : 'Listening...')
          : 'Connected';

  const statusColor = isSpeaking ? 'var(--color-purple-light)' : isThinking ? 'var(--color-warning)' : isListening ? 'var(--color-cyan)' : 'var(--color-text-muted)';

  return (
    <>
    {/* Hidden DOM audio element for iOS Safari — more reliable than JS-created Audio() */}
    {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
    <audio
      ref={(el) => { if (el && !reusableAudioRef.current) reusableAudioRef.current = el; }}
      autoPlay
      playsInline
      style={{ position: 'absolute', width: 0, height: 0, opacity: 0 }}
    />
    <div
      className="fixed inset-0 z-50 flex flex-col items-center justify-center backdrop-blur-sm transition-all duration-200"
      style={{
        backgroundColor: 'rgba(9, 9, 11, 0.95)',
        opacity: visible ? 1 : 0,
        transform: visible ? 'scale(1)' : 'scale(0.95)',
      }}
    >
      {/* Close button */}
      <button
        onClick={handleClose}
        className="absolute right-6 top-6 rounded-full p-2 transition-colors hover:bg-bg-tertiary z-20 text-text-secondary"
      >
        <X className="h-6 w-6" />
      </button>

      {/* Phase: Voice Picker */}
      {phase === 'picking' && (
        <div className="w-full h-full">
          <VoicePicker
            currentVoice={selectedVoice || undefined}
            onSelect={handleVoiceSelect}
            onPreview={handlePreview}
          />
        </div>
      )}

      {/* Phase: Active voice chat */}
      {phase === 'active' && (
        <>
          {/* Status */}
          <div className="mb-6 text-center">
            <div
              className="text-base font-medium mb-0.5 transition-colors duration-500 max-w-md truncate px-4"
              style={{ color: statusColor }}
            >
              {statusText}
            </div>
            {/* F5-TTS only — no fallback modes */}
            {errorMsg && (
              <div
                className="text-xs font-medium mt-1 animate-pulse text-error"
              >
                {errorMsg}
              </div>
            )}
            {/* Voice selector */}
            <div className="relative mt-2">
              <button
                onClick={() => setShowVoiceMenu(prev => !prev)}
                className="inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-medium transition-colors hover:bg-bg-tertiary"
                style={{ color: getVoiceInfo(selectedVoice || 'tara').glow }}
              >
                <span
                  className="inline-block w-2 h-2 rounded-full"
                  style={{ backgroundColor: getVoiceInfo(selectedVoice || 'tara').glow }}
                />
                {getVoiceInfo(selectedVoice || 'tara').name}
                <ChevronDown className="h-3 w-3" />
              </button>

              {showVoiceMenu && (
                <div
                  className="absolute left-1/2 -translate-x-1/2 mt-1 rounded-xl border border-bg-tertiary bg-bg-secondary/95 backdrop-blur-sm p-1.5 shadow-xl z-30"
                  style={{ minWidth: 180 }}
                >
                  {availableVoices.map(v => {
                    const info = getVoiceInfo(v);
                    const isActive = v === (selectedVoice || 'tara');
                    return (
                      <button
                        key={v}
                        onClick={() => switchVoice(v)}
                        className="flex items-center gap-2.5 w-full rounded-lg px-3 py-2 text-left text-sm transition-colors hover:bg-bg-tertiary"
                        style={{ color: isActive ? info.glow : 'var(--color-text-secondary)' }}
                      >
                        <span
                          className="w-2.5 h-2.5 rounded-full flex-shrink-0"
                          style={{
                            backgroundColor: info.glow,
                            boxShadow: isActive ? `0 0 8px ${info.glow}60` : 'none',
                          }}
                        />
                        <span className="font-medium">{info.name}</span>
                        {isActive && (
                          <span className="ml-auto text-xs opacity-60">✓</span>
                        )}
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          </div>

          {/* Fluid orb */}
          <FluidOrb
            audioLevel={isMuted ? 0 : audioLevel}
            speaker={isMuted ? 'idle' : activeSpeaker}
            size={260}
          />

          {/* Transcript */}
          <div className="mt-8 w-full max-w-lg px-4">
            <TranscriptView
              messages={messages}
              isListening={isListening && !isMuted}
            />
          </div>

          {/* Controls bar */}
          <div className="absolute bottom-12 flex items-center gap-6">
            <button
              onClick={toggleMute}
              className="rounded-full p-4 transition-colors"
              style={{
                backgroundColor: isMuted ? 'var(--color-error)' : 'var(--color-bg-tertiary)',
                color: 'var(--color-text)',
              }}
              title={isMuted ? 'Unmute' : 'Mute'}
            >
              {isMuted ? <MicOff className="h-6 w-6" /> : <Mic className="h-6 w-6" />}
            </button>

            <button
              onClick={handleClose}
              className="rounded-full p-4 transition-colors"
              style={{ backgroundColor: 'var(--color-error)', color: 'var(--color-text)' }}
              title="End call"
            >
              <PhoneOff className="h-6 w-6" />
            </button>
          </div>
        </>
      )}
    </div>
    </>
  );
}
