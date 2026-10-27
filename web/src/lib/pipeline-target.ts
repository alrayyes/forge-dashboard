import { FORGE_LABELS } from './forges';
import type { PipelineTarget } from './PipelineDialog.svelte';

// What both boards say when they open the pipeline dialog, so a pull request
// and a branch give it the same fields. The board adds what only it knows
// (pause, controls, cancel, the way back to its row).
export type PipelineSubject = {
  forge: string;
  fullName: string;
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
  | 'subject'
  | 'repo'
  | 'emptyText'
  | 'errorText'
  | 'runUrl'
  | 'forgeName'
>;

export function pipelineTarget(s: PipelineSubject): PipelineBase {
  const pr = s.number !== undefined;
  const { forge, fullName } = s;
  return {
    subtitle: pr
      ? `${fullName}#${s.number}`
      : `${fullName}${s.branch ? ` · ${s.branch}` : ''}`,
    subject: pr
      ? { kind: 'pull_request', forge, fullName, number: s.number }
      : { kind: 'main_branch', forge, fullName },
    repo: { forge, fullName },
    emptyText: pr
      ? 'No CI configured for this pull request.'
      : 'No jobs were found for this branch.',
    errorText: pr
      ? `Couldn't load pipeline checks for ${fullName}#${s.number}`
      : `Couldn't load the pipeline jobs for ${fullName}`,
    runUrl: s.runUrl,
    forgeName: FORGE_LABELS[forge] ?? forge,
  };
}
