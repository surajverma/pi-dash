# Changelog

## Unreleased

- Device metrics are enabled for existing installations when the flag is omitted. Desktop now requests Pi-hole's system and sensor readings at most every 30 seconds; mobile requests them while details are expanded. Set `show_device_metrics: false` to disable them.
- Network insights remain opt-in with `show_network_insights: true`. Rankings request at most 100 entries per Pi-hole; a source reaching that limit is marked partial, so the merged top five is not guaranteed complete for very large installations.
- Optional refresh waiters return cached data or a loading response immediately. Malformed replies retain the 30-second backoff, and detected DNS recovery expires failed optional readings.
- The compact desktop width is 768px; insights use 896px. Updated README screenshots use realistic fictional traffic with irregular activity and separate instance counters.
- Added a maskable Android icon and aligned the manifest theme color with the dark page background.
