// ioBroker eslint configuration for the VIS-2 widget set (React + TypeScript)
import config, { reactConfig } from '@iobroker/eslint-config';

export default [
    ...config,
    ...reactConfig,
    {
        languageOptions: {
            parserOptions: {
                projectService: {
                    allowDefaultProject: ['*.mjs', '*.mts'],
                },
                tsconfigRootDir: import.meta.dirname,
            },
        },
    },
    {
        // Props and interface fields are typed; per-field JSDoc would only repeat the names
        rules: {
            'jsdoc/require-jsdoc': 'off',
            'jsdoc/require-param': 'off',
        },
    },
    {
        ignores: ['build/', 'node_modules/', 'public/', '*.config.mjs', '*.config.mts'],
    },
];
