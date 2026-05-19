import { createApproval } from '../../agent/commandPost.js';
import { loadConfig } from '../../config/config.js';
import { writeReceipt } from '../../receipts/store.js';
import { validateOutboundCallRequest } from '../../telephony/phonePolicy.js';
import { registerSkill } from '../registry.js';

export function registerPhoneCallSkill(): void {
  registerSkill(
    {
      name: 'phone_call',
      description: 'Request an approval-gated Dograh outbound phone call. The tool never dials directly.',
      version: '0.1.0',
      source: 'bundled',
      enabled: true,
    },
    {
      name: 'phone_call',
      description: 'Request a Dograh-powered outbound phone call through TITAN Phone Desk. This tool creates an approval request only; it does not directly dial. Use only when the user explicitly asks TITAN to call a person or business. Cold-call/campaign mode is blocked unless configured separately.',
      parameters: {
        type: 'object',
        properties: {
          toNumber: { type: 'string', description: 'Destination phone number in E.164 format, e.g. +15551234567' },
          purpose: { type: 'string', description: 'Human-readable reason/objective for the call' },
          workflowId: { type: 'string', description: 'Optional Dograh outbound workflow ID. Defaults to telephony.dograh.defaultOutboundWorkflowId.' },
          mode: { type: 'string', enum: ['test', 'callback', 'campaign'], description: 'Call mode. campaign remains policy-gated.' },
        },
        required: ['toNumber', 'purpose'],
      },
      execute: async (args) => {
        const config = loadConfig();
        const policy = validateOutboundCallRequest(config.telephony, args);
        if (!policy.ok) {
          writeReceipt({
            kind: 'error',
            status: 'fail',
            summary: `Phone call blocked: ${policy.reason ?? 'policy failure'}`,
            meta: { mode: policy.mode, toNumberRedacted: policy.toNumberRedacted },
          });
          return `Phone call blocked: ${policy.reason ?? 'policy failure'}${policy.toNumberRedacted ? ` (${policy.toNumberRedacted})` : ''}`;
        }

        const approval = createApproval({
          type: 'custom',
          requestedBy: `phone-call-tool:${policy.mode}:${policy.approvalIdentity?.slice(0, 16) ?? policy.toNumberHash?.slice(0, 12) ?? 'unknown'}`,
          payload: {
            category: 'telephony_outbound_call',
            kind: 'telephony_outbound_call',
            title: policy.approvalIdentity ?? `${policy.mode}:${policy.workflowId}:${policy.toNumberHash}:${policy.purpose}`,
            approvalIdentity: policy.approvalIdentity,
            neverAutoApprove: true,
            mode: policy.mode,
            workflowId: policy.workflowId,
            toNumberRedacted: policy.toNumberRedacted,
            toNumberHash: policy.toNumberHash,
            toNumberOptOutHash: policy.toNumberOptOutHash,
            purpose: policy.purpose,
            source: 'dograh',
          },
        });
        const receipt = writeReceipt({
          kind: 'approval_request',
          status: 'pending',
          summary: `Phone call approval required: ${policy.toNumberRedacted}`,
          meta: {
            approvalActionId: approval.id,
            mode: policy.mode,
            workflowId: policy.workflowId,
            toNumberRedacted: policy.toNumberRedacted,
            toNumberHash: policy.toNumberHash,
            toNumberOptOutHash: policy.toNumberOptOutHash,
            purpose: policy.purpose,
          },
        });

        return [
          `Phone call approval required for ${policy.toNumberRedacted}.`,
          `Purpose: ${policy.purpose}`,
          `Mode: ${policy.mode}`,
          `Approval action: ${approval.id}`,
          `Receipt action: ${receipt.action_id}`,
          'No call was started. Use Phone Desk approval to place the Dograh call.',
        ].join('\n');
      },
    },
  );
}
