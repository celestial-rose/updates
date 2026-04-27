# Celestial Updates: Serverless Expo Updates on Cloudflare

<p align="center">
  <img src="https://img.shields.io/badge/Cloudflare-F38020?style=for-the-badge&logo=Cloudflare&logoColor=white" alt="Cloudflare" />
  <img src="https://img.shields.io/badge/Hono-E36002?style=for-the-badge&logo=hono&logoColor=white" alt="Hono" />
  <img src="https://img.shields.io/badge/Expo-000020?style=for-the-badge&logo=expo&logoColor=white" alt="Expo" />
  <img src="https://img.shields.io/badge/TypeScript-007ACC?style=for-the-badge&logo=typescript&logoColor=white" alt="TypeScript" />
  <img src="https://img.shields.io/badge/Bun-000000?style=for-the-badge&logo=bun&logoColor=white" alt="Bun" />
</p>

**Deploy Expo Updates for pennies. Scale infinitely. Own your infrastructure.**

**Celestial Updates** is a self-hosted, open-source custom Expo Updates server designed to run on the Cloudflare Developer Platform. Built with the ultra-fast **[Hono](https://hono.dev/)** framework, it leverages **Cloudflare Workers**, **R2 Storage**, and **KV Namespace** to provide a blazing fast, globally distributed, and incredibly cost-effective alternative.

We love [Expo Updates](https://docs.expo.dev/eas-update/introduction/). It allows you to:
*   🚀 **Ship Instantly:** Fix bugs and push features without waiting for App Store review.
*   🔄 **Sync Users:** Ensure everyone is on the latest version.
*   🛠️ **Hotfix Live:** Patch issues in minutes, not days.

**But as you scale, costs can add up.** 
**Celestial Updates solves this.** You pay only for what you use, often fitting within Cloudflare's generous free tier or costing significantly less at scale.

## 🚀 Features

*   **💸 Cost-Effective:** Zero egress fees with R2 and highly efficient Worker pricing. Stop paying a tax on your user growth.
*   **🌍 Edge-Native:** Updates are served from Cloudflare's massive global network, ensuring low latency for users everywhere.
*   **🔥 Built with Hono:** Uses the lightweight, ultrafast web framework for the Edges.
*   **🔐 Secure:** Native support for [Expo Code Signing](https://docs.expo.dev/eas-update/code-signing/) to ensure update integrity.
*   **⚡️ Standard Protocol:** Fully compliant with the open [Expo Updates Protocol](https://docs.expo.dev/technical-specs/expo-updates-1/). This open specification enables custom server implementations like Celestial Updates.
*   **📦 Simple Deployment:** Deploy your entire update infrastructure with a single `wrangler deploy`.

## 🛠 Prerequisites

*   [Bun](https://bun.sh/) (recommended) or Node.js
*   A Cloudflare account
*   Wrangler CLI installed (`bun install -g wrangler`)
*   An Expo project

## 📦 Installation & Setup

1.  **Clone the repository:**
    ```bash
    git clone https://github.com/celestial-rose/updates.git
    cd updates
    bun install
    ```

2.  **Configure Cloudflare Resources:**
    You need to create an R2 bucket and a KV namespace.
    ```bash
    # Create KV Namespace
    bunx wrangler kv namespace create EXPO_UPDATES_KV

    # Create R2 Bucket (optional: specify jurisdiction)
    bunx wrangler r2 bucket create expo-updates-assets --jurisdiction eu
    ```

3.  **Update `wrangler.jsonc`:**
    Update the `kv_namespaces` section in `wrangler.jsonc` with the ID you received from the previous command. The R2 bucket name should match what you created (default is `expo-updates-assets`).

    If you used a specific jurisdiction (like 'eu'), make sure to add it to the bucket configuration.

    ```jsonc
    // ...
    "r2_buckets": [
        {
            "bucket_name": "expo-updates-assets",
            "binding": "EXPO_UPDATES_BUCKET",
            "jurisdiction": "eu" // Optional: if you created the bucket in a specific jurisdiction
        }
    ],
    "kv_namespaces": [
        {
            "binding": "EXPO_UPDATES_KV",
            "id": "YOUR_NEW_KV_ID_HERE"
        }
    ]
    // ...
    ```


4.  **Generate Keys for Code Signing (Automated):**
    The publish script will automatically detect if you have code signing enabled in your `app.json` but are missing keys. It will offer to generate them for you.
    
    *Manual Option:* If you prefer to generate them manually:
    ```bash
    mkdir -p code-signing
    bunx expo-updates codesigning:generate --key-output-directory code-signing --certificate-output-directory code-signing --certificate-validity-duration-years 10 --certificate-common-name "My App"
    ```

5.  **Set Secrets (Automated):**
    The publish script will also check if your private key is uploaded to Cloudflare. If not, it will offer to upload it for you.
    
    *Manual Option:*
    ```bash
    bunx wrangler secret put EXPO_UPDATES_PRIVATE_KEY_MY_APP < code-signing/private-key.pem
    ```

6.  **Deploy:**
    ```bash
    bun run deploy
    ```
    Note the URL of your deployed worker (e.g., `https://my-expo-updates-server.my-subdomain.workers.dev`).

## 📱 App Configuration

In your Expo project's `app.json` (or `app.config.js`), configure the `updates` section to point to your new Celestial Updates server.

1.  **Set the URL and Code Signing (if enabled):**
    ```json
    {
      "expo": {
        "slug": "my-app",
        "runtimeVersion": "1",
        "updates": {
          "url": "https://my-expo-updates-server.my-subdomain.workers.dev/my-app/api/manifest",
          "enabled": true,
          "checkAutomatically": "ON_LOAD",
          "fallbackToCacheTimeout": 0,
          "codeSigningCertificate": "./code-signing/certificate.pem",
          "codeSigningMetadata": {
            "keyid": "main",
            "alg": "rsa-v1_5-sha256"
          }
        },
        // ...
      }
    }
    ```

    **Double Check:** Ensure the `url` includes your project slug (e.g., `/my-app/api/manifest`) and matches your worker's deployed URL. The `codeSigningCertificate` path must point to your generated certificate file.

    *If you use code signing, ensure the `codeSigningCertificate` path points to a valid file. If not, the publish script can help you generate one.*

2.  **Update .gitignore (Highly Recommended):**
    Add `dist-updates` to your `.gitignore` file to prevent the build artifacts from polluting your repository.
    ```
    dist-updates
    ```

## Runtime versions and updates

Since updates must be compatible with a build's native code, any time native code is updated, we're required to make a new build before publishing an update. Some developers only update native code when upgrading to a new Expo SDK, while others may upgrade native code between builds or at other intervals. Below is an explanation of different situations and configurations that may suit your project.

### Setting `"runtimeVersion"`

To make managing the `"runtimeVersion"` property easier between builds and updates, we've created policies that derive the runtime version from another piece of information already present in your project. If these policies do not match the development flow of a project, there's also an option to set the `"runtimeVersion"` manually.

#### Runtime version policies

The available policies are documented in the [`expo-updates` library documentation](https://docs.expo.dev/versions/latest/sdk/updates#automatic-configuration-using-runtime-version-policies).

#### Custom runtime version

You must set a custom runtime version that meets the [runtime version formatting requirements](https://docs.expo.dev/versions/latest/config/app#runtimeversion):

```json
{
  "expo": {
    "runtimeVersion": "1.0.0"
  }
}
```


#### Platform-specific runtime version

You can also set runtime version per-platform, for example

```json
{
  "expo": {
    "android": {
      "runtimeVersion": "1.0.0"
    }
  }
}
```



When both a top level runtime and a platform specific runtime are set, the platform specific one takes precedence.

### Avoiding Incompatible Updates

**CRITICAL:** When you install or update native libraries (e.g., `expo-camera`, `react-native-reanimated`) or change native code, you **MUST** update the `runtimeVersion` in your `app.json`.

If you publish an update with the *same* `runtimeVersion` but *different* native code requirements, your users' apps will crash because the native code they have installed won't match what the JavaScript bundle expects.

**Best Practices:**
1.  **Bump `runtimeVersion`:** Change it manually (e.g., "1.0.0" -> "1.0.1") or use a policy like "appVersion" or "fingerprint" (see [Runtime version policies](https://docs.expo.dev/versions/latest/sdk/updates#automatic-configuration-using-runtime-version-policies)).
2.  **Test Before Release:** Always test your updates on a development build or a physical device with the specific native build you are targeting.

For a deeper dive into how runtime versions work, refer to the [Expo documentation on Runtime Versions](https://docs.expo.dev/eas-update/runtime-versions/).

## 🚀 Publishing Updates

We provide a handy script to publish updates directly from your Expo project to your Celestial Updates infrastructure.

1.  **Run the publish script:**
    Run the publish script directly from the `celestial-updates` directory:
    ```bash
    # Publish to Production
    bun run publish:prod
    
    # Publish to Staging
    bun run publish:staging
    ```
    
    **First Run & Configuration:**
    *   On the first run, the script will ask for the **absolute path** to your Expo project root.
    *   It will then ask if you want to save this path to a `.env` file in the `celestial-updates` directory.
    *   **Multiple Projects:** You can add multiple paths to the `.env` file under `EXPO_PROJECT_PATHS` (comma-separated).
        ```env
        EXPO_PROJECT_PATHS=/path/to/project-a,/path/to/project-b
        ```
        If multiple paths exist, the script will ask you to select which project to publish.

    *Or with a remote flag if you want to publish directly to Cloudflare:*
    ```bash
    bun run publish:prod --remote
    ```

    **What the script does:**
    *   Reads your `app.json` to get the `runtimeVersion`.
    *   Runs `expo export` to bundle your JavaScript and assets.
    *   Uploads assets and the bundle to your **R2 Bucket**.
    *   Updates the **KV Namespace** with the latest update metadata pointing to the new assets.

## 🔐 Code Signing

For detailed information on Code Signing, strictly follow the [official Expo documentation](https://docs.expo.dev/eas-update/code-signing/).

Celestial Updates expects the `expo-expect-signature` header and will sign the response using the `EXPO_UPDATES_PRIVATE_KEY` secret you set earlier.

## 🧪 Running Tests

We use `vitest` with `@cloudflare/vitest-pool-workers` to test the worker logic in a simulation of the Cloudflare environment.

**Run Tests:**
```bash
bun run test
```

## 🤝 Contributing

We welcome contributions! Please see our contributing guidelines below to get started.

### Contributing Guidelines

1.  **Fork the Repository:** Start by forking this repository to your own GitHub account.
2.  **Clone Locally:** Clone your fork to your local machine.
3.  **Create a Branch:** Create a new branch for your feature or bug fix.
    ```bash
    git checkout -b feature/amazing-new-feature
    ```
4.  **Make Changes:** Implement your changes. Ensure you follow the code style (Prettier).
5.  **Run Tests:** Run the test suite to ensure no regressions.
    ```bash
    bun run test
    ```
6.  **Commit:** Commit your changes with a descriptive message.
7.  **Push:** Push your branch to your fork.
8.  **Open a Pull Request:** Open a PR against the `main` branch of this repository.

### Pull Request Rules

*   **Descriptive Title:** Use a clear and concise title for your PR.
*   **Description:** Provide a detailed description of what your PR does.
*   **Tests:** Include tests for any new features or bug fixes.
*   **Linting:** Ensure your code passes linting checks.
*   **One Feature per PR:** Keep your PRs focused on a single task.

## 🗺️ Roadmap & TODO

### Sentry Source Map Uploads (Manual)

> **⚠️ Warning:** Sentry integration is currently a **Work In Progress (WIP)** and considered **Alpha**. It may not be ready for production use. Proceed with caution.

**Disclaimer:** Since Celestial Updates uses `npx expo export` instead of `eas update`, source map uploading for Sentry needs to be handled manually or integrated into your CI/CD workflow.

[Sentry Source Map Uploads for Expo](https://docs.sentry.io/platforms/react-native/sourcemaps/uploading/expo/#upload-source-maps)

The following documentation is taken from the link above:

**Manual Upload for Updates:**
To upload source maps for updates generated via `npx expo export`, set up the Sentry Expo Plugin, the Sentry Metro plugin and execute the `sentry-expo-upload-sourcemaps` command.

1.  **Create Update (which generates source maps):**
    ```bash
    bunx expo export --dump-sourcemap
    # Then run the celestial-updates publish script to upload assets to R2/KV
    ```

2.  **Upload Source Maps:**
    To upload source maps for all platforms use the following command:
    ```bash
    SENTRY_AUTH_TOKEN=sntrys_YOUR_TOKEN_HERE \
    bunx sentry-expo-upload-sourcemaps dist
    ```

    To upload source maps without expo plugin (bare workflow):
    ```bash
    SENTRY_AUTH_TOKEN=sntrys_YOUR_TOKEN_HERE \
    SENTRY_PROJECT=example-project \
    SENTRY_ORG=example-org \
    SENTRY_URL=https://sentry.io/ \
    bunx sentry-expo-upload-sourcemaps dist
    ```

**Notes:**
*   `dist` is the default output directory of `bunx expo export`. Ensure this matches your export path.
*   Sentry Org, Sentry Project, and Sentry Url will be loaded from the expo plugin config (`app.json` / `app.config.js`) if the environment variable isn't set.
*   Uploaded source maps have no associated releases by default with this method. This is expected as updates can apply to multiple releases.

## ⚠️ Disclaimer

This software is provided "as is", without warranty of any kind. The authors and contributors are not responsible for any misuse, errors, data loss, or system instability resulting from the use of this software. It is your responsibility to ensure the reliability and security of your deployment. Use at your own risk.

## 📄 License

MIT

---

<p align="center">
  Made with 🧡 by Celestial Rose - Powered by Cloudflare
</p>/
