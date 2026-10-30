export const openapiPage=`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Steelkeep API</title>
</head>
<body>
  <div id="app"></div>
  <script src="/openapi/assets/scalar.js"></script>
  <script>
    Scalar.createApiReference('#app', {
      url: '/openapi/json',
      withDefaultFonts: false,
      persistAuth: false,
      telemetry: false,
      showDeveloperTools: 'never',
      hideClientButton: true,
      proxyUrl: ''
    })
  </script>
</body>
</html>`
