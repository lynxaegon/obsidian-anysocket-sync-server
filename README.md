<h1 align="center">Obsidian <img src="https://github.com/lynxaegon/obsidian-anysocket-sync/raw/master/icon.svg">AnySocket Sync Server</h1>
<p align="center">The self-hosted server for <a href="https://github.com/lynxaegon/obsidian-anysocket-sync">Obsidian AnySocket Sync</a> </p>
<p align="center">Built with: <a href="https://github.com/lynxaegon/anysocket">anysocket</a></p>

## Manual Setup
_Important: **Always backup your vault!**_

* Download the latest release ([Releases](https://github.com/lynxaegon/obsidian-anysocket-sync-server/releases))
  * Or using git clone
    ```
    git clone git@github.com:lynxaegon/obsidian-anysocket-sync-server.git
    ```
2. Rename `config.example.js` to `config.js`
3. Update the configuration
4. `node index.js`
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


## License

MIT
