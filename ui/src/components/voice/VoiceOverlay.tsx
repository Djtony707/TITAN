import { useState, useEffect, useCallback, useRef } from 'react';
import { X, Mic, MicOff, PhoneOff, ChevronDown } from 'lucide-react';
import { FluidOrb } from './FluidOrb';
import { TranscriptView } from './TranscriptView';
import { VoicePicker, getVoiceInfo } from './VoicePicker';
import { apiFetch } from '@/api/client';

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

/** Strip Orpheus emotion tags for display (keep for TTS) */
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
 * Direct voice mode — uses browser Web Speech API for STT and Orpheus TTS for speech.
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
  const [ttsMode, setTtsMode] = useState<'orpheus' | 'qwen3-tts' | 'browser' | null>(null);
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
  const isIOSRef = useRef(typeof navigator !== 'undefined' && /iPad|iPhone|iPod/.test(navigator.userAgent));

  /** Play audio data via Web Audio API (iOS-safe) or HTMLAudioElement (desktop) */
  const playAudioData = useCallback((blobUrl: string): Promise<void> => {
    return new Promise(async (resolve) => {
      // iOS path: use Web Audio API (AudioContext stays unlocked after user gesture)
      if (isIOSRef.current && playbackCtxRef.current) {
        try {
          const response = await fetch(blobUrl);
          const arrayBuffer = await response.arrayBuffer();
          const audioBuffer = await playbackCtxRef.current.decodeAudioData(arrayBuffer);
          // Stop any currently playing source
          try { currentSourceRef.current?.stop(); } catch { /* ok */ }
          const source = playbackCtxRef.current.createBufferSource();
          source.buffer = audioBuffer;
          source.connect(playbackCtxRef.current.destination);
          currentSourceRef.current = source;
          source.onended = () => { URL.revokeObjectURL(blobUrl); resolve(); };
          source.start(0);
          try { recognitionRef.current?.stop(); } catch { /* ok */ }
          return;
        } catch (e) {
          console.warn('[Voice] Web Audio playback failed, falling back to Audio element:', e);
        }
      }
      // Desktop path: use Audio element
      const audio = reusableAudioRef.current || new Audio();
      currentAudioRef.current = audio;
      audio.onplay = () => { try { recognitionRef.current?.stop(); } catch { /* ok */ } };
      audio.onended = () => { URL.revokeObjectURL(blobUrl); resolve(); };
      audio.onerror = () => { URL.revokeObjectURL(blobUrl); resolve(); };
      audio.src = blobUrl;
      audio.play().catch(() => { URL.revokeObjectURL(blobUrl); resolve(); });
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
            setTtsMode(data.engine || 'orpheus');
            // If saved voice isn't in the new list, switch to first available
            if (savedVoice && !data.voices.includes(savedVoice)) {
              const newVoice = data.voices[0];
              setSelectedVoice(newVoice);
              selectedVoiceRef.current = newVoice;
              localStorage.setItem('titan-voice', newVoice);
            }
          } else {
            setAvailableVoices(['tara', 'leah', 'jess', 'mia', 'zoe', 'leo', 'dan', 'zac']);
          }
        }
      } catch {
        setAvailableVoices(['tara', 'leah', 'jess', 'mia', 'zoe', 'leo', 'dan', 'zac']);
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

  // Send user message to TITAN and speak the response via streaming TTS
  const handleUserMessage = useCallback(async (text: string) => {
    // Prevent overlapping calls (echo can trigger rapid duplicate messages)
    if (processingRef.current) return;
    processingRef.current = true;

    // If TITAN is speaking, interrupt it
    stopCurrentAudio();

    // Abort any in-flight requests
    abortRef.current?.abort();

    setMessages(prev => [...prev, { id: nextMsgId(), role: 'user', text }]);
    setIsThinking(true);
    setIsListening(false);
    setErrorMsg(null);

    // Pause recognition while processing
    try { recognitionRef.current?.stop(); } catch { /* ok */ }

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      // Try streaming endpoint first (sentence-by-sentence TTS)
      const timeoutId = setTimeout(() => controller.abort(), 60000);
      const voice = selectedVoiceRef.current || 'tara';

      const res = await apiFetch('/api/voice/stream', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          content: text,
          sessionId: sessionIdRef.current,
          voice,
        }),
        signal: controller.signal,
      });
      clearTimeout(timeoutId);

      // Fallback to old sequential path if streaming endpoint doesn't exist
      if (res.status === 404) {
        await handleUserMessageLegacy(text);
        return;
      }
      if (!res.ok) throw new Error(`TITAN request failed (${res.status})`);

      // Parse SSE stream
      const reader = res.body?.getReader();
      if (!reader) throw new Error('No response body');

      const decoder = new TextDecoder();
      let buffer = '';
      const sentences: string[] = [];
      let assistantMsgId = '';
      let displayText = '';
      let audioPlaying = false;

      // Reactive audio player — items pushed as they arrive from SSE
      const audioPlayer = createAudioPlayer();

      const audioDoneCleanup = () => {
        currentAudioRef.current = null;
        setIsSpeaking(false);
        setAudioLevel(0);
        currentTranscriptRef.current = '';
        setInterimText('');
        setTimeout(() => {
          processingRef.current = false;
          if (!isMutedRef.current && phaseRef.current === 'active') {
            try { recognitionRef.current?.start(); } catch { /* ok */ }
          }
        }, 500);
      };

      let currentEvent = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (line.startsWith('event: ')) {
            currentEvent = line.slice(7).trim();
          } else if (line.startsWith('data: ') && currentEvent) {
            try {
              const data = JSON.parse(line.slice(6));
              const evt = currentEvent;
              currentEvent = '';

              if (evt === 'tts_mode') {
                setTtsMode(data.engine || 'browser');
              } else if (evt === 'sentence') {
                sentences.push(data.text);
                displayText = sentences.join(' ');
                if (!assistantMsgId) {
                  assistantMsgId = nextMsgId();
                  setMessages(prev => [...prev, { id: assistantMsgId, role: 'assistant', text: displayText }]);
                } else {
                  setMessages(prev => prev.map(m => m.id === assistantMsgId ? { ...m, text: displayText } : m));
                }
                setIsThinking(false);
              } else if (evt === 'audio') {
                // Convert base64 WAV to blob URL and push to reactive queue
                const binary = atob(data.audio);
                const bytes = new Uint8Array(binary.length);
                for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
                const blob = new Blob([bytes], { type: 'audio/wav' });
                audioPlayer.push(URL.createObjectURL(blob));

                // Start playback on first audio chunk
                if (!audioPlaying) {
                  audioPlaying = true;
                  setIsSpeaking(true);
                  setIsThinking(false);
                  audioPlayer.start(audioDoneCleanup);
                }
              } else if (evt === 'tool') {
                setIsThinking(true);
              } else if (evt === 'done') {
                if (data.sessionId) sessionIdRef.current = data.sessionId;
                if (!assistantMsgId && data.fullText) {
                  const clean = stripToolNarration(stripEmotionTags(stripMarkdown(data.fullText)));
                  setMessages(prev => [...prev, { id: nextMsgId(), role: 'assistant', text: clean }]);
                }
                if (data.error) {
                  setMessages(prev => [...prev, { id: nextMsgId(), role: 'assistant', text: 'Sorry, something went wrong.' }]);
                }
              }
            } catch { currentEvent = ''; }
          } else if (line === '') {
            currentEvent = '';
          }
        }
      }

      // Stream ended — tell the audio player no more chunks are coming
      audioPlayer.finish();

      // If no audio was played (browser TTS mode or TTS failure), handle cleanup
      if (!audioPlaying) {
        setIsThinking(false);
        setIsSpeaking(false);
        // Try browser TTS for the full text
        if (displayText && 'speechSynthesis' in window) {
          setIsSpeaking(true);
          const utterance = new SpeechSynthesisUtterance(displayText.slice(0, 500));
          utterance.rate = 1.05;
          const synthInterval = setInterval(() => setAudioLevel(0.3 + Math.random() * 0.3), 100);
          utterance.onend = () => {
            clearInterval(synthInterval);
            setIsSpeaking(false);
            setAudioLevel(0);
            currentTranscriptRef.current = '';
            setTimeout(() => {
              processingRef.current = false;
              if (!isMutedRef.current && phaseRef.current === 'active') {
                try { recognitionRef.current?.start(); } catch { /* ok */ }
              }
            }, 500);
          };
          utterance.onerror = () => {
            clearInterval(synthInterval);
            setIsSpeaking(false);
            processingRef.current = false;
            try { recognitionRef.current?.start(); } catch { /* ok */ }
          };
          window.speechSynthesis.cancel();
          window.speechSynthesis.speak(utterance);
        } else {
          currentTranscriptRef.current = '';
          processingRef.current = false;
          try { recognitionRef.current?.start(); } catch { /* ok */ }
        }
      }
    } catch (e: any) {
      // Ignore aborts from component close
      if (e?.name === 'AbortError' && !abortRef.current) return;

      const isTimeout = e?.name === 'AbortError';
      const msg = isTimeout ? 'Request timed out' : 'Connection error';
      setErrorMsg(msg);
      setTimeout(() => setErrorMsg(null), 4000);
      console.error('Voice processing error:', e);
      setMessages(prev => [...prev, { id: nextMsgId(), role: 'assistant', text: isTimeout ? 'Sorry, that took too long. Try again.' : 'Sorry, something went wrong.' }]);
      setIsThinking(false);
      setIsSpeaking(false);
      currentTranscriptRef.current = '';
      processingRef.current = false;
      try { recognitionRef.current?.start(); } catch { /* ok */ }
    }
  }, [stopCurrentAudio, createAudioPlayer]);

  // Legacy sequential path — fallback when /api/voice/stream is not available
  const handleUserMessageLegacy = useCallback(async (text: string) => {
    const controller = abortRef.current;
    if (!controller) return;

    try {
      const res = await apiFetch('/api/message', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ content: text, channel: 'voice', sessionId: sessionIdRef.current }),
        signal: controller.signal,
      });
      if (!res.ok) throw new Error(`TITAN request failed (${res.status})`);
      const data = await res.json();
      if (data.sessionId) sessionIdRef.current = data.sessionId;

      const rawText = data.content || 'Sorry, I couldn\'t process that.';
      const displayText = stripToolNarration(stripEmotionTags(stripMarkdown(rawText)));
      setMessages(prev => [...prev, { id: nextMsgId(), role: 'assistant', text: displayText }]);
      setIsThinking(false);
      setIsSpeaking(true);

      const voice = selectedVoiceRef.current || 'tara';
      const ttsText = displayText.length > 500 ? displayText.slice(0, 497) + '...' : displayText;

      try {
        const ttsRes = await apiFetch('/api/voice/preview', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ voice, text: ttsText }),
          signal: AbortSignal.timeout(15000),
        });
        if (ttsRes.ok) {
          const blob = await ttsRes.blob();
          const url = URL.createObjectURL(blob);
          // Reuse persistent Audio element for iOS compatibility
          const audio = reusableAudioRef.current || new Audio();
          currentAudioRef.current = audio;
          audio.onplay = () => { try { recognitionRef.current?.stop(); } catch { /* ok */ } };
          const cleanup = () => {
            URL.revokeObjectURL(url);
            audio.src = '';
            currentAudioRef.current = null;
            setIsSpeaking(false);
            setAudioLevel(0);
            currentTranscriptRef.current = '';
            setTimeout(() => {
              processingRef.current = false;
              if (!isMutedRef.current && phaseRef.current === 'active') {
                try { recognitionRef.current?.start(); } catch { /* ok */ }
              }
            }, 500);
          };
          audio.onended = cleanup;
          audio.onerror = cleanup;
          await audio.play();
          return;
        }
      } catch { /* TTS failed, fall through */ }

      // Browser TTS fallback
      if ('speechSynthesis' in window) {
        const utterance = new SpeechSynthesisUtterance(ttsText);
        utterance.rate = 1.05;
        utterance.onend = () => {
          setIsSpeaking(false);
          currentTranscriptRef.current = '';
          setTimeout(() => {
            processingRef.current = false;
            if (!isMutedRef.current && phaseRef.current === 'active') {
              try { recognitionRef.current?.start(); } catch { /* ok */ }
            }
          }, 500);
        };
        utterance.onerror = () => {
          setIsSpeaking(false);
          processingRef.current = false;
          try { recognitionRef.current?.start(); } catch { /* ok */ }
        };
        window.speechSynthesis.cancel();
        window.speechSynthesis.speak(utterance);
      } else {
        setIsSpeaking(false);
        processingRef.current = false;
        try { recognitionRef.current?.start(); } catch { /* ok */ }
      }
    } catch (e: any) {
      setIsThinking(false);
      setIsSpeaking(false);
      processingRef.current = false;
      try { recognitionRef.current?.start(); } catch { /* ok */ }
    }
  }, []);

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
      const res = await apiFetch('/api/voice/preview', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ voice: voiceId, text: 'Hey! I\'m TITAN, your AI assistant.' }),
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

  const statusColor = isSpeaking ? '#a78bfa' : isThinking ? '#f59e0b' : isListening ? '#22d3ee' : '#71717a';

  return (
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
        className="absolute right-6 top-6 rounded-full p-2 transition-colors hover:bg-[#27272a] z-20"
        style={{ color: '#a1a1aa' }}
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
            {ttsMode === 'browser' && (
              <div
                className="text-xs font-medium mt-1"
                style={{ color: '#f59e0b' }}
              >
                TTS server unavailable — using browser voice
              </div>
            )}
            {errorMsg && (
              <div
                className="text-xs font-medium mt-1 animate-pulse"
                style={{ color: '#ef4444' }}
              >
                {errorMsg}
              </div>
            )}
            {/* Voice selector */}
            <div className="relative mt-2">
              <button
                onClick={() => setShowVoiceMenu(prev => !prev)}
                className="inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-medium transition-colors hover:bg-[#27272a]"
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
                  className="absolute left-1/2 -translate-x-1/2 mt-1 rounded-xl border border-[#27272a] bg-[#18181b]/95 backdrop-blur-sm p-1.5 shadow-xl z-30"
                  style={{ minWidth: 180 }}
                >
                  {availableVoices.map(v => {
                    const info = getVoiceInfo(v);
                    const isActive = v === (selectedVoice || 'tara');
                    return (
                      <button
                        key={v}
                        onClick={() => switchVoice(v)}
                        className="flex items-center gap-2.5 w-full rounded-lg px-3 py-2 text-left text-sm transition-colors hover:bg-[#27272a]"
                        style={{ color: isActive ? info.glow : '#a1a1aa' }}
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
                backgroundColor: isMuted ? '#ef4444' : '#27272a',
                color: '#fafafa',
              }}
              title={isMuted ? 'Unmute' : 'Mute'}
            >
              {isMuted ? <MicOff className="h-6 w-6" /> : <Mic className="h-6 w-6" />}
            </button>

            <button
              onClick={handleClose}
              className="rounded-full p-4 transition-colors"
              style={{ backgroundColor: '#ef4444', color: '#fafafa' }}
              title="End call"
            >
              <PhoneOff className="h-6 w-6" />
            </button>
          </div>
        </>
      )}
    </div>
  );
}
