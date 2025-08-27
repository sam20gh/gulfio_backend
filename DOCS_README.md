# API Documentation Setup

This project uses Redocly to generate beautiful, interactive API documentation from the OpenAPI specification.

## 📚 Accessing Documentation

Once the server is running, you can access the API documentation at:

- **API Docs**: `http://localhost:5000/docs`
- **API Info**: `http://localhost:5000/docs/info`
- **OpenAPI JSON**: `http://localhost:5000/docs/openapi.json`
- **OpenAPI YAML**: `http://localhost:5000/docs/openapi.yaml`

## 🛠️ Documentation Commands

```bash
# Build the documentation (generates static HTML)
npm run docs:build

# Serve documentation in development mode (with live reload)
npm run docs:serve

# Watch for changes and rebuild automatically
npm run docs:watch

# Lint the OpenAPI specification
npm run docs:lint
```

## 📝 Files Structure

```
backend/
├── openapi.yaml          # OpenAPI specification
├── redocly.yaml          # Redocly configuration
├── docs/
│   └── index.html        # Generated documentation (after build)
└── routes/
    └── docs.js           # Express routes for serving docs
```

## 🔧 Configuration

### OpenAPI Specification (`openapi.yaml`)
Contains the complete API specification with:
- All endpoints and their parameters
- Request/response schemas
- Authentication requirements
- Examples and descriptions

### Redocly Configuration (`redocly.yaml`)
Configures the documentation build process:
- Linting rules
- Theme settings
- Code sample generation

## 🚀 Development Workflow

1. **Edit the API specification**: Update `openapi.yaml` when you add/modify endpoints
2. **Lint your changes**: Run `npm run docs:lint` to check for issues
3. **Build documentation**: Run `npm run docs:build` to generate the HTML
4. **Preview changes**: Use `npm run docs:serve` for live preview during development

## 📋 Adding New Endpoints

When adding new API endpoints:

1. Update the route handlers in your Express app
2. Document the endpoint in `openapi.yaml`:
   ```yaml
   paths:
     /api/your-new-endpoint:
       get:
         tags:
           - YourTag
         summary: Brief description
         description: Detailed description
         parameters:
           - name: param1
             in: query
             required: false
             schema:
               type: string
         responses:
           '200':
             description: Success response
             content:
               application/json:
                 schema:
                   $ref: '#/components/schemas/YourSchema'
   ```
3. Add any new schemas to the `components/schemas` section
4. Build and test the documentation

## 🎨 Customization

The documentation appearance can be customized in `redocly.yaml`:

```yaml
theme:
  colors:
    primary:
      main: '#1976d2'  # Primary color
  typography:
    fontSize: '14px'
    fontFamily: 'Source Sans Pro, sans-serif'
```

## 📤 Production Deployment

In production, the documentation is served as static files from the `/docs` endpoint. Make sure to:

1. Run `npm run docs:build` as part of your build process
2. Ensure the `docs/` directory is included in your deployment
3. Update server URLs in `openapi.yaml` for production

## 🔍 Troubleshooting

**Documentation not loading?**
- Check if `docs/index.html` exists (run `npm run docs:build`)
- Verify the server is running and `/docs` endpoint is accessible

**OpenAPI validation errors?**
- Run `npm run docs:lint` to see detailed error messages
- Check the OpenAPI 3.1 specification for proper syntax

**Missing endpoints in documentation?**
- Ensure all endpoints are documented in `openapi.yaml`
- Verify the YAML syntax is correct
- Rebuild the documentation after changes
