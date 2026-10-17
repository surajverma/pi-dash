[![CI/CD](https://github.com/surajverma/pi-dash/actions/workflows/main.yml/badge.svg)](https://github.com/surajverma/pi-dash/actions/workflows/main.yml)
[![Tests](https://github.com/surajverma/pi-dash/actions/workflows/test.yml/badge.svg)](https://github.com/surajverma/pi-dash/actions/workflows/test.yml)
![Latest Release](https://img.shields.io/github/v/release/surajverma/pi-dash?include_prereleases)
[![GitHub last commit](https://img.shields.io/github/last-commit/surajverma/pi-dash)](https://github.com/surajverma/pi-dash/commits/main)
[![GitHub issues](https://img.shields.io/github/issues/surajverma/pi-dash)](https://github.com/surajverma/pi-dash/issues)
[![GitHub Stars](https://img.shields.io/github/stars/surajverma/pi-dash?style=social)](https://github.com/surajverma/pi-dash/stargazers)
[![Downloads](https://img.shields.io/badge/dynamic/json?url=https%3A%2F%2Fghcr-badge.elias.eu.org%2Fapi%2Fsurajverma%2Fpi-dash&query=downloadCount&style=social&logo=github&label=Docker%20Pulls)](https://github.com/surajverma/pi-dash/pkgs/container/pi-dash)

# Pi-Dash: A Minimalist Pi-hole Dashboard

Pi-Dash is a simple, lightweight dashboard for monitoring multiple Pi-hole instances. It provides a clean, at-a-glance, responsive view of your Pi-hole statistics.

## Features

- **Multiple Pi-hole Support:** Monitor all your Pi-hole instances from a single dashboard.
- **Network Summary:** View combined query, blocked, cached, and forwarded totals.
- **Network Insights (Optional):** View query history, top clients, and top blocked domains.
- **Device Health:** See CPU, RAM, temperature, and uptime for each Pi-hole.
- **Pi-hole Status:** See reachability, authentication errors, and blocking ON/OFF state.
- **Responsive Design:** Works on desktop and mobile, with expandable details on smaller screens.
- **Live Query Feed:** Optionally show recent allowed and blocked domains.
- **Configurable Refresh:** Set separate refresh intervals for statistics and queries.
- **Lightweight and Fast:** Built with Flask and vanilla JavaScript, with minimal dependencies.
- **Dark Mode and PWA Support:** Follows your system theme and can be installed as an app.

## Screenshots

### Desktop: default view (light mode)

![Desktop default view](docs/screenshots/desktop-default-light.png)

### Desktop: optional network insights (dark mode)

![Desktop with network insights](docs/screenshots/desktop-insights-dark.png)

### Mobile: compact and expanded views (dark mode)

| Compact default | First instance expanded |
| --- | --- |
| <img src="docs/screenshots/mobile-default-dark.png" width="340" alt="Mobile compact view"> | <img src="docs/screenshots/mobile-details-dark.png" width="340" alt="Mobile expanded view"> |

## Configuration

Copy `config-example.json` to `config.json` and edit it for your network. Omitted options use the defaults below.

### 1. `config.json`

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

#### Dashboard options

| Option | Default | Description |
| --- | --- | --- |
| `base_path` | `/` | Hosting subpath, for example `/pi-dash/`. |
| `refresh_interval` | `5000` | Statistics refresh interval in milliseconds. |
| `queries_refresh_interval` | `refresh_interval` | Query-feed refresh interval in milliseconds. |
| `cache_ttl` | Automatic | Shared cache lifetime in milliseconds; `0` disables caching. |
| `show_queries` | `false` | Show recent allowed and blocked DNS queries. |
| `show_network_summary` | `true` | Show combined statistics from reporting Pi-holes. |
| `show_trends` | `true` | Show query-rate sparklines. |
| `show_network_insights` | `false` | Show history and top-five rankings; requires Network Summary. |
| `show_device_metrics` | `true` | Show CPU, RAM, temperature, and uptime in instance details. |
| `piholes` | `[]` | Pi-hole instances to monitor. |

#### Pi-hole options

| Option | Default | Description |
| --- | --- | --- |
| `name` | Required | Unique display name for the Pi-hole. |
| `address` | Required | Full base URL with scheme and optional port; omit `/admin` and `/api`. |
| `password` | Empty string | API/application password or `${ENV_NAME}` reference. |
| `enabled` | `true` | Set to `false` to hide and stop monitoring the instance. |
| `link` | `false` | Link the instance name to its admin interface. |
| `verify_ssl` | `false` | Verify HTTPS certificates with `true`, or provide a CA bundle path. |

Use a literal password or a `${ENV_NAME}` reference. For the example above, create a `.env` file beside `compose.yaml`:

```dotenv
PIHOLE_PRIMARY_PASSWORD=your_app_password_here
```

Compose passes this variable below; Docker Run uses `--env-file .env`. For native installs, export it before starting Pi-Dash. Keep `.env` out of version control.

#### Good to know

- Installing Pi-Dash as an app (PWA) requires HTTPS or localhost.
- Pi-Dash has no login of its own, so keep it on your LAN or behind a reverse proxy with authentication.
- Restart the container or process after changing `config.json`.

### 2. `manifest.json` (Optional)

If `/app/manifest.json` is mounted, Pi-Dash uses it; otherwise it uses the built-in manifest. To customize it, copy `web/manifest.json`, edit it, and mount it.

Icons in a custom manifest must load in the browser: prefer relative paths or a publicly trusted HTTPS URL. An icon on a host with an untrusted self-signed certificate, such as `https://pi.hole`, can block the install prompt.

Create the host file before enabling a manifest mount; if it does not exist, Docker creates an empty folder in its place.

---

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
      PIHOLE_PRIMARY_PASSWORD: "${PIHOLE_PRIMARY_PASSWORD}"
    volumes:
      - ./config.json:/app/config.json:ro
      # Optional: create manifest.json first, then uncomment.
      # - ./manifest.json:/app/manifest.json:ro
    restart: unless-stopped
```

### Docker Run

```bash
# Optional: create manifest.json first, then add this mount before the image.
#   -v /path/to/pi-dash/manifest.json:/app/manifest.json:ro \
docker run -d \
  --name pi-dash \
  -p 5001:5001 \
  --env-file .env \
  -v /path/to/pi-dash/config.json:/app/config.json:ro \
  ghcr.io/surajverma/pi-dash:latest
```

### Native Install

1. Clone the repository:

   ```bash
   git clone https://github.com/surajverma/pi-dash.git
   cd pi-dash
   ```

2. Create your configuration and install the dependencies:

   ```bash
   cp config-example.json config.json
   python -m pip install -r requirements.txt
   ```

   On Windows, use `copy config-example.json config.json` instead.

3. Start Pi-Dash:

   ```bash
   python -m pi_dash
   ```

Open `http://localhost:5001` in your browser.

## Health Check

`GET /health` reports whether Pi-Dash is running without contacting your Pi-holes.

## Development

```bash
python -m unittest discover -s tests
npm ci
npm run test:js
npm run build:css
npx playwright install chromium
npm run test:browser
```

## Credits

Initial development of Pi-Dash was done by [Codeloaf](https://github.com/codeloaf). It has since been transferred to this repository for ongoing maintenance, as the original author is not active on GitHub.

## Disclaimer

This project is not associated with the official [Pi-hole](https://pi-hole.net/) project. Pi-hole is a registered trademark of Pi-hole LLC.

## License

This project is licensed under the MIT License. See the [LICENSE](LICENSE) file for details.

## Contributing

Contributions are welcome! If you have any ideas, suggestions, or bug reports, please open an issue or submit a pull request.

## Thank You

If you like my work, you can [buy me a coffee ☕](https://ko-fi.com/skv)
