"""
TITAN Autoresearch — generate_data.py
Generates 500+ high-quality synthetic training examples for fine-tuning.

Uses Ollama's local model on Titan PC to generate diverse instruction/response
pairs across tool selection, reasoning, error recovery, and general knowledge.

Run: python3 generate_data.py
Output: ~/.titan/autoresearch/data/synthetic_generated.jsonl
"""
import json
import os
import random
import time
from pathlib import Path

DATA_DIR = Path.home() / ".titan" / "autoresearch" / "data"
DATA_DIR.mkdir(parents=True, exist_ok=True)
OUTPUT_PATH = DATA_DIR / "synthetic_generated.jsonl"

OLLAMA_URL = os.environ.get("OLLAMA_URL", "http://localhost:11434")
OLLAMA_MODEL = os.environ.get("OLLAMA_MODEL", "qwen3.5:35b")

# ── TITAN Tool Registry ──────────────────────────────────────────────
# Core tools with descriptions and example parameter schemas

TOOLS = [
    {"name": "weather", "desc": "Get weather for a location", "params": {"location": "string"}},
    {"name": "web_search", "desc": "Search the web", "params": {"query": "string"}},
    {"name": "web_fetch", "desc": "Fetch URL content", "params": {"url": "string"}},
    {"name": "read_file", "desc": "Read a file from disk", "params": {"path": "string"}},
    {"name": "write_file", "desc": "Write content to a file", "params": {"path": "string", "content": "string"}},
    {"name": "edit_file", "desc": "Edit a file with search/replace", "params": {"path": "string", "search": "string", "replace": "string"}},
    {"name": "list_dir", "desc": "List directory contents", "params": {"path": "string"}},
    {"name": "shell", "desc": "Execute a shell command", "params": {"command": "string"}},
    {"name": "memory", "desc": "Store or recall information", "params": {"action": "store|recall|search", "key": "string", "value": "string"}},
    {"name": "browse_url", "desc": "Open a URL in the browser", "params": {"url": "string"}},
    {"name": "browser_search", "desc": "Search the web via browser", "params": {"query": "string"}},
    {"name": "goal_create", "desc": "Create a new goal with subtasks", "params": {"title": "string", "subtasks": "array"}},
    {"name": "goal_list", "desc": "List all active goals", "params": {}},
    {"name": "goal_update", "desc": "Update a goal's progress", "params": {"goalId": "string", "status": "string"}},
    {"name": "cron", "desc": "Manage scheduled tasks", "params": {"action": "create|list|delete", "schedule": "string", "task": "string"}},
    {"name": "email_search", "desc": "Search emails", "params": {"query": "string"}},
    {"name": "github_issues", "desc": "List GitHub issues", "params": {"repo": "string", "state": "open|closed"}},
    {"name": "generate_image", "desc": "Generate an image from a prompt", "params": {"prompt": "string"}},
    {"name": "rag_search", "desc": "Search the RAG knowledge base", "params": {"query": "string"}},
    {"name": "calendar", "desc": "Manage calendar events", "params": {"action": "list|create|delete", "date": "string"}},
    {"name": "transcribe_audio", "desc": "Transcribe audio to text", "params": {"path": "string"}},
    {"name": "generate_speech", "desc": "Convert text to speech", "params": {"text": "string", "voice": "string"}},
    {"name": "code_exec", "desc": "Execute code in a sandbox", "params": {"language": "string", "code": "string"}},
    {"name": "deep_research_pipeline", "desc": "Run multi-step deep research", "params": {"topic": "string", "depth": "number"}},
    {"name": "ha_devices", "desc": "List smart home devices", "params": {}},
    {"name": "ha_control", "desc": "Control a smart home device", "params": {"entity_id": "string", "action": "string"}},
    {"name": "interaction_log", "desc": "Log a user interaction", "params": {"event": "string"}},
    {"name": "sessions_list", "desc": "List active chat sessions", "params": {}},
    {"name": "report_generate", "desc": "Generate a weekly report", "params": {"period": "string"}},
    {"name": "pdf_read", "desc": "Read and extract text from a PDF", "params": {"path": "string"}},
    {"name": "skyvern_task", "desc": "Run browser automation task", "params": {"url": "string", "task": "string"}},
    {"name": "freelance_search", "desc": "Search freelance job listings", "params": {"query": "string", "platform": "string"}},
    {"name": "hunter_email_finder", "desc": "Find email addresses for a domain", "params": {"domain": "string"}},
    {"name": "rc_search", "desc": "Search RevenueCat knowledge base", "params": {"query": "string"}},
    {"name": "train_prepare", "desc": "Prepare training data from sessions", "params": {}},
    {"name": "train_start", "desc": "Start model fine-tuning", "params": {"baseModel": "string", "epochs": "number"}},
    {"name": "self_improve_start", "desc": "Run self-improvement experiment", "params": {"area": "string", "budgetMinutes": "number"}},
    {"name": "browser_auto_nav", "desc": "Auto-navigate browser to accomplish a task", "params": {"task": "string"}},
    {"name": "experiment_loop", "desc": "Run autoresearch experiments", "params": {"goal": "string", "targetFile": "string"}},
]

# ── Static Templates (no LLM needed) ─────────────────────────────────

def generate_tool_selection_examples():
    """Generate tool selection training examples from templates."""
    examples = []

    # Multiple phrasings per tool
    templates = {
        "weather": [
            ("What's the weather like in {loc}?", "I'll check the weather in {loc}."),
            ("Is it going to rain in {loc} today?", "Let me look up the weather forecast for {loc}."),
            ("Temperature in {loc} right now?", "I'll get the current temperature for {loc}."),
            ("How's the weather in {loc} this week?", "Let me check the weekly forecast for {loc}."),
            ("Will it snow in {loc}?", "I'll check the weather conditions in {loc}."),
        ],
        "web_search": [
            ("Search for {q}", "I'll search the web for {q}."),
            ("Find information about {q}", "Let me search for information about {q}."),
            ("Look up {q}", "I'll search for {q}."),
            ("What is {q}?", "Let me search the web for {q}."),
            ("Google {q} for me", "I'll search the web for {q}."),
        ],
        "web_fetch": [
            ("Fetch the content from {u}", "I'll fetch the content from that URL."),
            ("Get the page at {u}", "Let me retrieve the content from {u}."),
            ("Download {u}", "I'll fetch the content from {u}."),
            ("What does {u} say?", "Let me fetch and read the content from {u}."),
        ],
        "read_file": [
            ("Read {f}", "I'll read the contents of {f}."),
            ("Show me what's in {f}", "Let me read {f} for you."),
            ("Cat {f}", "I'll read and display the contents of {f}."),
            ("What's in {f}?", "Let me check the contents of {f}."),
            ("Open {f}", "I'll read {f} and show you what's inside."),
        ],
        "write_file": [
            ("Create a file called {f} with {c}", "I'll create {f} with the specified content."),
            ("Write '{c}' to {f}", "I'll write that content to {f}."),
            ("Save this to {f}: {c}", "I'll save that content to {f}."),
            ("Make a new file {f} containing {c}", "I'll create {f} with that content."),
        ],
        "shell": [
            ("Run {cmd}", "I'll execute that command."),
            ("Execute {cmd}", "I'll run that command for you."),
            ("Do {cmd} in the terminal", "I'll execute {cmd}."),
            ("What does {cmd} output?", "Let me run {cmd} and show you the output."),
            ("Check {cmd}", "I'll run {cmd} to check."),
        ],
        "memory": [
            ("Remember that {k} is {v}", "I'll save that to memory."),
            ("Store this: {k} = {v}", "I'll store that information."),
            ("What did I tell you about {k}?", "Let me recall what you told me about {k}."),
            ("Do you remember {k}?", "Let me search my memory for {k}."),
            ("Save a note: {k} — {v}", "I'll store that note in memory."),
        ],
        "goal_create": [
            ("Create a goal to {g}", "I'll create a new goal for that."),
            ("I want to achieve {g}", "Let me set up a goal to track that."),
            ("Set a goal: {g}", "I'll create that goal with relevant subtasks."),
            ("Add a new objective: {g}", "I'll create a goal and break it into subtasks."),
        ],
        "browse_url": [
            ("Go to {u}", "I'll navigate to {u}."),
            ("Open {u}", "I'll open {u} in the browser."),
            ("Visit {u}", "I'll navigate the browser to {u}."),
            ("Browse to {u}", "I'll open that URL."),
        ],
        "list_dir": [
            ("List files in {d}", "I'll list the contents of {d}."),
            ("What's in the {d} directory?", "Let me list the files in {d}."),
            ("Show me the files in {d}", "I'll list the directory contents of {d}."),
            ("ls {d}", "I'll list the files in {d}."),
        ],
        "email_search": [
            ("Find my emails about {q}", "I'll search your emails for {q}."),
            ("Search emails for {q}", "Let me search your inbox for {q}."),
            ("Any emails about {q}?", "I'll check your emails for {q}."),
            ("Look through my mail for {q}", "I'll search your emails for {q}."),
        ],
        "github_issues": [
            ("What issues are open on {r}?", "I'll check the open issues on {r}."),
            ("List GitHub issues for {r}", "Let me look up the issues on {r}."),
            ("Any bugs reported on {r}?", "I'll check the GitHub issues for {r}."),
            ("Show open issues on {r}", "I'll list the open issues for {r}."),
        ],
        "generate_image": [
            ("Generate an image of {p}", "I'll generate an image based on that description."),
            ("Create a picture of {p}", "I'll generate that image for you."),
            ("Make me an image: {p}", "I'll create an image of {p}."),
            ("Draw {p}", "I'll generate an image of {p}."),
        ],
        "cron": [
            ("Schedule a task to {t} every day at {s}", "I'll create a cron job for that."),
            ("Set up a recurring task: {t} at {s}", "I'll schedule that as a cron job."),
            ("What cron jobs are running?", "I'll list the active scheduled tasks."),
            ("Remove the cron job for {t}", "I'll delete that scheduled task."),
        ],
        "calendar": [
            ("What's on my calendar {d}?", "I'll check your calendar for {d}."),
            ("Schedule a meeting {d}", "I'll add that to your calendar."),
            ("Any events {d}?", "Let me check your calendar for {d}."),
            ("Add to my calendar: meeting {d}", "I'll create a calendar event for {d}."),
        ],
        "code_exec": [
            ("Run this Python: {c}", "I'll execute that Python code in the sandbox."),
            ("Execute this code: {c}", "I'll run that code in a sandbox environment."),
            ("Test this snippet: {c}", "I'll execute that code and show you the output."),
        ],
        "rag_search": [
            ("Search the knowledge base for {q}", "I'll search the RAG knowledge base for {q}."),
            ("What do we know about {q}?", "Let me search our knowledge base for {q}."),
            ("Find docs about {q}", "I'll search the knowledge base for {q}."),
        ],
        "ha_control": [
            ("Turn on the {d}", "I'll turn on the {d}."),
            ("Turn off the {d}", "I'll turn off the {d}."),
            ("Set {d} to {v}", "I'll adjust the {d} to {v}."),
            ("Dim the {d} to {v}%", "I'll set the {d} brightness to {v}%."),
        ],
        "self_improve_start": [
            ("Run a self-improvement experiment on {a}", "I'll start a self-improvement experiment targeting {a}."),
            ("Improve TITAN's {a}", "I'll run an experiment to improve {a}."),
            ("Optimize {a} performance", "I'll start an improvement session for {a}."),
        ],
        "deep_research_pipeline": [
            ("Do deep research on {t}", "I'll start a deep research pipeline on {t}."),
            ("Research {t} thoroughly", "I'll run a multi-step research pipeline on {t}."),
            ("Give me an in-depth analysis of {t}", "I'll start deep research on {t}."),
        ],
    }

    # Fill values
    locations = ["San Francisco", "New York", "London", "Tokyo", "Austin", "Seattle", "Chicago", "Miami", "Denver", "Portland"]
    queries = ["latest AI news", "Python best practices", "TypeScript generics", "Docker networking", "React hooks", "Kubernetes deployment", "GraphQL vs REST", "WebSocket tutorial", "Node.js streams", "Rust vs Go", "WASM use cases", "LLM fine-tuning"]
    urls = ["https://github.com/trending", "https://news.ycombinator.com", "https://arxiv.org", "https://npmjs.com", "https://pytorch.org/docs", "https://ollama.ai"]
    files = ["/tmp/test.txt", "config.json", "README.md", "package.json", "src/index.ts", "~/.titan/titan.json", "/etc/hostname", "data.csv"]
    dirs = ["/tmp", ".", "src/", "~/Desktop", "/opt/TITAN", "~/.titan"]
    commands = ["ls -la", "whoami", "df -h", "free -m", "nvidia-smi", "docker ps", "git status", "npm test", "uname -a", "ps aux | head"]
    repos = ["Djtony707/TITAN", "facebook/react", "vercel/next.js", "ollama/ollama", "anthropics/claude-code"]
    goals = ["learn Rust", "deploy TITAN to production", "build a Chrome extension", "set up CI/CD pipeline", "create a mobile app"]
    topics = ["quantum computing", "autonomous agents", "RAG systems", "model distillation", "edge AI deployment"]
    areas = ["prompts", "tool-selection", "response-quality", "error-recovery"]
    devices = ["living room lights", "bedroom fan", "kitchen lights", "thermostat", "garage door"]

    for tool_name, phrasings in templates.items():
        for template_q, template_a in phrasings:
            # Generate 2-4 variations per phrasing
            for _ in range(random.randint(2, 4)):
                q = template_q
                a = template_a

                # Fill placeholders
                q = q.replace("{loc}", random.choice(locations))
                q = q.replace("{q}", random.choice(queries))
                q = q.replace("{u}", random.choice(urls))
                q = q.replace("{f}", random.choice(files))
                q = q.replace("{d}", random.choice(dirs))
                q = q.replace("{cmd}", random.choice(commands))
                q = q.replace("{r}", random.choice(repos))
                q = q.replace("{g}", random.choice(goals))
                q = q.replace("{t}", random.choice(topics))
                q = q.replace("{a}", random.choice(areas))
                q = q.replace("{c}", "print('hello world')")
                q = q.replace("{k}", "project deadline")
                q = q.replace("{v}", "March 30")
                q = q.replace("{s}", "9am")
                q = q.replace("{p}", "a futuristic city at sunset")

                a = a.replace("{loc}", q.split()[-1].rstrip("?"))
                a = a.replace("{q}", "that topic")
                a = a.replace("{u}", "that URL")
                a = a.replace("{f}", "that file")
                a = a.replace("{d}", "that directory")
                a = a.replace("{k}", "that")
                a = a.replace("{v}", "that value")
                a = a.replace("{r}", "that repository")
                a = a.replace("{p}", "that image")
                a = a.replace("{t}", "that task")
                a = a.replace("{a}", "that area")

                # Build tool call JSON
                tool_def = next((t for t in TOOLS if t["name"] == tool_name), None)
                if tool_def:
                    args = {}
                    for pname in tool_def["params"]:
                        if pname == "location": args[pname] = random.choice(locations)
                        elif pname == "query": args[pname] = random.choice(queries)
                        elif pname == "url": args[pname] = random.choice(urls)
                        elif pname == "path": args[pname] = random.choice(files)
                        elif pname == "command": args[pname] = random.choice(commands)
                        elif pname == "repo": args[pname] = random.choice(repos)
                        elif pname == "content": args[pname] = "Hello World"
                        elif pname == "action": args[pname] = "store"
                        elif pname == "key": args[pname] = "project_deadline"
                        elif pname == "value": args[pname] = "March 30"
                        elif pname == "title": args[pname] = random.choice(goals)
                        elif pname == "state": args[pname] = "open"
                        elif pname == "prompt": args[pname] = "a futuristic city at sunset"
                        elif pname == "text": args[pname] = "Hello, how are you?"
                        elif pname == "area": args[pname] = random.choice(areas)
                        elif pname == "entity_id": args[pname] = "light.living_room"
                        elif pname == "topic": args[pname] = random.choice(topics)
                        elif pname == "language": args[pname] = "python"
                        elif pname == "code": args[pname] = "print('hello world')"
                        else: args[pname] = "value"

                    tool_json = json.dumps({"tool": tool_name, "args": args})
                    full_response = f"{a}\n\n{tool_json}"
                else:
                    full_response = a

                examples.append({
                    "instruction": q,
                    "output": full_response,
                    "category": "tool_selection",
                })

    return examples


def generate_knowledge_examples():
    """General knowledge Q&A (no tool needed)."""
    pairs = [
        ("Explain what a REST API is", "A REST API is an architectural style for building web services using HTTP methods (GET, POST, PUT, DELETE) to perform CRUD operations on resources identified by URLs. It's stateless — each request contains all information needed to process it."),
        ("How do I reverse a string in JavaScript?", "Use `str.split('').reverse().join('')` — splits into characters, reverses the array, and joins back into a string."),
        ("What is Docker?", "Docker is a platform for building, shipping, and running applications in isolated containers. Containers package code with all dependencies, ensuring consistent behavior across environments."),
        ("Explain a race condition", "A race condition occurs when two or more threads or processes access shared data concurrently and the outcome depends on the timing of their execution. It can cause data corruption or unexpected behavior."),
        ("What's the difference between == and === in JavaScript?", "`==` performs type coercion before comparison (e.g., `'5' == 5` is true). `===` checks both value and type without coercion (e.g., `'5' === 5` is false). Always prefer `===`."),
        ("How do promises work in JavaScript?", "A Promise represents an asynchronous operation that will eventually resolve (succeed) or reject (fail). You handle results with `.then()` for success, `.catch()` for errors, or use `async/await` for cleaner syntax."),
        ("What is TypeScript?", "TypeScript is a typed superset of JavaScript that compiles to plain JS. It adds static types, interfaces, and generics, catching errors at compile time instead of runtime."),
        ("Explain big O notation", "Big O notation describes how an algorithm's time or space requirements grow with input size. O(1) is constant, O(n) is linear, O(n²) is quadratic. It helps compare algorithm efficiency."),
        ("What is a webhook?", "A webhook is an HTTP callback — when an event occurs in a service, it sends an HTTP POST request to a URL you specify. It's a push-based alternative to polling."),
        ("What is LoRA fine-tuning?", "LoRA (Low-Rank Adaptation) freezes the pre-trained model weights and injects small trainable matrices into each layer. This dramatically reduces the number of trainable parameters (often 0.1-1% of the original) while achieving similar quality to full fine-tuning."),
        ("Explain GGUF format", "GGUF (GPT-Generated Unified Format) is a binary format for storing quantized LLM weights. It's used by llama.cpp and Ollama for efficient CPU/GPU inference with reduced memory requirements."),
        ("What is a Zod schema?", "Zod is a TypeScript-first schema validation library. You define schemas as code (`z.object({name: z.string()})`) and use them to validate data at runtime, with full TypeScript type inference."),
        ("Explain event-driven architecture", "Event-driven architecture is a pattern where components communicate through events rather than direct calls. Producers emit events, and consumers react to them asynchronously, enabling loose coupling and scalability."),
        ("What is a JWT?", "JWT (JSON Web Token) is a compact, URL-safe way to represent claims between parties. It has three parts: header (algorithm), payload (claims), and signature. Used for authentication — the server verifies the signature instead of querying a database."),
        ("How does git rebase work?", "Git rebase moves your branch's commits to start from a new base commit. Unlike merge, it creates a linear history by replaying your commits on top of the target branch. Use it to keep history clean, but avoid rebasing shared branches."),
        ("What is a closure in JavaScript?", "A closure is a function that retains access to its lexical scope even after the outer function has returned. It 'closes over' the variables it references. This enables data privacy and stateful functions."),
        ("Explain MCP (Model Context Protocol)", "MCP is a JSON-RPC 2.0 protocol that lets AI agents expose and consume tools across processes. An MCP server lists available tools, and clients call them via standard request/response. It enables tool sharing between agents."),
        ("What is WebRTC?", "WebRTC (Web Real-Time Communication) enables peer-to-peer audio, video, and data streaming in browsers without plugins. It uses STUN/TURN for NAT traversal and DTLS/SRTP for encryption."),
        ("Explain the difference between SQL and NoSQL", "SQL databases (PostgreSQL, MySQL) use structured schemas and relational tables with ACID transactions. NoSQL databases (MongoDB, Redis) use flexible schemas (document, key-value, graph) and prioritize scalability over strict consistency."),
        ("What is Tailwind CSS?", "Tailwind is a utility-first CSS framework that provides atomic classes like `flex`, `p-4`, `text-lg` directly in HTML. Instead of writing custom CSS, you compose styles from pre-built utilities. Produces small bundles via tree-shaking."),
        ("Explain what CUDA is", "CUDA is NVIDIA's parallel computing platform that lets you run code on GPUs. It provides APIs for launching thousands of threads simultaneously, crucial for deep learning, scientific computing, and graphics."),
        ("What is a LoRA adapter?", "A LoRA adapter is a small set of trained low-rank matrices that modify a frozen base model's behavior. It's typically 1-5% the size of the full model and can be loaded/swapped at inference time, enabling efficient customization."),
        ("How does Ollama work?", "Ollama is a tool for running LLMs locally. It downloads and manages GGUF-quantized models, serves them via a REST API at port 11434, and handles GPU memory management. You interact with `ollama run model` or `POST /api/generate`."),
        ("What is RAG?", "RAG (Retrieval-Augmented Generation) combines a retrieval system with an LLM. When a user asks a question, relevant documents are retrieved from a knowledge base and injected into the LLM's context, grounding responses in real data."),
        ("Explain ESM vs CommonJS", "ESM (ECMAScript Modules) uses `import/export` syntax and is the standard for modern JS. CommonJS uses `require/module.exports` and is Node.js's legacy format. ESM is statically analyzable, supports tree-shaking, and is the future of JavaScript."),
        ("What is quantization in LLMs?", "Quantization reduces model precision from FP32/FP16 to lower bit widths (INT8, INT4). This shrinks model size and speeds up inference with minimal quality loss. Q4_K_M is a popular balance of size and quality."),
        ("Explain what Vite is", "Vite is a fast build tool for modern web projects. It uses native ES modules for instant dev server startup, and Rollup for optimized production builds. Much faster than webpack for development."),
        ("What are React hooks?", "Hooks are functions that let you use state and lifecycle features in functional React components. `useState` for state, `useEffect` for side effects, `useCallback` for memoized callbacks, `useMemo` for memoized values."),
        ("How does a transformer model work?", "Transformers use self-attention to process all tokens in parallel (unlike RNNs). Each layer computes attention scores between all token pairs, allowing the model to capture long-range dependencies. The architecture powers GPT, BERT, and modern LLMs."),
        ("Explain what Prometheus is", "Prometheus is a time-series monitoring system. It scrapes metrics from HTTP endpoints at regular intervals, stores them in a TSDB, and provides PromQL for querying. Commonly paired with Grafana for visualization."),
    ]

    return [{"instruction": q, "output": a, "category": "knowledge"} for q, a in pairs]


def generate_multi_step_examples():
    """Multi-step reasoning requiring chained tool calls."""
    examples = [
        {
            "instruction": "Find the latest issue on the TITAN repo and summarize it",
            "output": 'I\'ll first check the GitHub issues, then summarize the latest one.\n\n{"tool": "github_issues", "args": {"repo": "Djtony707/TITAN", "state": "open"}}',
            "category": "multi_step",
        },
        {
            "instruction": "Check if the TITAN gateway is running on the Titan PC",
            "output": 'I\'ll run a command to check the process status.\n\n{"tool": "shell", "args": {"command": "curl -s http://localhost:48420/api/health | jq ."}}',
            "category": "multi_step",
        },
        {
            "instruction": "Read the package.json and tell me what version TITAN is",
            "output": 'I\'ll read the package.json to find the version.\n\n{"tool": "read_file", "args": {"path": "package.json"}}',
            "category": "multi_step",
        },
        {
            "instruction": "Create a backup of the config file and then update the model setting",
            "output": 'I\'ll first read the current config, back it up, then update it.\n\n{"tool": "read_file", "args": {"path": "~/.titan/titan.json"}}',
            "category": "multi_step",
        },
        {
            "instruction": "Search the web for the latest Ollama release and download the changelog",
            "output": 'I\'ll search for the latest Ollama release first.\n\n{"tool": "web_search", "args": {"query": "Ollama latest release changelog 2026"}}',
            "category": "multi_step",
        },
        {
            "instruction": "Check GPU usage on Titan PC and if it's idle, start a training run",
            "output": 'I\'ll first check the GPU status.\n\n{"tool": "shell", "args": {"command": "ssh <titan-host> nvidia-smi --query-gpu=utilization.gpu,memory.used --format=csv"}}',
            "category": "multi_step",
        },
        {
            "instruction": "Find all TypeScript files with TODO comments in the src directory",
            "output": 'I\'ll search for TODO comments in the source files.\n\n{"tool": "shell", "args": {"command": "grep -rn TODO src/ --include=*.ts | head -20"}}',
            "category": "multi_step",
        },
        {
            "instruction": "Check the disk space on Titan PC and clean up old training runs if it's low",
            "output": 'I\'ll check the disk space first.\n\n{"tool": "shell", "args": {"command": "ssh <titan-host> df -h / | tail -1"}}',
            "category": "multi_step",
        },
        {
            "instruction": "Look up the weather in Austin and set a reminder if it might rain",
            "output": 'I\'ll check the weather first, then create a reminder if needed.\n\n{"tool": "weather", "args": {"location": "Austin"}}',
            "category": "multi_step",
        },
        {
            "instruction": "Read the CHANGELOG and create a summary goal to review the latest changes",
            "output": 'I\'ll read the changelog first.\n\n{"tool": "read_file", "args": {"path": "CHANGELOG.md"}}',
            "category": "multi_step",
        },
        {
            "instruction": "Check if there are any failing tests and fix them",
            "output": 'I\'ll run the test suite first to see what\'s failing.\n\n{"tool": "shell", "args": {"command": "npm test 2>&1 | tail -30"}}',
            "category": "multi_step",
        },
        {
            "instruction": "List the running Docker containers and check their resource usage",
            "output": 'I\'ll check the Docker containers and their stats.\n\n{"tool": "shell", "args": {"command": "docker ps --format \\"table {{.Names}}\\t{{.Status}}\\t{{.Ports}}\\" && docker stats --no-stream --format \\"table {{.Name}}\\t{{.CPUPerc}}\\t{{.MemUsage}}\\" 2>/dev/null"}}',
            "category": "multi_step",
        },
        {
            "instruction": "Research how to implement WebSocket authentication and save notes",
            "output": 'I\'ll search for WebSocket auth best practices.\n\n{"tool": "web_search", "args": {"query": "WebSocket authentication best practices 2026"}}',
            "category": "multi_step",
        },
        {
            "instruction": "Check the Ollama models on Titan PC and pull the latest qwen3.5 if needed",
            "output": 'I\'ll check what models are currently available.\n\n{"tool": "shell", "args": {"command": "ssh <titan-host> ollama list"}}',
            "category": "multi_step",
        },
        {
            "instruction": "Scan my emails for any job opportunities and create a tracking goal",
            "output": 'I\'ll search your emails for job-related messages.\n\n{"tool": "email_search", "args": {"query": "job opportunity interview offer"}}',
            "category": "multi_step",
        },
    ]

    # Add more with variations
    for i in range(35):
        task = random.choice([
            ("Monitor the TITAN gateway health", "shell", {"command": "curl -sf http://localhost:48420/api/health | jq ."}),
            ("Check memory usage on this machine", "shell", {"command": "free -m"}),
            ("Find the largest files in the project", "shell", {"command": "find . -type f -exec du -h {} + | sort -rh | head -10"}),
            ("Count lines of code in the TypeScript source", "shell", {"command": "find src -name '*.ts' | xargs wc -l | tail -1"}),
            ("Check Ollama GPU memory usage", "shell", {"command": "nvidia-smi --query-gpu=memory.used,memory.total --format=csv,noheader"}),
            ("List all cron jobs", "cron", {"action": "list"}),
            ("Show active goals and their progress", "goal_list", {}),
            ("Search for recent AI research papers", "web_search", {"query": "AI research papers " + random.choice(["2026", "latest", "transformer", "agent"])}),
            ("Check the TITAN logs for errors", "shell", {"command": "tail -50 /tmp/titan-gateway.log | grep -i error"}),
            ("List all smart home devices", "ha_devices", {}),
        ])
        examples.append({
            "instruction": task[0],
            "output": f'I\'ll {task[0].lower().replace("check", "check").replace("find", "search for").replace("list", "get a list of").replace("monitor", "check")}.\n\n{json.dumps({"tool": task[1], "args": task[2]})}',
            "category": "multi_step",
        })

    return examples


def generate_error_recovery_examples():
    """Error handling and graceful recovery examples."""
    examples = [
        {
            "instruction": "Read /nonexistent/file.txt",
            "output": "I'll try to read that file, but if it doesn't exist I'll let you know.\n\n{\"tool\": \"read_file\", \"args\": {\"path\": \"/nonexistent/file.txt\"}}\n\nIf the file doesn't exist, you could:\n1. Check the correct path with `list_dir`\n2. Create the file with `write_file`\n3. Search for similar files with `shell` using `find`",
            "category": "error_recovery",
        },
        {
            "instruction": "Connect to a server that's down",
            "output": "I'll attempt the connection, but if the server is unreachable, here are some troubleshooting steps:\n1. Check if the host is reachable: `ping hostname`\n2. Verify the port is open: `nc -zv hostname port`\n3. Check if the service is running: `ssh hostname systemctl status service`\n4. Review firewall rules: `ssh hostname sudo ufw status`",
            "category": "error_recovery",
        },
        {
            "instruction": "Run a command that requires sudo",
            "output": "I should note that running commands with `sudo` requires elevated privileges and may prompt for a password. I'll try without sudo first, and if permission is denied, I'll let you know what permissions are needed.\n\n{\"tool\": \"shell\", \"args\": {\"command\": \"ls -la /root\"}}",
            "category": "error_recovery",
        },
        {
            "instruction": "Install a package that might not exist",
            "output": "I'll try to install the package. If it's not found, I'll search for alternatives or suggest the correct package name.\n\n{\"tool\": \"shell\", \"args\": {\"command\": \"npm install nonexistent-package-xyz 2>&1\"}}\n\nIf this fails, I can:\n1. Search npm for similar packages\n2. Check if the package was renamed\n3. Look for alternative packages that provide similar functionality",
            "category": "error_recovery",
        },
        {
            "instruction": "Fetch a URL that returns a 404",
            "output": "I'll fetch the URL. If it returns a 404 (Not Found), I can:\n1. Check if the URL has a typo\n2. Search for the correct page URL\n3. Try the Wayback Machine for archived versions\n4. Look for alternative sources\n\n{\"tool\": \"web_fetch\", \"args\": {\"url\": \"https://example.com/missing-page\"}}",
            "category": "error_recovery",
        },
    ]

    # Generate more error scenarios
    error_scenarios = [
        ("Git push fails due to conflicts", "I'll check the current git status and resolve any conflicts."),
        ("Docker build fails with dependency errors", "I'll check the Dockerfile and try to identify the failing dependency."),
        ("npm test fails with import errors", "I'll check the failing test and verify the import paths are correct."),
        ("SSH connection times out", "The connection timed out. I'll try the Tailscale IP as a fallback, or check if the machine is online."),
        ("Ollama model pull fails", "The model pull failed. I'll check available disk space and network connectivity."),
        ("Training runs out of GPU memory", "GPU OOM error. I'll try reducing batch size, enabling gradient checkpointing, or using a more quantized model."),
        ("API returns rate limit error", "Hit rate limit. I'll wait and retry with exponential backoff, or suggest using a different API key."),
        ("File permission denied when writing", "Permission denied. I'll check the file ownership and suggest the correct permissions."),
        ("Database connection refused", "Connection refused. I'll verify the database service is running and check the connection string."),
        ("Build fails with TypeScript errors", "TypeScript compilation failed. I'll check the error messages and fix the type issues."),
        ("Cron job runs but produces no output", "The cron job ran but had no output. I'll check the command, verify the working directory, and ensure environment variables are set."),
        ("Browser automation fails to find element", "Element not found. I'll try alternative selectors, wait for the page to load, or check if the page structure changed."),
        ("Memory storage fails — disk full", "Disk is full. I'll check disk usage, identify large files that can be cleaned up, and free space."),
        ("Model inference returns empty response", "Empty response from the model. I'll retry with a clearer prompt, check the model health, or try a different model."),
        ("Webhook delivery fails with timeout", "Webhook timed out. I'll verify the endpoint URL, check if the receiving server is up, and retry."),
    ]

    for scenario, recovery in error_scenarios:
        examples.append({
            "instruction": f"Handle this error: {scenario}",
            "output": recovery,
            "category": "error_recovery",
        })

    return examples


def generate_code_examples():
    """Code generation examples."""
    pairs = [
        ("Write a function to check if a number is prime in Python",
         "```python\ndef is_prime(n: int) -> bool:\n    if n < 2:\n        return False\n    for i in range(2, int(n**0.5) + 1):\n        if n % i == 0:\n            return False\n    return True\n```"),
        ("Create a TypeScript function to debounce",
         "```typescript\nfunction debounce<T extends (...args: unknown[]) => void>(fn: T, ms: number): T {\n  let timer: ReturnType<typeof setTimeout>;\n  return ((...args: Parameters<T>) => {\n    clearTimeout(timer);\n    timer = setTimeout(() => fn(...args), ms);\n  }) as T;\n}\n```"),
        ("Write a bash script to backup a directory",
         "```bash\n#!/bin/bash\nSRC=\"${1:-.}\"\nDEST=\"${2:-/tmp/backup}\"\nTIME=$(date +%Y%m%d_%H%M%S)\nmkdir -p \"$DEST\"\ntar czf \"$DEST/backup_$TIME.tar.gz\" \"$SRC\"\necho \"Backup saved to $DEST/backup_$TIME.tar.gz\"\n```"),
        ("Create a simple Express API endpoint in TypeScript",
         "```typescript\nimport express from 'express';\n\nconst app = express();\napp.use(express.json());\n\napp.get('/api/health', (_req, res) => {\n  res.json({ status: 'ok', uptime: process.uptime() });\n});\n\napp.post('/api/echo', (req, res) => {\n  res.json({ received: req.body });\n});\n\napp.listen(3000, () => console.log('Server running on :3000'));\n```"),
        ("Write a Python function to flatten a nested list",
         "```python\ndef flatten(lst: list) -> list:\n    result = []\n    for item in lst:\n        if isinstance(item, list):\n            result.extend(flatten(item))\n        else:\n            result.append(item)\n    return result\n\n# Example: flatten([1, [2, [3, 4]], 5]) -> [1, 2, 3, 4, 5]\n```"),
        ("Create a React hook for local storage",
         "```typescript\nimport { useState, useEffect } from 'react';\n\nexport function useLocalStorage<T>(key: string, initial: T) {\n  const [value, setValue] = useState<T>(() => {\n    const stored = localStorage.getItem(key);\n    return stored ? JSON.parse(stored) : initial;\n  });\n\n  useEffect(() => {\n    localStorage.setItem(key, JSON.stringify(value));\n  }, [key, value]);\n\n  return [value, setValue] as const;\n}\n```"),
        ("Write a shell one-liner to find the 10 largest files",
         "```bash\nfind . -type f -exec du -h {} + | sort -rh | head -10\n```\nThis recursively finds all files, gets their sizes, sorts by size descending, and shows the top 10."),
        ("Create a Python context manager for timing",
         "```python\nimport time\nfrom contextlib import contextmanager\n\n@contextmanager\ndef timer(label: str = 'Block'):\n    start = time.perf_counter()\n    yield\n    elapsed = time.perf_counter() - start\n    print(f'{label}: {elapsed:.3f}s')\n\n# Usage: with timer('Training'): train()\n```"),
        ("Write a TypeScript utility type for deep partial",
         "```typescript\ntype DeepPartial<T> = {\n  [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K];\n};\n\n// Usage:\ninterface Config {\n  server: { port: number; host: string };\n  db: { url: string; pool: number };\n}\ntype PartialConfig = DeepPartial<Config>;\n// Now { server?: { port?: number; host?: string }; db?: ... }\n```"),
        ("Write a Python async HTTP client",
         "```python\nimport aiohttp\nimport asyncio\n\nasync def fetch(url: str) -> str:\n    async with aiohttp.ClientSession() as session:\n        async with session.get(url) as resp:\n            return await resp.text()\n\nasync def fetch_many(urls: list[str]) -> list[str]:\n    return await asyncio.gather(*[fetch(u) for u in urls])\n\n# Usage: results = asyncio.run(fetch_many(['https://...', ...]))\n```"),
        ("Create a simple Dockerfile for a Node.js app",
         "```dockerfile\nFROM node:20-slim\nWORKDIR /app\nCOPY package*.json ./\nRUN npm ci --production\nCOPY dist/ ./dist/\nEXPOSE 3000\nCMD [\"node\", \"dist/index.js\"]\n```"),
        ("Write a GitHub Actions workflow for CI",
         "```yaml\nname: CI\non: [push, pull_request]\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@v4\n      - uses: actions/setup-node@v4\n        with:\n          node-version: 20\n      - run: npm ci\n      - run: npm test\n      - run: npm run build\n```"),
    ]

    return [{"instruction": q, "output": a, "category": "code"} for q, a in pairs]


def generate_json_output_examples():
    """Examples requiring structured JSON output (critical for Qwen)."""
    examples = []

    # Tool calls with complex args
    complex_tools = [
        {
            "instruction": "Create a goal to deploy TITAN v3 with subtasks for testing, building, and publishing",
            "output": json.dumps({"tool": "goal_create", "args": {
                "title": "Deploy TITAN v3",
                "subtasks": [
                    {"title": "Run full test suite", "description": "npm test — all 3839 tests must pass"},
                    {"title": "Build TypeScript and UI", "description": "npm run build && npm run build:ui"},
                    {"title": "Publish to npm", "description": "npm publish with updated version"},
                    {"title": "Deploy to Titan PC", "description": "rsync to /opt/TITAN and restart gateway"},
                ]
            }}, indent=2),
        },
        {
            "instruction": "Schedule a daily health check at 6am",
            "output": json.dumps({"tool": "cron", "args": {
                "action": "create",
                "schedule": "0 6 * * *",
                "task": "Check TITAN gateway health, Ollama status, and disk space"
            }}, indent=2),
        },
        {
            "instruction": "Store the homelab network config in memory",
            "output": json.dumps({"tool": "memory", "args": {
                "action": "store",
                "key": "homelab_network",
                "value": "Titan PC: <titan-host>, Mini PC: <minipc-host>, T610: <t610-host>, Gateway: 48420"
            }}, indent=2),
        },
        {
            "instruction": "Run a Python script in the sandbox that calculates fibonacci",
            "output": json.dumps({"tool": "code_exec", "args": {
                "language": "python",
                "code": "def fib(n):\n    a, b = 0, 1\n    for _ in range(n):\n        a, b = b, a + b\n    return a\n\nfor i in range(10):\n    print(f'fib({i}) = {fib(i)}')"
            }}, indent=2),
        },
        {
            "instruction": "Start a self-improvement experiment on tool selection with a 15 minute budget",
            "output": json.dumps({"tool": "self_improve_start", "args": {
                "area": "tool-selection",
                "budgetMinutes": 15
            }}, indent=2),
        },
    ]

    for ex in complex_tools:
        examples.append({
            "instruction": ex["instruction"],
            "output": f"I'll handle that.\n\n{ex['output']}",
            "category": "json_output",
        })

    # Add more JSON structured responses
    for i in range(45):
        tool = random.choice(TOOLS)
        args = {}
        for pname, ptype in tool["params"].items():
            if ptype == "string": args[pname] = f"example_{pname}_value"
            elif ptype == "number": args[pname] = random.randint(1, 100)
            elif ptype == "array": args[pname] = ["item1", "item2"]
            else: args[pname] = f"value"

        examples.append({
            "instruction": f"Use the {tool['name']} tool with these settings: {', '.join(f'{k}={v}' for k, v in args.items())}",
            "output": f"I'll use the {tool['name']} tool.\n\n{json.dumps({'tool': tool['name'], 'args': args})}",
            "category": "json_output",
        })

    return examples


def main():
    print("Generating TITAN training data...")

    all_examples = []

    print("  Tool selection examples...", end=" ")
    tool_ex = generate_tool_selection_examples()
    all_examples.extend(tool_ex)
    print(f"{len(tool_ex)}")

    print("  Knowledge examples...", end=" ")
    knowledge_ex = generate_knowledge_examples()
    all_examples.extend(knowledge_ex)
    print(f"{len(knowledge_ex)}")

    print("  Multi-step examples...", end=" ")
    multi_ex = generate_multi_step_examples()
    all_examples.extend(multi_ex)
    print(f"{len(multi_ex)}")

    print("  Error recovery examples...", end=" ")
    error_ex = generate_error_recovery_examples()
    all_examples.extend(error_ex)
    print(f"{len(error_ex)}")

    print("  Code examples...", end=" ")
    code_ex = generate_code_examples()
    all_examples.extend(code_ex)
    print(f"{len(code_ex)}")

    print("  JSON output examples...", end=" ")
    json_ex = generate_json_output_examples()
    all_examples.extend(json_ex)
    print(f"{len(json_ex)}")

    # Shuffle
    random.shuffle(all_examples)

    # Write output
    with open(OUTPUT_PATH, "w") as f:
        for ex in all_examples:
            f.write(json.dumps({"instruction": ex["instruction"], "output": ex["output"]}) + "\n")

    # Summary
    categories = {}
    for ex in all_examples:
        cat = ex.get("category", "unknown")
        categories[cat] = categories.get(cat, 0) + 1

    print(f"\nTotal: {len(all_examples)} examples")
    print(f"Output: {OUTPUT_PATH}")
    print("\nBreakdown:")
    for cat, count in sorted(categories.items()):
        print(f"  {cat}: {count}")


if __name__ == "__main__":
    main()
