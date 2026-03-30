#!/bin/bash

# Media Drop - Installation Script for Ubuntu

set -e

echo "🚀 Starting Media Drop installation..."

# 1. Update and install dependencies
sudo apt-get update
sudo apt-get install -y nodejs aria2 sqlite3 samba curl

# 2. Create directories
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

# 5. Copy app files
sudo cp -r app/* /opt/media-drop/app/
cd /opt/media-drop/app

# 6. Install NPM dependencies
# Use a temporary home for npm install to avoid permission issues with system user
sudo -u media-drop HOME=/home/media-drop npm install --omit=dev

# 7. Setup Environment
if [ ! -f .env ]; then
    sudo -u media-drop cp .env.example .env
    echo "⚠️  Please edit /opt/media-drop/app/.env to set your ADMIN_PASSWORD!"
fi

# 8. Install Systemd Service
sudo cp scripts/media-drop.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable media-drop
sudo systemctl start media-drop

echo "✅ Media Drop installed and started on port 8080!"
echo "🔗 Access it at http://your-server-ip:8080"
echo "📂 Media library is at /srv/media-drop/library"
