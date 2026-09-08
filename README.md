[![CI/CD](https://github.com/surajverma/pi-dash/actions/workflows/main.yml/badge.svg)](https://github.com/surajverma/pi-dash/actions/workflows/main.yml)
[![Tests](https://github.com/surajverma/pi-dash/actions/workflows/test.yml/badge.svg)](https://github.com/surajverma/pi-dash/actions/workflows/test.yml)
![Latest Release](https://img.shields.io/github/v/release/surajverma/pi-dash?include_prereleases)
[![GitHub last commit](https://img.shields.io/github/last-commit/surajverma/pi-dash)](https://github.com/surajverma/pi-dash/commits/main)
[![GitHub issues](https://img.shields.io/github/issues/surajverma/pi-dash)](https://github.com/surajverma/pi-dash/issues)
[![GitHub Stars](https://img.shields.io/github/stars/surajverma/pi-dash?style=social)](https://github.com/surajverma/pi-dash/stargazers)

# Pi-Dash: A Minimalist Pi-hole Dashboard

Pi-Dash is a lightweight dashboard for monitoring one or more Pi-hole instances. It intentionally stays focused on at-a-glance health and DNS activity instead of replacing the Pi-hole administration interface.

## Features

- Multiple Pi-hole instances on one responsive dashboard
- Compact mobile view with critical metrics and expandable full details for each instance
- Desktop cards retain the full metrics layout and optional query-rate sparklines
- Network-wide aggregate query, blocked, percentage, cache and forward counters
- Clear partial totals when an instance is unavailable
- Per-instance reachability, authentication and blocking ON/OFF status
- Optional live DNS query feed with consecutive duplicate grouping, such as `(x2)` or `(x3)`
- Independent statistics and query polling intervals
- Foreground-only polling: hidden/offline browser pages stop their timers and abort pending browser requests
- Shared in-process cache to reduce duplicate Pi-hole API traffic from multiple browser tabs/devices
- Automatic session re-authentication
- Optional TLS verification per Pi-hole
- Environment-variable substitution for passwords and CA paths
- PWA support with network-first application-shell updates
- Dark mode, Docker amd64/arm64 support, and a `/health` endpoint
- No external font dependency

![pi-dash-landscape](https://github.com/user-attachments/assets/a0e1fbef-279a-40df-9424-0cad50c31b50)

## Mobile and desktop layout

Desktop keeps the full metric cards and ambient query feed. On narrow screens, Pi-Dash uses smaller spacing, a compact Network Summary, and a condensed card for each Pi-hole. The condensed card shows its name, query rate, health/blocking state, total queries, blocked queries and blocked percentage. Tap **Show details** to reveal all seven metrics shown on desktop; tap **Hide details** to collapse it again.

The mobile query feed is a collapsible panel below the cards. It no longer shifts the dashboard upward by a percentage of the viewport. There is no requirement to fit every detail on one screen; the goal is to make the critical information visible quickly, with full details available when needed. The desktop query-background layout is preserved.

### Why the latency number was removed

The previous API latency number measured the time required for an authenticated HTTP statistics request, not ICMP ping or DNS resolution time. Connection setup, TLS, authentication and API processing could make a healthy Pi-hole appear slow compared with a 2-3 ms ping. The number and the latency-based slow warning have been removed. Reachability and blocking state remain, without treating API response time as network speed.

## Backward compatibility

Existing `config.json` files continue to work without adding any new options. Do not replace your working configuration just to upgrade.

- `refresh_interval` retains its existing meaning and historical 5000 ms code default.
- If `queries_refresh_interval` is absent, it inherits the effective `refresh_interval`.
- `verify_ssl` defaults to `false`, matching the previous behavior.
- `/data` keeps its original response format unless a caller explicitly requests summary/query data.
- New configuration keys are optional. The example values are recommendations, not mandatory defaults.
- `python proxy.py` remains available for native use; Docker uses Gunicorn.

## Configuration

Copy `config-example.json` to `config.json` and edit the values for your network. The example contains descriptive `_comment` fields explaining every setting and its default. Standard JSON does not permit `//` or `/* */` comments, so these explanatory fields keep the file valid JSON. Pi-Dash ignores `_comment` fields and never exposes them, passwords, or TLS settings in the frontend configuration.

You can delete any optional setting to use its code default. Existing installations do not need a migration.

```json
{
  "base_path": "/",
  "refresh_interval": 2000,
  "queries_refresh_interval": 3000,
  "cache_ttl": 1000,
  "show_queries": false,
  "show_network_summary": true,
  "show_trends": true,
  "piholes": [
    {
      "name": "Primary",
      "address": "https://pi.hole",
      "password": "${PIHOLE_PRIMARY_PASSWORD}",
      "enabled": true,
      "link": true,
      "verify_ssl": false
    }
  ]
}
```

### Dashboard options

| Option | Code default | Purpose |
| --- | --- | --- |
| `base_path` | `/` | Subpath where Pi-Dash is hosted, for example `/pi-dash/` |
| `refresh_interval` | `5000` | Main statistics refresh interval in milliseconds |
| `queries_refresh_interval` | Effective `refresh_interval` | Independent live-query refresh interval in milliseconds |
| `cache_ttl` | Derived automatically | Shared backend cache lifetime in milliseconds; `0` disables caching |
| `show_queries` | `false` | Enable the optional live DNS query feed |
| `show_network_summary` | `true` | Show combined additive DNS counters |
| `show_trends` | `true` | Show short in-memory query-rate sparklines |
| `piholes` | `[]` | List of Pi-hole instances to monitor |

The example recommends 2000 ms for stats and 3000 ms for queries. If `cache_ttl` is omitted, the code chooses `min(1000, max(100, min(refresh_interval, queries_refresh_interval) // 2))` milliseconds. This is deliberately shorter than the fastest configured polling cadence. An explicitly configured cache lifetime can delay fresh upstream data, so keep it below the fastest interval if you want each refresh to be able to obtain a new snapshot.

### Pi-hole options

| Option | Code default | Purpose |
| --- | --- | --- |
| `name` | Required | Unique display name |
| `address` | Required | Full Pi-hole base URL, including scheme and optional port; do not include `/admin` or `/api` |
| `password` | Empty string | API/application password or `${ENV_NAME}` |
| `enabled` | `true` | Include or exclude an instance without deleting its configuration |
| `link` | `false` | Make the instance name open Pi-hole Admin |
| `verify_ssl` | `false` | `true`, `false`, or a path to a trusted CA bundle |

`verify_ssl` remains false by default for compatibility with LAN installations that use self-signed certificates. If your Pi-hole uses a trusted HTTPS certificate, set it to true. You may also provide a CA bundle path, including an environment-variable reference.

Passwords can be kept outside `config.json`:

```json
"password": "${PIHOLE_PRIMARY_PASSWORD}"
```

Provide the variable through your shell or Docker environment. Literal passwords remain supported for existing installations. Treat your configuration and environment files as secrets; do not commit real passwords to GitHub.

## Polling and query-feed behavior

Stats and recent queries are fetched separately. Opening the dashboard on multiple devices shares short-lived server-side snapshots through the in-process cache. The cache is demand-driven: Pi-Dash does not run a background polling service of its own.

The browser stops its statistics and query timers when the page becomes hidden or the device goes offline, and resumes when it becomes visible/online again. Pending browser requests are aborted and stale responses are ignored. An upstream HTTP request already started by the server may still finish, but no repeated server-side polling continues after the browser stops requesting data.

The feed fetches the latest 50 queries per Pi-hole on each poll. It tracks IDs separately for each instance and uses timestamps for cross-instance ordering. Actual duplicate DNS requests are legitimate and are not deleted from the API data. For display, only **consecutive** entries with the same Pi-hole, domain and blocked/allowed status are combined into `(xN)`. The last group can continue increasing across refreshes. A different domain or blocking status starts a new row. No rolling-window aggregation or top-domain ranking is used.

The query panel can be paused for reading. New events are held in a bounded browser-memory queue and displayed on resume; the feed does not maintain a permanent history. As with the previous implementation, bursts of more than 50 queries between polls can exceed the latest-query window, so this is an at-a-glance feed rather than a guaranteed complete DNS audit log. Use Pi-hole's query log for complete historical investigation.

The blocking enabled/disabled state is cached separately for 30 seconds. Therefore, a blocking-state change may take up to approximately 30 seconds (plus the next visible refresh) to appear.

## Network summary semantics

Pi-Dash sums queries, blocked queries, cached queries and forwarded queries across reporting instances. The blocked percentage is calculated from the combined blocked and total counters. It deliberately does not sum active clients, unique domains or domains on lists, because those values may overlap across redundant Pi-holes.

If an instance is unavailable, the summary is marked partial and displays how many instances are reporting. An instance with blocking disabled is not counted as healthy. If the blocking endpoint is unavailable, the dashboard distinguishes an online Pi-hole with unknown blocking status from one confirmed to be blocking.

These are totals of DNS queries handled by the configured instances, not a deduplicated count of distinct network requests. They should not be interpreted as unique users or unique domains across the network.

## Installation

### Testing the development branch

To test the changes without merging into `main`:

```bash
git fetch origin
git switch feature/dashboard-hardening
# If the branch does not exist locally yet:
# git switch --track origin/feature/dashboard-hardening
```

Keep a backup of your existing `config.json`. Do not overwrite it with the example. For Docker testing, build the branch locally and use a temporary image tag rather than assuming the published `latest` tag contains unmerged changes:

```bash
docker build -t pi-dash:testing .
```

### Docker Compose

```yaml
services:
  pi-dash:
    image: ghcr.io/surajverma/pi-dash:latest
    container_name: pi-dash
    ports:
      - 5001:5001
    environment:
      PIHOLE_PRIMARY_PASSWORD: "your_app_password_here"
    volumes:
      - ./config.json:/app/config.json:ro
      - ./manifest.json:/app/manifest.json:ro
    restart: unless-stopped
```

For branch testing, replace the image with `pi-dash:testing` after building it locally. The container runs Gunicorn as a non-root user and includes a Docker healthcheck. The root `/health` endpoint remains available even when the dashboard itself is hosted below a configured `base_path`.

### Docker Run

```bash
docker run -d \
  --name pi-dash \
  -p 5001:5001 \
  -e PIHOLE_PRIMARY_PASSWORD='your_app_password_here' \
  -v /path/to/config.json:/app/config.json:ro \
  -v /path/to/manifest.json:/app/manifest.json:ro \
  ghcr.io/surajverma/pi-dash:latest
```

### Native install

```bash
git clone https://github.com/surajverma/pi-dash.git
cd pi-dash
cp config-example.json config.json
python -m pip install -r requirements.txt
python proxy.py
```

Then open `http://localhost:5001`. On Windows, use `copy` instead of `cp`. The repository ships the responsive dashboard styles separately in `css/dashboard.css`, so you do not need a Node.js build just to use the new layout. If you are modifying Tailwind classes, run `npm install` followed by `npm run build:css`.

## Health endpoint

```text
GET /health
```

Returns a small Pi-Dash process-health response without contacting every Pi-hole. This makes it suitable for Docker, Uptime Kuma, Homepage, Homarr and similar monitoring tools. It is not a substitute for checking individual DNS availability.

## Tests

The regression suite uses mocked Pi-hole responses and does not require a live Pi-hole:

```bash
python -m unittest discover -s tests -v
npm install
npm run test:js
npm run build:css
```

Backend tests cover config fallback, cache behavior, zero enabled instances, TLS/secret resolution, blocking states, partial aggregation, legacy API response shapes and process health. Browser tests cover compact-card expansion, all desktop metrics, consecutive grouping, overlapping queries, per-instance IDs, hidden/offline polling, disabled query feeds and safe rendering of instance names. GitHub Actions runs both suites and verifies the frontend build.

## PWA behavior

Pi-Dash caches its application shell for offline/reload resilience. The service worker includes both dashboard scripts and both stylesheets, uses network-first loading for navigation and application assets, and never caches API responses. Live statistics require a working connection to Pi-Dash and its Pi-hole instances. A new cache version is installed for the mobile update; if an older installed PWA continues displaying an old shell after upgrading, close/reopen it or perform a hard refresh.

## Credits

Initial development of Pi-Dash was done by [Codeloaf](https://github.com/codeloaf). It has since been transferred to this repository for ongoing maintenance, as the original author is not active on GitHub.

## Disclaimer

This project is not associated with the official [Pi-hole](https://pi-hole.net/) project. Pi-hole is a registered trademark of Pi-hole LLC.

## License

MIT. See [LICENSE](LICENSE).

## Contributing

Contributions, suggestions and bug reports are welcome through GitHub issues and pull requests.

## Thank You

If you like my work, you can [buy me a coffee ☕](https://ko-fi.com/skv)
