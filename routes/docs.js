const express = require('express');
const path = require('path');
const fs = require('fs');

const docsRouter = express.Router();

// Serve the main documentation page
docsRouter.get('/', (req, res) => {
    const docsPath = path.join(__dirname, '../docs/index.html');

    // Check if docs file exists
    if (fs.existsSync(docsPath)) {
        res.sendFile(docsPath);
    } else {
        res.status(404).json({
            error: 'Documentation not found',
            message: 'API documentation has not been built yet. Please run "npm run docs:build" to generate the documentation.',
            instructions: {
                build: 'npm run docs:build',
                serve_development: 'npm run docs:serve'
            }
        });
    }
});

// Serve the OpenAPI spec as JSON
docsRouter.get('/openapi.json', (req, res) => {
    const specPath = path.join(__dirname, '../openapi.yaml');

    if (fs.existsSync(specPath)) {
        const yaml = require('js-yaml');
        const yamlContent = fs.readFileSync(specPath, 'utf8');

        try {
            const jsonSpec = yaml.load(yamlContent);
            res.json(jsonSpec);
        } catch (error) {
            res.status(500).json({
                error: 'Failed to parse OpenAPI specification',
                message: error.message
            });
        }
    } else {
        res.status(404).json({
            error: 'OpenAPI specification not found',
            message: 'The OpenAPI specification file (openapi.yaml) was not found.'
        });
    }
});

// Serve the raw YAML spec
docsRouter.get('/openapi.yaml', (req, res) => {
    const specPath = path.join(__dirname, '../openapi.yaml');

    if (fs.existsSync(specPath)) {
        res.type('text/yaml');
        res.sendFile(specPath);
    } else {
        res.status(404).json({
            error: 'OpenAPI specification not found',
            message: 'The OpenAPI specification file (openapi.yaml) was not found.'
        });
    }
});

// API documentation info endpoint
docsRouter.get('/info', (req, res) => {
    const docsPath = path.join(__dirname, '../docs/index.html');
    const specPath = path.join(__dirname, '../openapi.yaml');

    res.json({
        title: 'MENA News API Documentation',
        description: 'Interactive API documentation built with Redocly',
        endpoints: {
            documentation: '/docs',
            openapi_json: '/docs/openapi.json',
            openapi_yaml: '/docs/openapi.yaml'
        },
        status: {
            documentation_built: fs.existsSync(docsPath),
            specification_exists: fs.existsSync(specPath)
        },
        build_commands: {
            build_docs: 'npm run docs:build',
            serve_docs: 'npm run docs:serve',
            lint_spec: 'npm run docs:lint'
        },
        last_updated: new Date().toISOString()
    });
});

module.exports = docsRouter;
