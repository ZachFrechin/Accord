# Discord2 Desktop

## Release builds

Desktop release artifacts are produced with `electron-builder`.

Required build-time variables:

- `VITE_SUPABASE_URL`
- `VITE_SUPABASE_ANON_KEY`
- `VITE_API_URL`
- `VITE_GATEWAY_URL`
- `VITE_LIVEKIT_URL`

For GitHub Actions, configure:

- Repository Variables: `VITE_SUPABASE_URL`, `VITE_API_URL`, `VITE_GATEWAY_URL`, `VITE_LIVEKIT_URL`
- Repository Secret: `VITE_SUPABASE_ANON_KEY`

macOS release artifacts must also be signed and notarized. Configure these repository secrets:

- `MACOS_CERTIFICATE`: base64 export of a `Developer ID Application` `.p12` certificate.
- `MACOS_CERTIFICATE_PASSWORD`: password for that `.p12` export.
- `APPLE_API_KEY_BASE64`: base64 content of the App Store Connect `AuthKey_<key id>.p8` file.
- `APPLE_API_KEY_ID`: key ID for the App Store Connect API key.
- `APPLE_API_ISSUER`: issuer ID for the App Store Connect API key.

Without these macOS secrets, the workflow intentionally fails the macOS job instead of publishing a DMG that Gatekeeper reports as damaged.

Create a release by pushing a tag:

```bash
git tag v0.1.0
git push origin v0.1.0
```

The workflow builds macOS, Windows, and Linux artifacts, uploads them as workflow artifacts, and publishes them to the tagged GitHub release.
