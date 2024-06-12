let peerList = [];
const AnySocket = require("anysocket");
const Helpers = require("./helpers");
const fs = require("fs");
const DEBUG = true;
process.on('unhandledRejection', (reason, p) => {
    console.log('Unhandled Rejection at: Promise', p, 'reason:', reason);
    console.log('stacktrace', (new Error()).stack)
    // application specific logging, throwing an error, or other logic here
});
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
        this.server.listen("http", {
            key: "./certs/privkey.pem",
            cert: "./certs/fullchain.pem",
            port: 3000,
            host: "0.0.0.0"
        });
        this.server.listen("ws", 3000);


        this.server.on("connected", (peer) => {
            console.log("[SERVER][" + peer.id + "] Connected");
            peerList.push(peer);
        });
        this.server.rpc = {
            setDeviceId: (id, peer) => {
                console.log("[SERVER][" + peer.id + "] Device Id:", id);
                if (!peer.data)
                    peer.data = {};

                peer.data.id = id;
                XDB.devices.add(id);
                XDB.devices.set(id, "last_online", (new Date()).getTime());
            },
            onVersionCheck: this.onVersionCheck.bind(this)
        }

        this.server.on("message", (packet) => {
            if(packet.msg == null)
                return;

            switch (packet.msg.type) {
                case "sync":
                    this.onSync(packet.msg.data, packet.peer);
                    break;
                case "file_event":
                    this.onFileEvent(packet.msg.data, packet.peer);
                    break;
                case "file_data":
                    this.onFileData(packet.msg.data, packet.peer);
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

    async onSync(data, peer) {
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
                    this.onFileEvent(foundItem.metadata, peer);
                } else {
                    let metadata = (await XStorage.readMetadata(localFile));
                    if (metadata.action == "deleted") {
                        // if only the server has the deleted item, ignore
                        continue;
                    }

                    // if only the server has the item
                    this.onFileEvent({
                        path: localFile,
                        action: metadata.action,
                        mtime: 0
                    }, peer);
                }
            }

            // SYNC client to server
            for (let item of data) {
                if (processedFiles[item.path]) {
                    continue;
                }

                item.metadata.path = item.path;
                this.onFileEvent(item.metadata, peer);
            }
        } catch (e) {
            console.error("ERROR:", e);
        }
    }

    async onFileEvent(data, peer) {
        const metadata = await XStorage.readMetadata(data.path);
        let fileResult = await this.checkFile(data);
        DEBUG && console.log("[FileEvent]", data);
        DEBUG && console.log("[CheckFileResult]", fileResult);

        // request from client
        if (fileResult == -1) {
            peer.send({
                type: "file_data",
                data: {
                    type: "send",
                    path: data.path
                }
            });
        }
        // send to client
        else if (fileResult == 1) {
            peer.send({
                type: "file_data",
                data: {
                    type: "apply",
                    path: data.path,
                    metadata: metadata,
                    data: await XStorage.read(data.path)
                }
            });
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

    async onFileData(data, peer) {
        DEBUG && console.log("[FileData]", data);

        if (data.type == "send") {
            peer.send({
                type: "file_data",
                data: {
                    type: "apply",
                    data: await XStorage.read(data.path),
                    path: data.path,
                    metadata: await XStorage.readMetadata(data.path)
                }
            })
        } else if (data.type == "apply") {
            switch (data.metadata.action) {
                case "created":
                    await XStorage.writeMetadata(data.path, data.metadata);
                    if (data.metadata.type == "file" && data.data) {
                        await XStorage.write(data.path, data.data);
                    }
                    break
                case "deleted":
                    await XStorage.writeMetadata(data.path, data.metadata);
                    break;
            }

            peerList.map(async (other) => {
                try {
                    console.log(other.id, peer.id);
                    if (other.id != peer.id) {
                        console.log("sent", data);
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
}