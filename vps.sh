#!/bin/bash

# 1. Variables
REPO_URL="https://gitlab.com/lorem-group-us/v9.git"
APP_DIR="v9"

echo "🚀 Starting full deployment..."

# 2. Kill anything sitting on our ports (Caddy & Node)
sudo fuser -k 80/tcp 443/tcp 8080/tcp 2>/dev/null

# 3. Ensure Caddy is installed
if ! command -v caddy &> /dev/null; then
    sudo apt update && sudo apt install -y curl debian-keyring debian-archive-keyring apt-transport-https
    curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
    curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list
    sudo apt update
    sudo apt install caddy -y
fi

# 3.5. Ensure Tor is installed
if ! command -v tor &> /dev/null; then
    sudo apt update
    sudo apt install tor -y
    sudo systemctl enable tor
    sudo systemctl start tor
fi

# 4. Import/Update Repository
if [ -d "$APP_DIR" ]; then
    echo "Found existing repo, updating..."
    cd $APP_DIR && git pull
else
    git clone $REPO_URL
    cd $APP_DIR
fi

# 5. Install Dependencies
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash
nvm install --lts
npm install pm2@latest -g
npm install

# 6. Configure Caddyfile
sudo cp Caddyfile /etc/caddy/Caddyfile

# 8. Start everything
pm2 delete index 2>/dev/null
pm2 start index.js --name "index"
pm2 save
sudo systemctl restart caddy

echo "------------------------------------------------"
echo "✅ DEPLOYMENT FINISHED"
echo "IP: http://$(curl -s ifconfig.me)"
echo "Check: http://$(curl -s ifconfig.me)/check"
echo "------------------------------------------------"