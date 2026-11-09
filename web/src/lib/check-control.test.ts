/// <reference types="bun" />
import { describe, expect, test } from 'bun:test';
import { factsOf } from './check-facts-fixture';
import {
  checkControl,
  checkHint,
  checkLinkLabel,
  checkLinkText,
} from './run-log';

const repo = { forge: 'github', fullName: 'a/b' };
const forgejo = { forge: 'forgejo', fullName: 'a/b' };
const url = 'https://example.test/run/1';

// What the pipeline dialog offers beside a check, decided with no browser. A
// queued job has no log yet, so it never offers Show output.
describe('checkControl', () => {
  test('a queued job links to the forge, with or without a job id', () => {
    expect(checkControl({ status: 'queued', url, jobId: 7 }, repo)).toBe(
      'open-on-forge',
    );
    expect(checkControl({ status: 'queued', url }, repo)).toBe('open-on-forge');
  });

  test('a running or finished job with an id opens its output', () => {
    for (const state of ['running', 'success', 'failure']) {
      expect(checkControl({ ...factsOf(state), url, jobId: 7 }, forgejo)).toBe(
        'output',
      );
    }
    for (const state of ['success', 'failure']) {
      expect(checkControl({ ...factsOf(state), url, jobId: 7 }, repo)).toBe(
        'output',
      );
    }
  });

  // GitHub serves a job's log only once the job has finished: the endpoint
  // answers 404 while it runs. Forgejo streams a running job's log.
  test('a running GitHub job links to the forge, which shows it live', () => {
    expect(checkControl({ status: 'in_progress', url, jobId: 7 }, repo)).toBe(
      'open-on-forge',
    );
  });

  test('a running job on a repository that is not on Forgejo links to the forge', () => {
    expect(
      checkControl(
        { status: 'in_progress', url, jobId: 7 },
        { forge: '', fullName: 'a/b' },
      ),
    ).toBe('open-on-forge');
  });

  test('a job with no id, or no checks address, gets the plain link', () => {
    expect(
      checkControl({ status: 'completed', conclusion: 'success', url }, repo),
    ).toBe('link');
    expect(
      checkControl({ status: 'in_progress', url, jobId: 7 }, undefined),
    ).toBe('link');
  });

  test('a held workflow links to its page, where the approve button is', () => {
    expect(checkControl({ status: 'waiting', url, jobId: 7 }, repo)).toBe(
      'link',
    );
  });

  test('a skipped job, or one with no page, offers nothing', () => {
    expect(
      checkControl(
        { status: 'completed', conclusion: 'skipped', url, jobId: 7 },
        repo,
      ),
    ).toBe('none');
    expect(checkControl({ status: 'queued', url: '' }, repo)).toBe('none');
    expect(checkControl({ status: 'in_progress', jobId: 7 }, repo)).toBe(
      'none',
    );
  });
});

// The words a screen reader hears for a check link that opens the forge in a
// new tab. They are typed out here on purpose, so editing the template and its
// callers together can't stay green.
describe('checkLinkLabel', () => {
  test('starts with the visible text, then the new-tab warning, then the check', () => {
    expect(checkLinkLabel('Open check page', 'build')).toBe(
      'Open check page (opens in a new tab): build',
    );
    expect(checkLinkLabel('Open on GitHub', 'lint')).toBe(
      'Open on GitHub (opens in a new tab): lint',
    );
    expect(checkLinkLabel('Open on Forgejo', 'queued-job')).toBe(
      'Open on Forgejo (opens in a new tab): queued-job',
    );
  });
});

// The words on the link beside a check. A running GitHub job has no output to
// show until it finishes, and the link says so rather than offering the same
// words as a queued one.
describe('checkLinkText', () => {
  test('a queued job opens on the forge', () => {
    expect(checkLinkText('open-on-forge', 'queued', 'GitHub')).toBe(
      'Open on GitHub',
    );
  });

  test('a running job with no log to read says it is watched on the forge', () => {
    expect(checkLinkText('open-on-forge', 'running', 'GitHub')).toBe(
      'Watch on GitHub',
    );
  });

  test('a job going from queued to running changes its words', () => {
    const queued = checkControl({ status: 'queued', url, jobId: 7 }, repo);
    const running = checkControl(
      { status: 'in_progress', url, jobId: 7 },
      repo,
    );
    expect(checkLinkText(queued, 'queued', 'GitHub')).toBe('Open on GitHub');
    expect(checkLinkText(running, 'running', 'GitHub')).toBe('Watch on GitHub');
  });

  test('a held workflow is approved on the forge that holds it', () => {
    expect(checkLinkText('link', 'awaiting_approval', 'Forgejo')).toBe(
      'Approve on Forgejo',
    );
  });

  test('a held workflow is approved and any other plain link opens the check page', () => {
    expect(checkLinkText('link', 'awaiting_approval', 'GitHub')).toBe(
      'Approve on GitHub',
    );
    expect(checkLinkText('link', 'success', 'GitHub')).toBe('Open check page');
  });
});

// The muted line under a row that has no output or no page to open. The first
// rule that matches wins.
describe('checkHint', () => {
  test('a skipped check says nothing, its chip already does', () => {
    expect(
      checkHint({ status: 'completed', conclusion: 'skipped', url }, repo),
    ).toBeNull();
    expect(
      checkHint({ status: 'completed', conclusion: 'skipped' }, repo),
    ).toBeNull();
  });

  test('a queued check has not started, with or without a page', () => {
    expect(checkHint({ status: 'queued', url }, repo)).toBe('Not started yet.');
    expect(checkHint({ status: 'queued' }, repo)).toBe('Not started yet.');
  });

  test('a running GitHub job with a page says its output waits for the end', () => {
    expect(checkHint({ status: 'in_progress', url, jobId: 7 }, repo)).toBe(
      'Output is available when it finishes.',
    );
  });

  test('a running Forgejo job streams its log and needs no line', () => {
    expect(
      checkHint({ status: 'in_progress', url, jobId: 7 }, forgejo),
    ).toBeNull();
  });

  test('any other state with no page says there is none', () => {
    for (const state of [
      'failure',
      'success',
      'cancelled',
      'running',
      'timed_out',
      'awaiting_approval',
    ]) {
      expect(checkHint({ ...factsOf(state), url: '' }, repo), state).toBe(
        'No page for this check.',
      );
    }
    expect(checkHint({ status: 'in_progress', jobId: 7 }, repo)).toBe(
      'No page for this check.',
    );
  });

  test('a check with a page and its own control needs no line', () => {
    for (const state of ['failure', 'success', 'awaiting_approval']) {
      expect(checkHint({ ...factsOf(state), url, jobId: 7 }, repo)).toBeNull();
    }
  });
});
