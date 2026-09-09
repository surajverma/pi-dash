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
- **Network Summary:** View combined query, blocked, cached, and forwarded totals across reporting Pi-holes.
- **Pi-hole Status:** See reachability, authentication errors, and blocking ON/OFF state for each instance.
- **Responsive Design:** Desktop shows the full dashboard and ambient query feed. Mobile shows critical metrics in compact cards, with an accessible control to expand all available metrics.
- **Live Query Feed:** Optionally show recent allowed and blocked domains. Consecutive duplicate queries are grouped with `(x2)`, `(x3)`, and similar counts.
- **Configurable Refresh:** Set separate refresh intervals for statistics and queries. If the query interval is omitted, it uses the statistics interval.
- **Efficient Polling:** Polling stops while the page is hidden or the browser is offline, then resumes safely when it becomes active again. A short shared cache reduces duplicate Pi-hole API requests.
- **Lightweight and Fast:** Built with Flask and vanilla JavaScript, with no database or frontend framework.
- **Dark Mode and PWA Support:** Works with your preferred color scheme and can be installed as a Progressive Web App.

![pi-dash-landscape](https://github.com/user-attachments/assets/a0e1fbef-279a-40df-9424-0cad50c31b50)

<img width="2481" height="1477" alt="Pi-Dash dashboard" src="https://github.com/user-attachments/assets/e160cb8d-8dd9-49ac-801a-a95a34c254f7" />

## Configuration

Copy `config-example.json` to `config.json` and edit it for your network. The example is valid JSON without comments; all options and their defaults are described below.

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
| `base_path` | `/` | Subpath where Pi-Dash is hosted, for example `/pi-dash/`. |
| `refresh_interval` | `5000` | Statistics refresh interval in milliseconds. |
| `queries_refresh_interval` | `refresh_interval` | Query-feed refresh interval in milliseconds. |
| `cache_ttl` | Automatic | Shared backend cache lifetime in milliseconds. Set to `0` to disable caching. |
| `show_queries` | `false` | Show the live DNS query feed. Allowed queries are green and blocked queries are red. |
| `show_network_summary` | `true` | Show combined statistics from all reporting Pi-holes. |
| `show_trends` | `true` | Show short, in-memory query-rate sparklines. |
| `piholes` | `[]` | List of Pi-hole instances to monitor. |

When `cache_ttl` is omitted, Pi-Dash calculates it as half of the shortest refresh interval, with a minimum of 100 ms and a maximum of 1000 ms. The values in `config-example.json` are recommended example settings; omitted options use the defaults above.

#### Pi-hole options

| Option | Default | Description |
| --- | --- | --- |
| `name` | Required | Display name for the Pi-hole. Names must be unique. |
| `address` | Required | Full Pi-hole base URL, including the scheme and optional port. Do not include `/admin` or `/api`. |
| `password` | Empty string | Pi-hole API/application password. Literal values and `${ENV_NAME}` references are supported. |
| `enabled` | `true` | Set to `false` to hide and stop monitoring an instance without deleting it from the configuration. |
| `link` | `false` | Make the Pi-hole name a link to its admin interface. |
| `verify_ssl` | `false` | Set to `true` to verify trusted HTTPS certificates, or provide a CA bundle path. |

Settings omitted from `config.json` use the defaults above, so existing configurations continue to work. Passwords and CA bundle paths can reference environment variables:

```json
"password": "${PIHOLE_PRIMARY_PASSWORD}"
```

Provide referenced variables through your shell or Docker environment. Literal passwords remain supported. Do not commit real passwords to GitHub.

The Network Summary includes only additive DNS counters: total queries, blocked queries, cached queries, and forwarded queries. It does not combine active clients, unique domains, or domains on lists because those values can overlap between Pi-holes. If an instance is unavailable, the summary is marked as partial.

When the query feed is enabled, it displays recent queries while the dashboard is visible and online. Only consecutive entries with the same Pi-hole, domain, and blocked/allowed state are grouped. The feed is intended as a live overview; use Pi-hole's query log for complete history.

### 2. `manifest.json` (Optional)

This file contains the Progressive Web App name, colors, and icon:

```json
{
  "name": "Pi-Dash",
  "short_name": "Pi-Dash",
  "description": "A simple dashboard to monitor Pi-hole status.",
  "start_url": "/",
  "display": "standalone",
  "background_color": "#111827",
  "theme_color": "#06b6d4",
  "icons": [
    {
      "src": "https://pi.hole/admin/img/logo.svg",
      "sizes": "512x512",
      "type": "image/svg+xml"
    }
  ]
}
```

Replace `icons.src` with a direct link to your Pi-hole logo or preferred icon.

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
      PIHOLE_PRIMARY_PASSWORD: "your_app_password_here"
    volumes:
      - ./config.json:/app/config.json:ro
      - ./manifest.json:/app/manifest.json:ro
    restart: unless-stopped
```

### Docker Run

```bash
docker run -d \
  --name pi-dash \
  -p 5001:5001 \
  -e PIHOLE_PRIMARY_PASSWORD='your_app_password_here' \
  -v /path/to/pi-dash/config.json:/app/config.json:ro \
  -v /path/to/pi-dash/manifest.json:/app/manifest.json:ro \
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
   python proxy.py
   ```

Open `http://localhost:5001` in your browser.

## Health Check

`GET /health` reports whether the Pi-Dash application is running. It does not contact the configured Pi-hole instances.

## Development

The automated tests use mocked Pi-hole responses and do not require a live Pi-hole:

```bash
python -m unittest discover -s tests -v
npm install
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
