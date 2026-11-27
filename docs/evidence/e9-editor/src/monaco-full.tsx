// Size reference only: Monaco's default entry (all languages and contributions).
import * as monaco from 'monaco-editor';
monaco.editor.create(document.getElementById('root')!, { value: 'SELECT 1', language: 'sql' });
