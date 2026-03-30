# ⬇️ Media Drop

Media Drop is a simple, self-hosted web application for downloading and streaming media on Ubuntu.

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
