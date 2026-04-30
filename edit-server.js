import fs from 'fs';

const file = '/Users/michaelelliott/Desktop/TitanBot/TITAN-main/src/gateway/server.ts';
let lines = fs.readFileSync(file, 'utf-8').split('\n');

const originalLength = lines.length;

// 1) Remove PANE_SSE_TOPICS constant block (used only by extracted watch stream)
const paneStart = lines.findIndex(l => l.trim() === 'const PANE_SSE_TOPICS = [');
const paneEnd   = lines.findIndex((l, i) => i > paneStart && l.trim() === '];');
lines = lines.filter((_, i) => i < paneStart || i > paneEnd);

const shift = paneEnd - paneStart + 1;
const newDeleteStart = 2716 - shift; // 1-indexed
const newDeleteEnd   = 2943 - shift; // 1-indexed

// 2) Remove inline route block [newDeleteStart-1, newDeleteEnd-1] 0-indexed
lines = [...lines.slice(0, newDeleteStart - 1), ...lines.slice(newDeleteEnd)];

// 3) Add new imports after createTestsRouter
const impIdx = lines.findIndex(l => l.trim() === "import { createTestsRouter } from './routes/tests.js';");
lines.splice(impIdx + 1, 0, '', "import { createSocialRouter } from './routes/socialRouter.js';", "import { createWatchRouter } from './routes/watchRouter.js';");

// 4) Add router uses before app.use('/api/files'
const useIdx = lines.findIndex(l => l.trim() === "app.use('/api/files', createFilesRouter());");
lines.splice(useIdx, 0,
  '',
  "  // \u2500\u2500 Social Media and Watch routes (extracted) \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500",
  "  app.use('/api', createSocialRouter());",
  "  app.use('/api', createWatchRouter());"
);

fs.writeFileSync(file, lines.join('\n') + (lines[lines.length - 1].endsWith('\n') ? '' : '\n'));
console.log(`Original ${originalLength} lines \u2192 new ${lines.length} lines (delta = ${lines.length - originalLength})`);
