/// <reference types="bun" />
import { describe, expect, test } from 'bun:test';
import { createWebMCPTools } from './webmcp-tools';

// Every API operation is reachable through WebMCP, or says why it isn't, or is
// on the list of tools still to come. A new operation in api/openapi.yaml with
// none of the three fails here, so a capability can't ship that an in-browser
// agent can't reach. The server MCP has the same test in Go
// (internal/api/mcp_parity_test.go) and the same exclusion list: the
// `x-mcp-excluded` reason on the operation in the spec.
// https://github.com/alrayyes/forge-dashboard/issues/1503

interface Spec {
  paths?: Record<string, Record<string, unknown>>;
}

const METHODS = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch'];

/** Every operation in a parsed spec, with its exclusion reason if it has one. */
export function specOperations(spec: Spec): {
  ids: string[];
  excluded: Map<string, string>;
} {
  const ids: string[] = [];
  const excluded = new Map<string, string>();
  for (const [path, item] of Object.entries(spec.paths ?? {})) {
    for (const method of METHODS) {
      const op = item[method] as Record<string, unknown> | undefined;
      if (!op) continue;
      const id = op.operationId;
      if (typeof id !== 'string' || id === '') {
        throw new Error(`${method.toUpperCase()} ${path} has no operationId`);
      }
      if (ids.includes(id)) throw new Error(`operationId ${id} is used twice`);
      ids.push(id);
      const reason = op['x-mcp-excluded'];
      if (reason !== undefined) {
        if (typeof reason !== 'string' || reason.trim() === '') {
          throw new Error(`${id}: x-mcp-excluded must be a written reason`);
        }
        excluded.set(id, reason);
      }
    }
  }

  return { ids, excluded };
}

/** What is wrong with how a spec's operations are covered; empty when nothing. */
export function parityProblems(
  spec: Spec,
  toolOperations: Record<string, string>,
  pending: Record<string, string>,
): string[] {
  const { ids, excluded } = specOperations(spec);
  const problems: string[] = [];
  const covered = new Map<string, string>();
  const add = (id: string, how: string) => {
    const prev = covered.get(id);
    if (prev) problems.push(`${id} is both ${prev} and ${how}`);
    covered.set(id, how);
  };
  for (const [tool, id] of Object.entries(toolOperations)) {
    if (!ids.includes(id)) {
      problems.push(`tool ${tool} maps to ${id}, which is not in the spec`);
    }
    add(id, `tool ${tool}`);
  }
  for (const id of excluded.keys()) add(id, 'excluded');
  for (const [id, reason] of Object.entries(pending)) {
    if (reason.trim() === '') problems.push(`pending ${id} has no reason`);
    if (!ids.includes(id)) {
      problems.push(`pending ${id} is not in the spec`);
    }
    add(id, 'pending');
  }
  for (const id of ids) {
    if (!covered.has(id)) {
      problems.push(
        `${id} has no WebMCP tool, no x-mcp-excluded reason and no pending entry`,
      );
    }
  }

  return problems;
}

const NOT_YET = 'not yet: its tool arrives in a later small pull request';

// Operations whose WebMCP tool is still to come, one resource at a time. A pull
// request that adds a tool moves its operation out of here; the test refuses
// an operation that is both.
const PENDING_OPERATIONS = [
  'getSession',
  'listCredentials',
  'deleteCredential',
  'getSettings',
  'putSettings',
  'getTheme',
  'setTheme',
  'getTimezone',
  'setTimezone',
  'ensureWebhook',
  'ignoreRepo',
  'unignoreRepo',
  'enableAutoUpdateBranch',
  'disableAutoUpdateBranch',
  'mergePullRequest',
  'enablePullRequestAutoMerge',
  'cancelPullRequestAutoMerge',
  'closePullRequest',
  'rerunPullRequestChecks',
  'hidePullRequest',
  'unhidePullRequest',
  'updatePullRequestBranch',
  'postPullRequestDependabotAction',
  'postPullRequestRenovateRebase',
  'listQueuedActions',
  'queueAction',
  'cancelQueuedAction',
  'listUsers',
  'revokeUser',
  'deleteUser',
  'createInvite',
  'listInvites',
  'revokeInvite',
  'listRequests',
  'exportRequests',
  'getVersion',
  'refreshDashboard',
  'getSharing',
  'shareWith',
  'unshareWith',
];
const PENDING: Record<string, string> = Object.fromEntries(
  PENDING_OPERATIONS.map((id) => [id, NOT_YET]),
);

const tools = createWebMCPTools({
  getDashboard: async () => ({}),
});
const TOOL_OPERATIONS = Object.fromEntries(
  tools.map((t) => [t.name, t.operationId]),
);

const realSpec = Bun.YAML.parse(
  await Bun.file(new URL('../../../api/openapi.yaml', import.meta.url)).text(),
) as Spec;

const fakeSpec = (extra: Record<string, unknown> = {}): Spec => ({
  paths: {
    '/api/a': { get: { operationId: 'getA' } },
    '/api/b': { post: { operationId: 'postB', 'x-mcp-excluded': 'a probe' } },
    '/api/c': { get: { operationId: 'getC' } },
    ...Object.fromEntries(
      Object.entries(extra).map(([p, op]) => [p, { get: op }]),
    ),
  },
});

describe('the WebMCP parity check', () => {
  test('passes when each operation has a tool, an exclusion or a pending entry', () => {
    expect(
      parityProblems(fakeSpec(), { tool_a: 'getA' }, { getC: NOT_YET }),
    ).toEqual([]);
  });

  test('fails for a new operation with none of the three', () => {
    const spec = fakeSpec({ '/api/new': { operationId: 'getNew' } });
    expect(parityProblems(spec, { tool_a: 'getA' }, { getC: NOT_YET })).toEqual(
      [
        'getNew has no WebMCP tool, no x-mcp-excluded reason and no pending entry',
      ],
    );
  });

  test('fails for a tool that maps to an operation the spec lacks', () => {
    expect(
      parityProblems(
        fakeSpec(),
        { tool_a: 'getA', ghost: 'getGhost' },
        { getC: NOT_YET },
      ),
    ).toContain('tool ghost maps to getGhost, which is not in the spec');
  });

  test('fails for an operation that is both pending and covered', () => {
    expect(
      parityProblems(
        fakeSpec(),
        { tool_a: 'getA' },
        { getA: NOT_YET, getC: NOT_YET },
      ),
    ).toContain('getA is both tool tool_a and pending');
  });

  test('fails for a pending entry without a reason, or for an unknown operation', () => {
    const problems = parityProblems(
      fakeSpec(),
      { tool_a: 'getA' },
      { getC: ' ', getGone: NOT_YET },
    );
    expect(problems).toContain('pending getC has no reason');
    expect(problems).toContain('pending getGone is not in the spec');
  });

  test('refuses an exclusion with no written reason', () => {
    const spec: Spec = {
      paths: { '/x': { get: { operationId: 'x', 'x-mcp-excluded': '' } } },
    };
    expect(() => specOperations(spec)).toThrow('written reason');
  });
});

describe('api/openapi.yaml against the WebMCP tools', () => {
  test('every operation has a tool, an exclusion or a pending entry', () => {
    expect(parityProblems(realSpec, TOOL_OPERATIONS, PENDING)).toEqual([]);
  });

  test('every tool maps to an operation in the spec', () => {
    const { ids } = specOperations(realSpec);
    for (const tool of tools) {
      expect(ids).toContain(tool.operationId);
    }
  });

  test('every tool has a description, and an object input schema if any', () => {
    for (const tool of tools) {
      expect(tool.description.length).toBeGreaterThan(40);
      if (tool.inputSchema) {
        expect((tool.inputSchema as { type: string }).type).toBe('object');
      }
    }
  });
});
