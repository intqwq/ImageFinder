# PixelTrace

[![CI](https://github.com/intqwq/ImageFinder/actions/workflows/ci.yml/badge.svg)](https://github.com/intqwq/ImageFinder/actions/workflows/ci.yml)

PixelTrace is a private, browser-based visual locator. Give it a smaller fragment and a larger image; it searches for the closest region across multiple scales and produces a downloadable PNG with that region marked.

The result view shows three ranked candidates, a magnified close-up of the selected candidate, fit/focus/100% views, zoom controls, and a scrollable full-resolution annotated image. All image processing stays in the browser; uploaded images are never sent to the server.

## Run it

No build step or dependencies are required. Serve the folder with any static web server:

```powershell
python -m http.server 4173
```

Then open `http://localhost:4173`.

For a closer approximation of production, use the included server:

```powershell
python server.py --port 4173
```

## How matching works

The app uses two complementary searches. A high-resolution pass keeps tiny objects—such as one avatar in a dense avatar wall—recognizable, while a faster lower-resolution pass handles larger fragments. Both compare normalized luminance/color descriptors across scales and refine the strongest candidates with edge-aware matching at single-pixel steps. Normalization makes the search tolerant of modest compression, brightness, resolution, and detail differences.

The final ranking combines both passes, preserves absolute color evidence, suppresses overlapping scale duplicates, and presents the three strongest distinct candidates.

Use the default **Auto** range when the target may be tiny. The **Fast** range skips the high-resolution tiny-target pass when the fragment is known to occupy at least roughly one-third of its uploaded dimensions in the larger image.

## Tests

Run the deterministic randomized suite with `npm test`. It covers exact matches, up/downscaling, brightness and contrast changes, color shifts, noise, blur, partial occlusion, repeated distractors, edge placement, combined degradation, top-three suppression, and a CPU-time regression budget. Seeds are fixed so every failure is reproducible.

All processing happens locally in the browser. No image is uploaded.

## Raspberry Pi and Bridge deployment

PixelTrace ships as a loopback-only origin for [Bridge](https://github.com/intqwq/Bridge). The included manifest registers:

```text
pixeltrace.intqwq.com -> http://127.0.0.1:18103
```

On a Debian or Ubuntu Raspberry Pi:

1. Install Bridge and make sure `sudo bridge status` is healthy.
2. Clone PixelTrace, then run:

   ```bash
   sudo bash deploy/install.sh
   ```

3. Verify both layers:

   ```bash
   curl -fsS http://127.0.0.1:18103/healthz
   curl -fsS -H 'Host: pixeltrace.intqwq.com' http://127.0.0.1:18080/healthz
   curl -fsS https://pixeltrace.intqwq.com/healthz
   ```

The installer creates a locked-down `pixeltrace.service`, starts the local origin, waits for its health check, and then calls `bridge register`. Bridge owns the public Cloudflare Tunnel and DNS record; PixelTrace never binds to a LAN or public interface.

To choose another unused origin port, set it for the one installer invocation:

```bash
sudo PIXELTRACE_PORT=18113 bash deploy/install.sh
```

Useful operations:

```bash
sudo systemctl status pixeltrace
sudo journalctl -u pixeltrace -f
sudo bridge inspect pixeltrace
sudo bridge unregister pixeltrace
```

Re-running the installer updates the deployed files and registration idempotently.
