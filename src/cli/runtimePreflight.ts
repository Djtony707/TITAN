import { assertSecureNodeRuntime } from '../utils/nodeRuntime.js';

// Imported first by the CLI, before modules that can initialize runtime services.
assertSecureNodeRuntime();
