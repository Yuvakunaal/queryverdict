// ESLint flat config (docs/IMPLEMENTATION_PLAN.md M01, docs/ARCHITECTURE.md §3–§4).
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';

/** src/core is framework-free TypeScript: no React and no UI, feature, store or app imports. */
const coreBoundary = {
  patterns: [
    { group: ['react', 'react/*', 'react-dom', 'react-dom/*'], message: 'src/core must not depend on React (docs/ARCHITECTURE.md §3).' },
    { regex: '(^|/)(ui|features|stores|app)(/|$)', message: 'src/core must not import UI, features, stores or the app shell (docs/ARCHITECTURE.md §4).' },
  ],
};

const HTML_SINK = 'forbidden HTML sink: render untrusted text as text (docs/ARCHITECTURE.md §19).';
/** Raw-HTML sinks, matched wherever the name appears (JSX, object keys, spreads, createElement props, computed access). */
const RAW_HTML_SINKS = [
  { selector: "JSXIdentifier[name='dangerouslySetInnerHTML']", message: `dangerouslySetInnerHTML is a ${HTML_SINK}` },
  { selector: "Identifier[name='dangerouslySetInnerHTML']", message: `dangerouslySetInnerHTML is a ${HTML_SINK}` },
  { selector: "Literal[value='dangerouslySetInnerHTML']", message: `dangerouslySetInnerHTML is a ${HTML_SINK}` },
  { selector: 'MemberExpression[property.name=/^(innerHTML|outerHTML)$/]', message: `innerHTML/outerHTML is a ${HTML_SINK}` },
  { selector: 'MemberExpression > Literal[value=/^(innerHTML|outerHTML)$/]', message: `innerHTML/outerHTML is a ${HTML_SINK}` },
  { selector: 'CallExpression[callee.property.name=/^(insertAdjacentHTML|createContextualFragment|setHTMLUnsafe|parseHTMLUnsafe)$/]', message: `this call is a ${HTML_SINK}` },
  { selector: "CallExpression[callee.object.name='document'][callee.property.name=/^(write|writeln)$/]", message: `document.write is a ${HTML_SINK}` },
  { selector: "JSXAttribute[name.name='srcDoc']", message: `srcDoc is a ${HTML_SINK}` },
];
/** Dynamic imports must use a string literal so scripts/check-boundaries.mjs can resolve them. */
const DYNAMIC_IMPORTS = [
  { selector: "ImportExpression[source.type!='Literal']", message: 'Dynamic import() must use a string literal (resolved by scripts/check-boundaries.mjs).' },
];

/** Production code must never import the test-only harness. */
const noHarness = {
  patterns: [{ regex: '(^|/)harness(/|$)', message: 'Production code must not import the test-only harness (P-022).' }],
};

export default tseslint.config(
  { ignores: ['dist/**', 'dist-harness/**', 'build/**', 'node_modules/**', 'spikes/**', 'test-results/**', 'playwright-report/**', 'public/**', 'docs/evidence/**'] },
  ...tseslint.configs.recommended,
  {
    files: ['**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks },
    rules: {
      ...reactHooks.configs.recommended.rules,
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
    },
  },
  {
    // Production code: untrusted text (file names, cells, SQL, errors) is always rendered as text,
    // and no code is evaluated from strings. Static rules cannot prove absence of every sink; the
    // browser tests and review are the other layers (docs/ARCHITECTURE.md §19).
    files: ['src/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': ['error', noHarness],
      'no-eval': 'error',
      'no-implied-eval': 'error',
      'no-new-func': 'error',
      'no-restricted-syntax': ['error', ...RAW_HTML_SINKS, ...DYNAMIC_IMPORTS],
    },
  },
  { files: ['src/core/**/*.{ts,tsx}'], rules: { 'no-restricted-imports': ['error', { patterns: [...coreBoundary.patterns, ...noHarness.patterns] }] } },
);
