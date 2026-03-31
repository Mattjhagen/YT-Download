#!/bin/bash

# Media Drop - Installation Script for Ubuntu

set -e

echo "🚀 Starting Media Drop installation..."

# 0. Capture repository root
REPO_ROOT=$(pwd)

# 1. Update and install base dependencies
sudo apt-get update
sudo apt-get install -y nodejs aria2 sqlite3 samba curl

# 2. Install latest yt-dlp binary from GitHub
echo "⏬ Downloading latest yt-dlp..."
sudo curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp
sudo chmod a+rx /usr/local/bin/yt-dlp

# 3. Create directories
sudo mkdir -p /opt/media-drop/app
sudo mkdir -p /srv/media-drop/library
sudo mkdir -p /srv/media-drop/tmp
sudo mkdir -p /srv/media-drop/db

# 3. Setup User
if ! id "media-drop" &>/dev/null; then
    sudo useradd -r -m -s /bin/false media-drop
else
    # Ensure home directory exists for npm cache
    sudo mkdir -p /home/media-drop
    sudo chown media-drop:media-drop /home/media-drop
fi

# 4. Set permissions
sudo chown -R media-drop:media-drop /srv/media-drop
sudo chown -R media-drop:media-drop /opt/media-drop

# 5. Copy app files (including hidden files like .env.example)
sudo cp -r app/. /opt/media-drop/app/
cd /opt/media-drop/app

# 6. Install NPM dependencies
sudo -u media-drop HOME=/home/media-drop npm install --omit=dev

# 7. Setup Environment
if [ ! -f .env ]; then
    sudo -u media-drop cp .env.example .env
    echo "⚠️  Please edit /opt/media-drop/app/.env to set your ADMIN_PASSWORD!"
fi

# 8. Setup Samba Share
if ! grep -q "\[media\]" /etc/samba/smb.conf; then
    echo "Sharing library via Samba..."
    sudo bash -c 'cat >> /etc/samba/smb.conf <<EOF

[media]
   path = /srv/media-drop/library
   browseable = yes
   read only = no
   guest ok = yes
   force user = media-drop
EOF'
    sudo systemctl restart smbd
fi

# 9. Install Systemd Service
sudo cp "$REPO_ROOT/scripts/media-drop.service" /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable media-drop
sudo systemctl start media-drop

echo "✅ Media Drop installed and started on port 8080!"
echo "🔗 Access it at http://your-server-ip:8080"
echo "📂 Media library is at /srv/media-drop/library"
