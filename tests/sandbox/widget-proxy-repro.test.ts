import { describe, it, expect, vi } from 'vitest';
import { SandboxRuntime } from '../../ui/src/titan2/sandbox/SandboxRuntime';

describe('widget proxy bug', () => {
  it('should return titan.api.call response in correct format', async () => {
    const iframe = document.createElement('iframe');
    document.body.appendChild(iframe);
    
    const runtime = new SandboxRuntime(iframe);
    await runtime.whenReady();
    
    // The bug: widgets expect { status, body } but get { ok, status, text, json }
    const response = await runtime.post('api', { 
      endpoint: '/stock/analyze', 
      body: { ticker: 'AAPL' } 
    });
    
    // Widget code expects response.body (not response.json) and response.status
    expect(response).toHaveProperty('status');
    expect(response).toHaveProperty('body');
    expect(response.ok).toBeUndefined(); // Should NOT have .ok wrapper
  });
});
