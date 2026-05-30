[![CI/CD](https://github.com/surajverma/pi-dash/actions/workflows/main.yml/badge.svg)](https://github.com/surajverma/pi-dash/actions/workflows/main.yml)
![Latest Release](https://img.shields.io/github/v/release/surajverma/pi-dash?include_prereleases)
[![GitHub last commit](https://img.shields.io/github/last-commit/surajverma/pi-dash)](https://github.com/surajverma/pi-dash/commits/main)
[![GitHub issues](https://img.shields.io/github/issues/surajverma/pi-dash)](https://github.com/surajverma/pi-dash/issues)
[![GitHub Stars](https://img.shields.io/github/stars/surajverma/pi-dash?style=social)](https://github.com/surajverma/pi-dash/stargazers)
[![Downloads](https://img.shields.io/badge/dynamic/json?url=https%3A%2F%2Fghcr-badge.elias.eu.org%2Fapi%2Fsurajverma%2Fpi-dash&query=downloadCount&style=social&logo=github&label=Docker%20Pulls)](https://github.com/surajverma/pi-dash/pkgs/container/pi-dash)

# Pi-Dash: A Minimalist Pi-hole Dashboard

Pi-Dash is a simple, lightweight dashboard for monitoring multiple Pi-hole instances. It provides a clean, at-a-glance, responsive view of your Pi-hole statistics.

## Features

- **Multiple Pi-hole Support:** Monitor all your Pi-hole instances from a single dashboard. You can add as many as Pi-hole's you want.
- **Dynamic Configuration:** Easily add, remove, or disable Pi-holes through a simple `config.json` file.
- **Responsive Design:** The layout works on both desktop and mobile devices, stacking cards vertically on smaller screens.
- **Real-time Statistics:** The dashboard automatically refreshes every second.
- **Lightweight and Fast:** Built with Flask and vanilla JavaScript, Pi-Dash is fast and has minimal dependencies.
- **Dark Mode:** Automatically switches theme based on your system preferences.

![pi-dash-landscape](https://github.com/user-attachments/assets/a0e1fbef-279a-40df-9424-0cad50c31b50)


<img width="2481" height="1477" alt="Screenshot 2025-10-04 114711" src="https://github.com/user-attachments/assets/e160cb8d-8dd9-49ac-801a-a95a34c254f7" />

## Configuration

Before running the application, you need to create and configure the following files:

### 1. `config.json`

This file manages your Pi-hole instances and dashboard settings. Example:

```json
{
  "base_path": "/",
  "refresh_interval": 1000,
  "show_queries": false,
  "piholes": [
    {
      "name": "Primary",
      "address": "https://pi.hole/one",
      "password": "your_app_password_here",
      "enabled": true,
      "link": true
    },
    {
      "name": "Secondary",
      "address": "https://pi.hole/two",
      "password": "your_app_password_here",
      "enabled": true,
      "link": false
    }
  ]
}
```

- **base_path**: (optional) The subpath where the application is hosted (e.g., `/pi-dash/`). Defaults to `/`.
- **refresh_interval**: (optional) How often the dashboard updates, in milliseconds (e.g., 1000 = 1 second).
- **show_queries**: (optional, default: `false`) When set to `true`, a subtle scrolling feed of recent DNS queries will appear from the bottom of the screen. Blocked domains are shown in red, allowed in green.
- **piholes**: List of Pi-hole instances.
  - **name**: Display name for your Pi-hole (e.g., "Primary").
  - **address**: Full URL to your Pi-hole (e.g., "http://pi.hole").
  - **password**: Your Pi-hole API token/password.
  - **enabled**: Set to `true` to display the Pi-hole on the dashboard, or `false` to hide it.
  - **link**: (optional, default: `false`) When `true`, the display name becomes a clickable link that opens the Pi-hole admin in a new tab.

### 2. `manifest.json` (Optional)

This file is for Progressive Web App (PWA) settings and icon. Example:

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

- **icons.src**: Replace with a direct link to your Pi-hole logo or preferred icon.

---

## Installation

### Docker

1. **Docker Compose**
   ```yaml
   services:
     pi-dash:
       image: ghcr.io/surajverma/pi-dash:latest
       container_name: pi-dash
       ports:
         - 5001:5001
       volumes:
         - ./config.json:/app/config.json
         - ./manifest.json:/app/manifest.json
         # Assumes config.json and manifest.json are in the same folder as your compose.yml file
   ```
2. **Docker Run**
   ```bash
   docker run -d \
    --name=pi-dash \
    -p 5001:5001 \
    -v /path/to/pi-dash/config.json:/app/config.json \
    -v /path/to/pi-dash/manifest.json:/app/manifest.json \ # If you wish to edit the current manifest
    ghcr.io/surajverma/pi-dash:latest
   ```

### Native Install

1.  **Clone the repository:**

    ```bash
    git clone https://github.com/surajverma/pi-dash.git
    cd pi-dash
    ```

2.  **Install the dependencies:**

    ```bash
    pip install -r requirements.txt
    ```

3.  **Start the app:**
    To start the application, run the following command from the project's root directory:
    ```bash
    python proxy.py
    ```

Then, open your web browser and navigate to `http://localhost:5001`.

## Credits
Initial development of Pi-dash was done by [Codeloaf](https://github.com/codeloaf). It has since been transferred to this repository for ongoing maintenance, as the original author is not active on GitHub. 

## Disclaimer

This project is not associated with the official [Pi-hole](https://pi-hole.net/) project. Pi-hole is a registered trademark of Pi-hole LLC.

## License

This project is licensed under the MIT License. See the [LICENSE](LICENSE) file for details.

## Contributing

Contributions are welcome! If you have any ideas, suggestions, or bug reports, please open an issue or submit a pull request.

## Thank You
If you like my work, you can [buy me a coffee ☕](https://ko-fi.com/skv)
