// Builds the widget set as a module federation remote for VIS-2 (layout of ioBroker.vis-2-widgets-react-template).
// React comes from VIS-2 as shared singleton, the bundle only holds the widget itself.
import react from '@vitejs/plugin-react';
import { federation } from '@module-federation/vite';
import { moduleFederationShared } from '@iobroker/types-vis-2/modulefederation.vis.config';

export default {
    plugins: [
        federation({
            manifest: true,
            name: 'vis2LiebherrHome',
            filename: 'customWidgets.js',
            exposes: {
                './LiebherrDevice': './src/LiebherrDevice',
                './translations': './src/translations',
            },
            remotes: {},
            // only React is used at runtime; MUI and gui-components are installed for the vis-2 types only
            shared: moduleFederationShared(['react', 'react-dom']),
            dts: false,
        }),
        react(),
    ],
    server: {
        port: 3000,
        proxy: {
            '/_socket': 'http://localhost:8082',
            '/vis.0': 'http://localhost:8082',
            '/adapter': 'http://localhost:8082',
            '/vis': 'http://localhost:8082',
            '/widgets': 'http://localhost:8082/vis',
            '/web': 'http://localhost:8082',
            '/state': 'http://localhost:8082',
        },
    },
    base: './',
    resolve: {
        dedupe: ['react', 'react-dom'],
    },
    build: {
        target: 'chrome89',
        outDir: './build',
        rollupOptions: {
            onwarn(warning: { code: string }, warn: (warning: { code: string }) => void): void {
                // "Module level directives cause errors when bundled" ("use client" in dependencies)
                if (warning.code === 'MODULE_LEVEL_DIRECTIVE') {
                    return;
                }
                warn(warning);
            },
        },
    },
};
