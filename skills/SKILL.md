# Celestial Updates

Celestial Updates is a self-hosted, open-source custom Expo Updates server designed to run on the Cloudflare Developer Platform. Built with the **Hono** framework, it leverages **Cloudflare Workers**, **R2 Storage**, and **KV Namespace** to provide a fast, globally distributed, and cost-effective alternative to EAS Update.

## Key Components

### 1. Cloudflare Worker (`src/index.ts`)
The core of the server. It handles incoming update requests from Expo apps:
-   **Manifest Generation:** Dynamically generates update manifests based on requested `runtimeVersion` and platform headers.
-   **Asset Serving:** Redirects asset requests to the appropriate R2 bucket (potentially jurisdiction-specific).
-   **Code Signing:** Signs manifests using a private RSA key stored in Cloudflare Secrets (`EXPO_UPDATES_PRIVATE_KEY`) to ensure update integrity.
-   **Rollbacks:** Supports rollback directives via the `expo-embedded-update-id` header.

### 2. Publish Script (`scripts/publish.ts`)
A CLI script that automates the deployment process:
-   **Expo Export:** Runs `expo export` to bundle JavaScript and assets.
-   **Asset Upload:** Uploads bundled assets to R2, respecting `runtimeVersion` organization.
-   **KV Updates:** Updates the KV store with the latest update metadata.
-   **Code Signing Keys:** Automatically checks for and generates code signing keys if configured in `app.json` but missing locally. Adds generated key directories to `.gitignore`.
-   **Jurisdiction Support:** Parses `wrangler.jsonc` to apply correct `--jurisdiction` flags for R2 operations.

## Configuration

-   **`wrangler.jsonc`:** Configures Cloudflare bindings (R2, KV) and environment variables. Supports multiple environments (production, staging).
-   **`app.json`:** Configures the Expo project. Critical fields include `updates.url`, `runtimeVersion`, and `updates.codeSigningCertificate`.

## Testing

Due to the Cloudflare Workers environment simulation provided by `@cloudflare/vitest-pool-workers`, tests must be run using the project's specific script:

```bash
bun run test
```

Using `vitest` directly may fail or produce inconsistent results outside of the configured environment.
