import { describe, expect, it } from 'vitest';
import {
  appMatchesWorkspace,
  baseName,
  effectiveLabel,
  filterAppsByWorkspace,
  workspaceMemberNames,
  workspaceOptionsFrom,
} from './workspace-helpers';

// M173 (v1.15 "Atlas"): the effective-label rule — label, or folder basename
// when the searchRoot is unlabeled — mirrored from the daemon's src/graph.ts.

describe('baseName', () => {
  it('handles both separators and trailing slashes', () => {
    expect(baseName('D:\\ws\\alpha')).toBe('alpha');
    expect(baseName('/home/y/beta/')).toBe('beta');
    expect(baseName('')).toBeNull();
    expect(baseName(null)).toBeNull();
  });
});

describe('effectiveLabel', () => {
  it('label wins; basename fallback; null when neither', () => {
    expect(effectiveLabel('fullstack', 'D:\\ws\\alpha')).toBe('fullstack');
    expect(effectiveLabel(null, 'D:\\ws\\alpha')).toBe('alpha');
    expect(effectiveLabel(null, null)).toBeNull();
  });
});

describe('workspaceOptionsFrom', () => {
  const rows = [
    { path: 'D:\\ws\\alpha', label: 'fullstack' },
    { path: 'D:\\ws\\beta', label: null },
  ];

  it('configured roots first in config order, unlabeled as basename, deduped', () => {
    expect(workspaceOptionsFrom(rows, [])).toEqual(['fullstack', 'beta']);
  });

  it('labels seen on live apps append after config order', () => {
    const apps = [
      { workspaceLabel: 'fullstack', workspaceRoot: 'D:\\ws\\alpha' },
      { workspaceLabel: 'legacy', workspaceRoot: 'D:\\old' },
    ];
    expect(workspaceOptionsFrom(rows, apps)).toEqual(['fullstack', 'beta', 'legacy']);
  });

  it('degrades to app-derived labels when the workspaces fetch failed', () => {
    const apps = [{ workspaceLabel: null, workspaceRoot: 'D:\\ws\\beta' }];
    expect(workspaceOptionsFrom([], apps)).toEqual(['beta']);
  });
});

describe('appMatchesWorkspace / filterAppsByWorkspace', () => {
  const apps = [
    { name: 'web', workspaceLabel: 'fullstack', workspaceRoot: 'D:\\ws\\alpha' },
    { name: 'beta1', workspaceLabel: null, workspaceRoot: 'D:\\ws\\beta' },
  ];

  it('null = no filter; matching uses the effective label', () => {
    expect(filterAppsByWorkspace(apps, null)).toBe(apps);
    expect(filterAppsByWorkspace(apps, 'fullstack').map(a => a.name)).toEqual(['web']);
    expect(filterAppsByWorkspace(apps, 'beta').map(a => a.name)).toEqual(['beta1']);
    expect(filterAppsByWorkspace(apps, 'nope')).toEqual([]);
    expect(appMatchesWorkspace(apps[1], 'beta')).toBe(true);
  });
});

describe('workspaceMemberNames', () => {
  const apps = [
    { name: 'web', workspaceLabel: 'fullstack', workspaceRoot: 'D:\\ws\\alpha' },
    { name: 'beta1', workspaceLabel: null, workspaceRoot: 'D:\\ws\\beta' },
  ];

  it('null ws -> null (no filter), so callers can skip filtering entirely', () => {
    expect(workspaceMemberNames(apps, null)).toBeNull();
  });

  it('returns the name set of apps matching the effective label', () => {
    expect(workspaceMemberNames(apps, 'fullstack')).toEqual(new Set(['web']));
    expect(workspaceMemberNames(apps, 'beta')).toEqual(new Set(['beta1']));
    expect(workspaceMemberNames(apps, 'nope')).toEqual(new Set());
  });
});
