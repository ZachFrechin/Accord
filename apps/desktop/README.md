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

macOS release artifacts are currently unsigned and not notarized. Users may need to allow the app manually in macOS security settings until Developer ID signing is re-enabled.

Create a release by pushing a tag:

```bash
git tag v0.1.0
git push origin v0.1.0
```

The workflow builds macOS, Windows, and Linux artifacts, uploads them as workflow artifacts, and publishes them to the tagged GitHub release.
