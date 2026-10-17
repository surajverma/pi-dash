# Changelog

## Unreleased

- Split the backend into `pi_dash/` and move shipped assets to `web/`; native startup is now `python -m pi_dash`, with Gunicorn using `pi_dash.app:app`. Rename the insights script to `network-insights.js` and refresh the service-worker cache.
- Preserve `/app/config.json` and optional `/app/manifest.json` mounts, add `PI_DASH_CONFIG` and `PI_DASH_MANIFEST` path overrides, and document restart requirements. Docker copies only runtime dependencies, the backend package and web assets, retaining one worker and four threads.
- Confirm combined top-five rankings against bounds for omitted source entries rather than warning whenever a source reaches 100 rows. Potentially understated counts show `≥`; missing-source warnings remain separate.
- Return generic API and instance error messages while logging full exception details server-side. Document the dashboard's lack of a login and the need for LAN access or an authenticated reverse proxy.
- Device metrics are enabled for existing installations when the flag is omitted. Desktop now requests Pi-hole's system and sensor readings at most every 30 seconds; mobile requests them while details are expanded. Set `show_device_metrics: false` to disable them.
- Network insights remain opt-in with `show_network_insights: true`. Rankings request at most 100 entries per Pi-hole and use threshold bounds to identify uncertain combined rankings.
- Optional refresh waiters return cached data or a loading response immediately. Malformed replies retain the 30-second backoff, and detected DNS recovery expires failed optional readings.
- The compact desktop width is 768px; insights use 896px. Updated README screenshots use realistic fictional traffic with irregular activity and separate instance counters.
- Added a maskable Android icon and aligned the manifest theme color with the dark page background.
