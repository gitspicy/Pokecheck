# Deploying Pokecheck with Apache on Ubuntu

`setup-apache-pokestop.sh` installs Apache + PHP-FPM and deploys this repo so
it's served at `http://<server-ip>/pokestop`.

## Prerequisites

- Ubuntu 24.04 or 26.04, with a user that has `sudo`.
- The server's LAN IP should already be `192.168.1.6` (set a DHCP
  reservation for its MAC address in your router, or a netplan static IP,
  if it isn't fixed yet — this script does not manage networking).

## Usage

Run directly from this repo on the server:

```bash
sudo ./deploy/setup-apache-pokestop.sh
```

Or, on a fresh box that doesn't have the repo yet, download and run just the
script (it clones the repo itself):

```bash
curl -O https://raw.githubusercontent.com/gitspicy/Pokecheck/claude/pokemon-go-pvp-app-lw2gy5/deploy/setup-apache-pokestop.sh
chmod +x setup-apache-pokestop.sh
sudo ./setup-apache-pokestop.sh
```

This will:

1. Install `apache2`, `php-fpm`, `php-cli`, and `git`.
2. Enable the Apache `proxy_fcgi`/`setenvif` modules and the PHP-FPM conf so
   PHP works under Apache's default `event` MPM (no need to downgrade to
   `mpm_prefork`/`mod_php`).
3. Clone (or, on re-run, `git pull`) the repo into `/var/www/html/pokestop`.
4. Set `www-data` ownership and sane file permissions.
5. Enable/restart `apache2` and the detected `phpX.Y-fpm` service.
6. Open the firewall for Apache if `ufw` is active.

Once it finishes, visit `http://192.168.1.6/pokestop/` from any device on
the LAN.

## Updating after new commits

Re-run the same command — it does a `git fetch` + `reset --hard` to the
target branch and restarts services. Pass a branch name as the first
argument to deploy a different branch, e.g.:

```bash
sudo ./deploy/setup-apache-pokestop.sh main
```
