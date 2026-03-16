/**
 * TITAN — Voice Tools
 * Provides Speech-to-Text (STT) and Text-to-Speech (TTS) capabilities using OpenAI APIs.
 */
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { v4 as uuid } from 'uuid';
import { registerSkill } from '../registry.js';
import type { ToolHandler } from '../../agent/toolRunner.js';
import { loadConfig } from '../../config/config.js';
import logger from '../../utils/logger.js';

const COMPONENT = 'VoiceTool';

const metaSTT = {
    name: 'transcribe_audio',
    description: 'Transcribes an audio file (mp3, wav, ogg, m4a) into text using OpenAI Whisper.',
    version: '1.0.0',
    source: 'bundled' as const,
    enabled: true,
};

const metaTTS = {
    name: 'generate_speech',
    description: 'Converts text into spoken audio (mp3) using OpenAI TTS.',
    version: '1.0.0',
    source: 'bundled' as const,
    enabled: true,
};

const sttHandler: ToolHandler = {
    name: 'transcribe_audio',
    description: 'Transcribe an audio file into text using OpenAI Whisper (STT).\n\nUSE THIS WHEN Tony says: "transcribe this audio" / "what does this voice note say" / "convert this recording to text" / "read this audio file"\n\nRequires an audio file path on the filesystem. Supported formats: mp3, mp4, mpeg, mpga, m4a, wav, webm, ogg.\nRequires OpenAI API key configured.',
    parameters: {
        type: 'object',
        properties: {
            filePath: {
                type: 'string',
                description: 'The absolute path to the audio file (supported formats: mp3, mp4, mpeg, mpga, m4a, wav, webm, ogg).',
            }
        },
        required: ['filePath'],
    },
    execute: async (args: Record<string, unknown>) => {
        const filePath = args.filePath as string;
        if (!filePath || !existsSync(filePath)) {
            return `Error: Audio file not found at ${filePath}`;
        }

        const config = loadConfig();
        const apiKey = config.providers.openai?.apiKey;
        if (!apiKey) {
            return "Error: OpenAI API key is missing. Voice transcription requires OpenAI.";
        }

        try {
            logger.info(COMPONENT, `Transcribing audio file: ${filePath}`);

            const fileBuffer = readFileSync(filePath);
            const blob = new Blob([fileBuffer]);
            const formData = new FormData();
            formData.append('file', blob, 'audio.ogg'); // The extension hints the format to Whisper
            formData.append('model', 'whisper-1');

            const response = await fetch('https://api.openai.com/v1/audio/transcriptions', {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${apiKey}`
                },
                body: formData
            });

            if (!response.ok) {
                throw new Error(`OpenAI STT error: ${await response.text()}`);
            }

            const data = await response.json() as { text: string };
            return `Transcript: "${data.text}"`;
        } catch (e: unknown) {
            logger.error(COMPONENT, `Transcription failed: ${(e as Error).message}`);
            return `Error transcribing audio: ${(e as Error).message}`;
        }
    }
};

const ttsHandler: ToolHandler = {
    name: 'generate_speech',
    description: 'Convert text to spoken audio (MP3) using OpenAI TTS.\n\nUSE THIS WHEN Tony says: "say that out loud" / "speak this" / "read this to me" / "generate audio for X" / "create a voice message" / "speak X"\n\nRULES:\n- Call this tool immediately when Tony asks for speech — do NOT just print the text\n- Returns the path to the saved MP3 file\n- Voice options: alloy (default), echo, fable, onyx, nova, shimmer\n- Requires OpenAI API key configured',
    parameters: {
        type: 'object',
        properties: {
            text: {
                type: 'string',
                description: 'The text you want to convert to speech.',
            },
            voice: {
                type: 'string',
                description: 'The voice to use. Options: alloy, echo, fable, onyx, nova, shimmer. Default is alloy.',
            }
        },
        required: ['text'],
    },
    execute: async (args: Record<string, unknown>) => {
        const text = args.text as string;
        const voice = (args.voice as string) || 'alloy';

        if (!text) return "Error: You must provide text to generate speech.";

        const config = loadConfig();
        const apiKey = config.providers.openai?.apiKey;
        if (!apiKey) {
            return "Error: OpenAI API key is missing. TTS requires OpenAI.";
        }

        try {
            logger.info(COMPONENT, `Generating speech with voice ${voice}`);

            const response = await fetch('https://api.openai.com/v1/audio/speech', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${apiKey}`
                },
                body: JSON.stringify({
                    model: 'tts-1',
                    input: text,
                    voice: voice
                })
            });

            if (!response.ok) {
                throw new Error(`OpenAI TTS error: ${await response.text()}`);
            }

            const arrayBuffer = await response.arrayBuffer();
            const buffer = Buffer.from(arrayBuffer);

            const tmpPath = join(tmpdir(), `titan_voice_${uuid().substring(0, 8)}.mp3`);
            writeFileSync(tmpPath, buffer);

            return `Success. Generated MP3 audio file saved to: ${tmpPath}`;
        } catch (e: unknown) {
            logger.error(COMPONENT, `TTS failed: ${(e as Error).message}`);
            return `Error generating speech: ${(e as Error).message}`;
        }
    }
};

export function registerVoiceSkills(): void {
    registerSkill(metaSTT, sttHandler);
    registerSkill(metaTTS, ttsHandler);
}
