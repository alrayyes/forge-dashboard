import { FORGE_LABELS } from '#lib/forges.js';
import type { PipelineTarget } from '#lib/PipelineDialog.svelte';

// What both boards say when they open the pipeline dialog, so a pull request
// and a branch give it the same fields. The board adds what only it knows
// (pause, controls, cancel, the way back to its row).
export type PipelineSubject = {
  forge: string;
  fullName: string;
  signature: string;
  // A pull request has a number, a branch a name.
  number?: number;
  branch?: string;
  // Where the run is on the forge, when the board knows it. The dialog falls
  // back to the newest run its checks name.
  runUrl?: string;
};

export type PipelineBase = Pick<
  PipelineTarget,
  | 'subtitle'
  | 'checksUrl'
  | 'signature'
  | 'emptyText'
  | 'errorText'
  | 'runUrl'
  | 'forgeName'
>;

export function pipelineTarget(s: PipelineSubject): PipelineBase {
  const forge = encodeURIComponent(s.forge);
  const fullName = encodeURIComponent(s.fullName);
  const pr = s.number !== undefined;
  return {
    subtitle: pr
      ? `${s.fullName}#${s.number}`
      : `${s.fullName}${s.branch ? ` · ${s.branch}` : ''}`,
    checksUrl: pr
      ? `/api/pull-requests/checks?forge=${forge}&fullName=${fullName}&number=${s.number}`
      : `/api/main-branches/checks?forge=${forge}&fullName=${fullName}`,
    signature: s.signature,
    emptyText: pr
      ? 'No CI configured for this pull request.'
      : 'No jobs were found for this branch.',
    errorText: pr
      ? `Couldn't load pipeline checks for ${s.fullName}#${s.number}`
      : `Couldn't load the pipeline jobs for ${s.fullName}`,
    runUrl: s.runUrl,
    forgeName: FORGE_LABELS[s.forge] ?? s.forge,
  };
}
