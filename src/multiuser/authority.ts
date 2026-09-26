import { z } from 'zod';
import { Period, Sha256, SystemMode } from './contracts.js';

const audit = {
  id: z.uuid(), expectedMode: SystemMode,
  actor: z.string().trim().min(1).max(120), reason: z.string().trim().min(1).max(500),
};
export const AuthorityCommand = z.discriminatedUnion('action', [
  z.strictObject({ ...audit, action: z.literal('maintenance') }),
  z.strictObject({ ...audit, action: z.literal('quiesce') }),
  z.strictObject({ ...audit, action: z.literal('release_legacy'), claimId: z.uuid(), evidenceHash: Sha256 }),
  z.strictObject({ ...audit, action: z.literal('seal'), importId: z.uuid(), codeSha: z.string().regex(/^[a-f0-9]{40}$/),
    stateSha: z.string().regex(/^[a-f0-9]{40}$/), firstPeriod: Period }),
  z.strictObject({ ...audit, action: z.literal('activate'), proofHash: Sha256, stateSha: z.string().regex(/^[a-f0-9]{40}$/) }),
  z.strictObject({ ...audit, action: z.literal('resume') }),
  z.strictObject({ ...audit, action: z.literal('cancel') }),
]);
