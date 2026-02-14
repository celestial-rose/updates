# Troubleshooting

## Common Issues

### Expo Export Fails (Web Platform)

**Problem:**
Your `expo export` command fails, often with errors related to the web platform or missing web dependencies.

**Solution:**
This project is designed for native mobile updates (iOS and Android). If you are encountering issues with web exports, ensure that you have restricted the platforms to only `ios` and `android` in your Expo project's `app.json`.

Update your `app.json` to include only mobile platforms:

```json
{
  "expo": {
    "platforms": [
      "ios",
      "android"
    ],
    // ... other config
  }
}
```
