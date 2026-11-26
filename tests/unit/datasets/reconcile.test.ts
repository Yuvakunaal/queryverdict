import { describe, expect, it } from 'vitest';
import { mergeCatalog } from '../../../src/core/datasets/reconcile';
import type { CatalogObject, CatalogSnapshot, TrackedImport } from '../../../src/core/datasets/types';
import type { DataEpoch, Generation } from '../../../src/core/engine/types';

const G = (n: number) => n as Generation;
const E = (n: number) => n as DataEpoch;
const table = (name: string, oid: string, extra: Partial<CatalogObject> = {}): CatalogObject => ({ kind: 'table', database: 'memory', schema: 'main', name, oid, temporary: false, generated: false, ...extra });
const snap = (objects: CatalogObject[]): CatalogSnapshot => ({ currentDatabase: 'memory', currentSchema: 'main', objects, columns: [{ database: 'memory', schema: 'main', relation: 'orders', name: 'id', type: 'BIGINT', nullable: true }] });
const tracked = (relation: string, oid: string, generation = 1, extra: Partial<TrackedImport> = {}): TrackedImport => ({
  relation, identity: { database: 'memory', schema: 'main', oid }, source: { fileName: `${relation}.csv`, bytes: 10, format: 'csv' },
  file: new File(['x'], `${relation}.csv`), generation: G(generation), rowCount: '3', rowCountEpoch: E(1), ...extra,
});

describe('catalog reconciliation (QV-ENG-011)', () => {
  it('an imported table present with the same identity is ready, with its measured row count', () => {
    const [e] = mergeCatalog({ catalog: snap([table('orders', '10')]), tracked: [tracked('orders', '10')], generation: G(1), epoch: E(1) });
    expect(e).toMatchObject({ relation: 'orders', origin: 'imported', state: 'ready', rowCount: '3', verdictEligible: true, columns: [{ name: 'id', type: 'BIGINT', nullable: true }] });
  });

  it('omits a row count measured before the data last changed', () => {
    const [e] = mergeCatalog({ catalog: snap([table('orders', '10')]), tracked: [tracked('orders', '10')], generation: G(1), epoch: E(2) });
    expect(e?.rowCount).toBeUndefined();
  });

  it('dropped or renamed by SQL → missing; replaced by SQL → changed', () => {
    const missing = mergeCatalog({ catalog: snap([table('orders_renamed', '10')]), tracked: [tracked('orders', '10')], generation: G(1), epoch: E(1) });
    expect(missing.find((e) => e.relation === 'orders')).toMatchObject({ state: 'missing', verdictEligible: false });
    expect(missing.find((e) => e.relation === 'orders_renamed')).toMatchObject({ origin: 'sql', state: 'ready' });
    const [changed] = mergeCatalog({ catalog: snap([table('orders', '99')]), tracked: [tracked('orders', '10')], generation: G(1), epoch: E(1) });
    expect(changed).toMatchObject({ state: 'changed', identity: { oid: '99' } });
  });

  it('after engine replacement every import needs re-import (never restored automatically)', () => {
    const [e] = mergeCatalog({ catalog: snap([]), tracked: [tracked('orders', '10', 1)], generation: G(2), epoch: E(3) });
    expect(e).toMatchObject({ state: 'needs-reimport', verdictEligible: false });
    const [down] = mergeCatalog({ catalog: null, tracked: [tracked('orders', '10', 1)], generation: null, epoch: E(3) });
    expect(down?.state).toBe('needs-reimport');
  });

  it('a failed re-import is reported as failed with its reason', () => {
    const [e] = mergeCatalog({ catalog: snap([]), tracked: [tracked('orders', '10', 1, { failure: 'Choose the file again.' })], generation: G(2), epoch: E(3) });
    expect(e).toMatchObject({ state: 'failed', reason: 'Choose the file again.' });
  });

  it('SQL-created tables and views appear; views, ambiguous names, other schemas and generated columns are not Verdict-eligible', () => {
    const entries = mergeCatalog({
      catalog: snap([
        table('t_sql', '1'), table('t_gen', '2', { generated: true }), table('t_other', '3', { database: 'other' }), table('t_tmp', '4', { database: 'temp', temporary: true }),
        { ...table('v', '5'), kind: 'view' }, table('dup', '6'), table('dup', '7', { database: 'temp', temporary: true }), table('__qv_scratch', '8'),
      ]),
      tracked: [], generation: G(1), epoch: E(1),
    });
    const by = (n: string) => entries.filter((e) => e.relation === n);
    expect(by('t_sql')[0]).toMatchObject({ origin: 'sql', verdictEligible: true });
    expect(by('t_tmp')[0]?.verdictEligible).toBe(true);
    expect(by('t_gen')[0]?.eligibilityReason).toMatch(/generated/);
    expect(by('t_other')[0]?.eligibilityReason).toMatch(/outside the current schema/);
    expect(by('v')[0]).toMatchObject({ kind: 'view', verdictEligible: false });
    expect(by('dup').every((e) => e.verdictEligible === false && /ambiguous/.test(e.eligibilityReason ?? ''))).toBe(true);
    expect(by('__qv_scratch')).toEqual([]);
  });
});
