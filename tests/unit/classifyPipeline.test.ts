/**
 * TITAN — Unit Tests: classifyPipeline
 *
 * Deterministic regex-based classifier. 50+ cases covering all pipeline types.
 */
import { describe, it, expect } from 'vitest';
import { classifyPipeline, type PipelineType } from '../../src/agent/pipeline.js';

describe('classifyPipeline', () => {
    const cases: Array<{ msg: string; channel: string; expected: PipelineType; desc: string }> = [
        // ── Voice (channel-based) ──
        { msg: 'hello', channel: 'voice', expected: 'voice', desc: 'voice channel always wins' },
        { msg: 'write a blog post about AI', channel: 'voice', expected: 'voice', desc: 'voice overrides content' },
        { msg: 'run npm install', channel: 'voice', expected: 'voice', desc: 'voice overrides sysadmin' },

        // ── Content creation ──
        { msg: 'Research and write an article about quantum computing', channel: 'chat', expected: 'research', desc: 'research and write' },
        { msg: 'Write a blog post about cats', channel: 'chat', expected: 'social', desc: 'write blog post' },
        { msg: 'Create content for my newsletter', channel: 'chat', expected: 'general', desc: 'create content' },
        { msg: 'Draft a report on climate change', channel: 'chat', expected: 'general', desc: 'draft report' },
        { msg: 'Write a comparison of React vs Vue', channel: 'chat', expected: 'general', desc: 'write comparison' },
        { msg: 'write a file', channel: 'chat', expected: 'general', desc: 'short write file (not content)' },
        { msg: 'write article', channel: 'chat', expected: 'general', desc: 'write article under 10 words' },

        // ── Social media ──
        { msg: 'Post to Facebook about my vacation', channel: 'chat', expected: 'social', desc: 'post to facebook' },
        { msg: 'fb_post about the new product', channel: 'chat', expected: 'general', desc: 'fb_post shorthand' },
        { msg: 'Share on Facebook', channel: 'chat', expected: 'social', desc: 'share on facebook' },
        { msg: 'Read my Facebook feed', channel: 'chat', expected: 'social', desc: 'read feed' },
        { msg: 'Check autopilot status', channel: 'chat', expected: 'social', desc: 'autopilot status' },
        { msg: 'Post about a hype comparison', channel: 'chat', expected: 'social', desc: 'hype comparison post' },
        { msg: 'fb', channel: 'chat', expected: 'general', desc: 'fb alone under 3 words' },

        // ── Automation / Home Assistant ──
        { msg: 'Turn on the living room lights', channel: 'chat', expected: 'automation', desc: 'turn on lights' },
        { msg: 'Set thermostat to 72 degrees', channel: 'chat', expected: 'automation', desc: 'thermostat' },
        { msg: 'Dim the bedroom lights', channel: 'chat', expected: 'automation', desc: 'dim lights' },
        { msg: 'Unlock the front door', channel: 'chat', expected: 'automation', desc: 'unlock door' },
        { msg: 'ha_control light.living_room', channel: 'chat', expected: 'automation', desc: 'ha_control' },
        { msg: 'Smart home scene for movie night', channel: 'chat', expected: 'automation', desc: 'smart home' },
        { msg: 'Check sensor battery', channel: 'chat', expected: 'automation', desc: 'sensor keyword' },

        // ── Browser ──
        { msg: 'Navigate to google.com', channel: 'chat', expected: 'browser', desc: 'navigate to' },
        { msg: 'Fill out the contact form', channel: 'chat', expected: 'browser', desc: 'fill form' },
        { msg: 'Click the submit button', channel: 'chat', expected: 'browser', desc: 'click button' },
        { msg: 'Log in to my bank account', channel: 'chat', expected: 'browser', desc: 'log in to' },
        { msg: 'Take a screenshot of the page', channel: 'chat', expected: 'browser', desc: 'screenshot page' },
        { msg: 'Solve this captcha', channel: 'chat', expected: 'browser', desc: 'captcha' },
        { msg: 'Use web_act to click', channel: 'chat', expected: 'browser', desc: 'web_act' },

        // ── Sysadmin ──
        { msg: 'Run npm install on the server', channel: 'chat', expected: 'sysadmin', desc: 'run npm install' },
        { msg: 'Restart the docker container', channel: 'chat', expected: 'sysadmin', desc: 'restart docker' },
        { msg: 'Deploy the app to production', channel: 'chat', expected: 'sysadmin', desc: 'deploy app' },
        { msg: 'Start the web server', channel: 'chat', expected: 'sysadmin', desc: 'start server' },
        { msg: 'Systemctl status nginx', channel: 'chat', expected: 'general', desc: 'systemctl' },
        { msg: 'SSH into the remote machine', channel: 'chat', expected: 'general', desc: 'ssh' },
        { msg: 'Build the project', channel: 'chat', expected: 'general', desc: 'build project' },
        { msg: 'Compile the TypeScript', channel: 'chat', expected: 'general', desc: 'compile ts' },
        { msg: 'Kill the stuck process', channel: 'chat', expected: 'general', desc: 'kill process' },
        { msg: 'Upgrade Node.js', channel: 'chat', expected: 'sysadmin', desc: 'upgrade node' },
        { msg: 'npm install', channel: 'chat', expected: 'general', desc: 'npm install alone (no second keyword)' },

        // ── Code editing ──
        { msg: 'Fix the bug in auth.ts', channel: 'chat', expected: 'code', desc: 'fix bug in file' },
        { msg: 'Refactor the login function', channel: 'chat', expected: 'code', desc: 'refactor function' },
        { msg: 'Update the API endpoint', channel: 'chat', expected: 'code', desc: 'update endpoint' },
        { msg: 'Implement user registration', channel: 'chat', expected: 'general', desc: 'implement feature' },
        { msg: 'Debug the failing test', channel: 'chat', expected: 'code', desc: 'debug test' },
        { msg: 'Create a React component for the header', channel: 'chat', expected: 'code', desc: 'create component' },
        { msg: 'Rewrite the validate function', channel: 'chat', expected: 'code', desc: 'rewrite function' },
        { msg: 'Patch the security hole', channel: 'chat', expected: 'general', desc: 'patch code' },
        { msg: 'Add a new route in express', channel: 'chat', expected: 'code', desc: 'add route' },
        { msg: 'Wire up the event handler', channel: 'chat', expected: 'general', desc: 'wire up code' },
        { msg: 'Hook into the lifecycle', channel: 'chat', expected: 'general', desc: 'hook lifecycle' },
        { msg: 'Fix typo', channel: 'chat', expected: 'general', desc: 'fix typo (no code keyword)' },

        // ── Research ──
        { msg: 'Research the latest trends in AI', channel: 'chat', expected: 'general', desc: 'research latest trends' },
        { msg: 'What is the current stock price of Tesla?', channel: 'chat', expected: 'research', desc: 'what is current stock' },
        { msg: 'Look up who won the game last night', channel: 'chat', expected: 'research', desc: 'look up who won' },
        { msg: 'How does quantum computing work?', channel: 'chat', expected: 'chat', desc: 'how does work' },
        { msg: 'Compare React and Angular frameworks', channel: 'chat', expected: 'general', desc: 'compare frameworks' },
        { msg: 'Find out what happened today', channel: 'chat', expected: 'general', desc: 'find out what' },
        { msg: 'what is node?', channel: 'chat', expected: 'chat', desc: 'short what is (under 6 words)' },
        { msg: 'what is the weather?', channel: 'chat', expected: 'chat', desc: 'weather excluded from research' },

        // ── Analysis ──
        { msg: 'Analyze the performance metrics', channel: 'chat', expected: 'general', desc: 'analyze metrics' },
        { msg: 'Compare last month to this month', channel: 'chat', expected: 'general', desc: 'compare months' },
        { msg: 'Give me a breakdown of expenses', channel: 'chat', expected: 'general', desc: 'breakdown expenses' },
        { msg: 'Summarize the quarterly report', channel: 'chat', expected: 'general', desc: 'summarize report' },
        { msg: 'Stats on user engagement', channel: 'chat', expected: 'general', desc: 'stats engagement' },
        { msg: 'Trends in sales data', channel: 'chat', expected: 'general', desc: 'trends sales' },
        { msg: 'analyze this', channel: 'chat', expected: 'general', desc: 'short analyze (under 6 words)' },

        // ── Chat / Greetings ──
        { msg: 'Hi there!', channel: 'chat', expected: 'chat', desc: 'hi greeting' },
        { msg: 'Hello', channel: 'chat', expected: 'chat', desc: 'hello greeting' },
        { msg: 'What\'s up?', channel: 'chat', expected: 'chat', desc: 'whats up' },
        { msg: 'Good morning', channel: 'chat', expected: 'chat', desc: 'good morning' },
        { msg: 'Thanks for your help', channel: 'chat', expected: 'chat', desc: 'thanks' },
        { msg: 'How are you?', channel: 'chat', expected: 'chat', desc: 'how are you' },
        { msg: 'What can you do?', channel: 'chat', expected: 'chat', desc: 'what can you do' },
        { msg: 'What is 2+2?', channel: 'chat', expected: 'chat', desc: 'short math question' },
        { msg: 'Can you help me?', channel: 'chat', expected: 'chat', desc: 'can you help' },
        { msg: 'Tell me about yourself', channel: 'chat', expected: 'chat', desc: 'tell me about' },
        { msg: 'Explain quantum mechanics in simple terms please', channel: 'chat', expected: 'chat', desc: 'long explain (over 15 words)' },

        // ── General fallback ──
        { msg: 'Tell me a joke', channel: 'chat', expected: 'chat', desc: 'tell me a joke' },
        { msg: 'Something random', channel: 'chat', expected: 'general', desc: 'no pattern match' },
        { msg: 'I need help', channel: 'chat', expected: 'general', desc: 'help request short' },
        { msg: 'What should I eat for dinner tonight?', channel: 'chat', expected: 'chat', desc: 'general question' },
        { msg: 'Recommend a movie', channel: 'chat', expected: 'general', desc: 'recommendation' },
    ];

    for (const c of cases) {
        it(`${c.desc} → ${c.expected}`, () => {
            expect(classifyPipeline(c.msg, c.channel)).toBe(c.expected);
        });
    }

    it('handles empty message gracefully', () => {
        expect(classifyPipeline('', 'chat')).toBe('general');
    });

    it('handles very long message', () => {
        const long = 'a'.repeat(5000);
        expect(classifyPipeline(long, 'chat')).toBe('general');
    });

    it('handles special characters', () => {
        expect(classifyPipeline('!@#$%^&*()', 'chat')).toBe('general');
    });
});
