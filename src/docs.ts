/**
 * Interactive API Documentation — Swagger UI page for PayGate MCP.
 *
 * Served at GET /docs. Loads Swagger UI from CDN (no bundled dependencies).
 * Fetches the OpenAPI spec from /openapi.json on the same server.
 */

export function getDocsHtml(serverName: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${esc(serverName)} — API Docs</title>
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/swagger-ui-dist@5/swagger-ui.css">
<style>
  html { box-sizing: border-box; overflow-y: scroll; }
  *, *::before, *::after { box-sizing: inherit; }
  body { margin: 0; background: #fafafa; }
  /* Dark topbar */
  .swagger-ui .topbar { background-color: #0a0a0f; padding: 10px 0; }
  .swagger-ui .topbar .wrapper { display: flex; align-items: center; }
  .swagger-ui .topbar a { font-size: 0; }
  .swagger-ui .topbar .topbar-wrapper::before {
    content: '${esc(serverName)} — API';
    color: #00e68a;
    font-size: 18px;
    font-weight: 700;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
  }
  /* Accent colors */
  .swagger-ui .opblock.opblock-get .opblock-summary-method { background: #6366f1; }
  .swagger-ui .opblock.opblock-post .opblock-summary-method { background: #22c55e; }
  .swagger-ui .opblock.opblock-delete .opblock-summary-method { background: #ef4444; }
  .swagger-ui .opblock.opblock-put .opblock-summary-method { background: #eab308; }
  /* Info section */
  .swagger-ui .info .title { color: #0a0a0f; }
  .swagger-ui .info a { color: #6366f1; }
  /* Hide validator badge */
  .swagger-ui .info hgroup.main > a { display: none; }
  /* Mobile */
  @media (max-width: 768px) {
    .swagger-ui .wrapper { padding: 0 12px; }
  }
</style>
</head>
<body>
<div id="swagger-ui"></div>
<script src="https://cdn.jsdelivr.net/npm/swagger-ui-dist@5/swagger-ui-bundle.js"></script>
<script>
  SwaggerUIBundle({
    url: '/openapi.json',
    dom_id: '#swagger-ui',
    deepLinking: true,
    presets: [SwaggerUIBundle.presets.apis, SwaggerUIBundle.SwaggerUIStandalonePreset],
    layout: 'BaseLayout',
    defaultModelsExpandDepth: 1,
    defaultModelExpandDepth: 2,
    docExpansion: 'list',
    filter: true,
    showExtensions: true,
    showCommonExtensions: true,
    tryItOutEnabled: false,
    persistAuthorization: true,
  });
</script>
</body>
</html>`;
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
