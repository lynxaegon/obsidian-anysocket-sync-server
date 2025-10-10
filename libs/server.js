let peerList = [];
const AnySocket = require("anysocket");
const Helpers = require("./helpers");
const fs = require("fs");

module.exports = class Server {
    constructor(config) {
        this.config = config;
        this.debug = 1;
        if(config.logs && config.logs.level) {
            this.debug = config.logs.level;
        }

        // Expose peerList for testing
        this.getPeerList = () => peerList;
        this.setPeerList = (list) => { peerList = list; };

        this.server = new AnySocket();
        this.server.onAuth = (packet) => {
            return packet.auth == Helpers.getSHA(packet.id.substring(0, 16) + this.config.password + packet.id.substring(16));
        };
        this.server.authPacket = () => {
            return Helpers.getSHA(this.server.id.substring(0, 16) + this.config.password + this.server.id.substring(16));
        };


        // HTTPS
        if(this.config.certs) {
            this.server.listen("http", {
                key: this.config.certs.pk,
                cert: this.config.certs.cert,
                port: this.config.port,
                host: this.config.host
            });
        }
        this.server.listen("ws", this.config.port);


        this.server.on("connected", (peer) => {
            this.debug >= 1 && console.log("[SERVER][" + peer.id + "] Connected");
            peer._noDeviceTimeout = setTimeout(() => {
                peer.disconnect("No device name sent...");
            }, 5000);
        });
        this.server.rpc = {
            autoSync: (value, peer) => {
                peer.data.autoSync = value;
            },
            setDeviceId: (id, peer) => {
                clearTimeout(peer._noDeviceTimeout);
                this.debug >= 1 && console.log("[SERVER][" + peer.id + "] Device Id:", id);
                if (!peer.data) {
                    peer.data = {
                        autoSync: true // default
                    };
                }

                peer.data.id = id;
                XDB.devices.add(id);
                XDB.devices.set(id, "last_online", (new Date()).getTime());
                peerList.push(peer);
            },
            onVersionCheck: this.onVersionCheck.bind(this)
        }

        this.server.on("message", (packet) => {
            if(packet.msg == null)
                return;

            if(!packet.peer.data || !packet.peer.data.id) {
                return packet.peer.disconnect();
            }

            switch (packet.msg.type) {
                case "sync":
                    this.onSync(packet.msg.data, packet);
                    break;
                case "file_event":
                    this.onFileEvent(packet.msg.data, packet);
                    break;
                case "file_data":
                    this.onFileData(packet.msg.data, packet);
                    break;
                case "file_history":
                    this.onFileHistory(packet.msg.data, packet);
                    break;
            }
        })

        this.server.on("disconnected", (peer, reason) => {
            clearTimeout(peer._noDeviceTimeout);
            this.debug >= 1 && console.log("[SERVER][" + peer.id + "] Disconnected", reason);
            peerList = peerList.filter((item) => item.id != peer.id);

            if (peer.data && peer.data.id) {
                XDB.devices.set(peer.data.id, "last_online", (new Date()).getTime());
            }
        });
    }

    onVersionCheck(version, build, peer) {
        const BUILD_INFO = JSON.parse(fs.readFileSync(this.config.app_dir + "/client/build_info.json", "utf-8"));
        if (version == BUILD_INFO.version && build == BUILD_INFO.build) {
            return {
                type: "ok"
            };
        } else {
            this.debug >= 1 && console.log("== Client updated from:",
                version, "(build: " + build + ")",
                "to:", BUILD_INFO.version, "(build: " + BUILD_INFO.build + ")");

            return {
                type: "update",
                version: BUILD_INFO.version,
                build: BUILD_INFO.build,
                files: [
                    {
                        path: "main.js",
                        data: fs.readFileSync(this.config.app_dir + "/client/main.js", "utf-8")
                    },
                    {
                        path: "styles.css",
                        data: fs.readFileSync(this.config.app_dir + "/client/styles.css", "utf-8")
                    },
                    {
                        path: "manifest.json",
                        data: fs.readFileSync(this.config.app_dir + "/client/manifest.json", "utf-8")
                    },
                ]
            };
        }
    }

    async checkFile(otherMetadata) {
        const metadata = await XStorage.readMetadata(otherMetadata.path);

        if (!metadata) {
            return -1;
        } else {
            if (metadata.sha1 !== otherMetadata.sha1 || metadata.action !== otherMetadata.action) {
                if (otherMetadata.mtime > metadata.mtime) {
                    // request file upload
                    return -1;
                } else if (otherMetadata.mtime < metadata.mtime) {
                    // request file download
                    return 1;
                }
            }
        }
        return 0;
    }

    async onSync(data, packet) {
        if(packet.peer.data.syncing) {
            this.debug >= 1 && console.log("[SERVER][" + packet.peer.data.id + "] Sync already in progress...");
            return;
        }
        this.debug >= 2 && console.log("[SERVER][" + packet.peer.data.id + "] Started sync");
        packet.peer.data.syncing = true;
        packet.peer.data.files = {};

        try {
            this.debug >= 3 && console.log("[SYNC]", data);
            const files = await XStorage.iterate();
            const processedFiles = {};

            // SYNC server to client
            for (let localFile of files) {
                let foundItem = data.find((item) => item.path == localFile);
                processedFiles[localFile] = 1;

                if (foundItem) {
                    // if server & client have the item, compare it as a FileEvent
                    foundItem.metadata.path = foundItem.path;
                    packet.peer.data.files[foundItem.path] = await this.onFileEvent(foundItem.metadata, packet);
                } else {
                    let metadata = (await XStorage.readMetadata(localFile));

                    // if only the server has the item
                    packet.peer.data.files[localFile] = await this.onFileEvent({
                        path: localFile,
                        action: metadata.action,
                        mtime: 0
                    }, packet);
                }
            }

            // SYNC client to server
            for (let item of data) {
                if (processedFiles[item.path]) {
                    continue;
                }

                item.metadata.path = item.path;
                packet.peer.data.files[item.path] = await this.onFileEvent(item.metadata, packet);
            }
            // filter null items
        } catch (e) {
            console.error("ERROR:", e);
        }

        for(let path in packet.peer.data.files) {
            if(packet.peer.data.files[path] == null || packet.peer.data.files[path] == "server_newer") {
                delete packet.peer.data.files[path];
            }
        }

        await this.onSyncCompleted(packet.peer);
    }

    async onSyncCompleted(peer) {
        if(peer.data.syncing == false)
            return;

        if (Object.keys(peer.data.files).length > 0) {
            return;
        }

        this.debug >= 2 && console.log("[SERVER][" + peer.data.id + "] Sync completed");
        peer.data.syncing = false;
        peer.send({
            type: "sync_complete"
        }).catch(e => console.error("ERROR:", e));
    }

    async onFileEvent(data, packet) {
        const metadata = await XStorage.readMetadata(data.path);
        let fileResult = await this.checkFile(data);
        this.debug >= 3 && console.log("[FileEvent]", data);
        this.debug >= 3 && console.log("[CheckFileResult]", fileResult);

        // request from client
        if (fileResult == -1) {
            if (data.action === "deleted") {
                await XStorage.writeMetadata(data.path, data);
                
                for(let other of peerList) {
                    if (other.id != packet.peer.id && other.data && other.data.autoSync) {
                        other.send({
                            type: "file_data",
                            data: {
                                type: "apply",
                                path: data.path,
                                metadata: data
                            }
                        }).catch(e => console.error("ERROR:", e));
                    }
                }
                return "client_newer";
            }
            
            // For created/modified files, request the content
            packet.peer.send({
                type: "file_data",
                data: {
                    type: "send",
                    path: data.path
                }
            }).catch(e => console.error("ERROR:", e));;
            return "client_newer";
        }
        // send to client
        else if (fileResult == 1) {
            let isBinary = Helpers.isBinary(data.path);
            packet.peer.send({
                type: "file_data",
                data: {
                    type: "apply",
                    binary: isBinary,
                    path: data.path,
                    metadata: metadata,
                    data: isBinary ?
                        AnySocket.Packer.pack(await XStorage.read(data.path, true)) :
                        await XStorage.read(data.path)
                }
            }).catch(e => console.error("ERROR:", e));;
            this.debug >= 2 && console.log("[SERVER][" + packet.peer.data.id + "] Updating client:", data.path);
            return "server_newer";
        }

        return null;
    }

    async onFileData(data, packet) {
        this.debug >= 3 && console.log("[FileData]", data);

        if (data.type == "send") {
            let isBinary = Helpers.isBinary(data.path);
            packet.peer.send({
                type: "file_data",
                data: {
                    type: "apply",
                    binary: isBinary,
                    data: isBinary ?
                        AnySocket.Packer.pack(await XStorage.read(data.path, true)) :
                        await XStorage.read(data.path),
                    path: data.path,
                    metadata: await XStorage.readMetadata(data.path)
                }
            }).catch(e => console.error("ERROR:", e));;
        } else if (data.type == "apply") {
            switch (data.metadata.action) {
                case "created":
                    await XStorage.writeMetadata(data.path, data.metadata);
                    if (data.metadata.type == "file") {
                        if(data.binary) {
                            await XStorage.write(data.path, AnySocket.Packer.unpack(data.data) || null, true);
                        }
                        else {
                            await XStorage.write(data.path, data.data || "");
                        }
                    }
                    break
                case "deleted":
                    await XStorage.writeMetadata(data.path, data.metadata);
                    break;
            }

            peerList.map(async (other) => {
                try {
                    if(data.type == "apply" && other.data.autoSync) {
                        if (other.id != packet.peer.id) {
                            other.send({
                                type: "file_data",
                                data: data
                            }).catch(e => console.error("ERROR:", e));;
                        }
                    }
                } catch (e) {
                    console.log("broadcast error", e);
                }
            });

            this.debug >= 2 && console.log("[SERVER][" + packet.peer.data.id + "] Updating server:", data.path);
            if(packet.peer.data.syncing) {
                delete packet.peer.data.files[data.path];
                await this.onSyncCompleted(packet.peer);
            }
        }
    }

    async onFileHistory(data, packet) {
        this.debug >= 3 && console.log("[FileHistory]", data);
        switch (data.type) {
            case "list_versions":
                let versions = await XStorage.iterateVersions(data.path);
                packet.reply({
                    deleted: (await XStorage.readMetadata(data.path)).action == "deleted",
                    data: versions.map(v => v.timestamp)
                })
                break;
            case "list_files":
                let files = [];
                let items = await XStorage.iterate();
                for(let item of items) {
                    let metadata = await XStorage.readMetadata(item);
                    if(metadata.type != "file") {
                        continue;
                    }

                    let shouldAdd = false;
                    if(data.mode != "deleted" && metadata.action != "deleted") {
                        shouldAdd = true;
                    }
                    else if(data.mode == "deleted" && metadata.action == "deleted") {
                        shouldAdd = true;
                    }

                    if(shouldAdd) {
                        files.push({
                            path: item,
                            mtime: metadata.mtime
                        });
                    }
                }
                packet.reply(files);
                break;
            case "read":
                if(!data.timestamp) {
                    return packet.reply(await XStorage.read(data.path));
                }
                if(data.binary) {
                    packet.reply(
                        AnySocket.Packer.pack(await XStorage.readExact(data.path + "/" + data.timestamp, true))
                    );
                }
                else {
                    packet.reply(await XStorage.readExact(data.path + "/" + data.timestamp));
                }
                break;

            default:
                console.log("[FileHistory]", "type", data.type, "NOT IMPLEMENTED");
        }
    }
}