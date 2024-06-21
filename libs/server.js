let peerList = [];
const AnySocket = require("anysocket");
const Helpers = require("./helpers");
const fs = require("fs");
const DEBUG = false

module.exports = class Server {
    constructor(config) {
        this.config = config;

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
            console.log("[SERVER][" + peer.id + "] Connected");
            peer._noDeviceTimeout = setTimeout(() => {
                peer.disconnect("No device name sent...");
            }, 5000);
        });
        this.server.rpc = {
            setDeviceId: (id, peer) => {
                clearTimeout(peer._noDeviceTimeout);
                console.log("[SERVER][" + peer.id + "] Device Id:", id);
                if (!peer.data)
                    peer.data = {};

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
            console.log("[SERVER][" + peer.id + "] Disconnected", reason);
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
            console.log("== Client updated from:",
                version, "(build: " + build + ")",
                "to:", BUILD_INFO.version, "(build: " + BUILD_INFO.build + ")");

            return {
                type: "update",
                version: BUILD_INFO.version,
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
        try {
            DEBUG && console.log("[SYNC]", data);
            const files = await XStorage.iterate();
            const processedFiles = {};

            // SYNC server to client
            for (let localFile of files) {
                let foundItem = data.find((item) => item.path == localFile);
                processedFiles[localFile] = 1;

                if (foundItem) {
                    // if server & client have the item, compare it as a FileEvent
                    foundItem.metadata.path = foundItem.path;
                    this.onFileEvent(foundItem.metadata, packet);
                } else {
                    let metadata = (await XStorage.readMetadata(localFile));

                    // if only the server has the item
                    this.onFileEvent({
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
                this.onFileEvent(item.metadata, packet);
            }
        } catch (e) {
            console.error("ERROR:", e);
        }
    }

    async onFileEvent(data, packet) {
        const metadata = await XStorage.readMetadata(data.path);
        let fileResult = await this.checkFile(data);
        DEBUG && console.log("[FileEvent]", data);
        DEBUG && console.log("[CheckFileResult]", fileResult);

        // request from client
        if (fileResult == -1) {
            packet.peer.send({
                type: "file_data",
                data: {
                    type: "send",
                    path: data.path
                }
            });
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
            });
        }
    }

    async onFileData(data, packet) {
        DEBUG && console.log("[FileData]", data);

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
            })
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
                    if (other.id != packet.peer.id) {
                        other.send({
                            type: "file_data",
                            data: data
                        });
                    }
                } catch (e) {
                    console.log("broadcast error", e);
                }
            });
        }
    }

    async onFileHistory(data, packet) {
        DEBUG && console.log("[FileHistory]", data);
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
                if(data.binary) {
                    console.log(await XStorage.readExact(data.path + "/" + data.timestamp, true));
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