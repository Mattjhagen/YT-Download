#!/bin/bash

# Media Drop - Update Script for Ubuntu
# Run this on your server from the repository root

set -e

echo "🔄 Pulling latest changes from GitHub..."
git pull

echo "📦 Syncing app files to /opt/media-drop/app..."
# Sync only the contents of the 'app' directory, excluding node_modules to avoid overwriting production binaries
sudo rsync -av --exclude 'node_modules' app/. /opt/media-drop/app/

# Check if package.json has changed between HEAD and HEAD@{1}
if git diff --name-only HEAD@{1} HEAD | grep -q "app/package.json"; then
    echo "📜 package.json changed, installing new dependencies..."
    cd /opt/media-drop/app
    sudo -u media-drop HOME=/home/media-drop npm install --omit=dev
    cd -
else
    echo "✅ No dependency changes detected."
fi

echo "🚀 Restarting Media Drop service..."
sudo systemctl restart media-drop

echo "✨ Update complete!"
