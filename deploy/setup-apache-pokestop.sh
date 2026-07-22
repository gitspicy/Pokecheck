#!/usr/bin/env bash
#
# Installs Apache + PHP-FPM on Ubuntu (24.04/26.04) and deploys Pokecheck so
# it's served at http://<this-machine's-LAN-IP>/pokestop
#
# Usage (run on the Ubuntu box that will host the site):
#   sudo ./setup-apache-pokestop.sh [branch]
#
# Safe to re-run: it just git-pulls into the existing clone.

set -euo pipefail

REPO_URL="https://github.com/gitspicy/Pokecheck.git"
DEPLOY_DIR="/var/www/html/pokestop"
BRANCH="${1:-claude/pokemon-go-pvp-app-lw2gy5}"

if [[ $EUID -ne 0 ]]; then
  echo "Run this as root: sudo $0" >&2
  exit 1
fi

echo "==> Installing Apache, PHP-FPM, and git"
apt-get update
apt-get install -y apache2 php-fpm php-cli php-mbstring git

PHP_VERSION="$(php -r 'echo PHP_MAJOR_VERSION.".".PHP_MINOR_VERSION;')"
FPM_CONF="php${PHP_VERSION}-fpm"

echo "==> Enabling Apache modules for PHP-FPM (detected PHP ${PHP_VERSION})"
a2enmod proxy_fcgi setenvif
a2enconf "${FPM_CONF}"

echo "==> Deploying repo to ${DEPLOY_DIR} (branch: ${BRANCH})"
if [[ -d "${DEPLOY_DIR}/.git" ]]; then
  git -C "${DEPLOY_DIR}" fetch origin "${BRANCH}"
  git -C "${DEPLOY_DIR}" checkout "${BRANCH}"
  git -C "${DEPLOY_DIR}" reset --hard "origin/${BRANCH}"
else
  mkdir -p "$(dirname "${DEPLOY_DIR}")"
  git clone --branch "${BRANCH}" "${REPO_URL}" "${DEPLOY_DIR}"
fi

echo "==> Setting ownership/permissions"
chown -R www-data:www-data "${DEPLOY_DIR}"
find "${DEPLOY_DIR}" -type d -exec chmod 755 {} \;
find "${DEPLOY_DIR}" -type f -exec chmod 644 {} \;

echo "==> Enabling and restarting services"
systemctl enable --now "${FPM_CONF}"
systemctl restart "${FPM_CONF}"
systemctl enable apache2
systemctl restart apache2

if command -v ufw >/dev/null 2>&1 && ufw status | grep -q "Status: active"; then
  echo "==> Opening firewall for Apache"
  ufw allow 'Apache' || true
fi

LAN_IP="$(hostname -I | awk '{print $1}')"
echo
echo "Done. The app should now be live at:"
echo "  http://${LAN_IP}/pokestop/"
echo
echo "To update after a new push, just re-run this script:"
echo "  sudo ./setup-apache-pokestop.sh ${BRANCH}"
