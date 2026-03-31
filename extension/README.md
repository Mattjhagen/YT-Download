# FinchWire Chrome Extension

A Manifest V3 extension that adds premium download and VLC integration directly to the FinchWire media app.

## Features
- **Auto-Detection**: Automatically finds media items on FinchWire pages via embedded DOM hooks.
- **Download Menu**: Injects a clean button that offers Video and Audio downloads.
- **VLC Integration**: One-click to open any video in your local VLC player.
- **Copy Media URL**: Quickly copy direct streaming links for other apps.

## Installation
1.  Download or clone this directory.
2.  Open Chrome and navigate to `chrome://extensions`.
3.  Enable **Developer mode** (top right).
4.  Click **Load unpacked**.
5.  Select this `extension/` directory.

## How it Works
The extension scans for elements with `data-media-url` or the `finchwire-media-root` class. It uses a `MutationObserver` to ensure buttons are correctly injected even on dynamic SPA pages. Downloads are processed via the official `chrome.downloads` API for maximum reliability.

## Manifest V3 Details
- **Permissions**: `downloads`, `storage`.
- **Host Permissions**: `https://yt.finchwire.site/*`.
- **Background**: Uses a Service Worker for event-based processing.

## Known Limitations
- **VLC Protocol**: Your operating system must have a `vlc://` handler registered. If VLC is installed, this is usually automatic.
- **Private Hosts**: This extension is configured for the public domain `yt.finchwire.site`. Update `manifest.json` host permissions if using a different domain.
