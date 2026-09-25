import js from '@eslint/js';
import globals from 'globals';

export default [
    { ignores: ['dist/', 'node_modules/', '.playwright-mcp/'] },
    js.configs.recommended,
    {
        languageOptions: {
            ecmaVersion: 2022,
            sourceType: 'module',
            globals: globals.browser
        },
        rules: {
            'no-unused-vars': ['warn', { args: 'none' }]
        }
    },
    {
        files: ['*.config.js', 'take_screenshots.js'],
        languageOptions: { globals: globals.node }
    }
];
