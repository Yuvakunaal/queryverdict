import { useId, useRef, useState, useSyncExternalStore, type FormEvent } from 'react';
import { flushSync } from 'react-dom';
import { invalidExpectation } from '../../core/verdict/expectations';
import { RELATIONSHIPS, type Expectation, type Relationship, type VerdictReport } from '../../core/verdict/types';
import type { ExpectationStore } from '../../stores/expectationStore';
import { Button } from '../../ui/Button';
import { describeExpectation, evidenceRows, EXPECTATION_KIND_LABEL, expectationTarget, outcomeSentence, outcomeView, presentation } from './model';
import { StatusMark } from './VerdictStates';

// ---------------------------------------------------------------------------------------------
// Outcomes of a report

/**
 * Exactly one outcome per declared expectation, in declaration order (PRD QV-VER-003). `unchecked`
 * is shown with its reason and never as held; a historical report's outcomes are labelled
 * historical and never shown as current violations.
 */
export function ExpectationOutcomes({ report, current }: { report: VerdictReport; current: boolean }) {
  if (!report.expectations.length) return <p className="empty-note">No expectations were declared for this analysis.</p>;
  const limited = current && !report.authoritative && report.expectations.some((o) => o.outcome !== 'unchecked');
  return (
    <>
    {limited ? (
      <p className="vd-foot">
        This report is not authoritative ({report.nonAuthoritativeReasons[0] ?? report.status}). The outcomes below were computed from its validated measurements, but they are limited evidence, not a definitive result.
      </p>
    ) : null}
    <ol className="vd-outcomes">
      {[...report.expectations].sort((a, b) => Number(b.outcome === 'violated') - Number(a.outcome === 'violated') || a.index - b.index).map((o) => {
        const v = outcomeView(o, presentation(report, current));
        const ev = evidenceRows(o.evidence);
        return (
          <li key={o.index} className="vd-outcome" data-tone={v.tone} data-outcome={o.outcome}>
            <p className="vd-outcome-head">
              <span className="vd-outcome-badge" data-tone={v.tone}>
                <StatusMark tone={v.tone} />
                {v.label}
              </span>
              <span className="vd-outcome-rule">
                Expectation {o.index + 1} · {describeExpectation(o.expectation)}
              </span>
            </p>
            <p className="vd-outcome-meta">Target: {expectationTarget(o.expectation)}</p>
            <p className="vd-outcome-reason">{outcomeSentence(o, report.join).replace(/^(Held|Violated): /, '')}</p>
            {o.outcome === 'held' && current && report.authoritative ? <p className="vd-outcome-reason">Held on the analysed snapshot, for this rule only.</p> : null}
            {ev.length ? (
              <details className="vd-evidence">
                <summary>Evidence ({ev.length} values)</summary>
                <dl>
                  {ev.map(([k, val]) => (
                    <div key={k}>
                      <dt>{k}</dt>
                      <dd>{val}</dd>
                    </div>
                  ))}
                </dl>
              </details>
            ) : null}
          </li>
        );
      })}
    </ol>
    </>
  );
}

// ---------------------------------------------------------------------------------------------
// Authoring

interface Draft {
  readonly kind: Expectation['kind'];
  readonly expected: Relationship;
  readonly side: 'left' | 'right';
  readonly min: string;
  readonly max: string;
}
const EMPTY: Draft = { kind: 'no-fan-out', expected: 'one-to-many', side: 'left', min: '', max: '' };

type Field = 'min' | 'max' | 'form';
export type FieldErrors = Partial<Record<Field, string>>;

const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);

/** Reads a whole-number field: '' → undefined; anything else must be a non-negative safe integer. */
function readCount(text: string): { value?: number; error?: string } {
  const t = text.trim();
  if (t === '') return {};
  if (!/^\d+$/.test(t)) return { error: 'Enter a whole number of 0 or more, digits only.' };
  if (BigInt(t) > MAX_SAFE) return { error: `Enter a number no larger than ${Number.MAX_SAFE_INTEGER.toLocaleString('en-US')}.` };
  return { value: Number(t) };
}

/**
 * Builds the declaration from the form. Field parsing (digits only) happens here; the domain
 * rules (supported kinds and shapes, bounds present, min ≤ max) are the core's
 * `invalidExpectation`, whose verdict is mapped onto the field it concerns.
 */
export function buildExpectation(d: Draft): { value: Expectation | null; errors: FieldErrors } {
  let value: Expectation;
  const errors: FieldErrors = {};
  if (d.kind === 'relationship') value = { kind: 'relationship', join: 0, expected: d.expected };
  else if (d.kind === 'no-row-loss' || d.kind === 'no-fan-out') value = { kind: d.kind, join: 0, side: d.side };
  else {
    const min = readCount(d.min);
    const max = readCount(d.max);
    if (min.error) errors.min = min.error;
    if (max.error) errors.max = max.error;
    if (errors.min || errors.max) return { value: null, errors };
    value = { kind: 'row-count', ...(min.value !== undefined ? { min: min.value } : {}), ...(max.value !== undefined ? { max: max.value } : {}) };
  }
  const bad = invalidExpectation(value);
  if (!bad) return { value, errors };
  if (bad === 'min is greater than max') errors.max = 'The maximum must be at least the minimum.';
  else if (bad === 'row-count needs min, max or both') errors.form = 'Enter a minimum, a maximum or both.';
  else errors.form = `This expectation is not valid: ${bad}.`;
  return { value: null, errors };
}

function draftOf(e: Expectation): Draft {
  switch (e.kind) {
    case 'relationship':
      return { ...EMPTY, kind: e.kind, expected: e.expected };
    case 'no-row-loss':
    case 'no-fan-out':
      return { ...EMPTY, kind: e.kind, side: e.side };
    case 'row-count':
      return { ...EMPTY, kind: e.kind, min: e.min === undefined ? '' : String(e.min), max: e.max === undefined ? '' : String(e.max) };
  }
}

const KIND_HELP: Record<Expectation['kind'], string> = {
  relationship:
    'Sets the maximum multiplicity allowed on each side, checked over the whole inputs. One-to-many: each key at most once on the left, any number of times on the right. An observed one-to-one relationship satisfies one-to-many and many-to-one; many-to-many allows anything.',
  'no-row-loss': 'Every input row on this side contributes at least one output row. In a LEFT JOIN, unmatched left rows are kept, so they are not lost.',
  'no-fan-out': 'No input row on this side appears more than once in the output.',
  'row-count': 'The join produces between the minimum and maximum output rows, both inclusive. Leave one empty for an open bound.',
};

const RELATIONSHIP_LABEL: Record<Relationship, string> = {
  'one-to-one': 'One-to-one (each key at most once on both sides)',
  'one-to-many': 'One-to-many (unique on the left)',
  'many-to-one': 'Many-to-one (unique on the right)',
  'many-to-many': 'Many-to-many (no uniqueness required)',
};

/**
 * How the declarations relate to the shown report: evaluated by the current report; given to the
 * current report but not evaluated (it was interrupted, unsupported or incomplete); or not part of
 * any current report (no report, a historical one, or edited since).
 */
export type DeclarationState = 'evaluated' | 'not-evaluated' | 'pending';

export interface ExpectationsEditorProps {
  readonly store: ExpectationStore;
  readonly state: DeclarationState;
  /** The app's single status region (announces a refused declaration even if focus does not move). */
  announce?(message: string): void;
}

const STATE_TEXT: Record<DeclarationState, string> = {
  evaluated: 'These declarations are the ones evaluated in the current report.',
  'not-evaluated': 'The current report received these declarations but could not evaluate them; their outcomes above are unchecked.',
  pending: 'Analyze to evaluate these declarations against the current query and data.',
};

/**
 * Authoring of the four P0 join-stage expectations (UI_SPECIFICATION §5 "Expectations"; PRD
 * QV-VER-003). An explicit Add or Save is required; nothing is analyzed automatically, and a
 * changed declaration makes an existing report historical (P-100) until Analyze binds the rules
 * to a new report. Invalid input is reported at its control and never stored.
 */
export function ExpectationsEditor({ store, state, announce }: ExpectationsEditorProps) {
  const list = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  const [draft, setDraft] = useState<Draft>(EMPTY);
  const [editing, setEditing] = useState<number | null>(null);
  const [errors, setErrors] = useState<FieldErrors>({});
  const id = useId();
  const kindRef = useRef<HTMLSelectElement>(null);
  const minRef = useRef<HTMLInputElement>(null);
  const maxRef = useRef<HTMLInputElement>(null);
  const formRef = useRef<HTMLFormElement>(null);

  const set = (patch: Partial<Draft>) => {
    setDraft((d) => ({ ...d, ...patch }));
    setErrors({});
  };
  const reset = () => {
    setDraft(EMPTY);
    setEditing(null);
    setErrors({});
  };
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const built = buildExpectation(draft);
    if (!built.value) {
      // Commit the error (aria-invalid, aria-describedby, message) before focus moves, so the
      // field is announced with its error; the status region covers a field that already had focus.
      flushSync(() => setErrors(built.errors));
      (built.errors.min ? minRef : built.errors.max ? maxRef : kindRef).current?.focus();
      announce?.(`Expectation not saved: ${built.errors.min ?? built.errors.max ?? built.errors.form ?? 'invalid input'}`);
      return;
    }
    const r = editing !== null ? store.update(editing, built.value) : store.add(built.value);
    if (!r.ok) {
      flushSync(() => setErrors({ form: `This expectation is not valid: ${r.error}.` }));
      kindRef.current?.focus();
      announce?.(`Expectation not saved: ${r.error}.`);
      return;
    }
    announce?.(editing !== null ? 'Expectation saved. Analyze to evaluate it.' : 'Expectation added. Analyze to evaluate it.');
    reset();
    kindRef.current?.focus();
  };
  const edit = (eid: number, value: Expectation) => {
    setDraft(draftOf(value));
    setEditing(eid);
    setErrors({});
    kindRef.current?.focus();
  };
  const remove = (eid: number) => {
    store.remove(eid);
    if (editing === eid) reset();
    kindRef.current?.focus();
  };

  const err = (f: Field) => (errors[f] ? `${id}-${f}-error` : undefined);
  const editingIndex = editing === null ? -1 : list.findIndex((x) => x.id === editing);

  return (
    <div className="vd-editor">
      <h4 className="vd-subhead" id={`${id}-declared`}>
        Declared expectations
      </h4>
      {list.length ? (
        <>
          <p className="vd-foot">{STATE_TEXT[state]}</p>
          <ol className="vd-declared" aria-labelledby={`${id}-declared`}>
            {list.map((x, i) => (
              <li key={x.id} data-editing={x.id === editing || undefined}>
                <span className="vd-declared-text">
                  <span className="vd-declared-n">{i + 1}.</span> {describeExpectation(x.value)} <span className="muted">· {expectationTarget(x.value)}</span>
                </span>
                <span className="vd-declared-actions">
                  <Button className="btn-small" variant="quiet" onClick={() => edit(x.id, x.value)} aria-label={`Edit expectation ${i + 1}: ${describeExpectation(x.value)}`}>
                    Edit
                  </Button>
                  <Button className="btn-small" variant="quiet" onClick={() => remove(x.id)} aria-label={`Remove expectation ${i + 1}: ${describeExpectation(x.value)}`}>
                    Remove
                  </Button>
                </span>
              </li>
            ))}
          </ol>
        </>
      ) : (
        <p className="empty-note">No expectations declared. They are optional: without them, Verdict still measures the join.</p>
      )}

      <form ref={formRef} className="vd-form" onSubmit={submit} noValidate aria-labelledby={`${id}-form-title`}>
        <p className="vd-form-title" id={`${id}-form-title`}>
          {editing !== null ? `Edit expectation ${editingIndex + 1}` : 'Add an expectation'}
        </p>
        <div className="vd-field">
          <label htmlFor={`${id}-kind`}>Rule</label>
          <select id={`${id}-kind`} ref={kindRef} value={draft.kind} onChange={(e) => set({ kind: e.target.value as Expectation['kind'] })} aria-describedby={`${id}-help ${err('form') ?? ''}`.trim()} aria-invalid={errors.form ? true : undefined}>
            {(Object.keys(EXPECTATION_KIND_LABEL) as Expectation['kind'][]).map((k) => (
              <option key={k} value={k}>
                {EXPECTATION_KIND_LABEL[k]}
              </option>
            ))}
          </select>
        </div>
        {draft.kind === 'relationship' ? (
          <div className="vd-field">
            <label htmlFor={`${id}-rel`}>Maximum allowed relationship</label>
            <select id={`${id}-rel`} value={draft.expected} onChange={(e) => set({ expected: e.target.value as Relationship })}>
              {RELATIONSHIPS.map((r) => (
                <option key={r} value={r}>
                  {RELATIONSHIP_LABEL[r]}
                </option>
              ))}
            </select>
          </div>
        ) : draft.kind === 'row-count' ? (
          <>
            <div className="vd-field">
              <label htmlFor={`${id}-min`}>Minimum output rows</label>
              <input
                id={`${id}-min`}
                ref={minRef}
                inputMode="numeric"
                autoComplete="off"
                spellCheck={false}
                value={draft.min}
                onChange={(e) => set({ min: e.target.value })}
                aria-invalid={errors.min ? true : undefined}
                aria-describedby={err('min')}
              />
              {errors.min ? (
                <p className="vd-error" id={err('min')}>
                  {errors.min}
                </p>
              ) : null}
            </div>
            <div className="vd-field">
              <label htmlFor={`${id}-max`}>Maximum output rows</label>
              <input
                id={`${id}-max`}
                ref={maxRef}
                inputMode="numeric"
                autoComplete="off"
                spellCheck={false}
                value={draft.max}
                onChange={(e) => set({ max: e.target.value })}
                aria-invalid={errors.max ? true : undefined}
                aria-describedby={err('max')}
              />
              {errors.max ? (
                <p className="vd-error" id={err('max')}>
                  {errors.max}
                </p>
              ) : null}
            </div>
          </>
        ) : (
          <fieldset className="vd-field vd-sides">
            <legend>Side</legend>
            {(['left', 'right'] as const).map((s) => (
              <label key={s} className="radio-option">
                <input type="radio" name={`${id}-side`} value={s} checked={draft.side === s} onChange={() => set({ side: s })} />
                {s === 'left' ? 'Left input' : 'Right input'}
              </label>
            ))}
          </fieldset>
        )}
        <p className="vd-help" id={`${id}-help`}>
          {KIND_HELP[draft.kind]}
        </p>
        {errors.form ? (
          <p className="vd-error" id={err('form')}>
            {errors.form}
          </p>
        ) : null}
        <div className="vd-form-actions">
          <Button type="submit" className="btn-small">
            {editing !== null ? 'Save changes' : 'Add expectation'}
          </Button>
          {editing !== null ? (
            <Button className="btn-small" variant="quiet" onClick={reset}>
              Cancel edit
            </Button>
          ) : null}
        </div>
      </form>
    </div>
  );
}
