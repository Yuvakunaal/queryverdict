# QueryVerdict UI implementation specification

**Status** · Proposed, 2026-11-26. This document specifies UI behavior and design acceptance for later implementation. The [architecture](ARCHITECTURE.md) remains pending. Routes, state ownership boundaries and editor choices below are proposals or observable contracts. [Production requirements](PRD.md) · [Visual system and mockups](DESIGN_SYSTEM.md) · [Feasibility requirements](SQL_ANALYSIS_FINDINGS.md#7-production-architecture-requirements-phase-5-inputs)

## 1. Scope and navigation

| Surface | Entry and purpose | Scope |
| --- | --- | --- |
| Landing | Root under the deployment's base path. Demo, workspace, supported SQL, privacy and source links. | P0 product entry |
| Workspace | Open workspace from landing. Contains Datasets, Editor, Results, Verdict and operation status. | P0 |
| Import / Explorer | Workspace action or empty-state action. Select files, name session tables, inspect schema and preview. | P0 |
| Profile | Dataset inspector or Verdict evidence. Show schema, bounded sample and validated join-key measures for the relevant snapshot. | P0 evidence view. Standalone scans, distributions and whole-table profiling are future proposals. |
| Visual Verdict | Verdict view in the workspace. One eligible join represented as inputs → join → output, with exact measurements and evidence. | P0 presentation of the supported result. A graph canvas, multi-stage tracing and general plan visualization remain future concepts under QV-ROAD-003/005. |
| Settings / shortcuts | Workspace header, available during engine startup and recovery. | P0 session preferences. Durable preferences and remapping can be evaluated separately. |

Keep workspace navigation, imports and views within the static site. Resolve internal links and assets relative to the configured project base. Source and documentation links can be intentional external navigation. One static entry point with client-side view selection is sufficient. Any route token may encode only a public view identifier. A copied URL carries no dataset identifiers, SQL text, expectations, results or workspace data. Refresh starts a new session.

## 2. Landing and onboarding

- **Landing** · Use “Same row count. Different rows.” and the worked sample to answer why this tool exists. Primary **Try the demo** starts the workspace with synthetic session tables and example SQL. Secondary **Open workspace** starts empty. Keep **Supported SQL**, **Privacy** and source discoverable. No deploy-date, performance claim or sign-up pitch.
- **Getting started, empty** · Show **Import CSV or Parquet** and **Load demo** in the main pane with “Files stay in this browser session.” Keep the editor usable while the engine initializes. Show at most three short next steps around import, writing an eligible join and Analyze. Replace the onboarding block with the relevant empty or active state as work progresses.
- **Getting started, demo** · Label the workspace **Illustrative data** while it contains the bundled example. Prefill the query and show the sample expectation as an editable example. Avoid background duplicate work. The demo entry loads the inputs and example SQL in one action. Run SQL and Analyze remain explicit and have separate states. If a sample report is rendered before analyzing, label it as an illustrative example and keep it separate from runtime results.
- **Replacing an active workspace** · Describe what would be cleared, including unsaved SQL and evidence when relevant. Keep **Cancel** as initial focus on destructive confirmation. If saved-to-disk files are mentioned, say exactly which state is affected. Loading a demo, resetting and retrying engine initialization must never trigger an old query.

## 3. Dataset import, explorer and profiling

**Import dialog.** Label the native file picker **Choose local files** and provide a visible drag-and-drop target as an alternative. Show CSV/Parquet, qualified workload guidance and “Imported as session tables.” Review filenames, source file bytes and proposed relation names before **Import**. Use names with predictable conflict handling. A requested name change that conflicts should show the resolved name or require correction before import. Show each file's stage independently. Use a progress bar only when a real numerator and denominator are supplied for that stage. Keep **Cancel import** reachable.

| Import state | UI response |
| --- | --- |
| Nothing selected | Native picker enabled. Import disabled with a visible reason. Return focus to picker after rejection when helpful. |
| Unsupported extension, malformed data, empty or unknown schema | State the observed issue per file. Keep eligible files and names available. An empty table with a known schema can be shown with zero rows. Offer reselection, a corrected file, or cancel. |
| Over the configured admission limit | State the actual file bytes and the applicable configured limit if known. Explain wider decoded files and joins can exceed other budgets. No “50 MB supported” copy until the release profile substantiates it. |
| Partial completion or cancellation | Show exactly which imports finished, which failed and which were cancelled. A working inventory exposes no partial table. Offer retry or remove for the affected entry only. |
| Worker replaced | Mark affected imports **Needs re-import**, disable querying them, and offer **Re-import** or **Choose file again** when access lapses. For SQL-created tables, say they must be recreated. Keep editor input in the open workspace. |

**Explorer and schema browser.** Use a 248–256 px initial sidebar. A dataset disclosure reveals columns and type labels. Show source/type/state, a measured row count only when available, and a selected-row state with visible focus. Dataset actions are **Preview**, **View schema**, **Copy table name**, **Remove** and **Re-import** when applicable. Copy uses the engine-safe quoted identifier supplied or validated by the SQL integration. The inspector shows schema before sample rows, displays nullability only where reported, and has a separate empty-sample state. Switching rows or tabs never starts a full scan. If a preview requires work, start it only on an explicit preview action with operation state.

**Profiling.** In P0, an **Overview** subsection shows imported metadata and sample scope. A **Join-key profile** appears only when the current Verdict provides validated evidence for that relation and key tuple. Its rows list non-NULL distinct key groups, duplicate key groups, NULL-key input rows, matched and unmatched input rows. Show dataset, side, analyzed key tuple and coverage. With no report, show “Analyze a supported join to inspect its keys.” A limited sample is described as such and is never presented as whole-table profiling. A future standalone profile can use explicit selected columns and bounded execution with separate acceptance for distributions, sampling and sensitive values. It remains outside P0.

## 4. SQL workspace and results

| Region | Content and behavior |
| --- | --- |
| Header | Wordmark, local session or illustrative indicator, shortcuts and settings. Include a skip link to the editor. |
| Sidebar | Dataset tree with Import and detail actions. Switch to a labelled drawer when the workspace is too narrow for both panes. |
| Editor | One session query buffer, visible language label, line numbers and syntax styling where available. **Run SQL** performs allowed ordinary SQL. **Analyze** submits the whole current query for the eligible Verdict subset. Analyze never auto-runs SQL. Editor text stays editable during operations. |
| Results and Verdict | Tab bar below the editor. Activate the matching panel on an explicit Run or Analyze action while keeping keyboard focus on its trigger. Panel selection alone does not issue SQL. Preserve each view's last identity and state. |
| Status strip | Engine ready/starting/recovering/failed and active operation text. Keep **Cancel** near the active operation in the toolbar and within reach regardless of the selected panel. A details affordance shows only measured counters and configured limits. |

**Results grid.** Start with a native table of bounded rows. Use sticky headers and an internal horizontal scroller for wide tables. Place the row-count and truncation footer outside the scroller. Mark NULL and empty strings distinctly, preserve exact values as text, and visibly mark each clipped cell. Do not expose a “total rows” value when only the displayed bound is known. Say “Showing the first N rows” only when the engine confirms that query sequence and the result limit is active. Without ORDER BY, label the numbered rows as display order rather than a stable ordering guarantee. A detail viewer shows only bounded content already available. A successful zero-row SQL result shows **SQL executed · 0 rows**. Mutation results use an affected-row count only when the operation supplies it. Optional sorting of displayed rows must be labelled as local to the bounded preview or omitted.

**Operation identity.** A displayed result or report belongs to the submitted query, eligible inputs and session. Keep a stable historical label after editing SQL, replacing inputs, running SQL that changes the underlying data, or resetting the engine. Historical reports cannot present a current violation. Hold back cancelled or superseded evidence on late delivery. Submitting a new task does not clear editor text. Notify the user when pending work references earlier SQL. Hidden-panel status updates must not move focus.

## 5. Visual SQL debugging and Verdict

The P0 Visual Verdict answers “What happened at this join?” Its reading order is **query identity and coverage → measured join → findings and expectations → witnesses → checked and outside scope**. Offer a full-width Verdict detail view to inspect evidence, with **Back to SQL** restoring editor selection or prior focus. Keep a small result summary on narrow screens. Free-form dragging, zooming, execution-plan diagrams and multi-stage tracing belong to separately qualified future work.

| Report region | Data and behavior |
| --- | --- |
| Header | Current or historical label, table aliases/names, supported join form and coverage state, plus **View diagnostic SQL** and **Copy summary** when available. Explicit **Copy diagnostic SQL** is available in the preview or as a labelled action with clear disclosure of what it copies. |
| Join diagram | Two input nodes labelled Left and Right with exact counts and relevant key diagnostics, a join node with type and key tuple, and output rows and matched pairs. Use small directional connectors and repeat the order in accessible text. Under LEFT, explicitly separate unmatched left rows preserved from rows dropped. Display whole-input and matched-key classifications with their scope. |
| Findings | Persistent text and icon for warning, violated expectation or operational failure. Each finding names its side, stage and evidence. Show measured facts once where a warning and expectation share evidence. Do not turn a matched relationship or SQL execution into a correctness verdict. |
| Expectations | The four supported rule types are Relationship, No row loss, No fan-out and Output row count. Use side selection where relevant and inclusive min/max fields. Labels explain that relationship rules set the maximum multiplicity allowed. Require an explicit add/edit action, then analyze to bind the rule to a current report. Invalid inputs are announced at their controls and produce an explicit unchecked outcome if included in a report. |
| Witness table | Separate tabs or filters for fan-out and unmatched keys. Show at most five per kind, exact key tuples, left/right counts and output contribution. Use deterministic ordering from the report. Label samples as bounded, and show NULL-key totals separately. In an empty category use “No sample keys for this check” with the validated count or reason. |
| Coverage and reproduction | List what was checked, omitted or refused, with a reason per unavailable area. Disclose the dialect, table/snapshot prerequisites and whether the SQL was a probe. Default summary omits witness values, private identifiers and SQL. Show the exact content before copying any diagnostic SQL that can contain identifying literals or relation names. Announce copy success without moving focus. |

**Unavailable analysis** · State **Unsupported** and name the specific construct or type, or state **Inconclusive** and name the failed validation or budget limit. Offer supported syntax help, schema inspection, ordinary Run SQL where allowed, or a smaller input. Keep retained observations separate and visibly labelled as limited coverage. Cancelled and stale runs expose no current authoritative evidence or held/violated outcome.

### Illustrative fixture used in all three mockups

- Left table `orders` has eight rows. Customer keys are `101, 102, 103, 104, 105, 106, 107, NULL`. Order IDs are 7001 through 7008 in that fixture order.
- Right table `customers` has nine rows with keys `101, 102, 102, 103, 104, 105, 105, 106, 109`. The first eight right rows have regions North, West, Central, South, East, West, North, East. Key 109 has region South.
- INNER equality produces eight matched pairs, six represented left rows, eight represented right rows, two multiplied left rows, two excess copies, two dropped left rows, one dropped right row, and two right duplicate groups. `102` and `105` each contribute two pairs and one extra left copy. `107` has no right row. `109` has no left row. One left NULL-key row is counted separately. The declared no-left-fan-out expectation is violated. The left row loss is a warning because there is no declared preservation rule. The displayed result order is illustrative.

## 6. Resource monitoring and cancellation

Show **Queued**, **Running SQL**, **Importing**, **Analyzing**, **Cancelling**, **Recovering**, **Failed** or **Ready** with the action and input/query identity as applicable. For active work, show elapsed time only when derived from a local operation clock, and label it as elapsed. Show transferred bytes or rows returned only when measured and label the measurement source. Display a configured budget as a **limit**. Optional engine memory telemetry, if qualified, must name its exact scope and freshness, for example “DuckDB buffer manager · last measured …”. Omit it when unknown, stale or unsupported. No tab memory percentage, ETA, CPU estimate or health score.

**Cancel** targets the visible queued request or active operation, with a single **Cancelling…** status after acceptance. A bounded stop can trigger recovery. Show **Recovering engine** until a verified ready state or failure. On replacement, explain that the in-memory database was lost. Offer explicit re-import or retry. Announce transitions through a status region and never predict a successful recovery. If background tabs delay timing, reconcile on return and show the actual terminal state. Keep a retry action visible if recovery failed. For boot and policy failure, preserve editor text and disable SQL, import, and analysis until verified readiness.

## 7. Settings, shortcuts and responsive behavior

**Settings** · Theme offers System, Light and Dark. Density offers Compact, Standard and Comfortable. Editor settings expose font size or use browser zoom and a wrap toggle. Session reset has its own action and confirmation. No storage or telemetry controls imply account-level settings. The current-session preference model is the default until persistence is approved.

| Action | Candidate binding | Interaction |
| --- | --- | --- |
| Run SQL | Command/Control + Enter | Scoped to editor and enabled action. Visible button is always available in the intended layout. |
| Analyze | Command/Control + Shift + Enter | Scoped to editor and supported active workspace. Distinct from Run. |
| Shortcut reference | Header button | Accessible dialog shows platform-specific keys and equivalent visible actions. |
| Resize focused splitter | Arrow keys, with optional Shift for larger steps | Up/Down for stacked views, Left/Right for side panels. Provide menu presets and Reset layout. Screen-reader announcement reports value as a percentage. |
| Leave the editor | Normal Tab by default, or documented escape if indent mode captures Tab | Hint near the editor and in shortcuts. Closing a dialog restores the opener's focus. |
| Cancel operation | Named button | Cancel is keyboard reachable while active. Escape dismisses the topmost dialog or menu and never silently stops SQL. |

Avoid global single-character shortcuts. Test platform and assistive-technology conflicts before fixing bindings. Preserve access to the browser's zoom, find and platform controls. No hidden keyboard-only feature.

| Width or condition | Layout |
| --- | --- |
| 1200 px and wider | Sidebar, resizable editor/output stack and optional full-width Verdict main area. Sidebar 200–360 px. Minimum editor 160 px and output 160 px when both panes are visible. |
| 900–1199 px | Narrower sidebar or collapsible drawer. Keep editor controls visible. Verdict nodes can stack without losing order. |
| Below 900 px or high zoom | Single-column workspace, drawer for datasets, tabs to switch Editor/Results/Verdict, and a concise active-operation strip. Tables scroll within their region and have names and focus. |
| Below 768 px on landing | Stack copy above example. Wrap or collapse nav into an accessible menu. Prefer full-width tap targets and a contained example table. |
| Short viewport or screen-reader linear navigation | Remove sticky regions that hide focused controls. Keep heading and landmark order consistent. Mobile layouts describe interface behavior, not engine support. |

## 8. UI handoff and acceptance

The UI needs a query and dataset identity, session/engine generation, operation and progress state, report authority and reasons, exact text values, declared expectation outcomes, capability/refusal reasons, provenance, truncation causes, and reset/re-import status. This is the data the interface must be able to distinguish. Architecture review defines transport, state ownership, cancellation integration, resource measurement availability, and safe route and editor implementation. Frontend work stays behind the project's implementation approval gate.

| Check | Observable acceptance | PRD |
| --- | --- | --- |
| UX-001 · First use | Landing → demo completes from an empty browser session. Demo marker remains visible. Existing workspace replacement prompts before any destructive action. | QV-PLAT-001, QV-UI-002 |
| UX-002 · Imports | Keyboard-only selection, invalid file, mixed outcomes, duplicate-name resolution, removal and post-restart re-import all expose the correct table state and preserve editor text. | QV-DATA-001/002, QV-ACC-001 |
| UX-003 · SQL | Run and Analyze follow distinct operation paths. SQL success, errors, empty output and each truncation cause remain distinct. A Result tab switch never runs SQL. | QV-UI-001, QV-SQL-001, QV-RES-001 |
| UX-004 · Verdict | Known fixture reproduces sample counts. One declared violation and one warning render distinctly. Unsupported, stale, cancelled, incomplete and unchecked outcomes never present a correctness pass. | QV-VER-001–006 |
| UX-005 · Cancellation and resource display | Fault-injected queued, running, timed-out and failed-recovery paths remain operable with the keyboard. Status changes are announced once, old results cannot republish, absent telemetry is omitted, and budget values are labelled limits. | QV-RES-002/003/004, QV-VER-005 |
| UX-006 · Accessibility | Test both themes, OS theme changes, reduced motion, 200% zoom, 320 CSS px reflow where applicable, keyboard import and resize, focus return, text contrast, and VoiceOver/NVDA on the supported release matrix. The editor always offers a keyboard exit. | QV-ACC-001 |
| UX-007 · Privacy | No automatic copying or sharing. Summary preview excludes SQL, private names and witness values. Clear/reset discards local view state, and navigation never serializes workspace data in URLs. | QV-UI-003, QV-SEC-001/002/003 |

Static design artifacts illustrate the default state. They do not verify browser integration, keyboard behavior, screen-reader compliance, resource bounds, cross-browser layout or a production build.
