# ⬇️ Media Drop

Media Drop is a simple, self-hosted web application for downloading and streaming media on Ubuntu.

## 🔒 Hardening & Public Access (Behind Cloudflare)

This app is now hardened for public exposure via **Cloudflare Tunnel**.

### Security Features
- **SSRF Protection**: Blocks downloads from localhost, private IP ranges (10.x, 192.168.x, etc.), and cloud metadata IPs.
- **Rate Limiting**: Limits Each IP to 5 download submissions per hour.
- **Audit Logging**: All download requests, IPs, and errors are logged to the internal database.
- **Concurrency Control**: Maximum of 3 active downloads (others stay in queue).
- **File Size Limit**: Defaults to 2GB per file (checked via HEAD request).

### 1. Cloudflare Access (Strongly Recommended)
Before traffic even reaches your server, you should require a login via **Cloudflare Access**.
1. Go to **Cloudflare Zero Trust** dashboard.
2. Navigate to **Access > Applications**.
3. Add a new application for `media.finchwire.site`.
4. Create a policy to allow only your email (e.g., `matt@yourdomain.com`).
5. This ensures the app is invisible to the public internet except for authorized users.

### 2. Cloudflare Tunnel Setup
Instead of opening ports on your router, use `cloudflared`:
1. Install `cloudflared` on your Ubuntu server.
2. Authenticate: `cloudflared tunnel login`.
3. Create tunnel: `cloudflared tunnel create media-drop-tunnel`.
4. Use the provided [config.yml](./config.yml) (update with your Tunnel ID).
5. Start tunnel: `cloudflared tunnel run media-drop-tunnel`.

### 3. Systemd Service (Ubuntu)
To keep the app running in the background:
1. Copy [media-drop.service](./media-drop.service) to `/etc/systemd/system/`.
2. Update the `Environment` variables in the file (especially `MEDIA_DROP_ADMIN_PASSWORD`).
3. Reload systemd: `sudo systemctl daemon-reload`.
4. Enable/Start: `sudo systemctl enable --now media-drop`.

### 5. Resolving YouTube "Bot Check" (Sign in to confirm you're not a bot)
If you see this error, YouTube is blocking your server IP. To fix:
1. Install a browser extension for cookies (e.g., [Get cookies.txt LOCALLY](https://chrome.google.com/webstore/detail/get-cookiestxt-locally/ccmclokmhdnhblbhpcjallbdihbejdbe)).
2. Log in to YouTube in your browser.
3. Open the extension and click **Export** to save a `cookies.txt` file.
4. Upload the file to your server:
   `scp cookies.txt matt@192.168.1.107:/srv/media-drop/cookies.txt`
5. The app will automatically detect and use these cookies for all future downloads.

## Features
- **URL Submission**: Support for direct HTTP/HTTPS media URLs.
- **Aria2c Engine**: Fast and robust downloading with native Node.js fallback.
- **SSRF Protection**: Prevents downloading from internal network addresses.
- **VLC-Ready Streaming**: HTTP streaming with range request support for seeking.
- **Samba Integration**: Easily browse your library from macOS Finder.
- **Simple UI**: Modern, dark-themed dashboard.

## Installation (Ubuntu)

1. **Clone the repository**:
   ```bash
   git clone git@github.com:Mattjhagen/YT-Download.git
   cd YT-Download
   ```

2. **Run the installation script**:
   ```bash
   chmod +x scripts/install.sh
   ./scripts/install.sh
   ```

3. **Configure the app**:
   - Edit `/opt/media-drop/app/.env` to set your `MEDIA_DROP_ADMIN_PASSWORD`.
   - Restart the service: `sudo systemctl restart media-drop`.

4. **Access the App**:
   - Web UI: `http://SERVER-IP:8080`
   - Streaming: `http://SERVER-IP:8080/media/<filename>`

## Samba Share (macOS Access)
To browse files directly in Finder:
1. Follow the instructions in `scripts/samba-snippet.conf`.
2. Map the drive in Finder: `Go -> Connect to Server -> smb://SERVER-IP/MediaDrop`.

## Project Structure
- `/opt/media-drop/app`: Application files (Server, Node modules).
- `/srv/media-drop/library`: Downloaded files ready for streaming.
- `/srv/media-drop/tmp`: Temporary download storage.
- `/srv/media-drop/db`: SQLite job database.
