<h1 align="center">Obsidian <img src="https://github.com/lynxaegon/obsidian-anysocket-sync/raw/master/icon.svg">AnySocket Sync Server</h1>
<p align="center">The self-hosted server for <a href="https://github.com/lynxaegon/obsidian-anysocket-sync">Obsidian AnySocket Sync</a> </p>
<p align="center">Built with: <a href="https://github.com/lynxaegon/anysocket">anysocket</a></p>

## Manual Setup
_Important: **Always backup your vault!**_

Requires **Node.js 20** or newer.

* Download the latest release ([Releases](https://github.com/lynxaegon/obsidian-anysocket-sync-server/releases))
  * Or using git clone
    ```
    git clone git@github.com:lynxaegon/obsidian-anysocket-sync-server.git
    ```
2. Rename `config.example.js` to `config.js`
3. Update the configuration (at least the `password`)
4. `npm install`, then `node index.js`
5. Enjoy!


## Docker Setup
- `/app/data`
  - the location where vault data will be on disk
- `/app/config.js`
  - the location of the config required to run the `server`


#### Using the official image: `lynxaegon/obsidian-anysocket-sync-server`
```
docker run \
-v ${PWD}/config.js:/app/config.js \
-v ${PWD}/data:/app/data \
-p 3000:3000 \
--rm \
lynxaegon/obsidian-anysocket-sync-server
```


#### Building the image:
```
docker build -t sync-server .

docker run \
-v ${PWD}/config.js:/app/config.js \
-v ${PWD}/data:/app/data \
-p 3000:3000 \
--rm \
sync-server
```


## Devices
The first device that connects is approved on its own. Every device after it waits until you approve it, either from a device that already syncs (a notice asks you, or open the sync panel from the status bar), or on the server:

```
node cli.js devices                      # list devices
node cli.js devices approve "My Phone"   # allow a waiting device to sync
node cli.js devices revoke "Old Laptop"  # stop a device from syncing
node cli.js devices remove "Stranger"    # decline a waiting device
```

With docker: `docker exec <container> node cli.js devices approve "My Phone"`.

The commands work whether the server is running or not.


## Upgrading from 1.5.x
- Update the server; your devices update their plugin on their own the next time they connect.
- Your data stays as it is: 1.6.0 only adds to it, and nothing that was recoverable before (deleted files, history) is removed by the upgrade.
- Devices that synced in the 30 days before the upgrade are approved automatically. Any other device waits for approval (see Devices).
- Once all your devices run 1.6.0, set `"allow_legacy_clients": false` in `config.js`, so every connection uses the stronger authentication.
- Going back to 1.5.x works on the same data.

## Coming in 1.7
- Devices on 1.5.x or older won't be able to connect to a 1.7 server, so get every device on 1.6 before you update. 1.6 devices connect to 1.7 and update on their own, as usual.
- The plugin connects only over TLS (wss) by default. If your server has no TLS (no `certs` and no reverse proxy), turn on "Allow insecure connection" in the plugin's settings after updating.


## Security
- Use TLS when the server is reachable from the internet: either `certs` in `config.js`, or a reverse proxy in front of it. With nginx:
  ```
  location / {
      proxy_pass http://127.0.0.1:3000;
      proxy_set_header Host $host;
      proxy_http_version 1.1;
      proxy_set_header Upgrade $http_upgrade;
      proxy_set_header Connection "upgrade";
  }
  ```
- Use a long, random `password`. The server won't start with the example one.
- Every connection is encrypted end to end (AES-256-GCM or ChaCha20-Poly1305), and a device can only sync once it is approved.
- Files are stored on the server as they are (not encrypted at rest). Encrypt the disk the `data` folder lives on if that matters to you.


## Development
```
npm test               # unit tests
npm run test:e2e       # a real server and the real plugin on simulated devices (desktop and mobile)
npm run test:compat    # against the 1.5 production server and plugin, rebuilt from git
npm run test:perf      # a 2000-note vault
OBSIDIAN_BIN="C:\Program Files\Obsidian\Obsidian.exe" node test/obsidian/run.js   # the real Obsidian app
```


## License

MIT
