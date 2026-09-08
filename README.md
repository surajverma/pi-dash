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
- Network-wide aggregate query, blocked, percentage, cache and forward counters
- Per-instance latency and health state
- Pi-hole blocking enabled/disabled state
- Optional live DNS query feed
- Lightweight in-browser query-rate sparklines with no database or history service
- Independent stats and query polling intervals
- Shared server-side cache to avoid duplicate Pi-hole API traffic from multiple browser tabs/devices
- Automatic session re-authentication
- Optional TLS verification per Pi-hole
- Environment-variable substitution for passwords and CA paths
- PWA support with network-fresh application shell updates
- Dark mode and mobile layout
- Docker images for amd64 and arm64
- `/health` endpoint and Docker healthcheck
- No external font dependency; the dashboard works on an isolated LAN

![pi-dash-landscape](https://github.com/user-attachments/assets/a0e1fbef-279a-40df-9424-0cad50c31b50)

## Backward compatibility

Existing `config.json` files continue to work without adding any of the new options.

- If `refresh_interval` is absent, Pi-Dash keeps the historical 5000 ms code default.
- If `queries_refresh_interval` is absent, it inherits `refresh_interval`, preserving the old query-feed cadence.
- `verify_ssl` defaults to `false`, matching the previous behavior.
- `/data` keeps its original response format unless a caller explicitly requests the richer summary/query payload.
- All newly introduced configuration keys are optional.

## Configuration

Create `config.json` from `config-example.json`.

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

| Option | Default | Purpose |
| --- | --- | --- |
| `base_path` | `/` | Subpath where Pi-Dash is hosted |
| `refresh_interval` | `5000` | Main statistics refresh interval in milliseconds |
| `queries_refresh_interval` | `refresh_interval` | Live query-feed refresh interval in milliseconds |
| `cache_ttl` | derived automatically | Shared backend cache lifetime in milliseconds |
| `show_queries` | `false` | Show the scrolling recent-query feed |
| `show_network_summary` | `true` | Show the combined network summary |
| `show_trends` | `true` | Show short in-memory query-rate sparklines |

When `cache_ttl` is omitted, Pi-Dash chooses a short value based on the fastest configured polling interval. The automatic value is deliberately shorter than the polling cadence so caching cannot silently slow an explicitly configured refresh rate.

### Pi-hole options

| Option | Default | Purpose |
| --- | --- | --- |
| `name` | required | Display name |
| `address` | required | Pi-hole base URL |
| `password` | required/empty | API password or `${ENV_NAME}` |
| `enabled` | `true` | Include the Pi-hole in the dashboard |
| `link` | `false` | Make the instance name open Pi-hole Admin |
| `verify_ssl` | `false` | `true`, `false`, or a CA bundle path |

`verify_ssl` remains `false` by default because many LAN Pi-hole installations use self-signed certificates. If your Pi-hole has a valid certificate, set it to `true`. A custom CA bundle can also be supplied as a path.

Passwords can be kept outside `config.json`:

```json
"password": "${PIHOLE_PRIMARY_PASSWORD}"
```

Then provide `PIHOLE_PRIMARY_PASSWORD` through your shell or Docker environment.

## Polling model

Stats and recent queries are fetched separately. This means a typical configuration can update the visible counters every 2 seconds while fetching the query feed every 3 seconds. Pi-Dash also caches Pi-hole responses briefly in the server process, so opening the dashboard on multiple devices does not multiply upstream Pi-hole API traffic unnecessarily.

The blocking enabled/disabled state changes much less frequently than query counters and is cached separately for 30 seconds.

## Network summary semantics

Pi-Dash only aggregates counters that can safely be summed across Pi-hole instances: queries, blocked queries, cached queries and forwarded queries. It deliberately does **not** sum active clients or unique domains because the same client/domain may appear on more than one redundant Pi-hole.

## Installation

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

The container runs Pi-Dash through Gunicorn and includes a healthcheck against `/health`.

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
pip install -r requirements.txt
python proxy.py
```

Then open `http://localhost:5001`.

`python proxy.py` remains available for simple native/LAN use. The Docker image uses Gunicorn for a more robust long-running server.

## Health endpoint

```text
GET /health
```

returns a small Pi-Dash process health response without contacting every Pi-hole. This makes it suitable for Docker, Uptime Kuma, Homepage, Homarr and similar monitoring tools.

## Tests

Tests do not require a live Pi-hole:

```bash
cp config-example.json config.json
python -m unittest discover -s tests -v
```

They cover old-config fallback behavior, independent query polling, cache behavior, zero enabled Pi-holes, secret resolution, safe network aggregation, the legacy `/data` shape and `/health`.

## PWA behavior

Pi-Dash caches its application shell for offline/reload resilience, but API responses are never cached by the service worker. Navigation uses network-first behavior and static assets are refreshed in the background, reducing the chance of an upgraded container continuing to display an old dashboard bundle.

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
