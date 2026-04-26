/**
 * TITAN — Model Trainer Skill (Built-in)
 * Fine-tunes local Ollama models on TITAN's own conversation history
 * using the GPU (RTX 5090) on Titan PC.
 *
 * Pipeline: prepare training data → launch LoRA fine-tune → poll progress → deploy to Ollama
 */
import { registerSkill } from '../registry.js';
import { loadConfig } from '../../config/config.js';
import logger from '../../utils/logger.js';
import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, appendFileSync } from 'fs';
import { join } from 'path';
import { TITAN_HOME } from '../../utils/constants.js';
import { execSync } from 'child_process';
import { EventEmitter } from 'events';

const COMPONENT = 'ModelTrainer';

// ── Training Progress Events ─────────────────────────────────────────
export interface TrainingProgressEvent {
    type: 'info' | 'progress' | 'success' | 'error' | 'complete';
    phase: 'generate' | 'train' | 'deploy' | 'prepare';
    message: string;
    timestamp: string;
    detail?: {
        category?: string;
        current?: number;
        total?: number;
        pct?: number;
        model?: string;
        loss?: number;
        examples?: number;
    };
}

export const trainingEvents = new EventEmitter();
trainingEvents.setMaxListeners(50);

function emitProgress(event: Omit<TrainingProgressEvent, 'timestamp'>): void {
    const full: TrainingProgressEvent = { ...event, timestamp: new Date().toISOString() };
    trainingEvents.emit('progress', full);
    // Also persist to a rolling log file for the UI to poll as fallback
    try {
        const logPath = join(TITAN_HOME, 'training-progress.jsonl');
        appendFileSync(logPath, JSON.stringify(full) + '\n', 'utf-8');
    } catch { /* best-effort */ }
}

// ── Paths ────────────────────────────────────────────────────────────
const TRAINING_DIR = join(TITAN_HOME, 'training-data');
const TRAINING_RUNS_DIR = join(TITAN_HOME, 'training-runs');
const TRAINING_HISTORY_PATH = join(TITAN_HOME, 'training-history.jsonl');

// ── Types ────────────────────────────────────────────────────────────

interface TrainingRun {
    id: string;
    status: 'preparing' | 'training' | 'completed' | 'failed' | 'deploying';
    startedAt: string;
    completedAt?: string;
    baseModel: string;
    method: string;
    dataPoints: number;
    epochs?: number;
    finalLoss?: number;
    outputModel?: string;
    error?: string;
}

interface TrainingDataPoint {
    instruction: string;
    response: string;
    toolsUsed?: string[];
    score?: number;
}

// ── Active training tracking ─────────────────────────────────────────
const activeRuns: Map<string, TrainingRun> = new Map();

// ── Helpers ──────────────────────────────────────────────────────────

function ensureDirs(): void {
    for (const dir of [TRAINING_DIR, TRAINING_RUNS_DIR]) {
        mkdirSync(dir, { recursive: true });
    }
}

function getRunId(): string {
    return `train-${Date.now().toString(36)}`;
}

function _appendTrainingHistory(run: TrainingRun): void {
    ensureDirs();
    appendFileSync(TRAINING_HISTORY_PATH, JSON.stringify(run) + '\n', 'utf-8');
}

function _readTrainingHistory(limit: number = 20): TrainingRun[] {
    if (!existsSync(TRAINING_HISTORY_PATH)) return [];
    try {
        const lines = readFileSync(TRAINING_HISTORY_PATH, 'utf-8').split('\n').filter(l => l.trim());
        const runs = lines.map(l => {
            try { return JSON.parse(l) as TrainingRun; }
            catch { return null; }
        }).filter(Boolean) as TrainingRun[];
        return runs.slice(-limit);
    } catch {
        return [];
    }
}
void _appendTrainingHistory;
void _readTrainingHistory;

/** Extract high-quality training pairs from TITAN's session database */
function extractTrainingData(): TrainingDataPoint[] {
    const dataPoints: TrainingDataPoint[] = [];

    // Try to read from session history files
    const sessionsDir = join(TITAN_HOME, 'sessions');
    if (!existsSync(sessionsDir)) {
        logger.warn(COMPONENT, 'No sessions directory found');
        return dataPoints;
    }

    try {
        const files = readdirSync(sessionsDir).filter(f => f.endsWith('.json'));
        for (const file of files.slice(-100)) { // Last 100 sessions
            try {
                const sessionData = JSON.parse(readFileSync(join(sessionsDir, file), 'utf-8'));
                const messages = sessionData.messages || sessionData.history || [];

                for (let i = 0; i < messages.length - 1; i++) {
                    const msg = messages[i];
                    const nextMsg = messages[i + 1];

                    if (msg.role === 'user' && nextMsg.role === 'assistant' && nextMsg.content) {
                        // Only include substantive exchanges
                        if (msg.content.length > 10 && nextMsg.content.length > 20) {
                            dataPoints.push({
                                instruction: msg.content,
                                response: nextMsg.content,
                                toolsUsed: nextMsg.toolsUsed || [],
                            });
                        }
                    }
                }
            } catch {
                // Skip corrupt session files
            }
        }
    } catch (e) {
        logger.warn(COMPONENT, `Error reading sessions: ${(e as Error).message}`);
    }

    // Also read from learning data for quality signals
    const learningPath = join(TITAN_HOME, 'learning.json');
    if (existsSync(learningPath)) {
        try {
            const learning = JSON.parse(readFileSync(learningPath, 'utf-8'));
            // Use tool success rates to score training data quality
            if (learning.toolSuccessRates) {
                // Boost data points that used successful tools
                for (const dp of dataPoints) {
                    if (dp.toolsUsed && dp.toolsUsed.length > 0) {
                        const avgRate = dp.toolsUsed.reduce((sum: number, tool: string) => {
                            const rate = learning.toolSuccessRates[tool];
                            return sum + (rate?.successRate || 0.5);
                        }, 0) / dp.toolsUsed.length;
                        dp.score = avgRate;
                    }
                }
            }
        } catch {
            // Ignore learning data errors
        }
    }

    // Sort by quality score (higher is better) and filter
    return dataPoints
        .sort((a, b) => (b.score || 0.5) - (a.score || 0.5))
        .filter(dp => (dp.score || 0.5) >= 0.4); // Exclude low-quality pairs
}

// ── Tool implementations ─────────────────────────────────────────────

async function trainPrepare(args: Record<string, unknown>): Promise<string> {
    const minSamples = (args.minSamples as number) || 50;

    ensureDirs();

    logger.info(COMPONENT, 'Extracting training data from session history...');
    const dataPoints = extractTrainingData();

    if (dataPoints.length < minSamples) {
        return `Not enough high-quality training data. Found ${dataPoints.length} pairs, need at least ${minSamples}. Keep using TITAN to build up more conversation history.`;
    }

    // Format as JSONL for training
    const jsonlPath = join(TRAINING_DIR, 'train.jsonl');
    const jsonlContent = dataPoints.map(dp => JSON.stringify({
        messages: [
            { role: 'user', content: dp.instruction },
            { role: 'assistant', content: dp.response },
        ],
    })).join('\n');

    writeFileSync(jsonlPath, jsonlContent, 'utf-8');

    // Create a validation split (10%)
    const valSize = Math.max(1, Math.floor(dataPoints.length * 0.1));
    const valData = dataPoints.slice(0, valSize);
    const valPath = join(TRAINING_DIR, 'val.jsonl');
    writeFileSync(valPath, valData.map(dp => JSON.stringify({
        messages: [
            { role: 'user', content: dp.instruction },
            { role: 'assistant', content: dp.response },
        ],
    })).join('\n'), 'utf-8');

    return [
        `## Training Data Prepared`,
        ``,
        `| Stat | Value |`,
        `|------|-------|`,
        `| Total pairs | ${dataPoints.length} |`,
        `| Training set | ${dataPoints.length - valSize} |`,
        `| Validation set | ${valSize} |`,
        `| Avg quality score | ${(dataPoints.reduce((s, d) => s + (d.score || 0.5), 0) / dataPoints.length).toFixed(2)} |`,
        ``,
        `Training data: \`${jsonlPath}\``,
        `Validation data: \`${valPath}\``,
        ``,
        `Ready to train. Use \`train_start\` to begin fine-tuning.`,
    ].join('\n');
}

async function trainStart(args: Record<string, unknown>): Promise<string> {
    const config = loadConfig();
    const trainingConfig = (config as Record<string, unknown>).training as Record<string, unknown> | undefined;

    if (trainingConfig && trainingConfig.enabled === false) {
        return 'Training is disabled in config. Set training.enabled = true to enable.';
    }

    // Model resolution: explicit arg → config → active model (if local/ollama) → fallback
    const activeModel = config.agent?.model || '';
    const activeModelName = activeModel.replace(/^ollama\//, '');
    const isLocalModel = activeModel.startsWith('ollama/') || (!activeModel.includes('/') && activeModel.length > 0);
    const baseModel = (args.baseModel as string)
        || (trainingConfig?.baseModel as string)
        || (isLocalModel ? activeModelName : '')
        || 'qwen3.5:35b';
    const method = (args.method as string) || (trainingConfig?.method as string) || 'lora';
    const budgetMinutes = (args.budgetMinutes as number) || (trainingConfig?.budgetMinutes as number) || 30;
    const epochs = (args.epochs as number) || 3;

    const trainDataPath = join(TRAINING_DIR, 'train.jsonl');
    if (!existsSync(trainDataPath)) {
        return 'No training data found. Run `train_prepare` first.';
    }

    const dataLines = readFileSync(trainDataPath, 'utf-8').split('\n').filter(l => l.trim());
    if (dataLines.length < 10) {
        return `Only ${dataLines.length} training samples — need at least 10. Run \`train_prepare\` to extract more data.`;
    }

    const runId = getRunId();
    const runDir = join(TRAINING_RUNS_DIR, runId);
    mkdirSync(runDir, { recursive: true });

    const run: TrainingRun = {
        id: runId,
        status: 'training',
        startedAt: new Date().toISOString(),
        baseModel,
        method,
        dataPoints: dataLines.length,
        epochs,
    };
    activeRuns.set(runId, run);

    // Generate training script
    const trainScript = `#!/usr/bin/env python3
"""TITAN Auto-Training Script — LoRA fine-tuning via unsloth"""
import os, sys, json, time, torch

# Check if unsloth is available
try:
    from unsloth import FastLanguageModel
    from trl import SFTTrainer
    from transformers import TrainingArguments
    from datasets import load_dataset
    HAS_UNSLOTH = True
except ImportError:
    HAS_UNSLOTH = False
    print("WARNING: unsloth not installed. Install with: pip install unsloth")
    print("Falling back to simulation mode for testing.")

OUTPUT_DIR = "${runDir}"
DATA_PATH = "${trainDataPath}"
BASE_MODEL = "${baseModel}"
EPOCHS = ${epochs}
MAX_MINUTES = ${budgetMinutes}

# Map Ollama model names to HuggingFace model IDs
OLLAMA_TO_HF = {
    "qwen3.5:35b": "Qwen/Qwen3.5-9B",  # 35B MoE too large for single GPU — use 9B dense
    "qwen3.5:7b": "Qwen/Qwen3.5-7B",
    "qwen3:30b": "Qwen/Qwen3-30B-A3B",
    "qwen3:8b": "Qwen/Qwen3-8B",
    "llama3.1:8b": "meta-llama/Llama-3.1-8B-Instruct",
    "llama3.1:70b": "meta-llama/Llama-3.1-70B-Instruct",
    "mistral:7b": "mistralai/Mistral-7B-Instruct-v0.3",
    "gemma2:9b": "google/gemma-2-9b-it",
    "phi3:14b": "microsoft/Phi-3-medium-128k-instruct",
    "devstral-small-2": "mistralai/Devstral-Small-2505",
}

def resolve_model_name(name):
    """Resolve Ollama model name to HuggingFace model ID."""
    if name in OLLAMA_TO_HF:
        hf_name = OLLAMA_TO_HF[name]
        print(f"Resolved Ollama model '{name}' -> HuggingFace '{hf_name}'")
        return hf_name
    # If it looks like a HF model (contains /), use as-is
    if "/" in name:
        return name
    print(f"WARNING: Unknown model '{name}', trying as HuggingFace ID directly")
    return name

def main():
    start = time.time()

    if not HAS_UNSLOTH:
        # Simulation mode — still produces a evaluable val_score so the
        # autopilot can benchmark improvements. Score is derived from data
        # quality (line count, JSON validity) rather than fake constants.
        import random
        print(f"[SIM] Loading base model: {BASE_MODEL}")
        print(f"[SIM] Training data: {DATA_PATH}")
        time.sleep(2)

        # Compute a data-quality heuristic that stays stable across runs
        data_score = 0.0
        try:
            with open(DATA_PATH, "r") as f:
                lines = f.readlines()
            total = len(lines)
            valid_json = sum(1 for line in lines if line.strip() and line.strip().startswith("{"))
            data_score = min(100.0, (valid_json / max(total, 1)) * 100.0 + total * 0.5)
        except Exception:
            data_score = 45.0

        best_loss = 999.0
        for epoch in range(1, EPOCHS + 1):
            elapsed = time.time() - start
            if elapsed > MAX_MINUTES * 60:
                print(f"[SIM] Time budget exhausted at epoch {epoch}")
                break
            loss = max(0.5, 2.5 - (epoch * 0.3) - (data_score / 100.0))
            best_loss = min(best_loss, loss)
            print(f"Epoch {epoch}/{EPOCHS} — loss: {loss:.4f}")
            time.sleep(1)

        # val_score = inverse of loss, scaled to 0-100, boosted by data quality
        val_score = round(min(100.0, max(0.0, (3.0 - best_loss) * 40.0 + data_score * 0.2)), 2)

        # Write results
        with open(os.path.join(OUTPUT_DIR, "results.json"), "w") as f:
            json.dump({
                "status": "simulated",
                "epochs": EPOCHS,
                "final_loss": round(best_loss, 4),
                "val_score": val_score,
                "model_path": None,
                "note": "unsloth not installed — score is a data-quality heuristic"
            }, f)
        print(f"Training complete (simulated) — val_score: {val_score}")
        return

    # Real training with unsloth
    hf_model = resolve_model_name(BASE_MODEL)
    print(f"Loading base model: {hf_model}")
    model, tokenizer = FastLanguageModel.from_pretrained(
        model_name=hf_model,
        max_seq_length=2048,
        dtype=None,  # Auto-detect
        load_in_4bit=True,
    )

    model = FastLanguageModel.get_peft_model(
        model,
        r=16,
        target_modules=["q_proj", "k_proj", "v_proj", "o_proj", "gate_proj", "up_proj", "down_proj"],
        lora_alpha=16,
        lora_dropout=0,
        bias="none",
        use_gradient_checkpointing="unsloth",
    )

    dataset = load_dataset("json", data_files=DATA_PATH, split="train")
    print(f"Loaded {len(dataset)} training examples")

    # Format chat messages into text using the tokenizer's chat template
    def format_chat(example):
        text = tokenizer.apply_chat_template(example["messages"], tokenize=False, add_generation_prompt=False)
        return {"text": text}

    dataset = dataset.map(format_chat)
    print(f"Formatted dataset — sample length: {len(dataset[0]['text'])} chars")

    trainer = SFTTrainer(
        model=model,
        tokenizer=tokenizer,
        train_dataset=dataset,
        dataset_text_field="text",
        max_seq_length=2048,
        packing=True,
        args=TrainingArguments(
            output_dir=OUTPUT_DIR,
            per_device_train_batch_size=${(args.batchSize as number) || 4},
            gradient_accumulation_steps=4,
            num_train_epochs=EPOCHS,
            learning_rate=${(args.learningRate as number) || 2e-4},
            fp16=False,
            bf16=True,
            logging_steps=1,
            save_strategy="epoch",
            warmup_steps=10,
            weight_decay=0.01,
            lr_scheduler_type="cosine",
            max_steps=-1,
            report_to="none",
        ),
    )

    print("Starting training...")
    gpu_stats = torch.cuda.get_device_properties(0)
    print(f"GPU: {gpu_stats.name}, VRAM: {gpu_stats.total_memory / 1024**3:.1f} GB")
    result = trainer.train()

    # Save LoRA adapter
    adapter_dir = os.path.join(OUTPUT_DIR, "lora_adapter")
    model.save_pretrained(adapter_dir)
    tokenizer.save_pretrained(adapter_dir)
    print(f"LoRA adapter saved to {adapter_dir}")

    # Also save as merged GGUF for Ollama
    print("Saving merged model as GGUF (Q4_K_M)...")
    try:
        model.save_pretrained_gguf(
            os.path.join(OUTPUT_DIR, "gguf"),
            tokenizer,
            quantization_method="q4_k_m",
        )
        print("GGUF export complete")
    except Exception as e:
        print(f"GGUF export failed (non-fatal): {e}")

    with open(os.path.join(OUTPUT_DIR, "results.json"), "w") as f:
        json.dump({
            "status": "completed",
            "epochs": EPOCHS,
            "final_loss": result.training_loss,
            "model_path": adapter_dir,
            "gguf_path": os.path.join(OUTPUT_DIR, "gguf"),
        }, f)

    print(f"Training complete — loss: {result.training_loss:.4f}")

if __name__ == "__main__":
    main()
`;

    const scriptPath = join(runDir, 'train.py');
    writeFileSync(scriptPath, trainScript, 'utf-8');

    // Launch training as background process
    try {
        // Prefer venv python (has unsloth installed), fall back to system python3
        const venvCandidates = [
            join(TITAN_HOME, 'venv', 'bin', 'python'),   // ~/.titan/venv
            '/opt/TITAN/venv/bin/python',                  // production deploy
        ];
        const pythonBin = venvCandidates.find(p => existsSync(p)) ?? 'python3';
        execSync(`${pythonBin} "${scriptPath}" > "${join(runDir, 'train.log')}" 2>&1 &`, {
            stdio: 'pipe',
            timeout: 5000,
        });
    } catch {
        // Background process launch — may appear to "fail" but actually started
        logger.info(COMPONENT, 'Training process launched in background');
    }

    // Save run metadata
    writeFileSync(join(runDir, 'meta.json'), JSON.stringify(run, null, 2), 'utf-8');

    return [
        `## Training Started`,
        ``,
        `| Setting | Value |`,
        `|---------|-------|`,
        `| Run ID | ${runId} |`,
        `| Base model | ${baseModel} |`,
        `| Method | ${method} |`,
        `| Training samples | ${dataLines.length} |`,
        `| Epochs | ${epochs} |`,
        `| Budget | ${budgetMinutes} min |`,
        ``,
        `Training log: \`${join(runDir, 'train.log')}\``,
        `Use \`train_status\` to check progress.`,
    ].join('\n');
}

async function trainStatus(args: Record<string, unknown>): Promise<string> {
    const runId = args.runId as string | undefined;

    if (runId) {
        const runDir = join(TRAINING_RUNS_DIR, runId);
        if (!existsSync(runDir)) {
            return `Training run "${runId}" not found.`;
        }

        const logPath = join(runDir, 'train.log');
        const resultsPath = join(runDir, 'results.json');

        const lines: string[] = [`## Training Run: ${runId}\n`];

        if (existsSync(resultsPath)) {
            const results = JSON.parse(readFileSync(resultsPath, 'utf-8'));
            lines.push(`**Status**: ${results.status}`);
            lines.push(`**Final loss**: ${results.final_loss}`);
            lines.push(`**Epochs**: ${results.epochs}`);
            if (results.model_path) {
                lines.push(`**Model path**: ${results.model_path}`);
            }
        } else if (existsSync(logPath)) {
            const log = readFileSync(logPath, 'utf-8');
            const lastLines = log.trim().split('\n').slice(-10);
            lines.push('**Status**: training...\n');
            lines.push('### Recent log output:');
            lines.push('```');
            lines.push(lastLines.join('\n'));
            lines.push('```');
        } else {
            lines.push('**Status**: waiting to start...');
        }

        return lines.join('\n');
    }

    // List all runs
    const lines: string[] = ['## Training Runs\n'];

    if (existsSync(TRAINING_RUNS_DIR)) {
        const dirs = readdirSync(TRAINING_RUNS_DIR, { withFileTypes: true })
            .filter(d => d.isDirectory())
            .map(d => d.name)
            .sort()
            .reverse();

        if (dirs.length > 0) {
            lines.push('| Run ID | Base Model | Status | Loss | Samples |');
            lines.push('|--------|-----------|--------|------|---------|');

            for (const dir of dirs.slice(0, 10)) {
                const metaPath = join(TRAINING_RUNS_DIR, dir, 'meta.json');
                const resultsPath = join(TRAINING_RUNS_DIR, dir, 'results.json');

                if (existsSync(metaPath)) {
                    const meta = JSON.parse(readFileSync(metaPath, 'utf-8'));
                    let status = 'unknown';
                    let loss = '-';

                    if (existsSync(resultsPath)) {
                        const results = JSON.parse(readFileSync(resultsPath, 'utf-8'));
                        status = results.status || 'completed';
                        loss = results.final_loss?.toFixed(4) || '-';
                    } else {
                        status = 'training...';
                    }

                    lines.push(`| ${dir} | ${meta.baseModel} | ${status} | ${loss} | ${meta.dataPoints} |`);
                }
            }
        } else {
            lines.push('No training runs found. Use `train_prepare` then `train_start` to begin.');
        }
    } else {
        lines.push('No training runs found.');
    }

    return lines.join('\n');
}

async function trainDeploy(args: Record<string, unknown>): Promise<string> {
    const runId = args.runId as string;
    const modelName = (args.modelName as string) || 'titan-custom';

    if (!runId) {
        return 'Error: runId is required. Use `train_status` to find completed runs.';
    }

    const runDir = join(TRAINING_RUNS_DIR, runId);
    const resultsPath = join(runDir, 'results.json');

    if (!existsSync(resultsPath)) {
        return `Training run "${runId}" not found or not completed.`;
    }

    const results = JSON.parse(readFileSync(resultsPath, 'utf-8'));
    if (results.status === 'simulated') {
        return [
            `## Deploy — Simulated Run`,
            ``,
            `This was a simulated training run (unsloth not installed).`,
            `To deploy a real model:`,
            `1. Install unsloth on Titan PC: \`pip install unsloth\``,
            `2. Run \`train_start\` again for real training`,
            `3. Then \`train_deploy\` to create an Ollama model`,
        ].join('\n');
    }

    if (!results.model_path || !existsSync(results.model_path)) {
        return `Model adapter not found at ${results.model_path}. Training may not have completed successfully.`;
    }

    // Create Modelfile for Ollama
    const config = loadConfig();
    const trainingConfig = (config as Record<string, unknown>).training as Record<string, unknown> | undefined;
    // Use configured base model, or active local model, or fallback
    const activeModel = config.agent?.model || '';
    const activeModelName = activeModel.replace(/^ollama\//, '');
    const isLocalModel = activeModel.startsWith('ollama/') || (!activeModel.includes('/') && activeModel.length > 0);
    const baseModel = (trainingConfig?.baseModel as string)
        || (isLocalModel ? activeModelName : '')
        || 'qwen3.5:35b';

    const modelfilePath = join(runDir, 'Modelfile');
    const modelfileContent = `FROM ${baseModel}
ADAPTER ${results.model_path}

PARAMETER temperature 0.7
PARAMETER num_ctx 65536

SYSTEM You are TITAN, an intelligent task automation agent. You help users accomplish complex tasks by selecting and using the right tools efficiently.
`;

    writeFileSync(modelfilePath, modelfileContent, 'utf-8');

    // Try to create Ollama model
    try {
        logger.info(COMPONENT, `Creating Ollama model: ${modelName}`);
        execSync(`ollama create ${modelName} -f "${modelfilePath}"`, {
            stdio: 'pipe',
            timeout: 300_000, // 5 min timeout for model creation
        });

        // Optionally switch TITAN's model
        const autoDeploy = trainingConfig?.autoDeploy;
        let switchedModel = false;
        if (autoDeploy) {
            try {
                const { saveConfig } = await import('../../config/config.js');
                const currentConfig = loadConfig();
                currentConfig.agent.model = `ollama/${modelName}`;
                saveConfig(currentConfig);
                switchedModel = true;
            } catch (e) {
                logger.warn(COMPONENT, `Auto-deploy config update failed: ${(e as Error).message}`);
            }
        }

        // Update run
        results.status = 'deployed';
        results.deployedModel = `ollama/${modelName}`;
        writeFileSync(resultsPath, JSON.stringify(results, null, 2), 'utf-8');

        return [
            `## Model Deployed`,
            ``,
            `| Setting | Value |`,
            `|---------|-------|`,
            `| Model name | ${modelName} |`,
            `| Ollama ID | ollama/${modelName} |`,
            `| Base model | ${baseModel} |`,
            `| Final loss | ${results.final_loss} |`,
            `| Auto-switched | ${switchedModel ? 'yes' : 'no'} |`,
            ``,
            switchedModel
                ? `TITAN is now using \`ollama/${modelName}\` as its default model.`
                : `Model available as \`ollama/${modelName}\`. Use \`/model ollama/${modelName}\` to switch.`,
        ].join('\n');
    } catch (err) {
        return `Error creating Ollama model: ${(err as Error).message}\n\nMake sure Ollama is running and accessible.`;
    }
}

// ── Cloud-Assisted Training Data Generation ──────────────────────────

const TITAN_SYSTEM_PROMPT = `You are TITAN (The Intelligent Task Automation Network), an autonomous AI agent framework. You help users accomplish complex tasks by selecting and executing tools efficiently. Always respond concisely and accurately. Use tools when appropriate — answer directly when you can.`;

const CLOUD_TRAINING_CATEGORIES: Record<string, { description: string; prompts: string[] }> = {
    tool_use: {
        description: 'Single and multi-tool usage with proper function calling format',
        prompts: [
            'What is the weather in San Francisco right now?',
            'Search the web for the latest news about AI agents',
            'Read the file at /home/user/project/README.md',
            'Create a new file called notes.txt with my meeting notes',
            'Find all Python files in the current directory',
            'Send an email to team@company.com with the weekly report',
            'Check the disk usage on this machine',
            'What time is it in Tokyo?',
            'Search GitHub for repositories related to autonomous agents',
            'Take a screenshot of https://news.ycombinator.com',
            'Browse to https://example.com and extract the main heading',
            'Run the command "npm test" and tell me if the tests pass',
            'Look up the DNS records for anthropic.com',
            'Download the file at https://example.com/data.csv',
            'Check if port 8080 is in use on this machine',
        ],
    },
    reasoning: {
        description: 'Multi-step reasoning, planning, and problem decomposition',
        prompts: [
            'I need to deploy a Node.js app to production. Walk me through the steps.',
            'Compare PostgreSQL vs MongoDB for a real-time chat application',
            'My API is returning 500 errors intermittently. How should I debug this?',
            'Design a caching strategy for an e-commerce product catalog',
            'What are the tradeoffs between microservices and a monolith for a startup?',
            'Plan a migration from REST to GraphQL for an existing API',
            'How do I set up CI/CD for a TypeScript project with GitHub Actions?',
            'Explain the CAP theorem and how it applies to distributed databases',
            'What is the best approach to handle rate limiting in a public API?',
            'How should I structure a React app with 50+ components?',
        ],
    },
    coding: {
        description: 'Code generation, debugging, and refactoring',
        prompts: [
            'Write a TypeScript function that retries a fetch request with exponential backoff',
            'Debug this code: const result = await fetch(url); const data = result.json();',
            'Refactor this function to use async/await instead of .then() chains',
            'Write a Python script to process a CSV file and output JSON',
            'Create a React hook that debounces user input',
            'Write a SQL query to find the top 10 customers by total spend',
            'Implement a simple LRU cache in TypeScript',
            'Write a bash script that monitors disk usage and alerts if over 90%',
            'Create an Express middleware for request logging with timestamps',
            'Write unit tests for a function that validates email addresses',
        ],
    },
    research: {
        description: 'Web research, information gathering, and synthesis',
        prompts: [
            'Research the current state of autonomous AI agent frameworks in 2026',
            'Find the top 5 competitors to TITAN and compare their features',
            'What are the latest developments in LoRA fine-tuning techniques?',
            'Summarize the key findings from the latest GPT-5 benchmarks',
            'Research best practices for securing a Node.js production server',
            'What are the most popular MCP servers available right now?',
            'Find recent papers on multi-agent orchestration systems',
            'Research the current pricing for cloud GPU instances for AI training',
        ],
    },
    conversation: {
        description: 'Natural dialogue, follow-ups, and context maintenance',
        prompts: [
            'Hey TITAN, what can you do?',
            'Tell me about yourself',
            'What tools do you have available?',
            'Can you help me with my project?',
            'Thanks for your help earlier with the deployment',
            'I changed my mind about the previous request, can we try a different approach?',
            'What was the last thing we worked on?',
            'How many tools do you have loaded right now?',
        ],
    },
    error_recovery: {
        description: 'Handling errors, failed tools, and graceful degradation',
        prompts: [
            'The web_search tool just returned an error. Can you try a different approach?',
            'I got a timeout when trying to fetch that URL. What should we do?',
            'The file I asked you to read does not exist. Can you help me find it?',
            'The shell command failed with exit code 1. What went wrong?',
            'Ollama is not responding. Can you still help me?',
            'The API returned a 429 rate limit error. How do we handle this?',
            'My browser automation script is failing because the page layout changed',
            'The database connection timed out. What are our options?',
        ],
    },
};

async function callOllamaCloud(model: string, systemPrompt: string, userPrompt: string): Promise<string> {
    const cfg = loadConfig();
    const ollamaUrl = cfg.providers.ollama?.baseUrl || process.env.OLLAMA_HOST || 'http://localhost:11434';
    try {
        const resp = await fetch(`${ollamaUrl}/api/chat`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                model,
                messages: [
                    { role: 'system', content: systemPrompt },
                    { role: 'user', content: userPrompt },
                ],
                stream: false,
                options: { temperature: 0.8, num_predict: 1024 },
            }),
            signal: AbortSignal.timeout(120_000),
        });
        if (!resp.ok) throw new Error(`Ollama returned ${resp.status}`);
        const data = await resp.json() as { message?: { content?: string } };
        return data.message?.content || '';
    } catch (err) {
        logger.warn(COMPONENT, `Cloud model call failed: ${(err as Error).message}`);
        return '';
    }
}

async function trainGenerateCloud(args: Record<string, unknown>): Promise<string> {
    const teacherModel = (args.teacherModel as string) || 'qwen3.5:397b-cloud';
    const totalCount = (args.count as number) || 200;
    const appendMode = args.append !== false; // default true
    const categoryFilter = args.categories
        ? (args.categories as string).split(',').map(c => c.trim())
        : Object.keys(CLOUD_TRAINING_CATEGORIES);

    ensureDirs();

    logger.info(COMPONENT, `Cloud training data generation: teacher=${teacherModel}, count=${totalCount}, categories=${categoryFilter.join(',')}`);
    emitProgress({ type: 'info', phase: 'generate', message: `Starting cloud training data generation`, detail: { model: teacherModel, total: totalCount } });

    // Validate teacher model is accessible
    emitProgress({ type: 'info', phase: 'generate', message: `Testing connection to ${teacherModel}...` });
    const testResp = await callOllamaCloud(teacherModel, 'You are a helpful assistant.', 'Say OK');
    if (!testResp) {
        emitProgress({ type: 'error', phase: 'generate', message: `Cannot reach teacher model "${teacherModel}"` });
        return `Error: Cannot reach teacher model "${teacherModel}". Make sure it is pulled in Ollama.\nAvailable cloud models: qwen3.5:397b-cloud, nemotron-3-super:cloud, qwen3-coder-next:cloud, glm-5:cloud, kimi-k2.5:cloud, gemini-3-flash-preview`;
    }
    emitProgress({ type: 'success', phase: 'generate', message: `Connected to ${teacherModel}` });

    const activeCategories = categoryFilter.filter(c => c in CLOUD_TRAINING_CATEGORIES);
    if (activeCategories.length === 0) {
        return `No valid categories. Choose from: ${Object.keys(CLOUD_TRAINING_CATEGORIES).join(', ')}`;
    }

    const perCategory = Math.ceil(totalCount / activeCategories.length);
    let totalGenerated = 0;
    let totalFailed = 0;
    const stats: Record<string, { generated: number; failed: number }> = {};

    // Write incrementally to disk so data survives tool timeouts
    const jsonlPath = join(TRAINING_DIR, 'train.jsonl');
    const valPath = join(TRAINING_DIR, 'val.jsonl');

    // If not appending, clear existing files
    if (!appendMode) {
        writeFileSync(jsonlPath, '', 'utf-8');
        writeFileSync(valPath, '', 'utf-8');
    }

    for (const catName of activeCategories) {
        const cat = CLOUD_TRAINING_CATEGORIES[catName];
        stats[catName] = { generated: 0, failed: 0 };
        const prompts = cat.prompts;

        logger.info(COMPONENT, `Generating ${perCategory} "${catName}" examples with ${teacherModel}...`);
        emitProgress({ type: 'info', phase: 'generate', message: `Starting category: ${catName}`, detail: { category: catName, current: 0, total: perCategory } });

        for (let i = 0; i < perCategory; i++) {
            // Pick a prompt (cycle through available, then ask teacher to generate new ones)
            let userPrompt: string;
            if (i < prompts.length) {
                userPrompt = prompts[i];
            } else {
                // Ask teacher to generate a novel prompt for this category
                const novelPrompt = await callOllamaCloud(teacherModel,
                    'You generate diverse, realistic user prompts for an AI agent assistant. Output ONLY the user prompt, nothing else.',
                    `Generate a unique, realistic user prompt for the category "${catName}" (${cat.description}). Make it different from these existing ones:\n${prompts.slice(0, 5).join('\n')}\n\nOutput only the prompt text.`,
                );
                userPrompt = novelPrompt.trim() || prompts[i % prompts.length];
            }

            // Generate the ideal TITAN response from the teacher
            const teacherSystemPrompt = `${TITAN_SYSTEM_PROMPT}

You are generating a training example for the TITAN agent. Respond exactly as TITAN should respond to this user message. Be concise, helpful, and use the appropriate approach:
- If the task requires a tool, describe what tool you would use and how
- If you can answer directly, give a clear, accurate response
- Show your reasoning for complex questions
- Be practical and action-oriented`;

            const response = await callOllamaCloud(teacherModel, teacherSystemPrompt, userPrompt);

            if (response && response.length > 20) {
                const example = {
                    messages: [
                        { role: 'system', content: TITAN_SYSTEM_PROMPT },
                        { role: 'user', content: userPrompt },
                        { role: 'assistant', content: response },
                    ],
                };
                // Write immediately to disk (incremental — survives timeouts)
                appendFileSync(jsonlPath, JSON.stringify(example) + '\n', 'utf-8');
                // Every 10th example also goes to validation set
                if (totalGenerated % 10 === 0) {
                    appendFileSync(valPath, JSON.stringify(example) + '\n', 'utf-8');
                }
                stats[catName].generated++;
                totalGenerated++;
                emitProgress({
                    type: 'progress', phase: 'generate',
                    message: `Generated example ${totalGenerated}/${totalCount}`,
                    detail: { category: catName, current: totalGenerated, total: totalCount, pct: Math.round((totalGenerated / totalCount) * 100), examples: totalGenerated },
                });
            } else {
                stats[catName].failed++;
                totalFailed++;
                emitProgress({ type: 'error', phase: 'generate', message: `Failed to generate example (${catName} #${i + 1})`, detail: { category: catName } });
            }

            // Log progress periodically
            if (i > 0 && i % 10 === 0) {
                logger.info(COMPONENT, `  ${catName}: ${i}/${perCategory} generated (${totalGenerated} total on disk)...`);
            }
        }
    }

    if (totalGenerated === 0) {
        return 'Error: No training examples generated. Check teacher model connectivity.';
    }

    // Count total lines in training file
    const totalLines = readFileSync(jsonlPath, 'utf-8').split('\n').filter(l => l.trim()).length;

    // Build report
    const lines = [
        `## Cloud-Assisted Training Data Generated`,
        ``,
        `| Setting | Value |`,
        `|---------|-------|`,
        `| Teacher model | ${teacherModel} |`,
        `| Examples generated | ${totalGenerated} |`,
        `| Failed | ${totalFailed} |`,
        `| Total in file | ${totalLines} |`,
        `| Mode | ${appendMode ? 'append' : 'overwrite'} |`,
        `| Output | \`${jsonlPath}\` |`,
        ``,
        `### By Category`,
        `| Category | Generated | Failed |`,
        `|----------|-----------|--------|`,
    ];

    for (const [cat, s] of Object.entries(stats)) {
        lines.push(`| ${cat} | ${s.generated} | ${s.failed} |`);
    }

    lines.push('');
    lines.push(`Ready to fine-tune. Use \`train_start\` to begin LoRA training on the local GPU.`);

    emitProgress({
        type: 'complete', phase: 'generate',
        message: `Cloud training data generation complete: ${totalGenerated} examples (${totalLines} total in file)`,
        detail: { examples: totalGenerated, total: totalCount },
    });

    return lines.join('\n');
}

// ── Registration ─────────────────────────────────────────────────────

export function registerModelTrainerSkill(): void {

    registerSkill(
        {
            name: 'model_trainer',
            description: 'Use this when the user says "train on this", "fine-tune with these examples", "add this to training data", "teach yourself from our conversation", or wants to improve the local model using past interactions. Runs LoRA fine-tuning on the RTX 5090 GPU.',
            version: '1.0.0',
            source: 'bundled',
            enabled: true,
        },
        {
            name: 'train_prepare',
            description: 'Prepare training data before launching a fine-tune. Use this when asked to "get the training data ready", "collect examples", or "prepare for training". Scans TITAN\'s conversation history, extracts high-quality instruction/response pairs scored by tool success rates, and saves as JSONL ready for fine-tuning.',
            parameters: {
                type: 'object',
                properties: {
                    minSamples: {
                        type: 'number',
                        description: 'Minimum training samples required before proceeding (default: 50)',
                    },
                },
                required: [],
            },
            execute: trainPrepare,
        },
    );

    registerSkill(
        {
            name: 'model_trainer',
            description: 'Use this when the user says "train on this", "fine-tune with these examples", "add this to training data", "teach yourself from our conversation", or wants to improve the local model using past interactions. Runs LoRA fine-tuning on the RTX 5090 GPU.',
            version: '1.0.0',
            source: 'bundled',
            enabled: true,
        },
        {
            name: 'train_start',
            description: 'Start a LoRA fine-tuning job on the local GPU. Use when the user says "start training", "fine-tune the model", or "run the training". Requires training data to be prepared first (train_prepare). Runs as a background process on the RTX 5090.',
            parameters: {
                type: 'object',
                properties: {
                    baseModel: {
                        type: 'string',
                        description: 'Base model to fine-tune (default: from config, e.g. qwen3.5:35b)',
                    },
                    method: {
                        type: 'string',
                        description: 'Training method: lora, qlora, or full (default: lora)',
                    },
                    budgetMinutes: {
                        type: 'number',
                        description: 'Training time budget in minutes (default: 30)',
                    },
                    epochs: {
                        type: 'number',
                        description: 'Number of training epochs (default: 3)',
                    },
                },
                required: [],
            },
            execute: trainStart,
        },
    );

    registerSkill(
        {
            name: 'model_trainer',
            description: 'Use this when the user says "train on this", "fine-tune with these examples", "add this to training data", "teach yourself from our conversation", or wants to improve the local model using past interactions. Runs LoRA fine-tuning on the RTX 5090 GPU.',
            version: '1.0.0',
            source: 'bundled',
            enabled: true,
        },
        {
            name: 'train_status',
            description: 'Check how a training job is progressing. Use when asked "how is training going?", "what\'s the loss?", "is training done?". Shows log output, current loss, and completion status. Without a runId, lists all training runs.',
            parameters: {
                type: 'object',
                properties: {
                    runId: {
                        type: 'string',
                        description: 'Specific training run ID to check (optional — omit to list all runs)',
                    },
                },
                required: [],
            },
            execute: trainStatus,
        },
    );

    registerSkill(
        {
            name: 'model_trainer',
            description: 'Use this when the user says "train on this", "fine-tune with these examples", "add this to training data", "teach yourself from our conversation", or wants to improve the local model using past interactions. Runs LoRA fine-tuning on the RTX 5090 GPU.',
            version: '1.0.0',
            source: 'bundled',
            enabled: true,
        },
        {
            name: 'train_deploy',
            description: 'Deploy a completed fine-tuned model into Ollama so TITAN can use it. Use when training is done and the user says "deploy the model", "use the trained model", or "switch to the fine-tuned version".',
            parameters: {
                type: 'object',
                properties: {
                    runId: {
                        type: 'string',
                        description: 'Training run ID to deploy (from train_status)',
                    },
                    modelName: {
                        type: 'string',
                        description: 'Name for the deployed Ollama model (default: titan-custom)',
                    },
                },
                required: ['runId'],
            },
            execute: trainDeploy,
        },
    );

    // ── Cloud-Assisted Training Data Generation ──────────────────────

    registerSkill(
        {
            name: 'model_trainer',
            description: 'Use this when the user says "train on this", "fine-tune with these examples", "add this to training data", "teach yourself from our conversation", or wants to improve the local model using past interactions. Runs LoRA fine-tuning on the RTX 5090 GPU.',
            version: '1.0.0',
            source: 'bundled',
            enabled: true,
        },
        {
            name: 'train_generate_cloud',
            description: 'Generate synthetic training examples using a large cloud model as teacher. Use when the user says "generate training data", "create examples for fine-tuning", or "use the cloud model to teach the local model". A smart cloud model (e.g. qwen3.5:397b-cloud) produces diverse, high-quality agent examples across tool use, reasoning, coding, research, conversation, and error recovery.',
            parameters: {
                type: 'object',
                properties: {
                    teacherModel: {
                        type: 'string',
                        description: 'Cloud model to use as teacher (default: qwen3.5:397b-cloud)',
                    },
                    count: {
                        type: 'number',
                        description: 'Number of training examples to generate (default: 200)',
                    },
                    categories: {
                        type: 'string',
                        description: 'Which categories to generate: tool_use, reasoning, coding, research, conversation, error_recovery (default: all)',
                    },
                    append: {
                        type: 'boolean',
                        description: 'Append to existing training data instead of overwriting (default: true)',
                    },
                },
                required: [],
            },
            execute: trainGenerateCloud,
        },
    );

    logger.info(COMPONENT, 'Model trainer skill registered (5 tools)');
}
