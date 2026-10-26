const AnySocket = require("anysocket");
const Helpers = require("./helpers");
const fs = require("fs");
const os = require("os");
const path = require("path");
const Devices = require("./Devices");
const SyncService = require("./sync/SyncService");

const PROTOCOL = 2;
const FEATURES = ["devices", "rename", "incremental", "merge"];
// a device has this long to say who it is
const IDENTIFY_TIMEOUT = 60 * 1000;

module.exports = class Server {
    constructor(config) {
        this.config = config;
        this.debug = 1;
        if(config.logs && config.logs.level !== undefined) {
            this.debug = config.logs.level;
        }
        this.version = JSON.parse(fs.readFileSync(path.join(config.app_dir, "package.json"), "utf8")).version;

        this.devices = new Devices(XDB);
        this.sync = new SyncService(XStorage, {
            debug: this.debug,
            onChange: (paths, device) => this.broadcastChanges(paths, device)
        });
        // deviceId -> Set of peers
        this.online = new Map();

        this.server = new AnySocket({
            // anysocket 1.0 mutual auth (challenge/response, binds the e2e keys)
            // optional: clients <= 1.5.x (anysocket 0.4) don't offer it and must still
            // be able to connect to receive the auto-update
            auth: {
                secret: this.config.password,
                optional: this.config.allow_legacy_clients !== false
            },
            rpcGuard: (peer, rpcPath) => this.canCall(peer, rpcPath)
        });
        // legacy auth, still sent by every client so that old servers accept new clients
        this.server.onAuth = (packet) => {
            return packet.auth == Helpers.getSHA(packet.id.substring(0, 16) + this.config.password + packet.id.substring(16));
        };
        this.server.authPacket = () => {
            return Helpers.getSHA(this.server.id.substring(0, 16) + this.config.password + this.server.id.substring(16));
        };

        this.server.rpc = this.makeRPC();
        this.server.on("connected", this.onConnected.bind(this));
        this.server.on("disconnected", this.onDisconnected.bind(this));
        this.server.on("message", this.onMessage.bind(this));
    }

    async listen() {
        const listenOptions = {
            port: this.config.port,
            // anysocket 1.0 drops a silent peer, ~60s budget
            heartbeatInterval: 10 * 1000,
            heartbeatsMaxMissed: 5
        };

        // HTTPS
        if(this.config.certs) {
            await this.server.listen("http", {
                key: this.config.certs.pk,
                cert: this.config.certs.cert,
                port: this.config.port,
                host: this.config.host
            });
        }
        await this.server.listen("ws", listenOptions);
        console.log("[SERVER] " + this.version + " listening on port " + this.config.port + (this.config.certs ? " (TLS)" : ""));
        await this.listenAdmin();
    }

    log(level, peer, ...args) {
        if (this.debug >= level) {
            const who = peer && peer.data && peer.data.name ? peer.data.name : (peer ? peer.id : "");
            console.log("[SERVER]" + (who ? "[" + who + "]" : ""), ...args);
        }
    }

    // ---- connection lifecycle ----

    onConnected(peer) {
        peer.data = peer.data || {};
        this.log(1, peer, "Connected");
        peer._identifyTimeout = setTimeout(() => {
            peer.disconnect("No device information sent");
        }, IDENTIFY_TIMEOUT);
    }

    onDisconnected(peer, reason) {
        clearTimeout(peer._identifyTimeout);
        this.log(1, peer, "Disconnected", reason || "");
        const data = peer.data || {};
        if (data.deviceId) {
            const peers = this.online.get(data.deviceId);
            if (peers) {
                peers.delete(peer);
                if (peers.size === 0) {
                    this.online.delete(data.deviceId);
                }
            }
            this.devices.seen(data.deviceId);
        }
    }

    // which RPCs a connection may call, at its current stage
    canCall(peer, rpcPath) {
        if (!peer.isE2EEnabled()) {
            return false;
        }
        if (!peer.data) {
            peer.data = {};
        }
        const data = peer.data;
        const name = rpcPath[0];
        if (name === "onVersionCheck") {
            return true;
        }
        if (name === "hello") {
            return !!data.versionOk;
        }
        // 1.5.x clients only get this far when their version matches, which a 1.6.0 server never does
        if (name === "setDeviceId" || name === "autoSync") {
            return !!data.versionOk;
        }
        return !!data.approved;
    }

    makeRPC() {
        return {
            onVersionCheck: this.onVersionCheck.bind(this),
            hello: this.onHello.bind(this),
            // 1.5.x: a client that never upgraded cannot sync with a 1.6.0 server
            setDeviceId: (id, peer) => {
                peer.disconnect("Please update the plugin");
            },
            autoSync: (value, peer) => {
                peer.data.autoSync = !!value;
            },
            sync: {
                list: (cursor, epoch) => this.sync.list(cursor, typeof epoch === "string" ? epoch : null),
                meta: (filePath) => {
                    this.assertPath(filePath);
                    return this.sync.meta(filePath);
                },
                // anysocket appends the calling peer to the arguments, so an optional
                // argument the client left out holds the peer: only a number counts
                content: (filePath, timestamp) => {
                    this.assertPath(filePath);
                    return this.sync.content(filePath, typeof timestamp === "number" ? timestamp : null);
                },
                put: (filePath, meta, base, data, peer) => {
                    this.assertPath(filePath);
                    // data is optional (folders, deletes), so the peer may arrive in its place
                    if (data && data.data && data.isE2EEnabled) {
                        peer = data;
                        data = null;
                    }
                    return this.sync.put(filePath, meta, base, data, this.deviceOf(peer));
                },
                rename: (from, to, base, peer) => {
                    this.assertPath(from);
                    this.assertPath(to);
                    return this.sync.rename(from, to, base, this.deviceOf(peer));
                },
                versions: (filePath) => {
                    this.assertPath(filePath);
                    return this.sync.versions(filePath);
                },
                files: (mode) => this.sync.files(mode === "deleted" ? "deleted" : "all")
            },
            devices: {
                list: () => this.listDevices(),
                approve: (id, peer) => this.approveDevice(id, peer.data.name),
                revoke: (id) => this.revokeDevice(id),
                remove: (id) => this.removeDevice(id)
            }
        };
    }

    assertPath(filePath) {
        if (!Helpers.isSafePath(filePath)) {
            throw new Error("Invalid path");
        }
    }

    deviceOf(peer) {
        return { id: peer.data.deviceId, name: peer.data.name };
    }

    onVersionCheck(version, build, peer) {
        const BUILD_INFO = JSON.parse(fs.readFileSync(this.config.app_dir + "/client/build_info.json", "utf-8"));
        if (version == BUILD_INFO.version && build == BUILD_INFO.build) {
            peer.data.versionOk = true;
            return {
                type: "ok",
                server: this.version,
                protocol: PROTOCOL
            };
        }

        this.log(1, peer, "Client updated from:", version, "(build: " + build + ")",
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

    // a 1.6.0+ client says which device it is
    onHello(info, peer) {
        clearTimeout(peer._identifyTimeout);
        info = info || {};
        const { device, error } = this.devices.register({
            id: info.id,
            secret: info.secret,
            name: info.name,
            platform: info.platform
        });
        if (error) {
            this.log(1, peer, "Refused:", error);
            setTimeout(() => peer.disconnect(error), 100);
            return { protocol: PROTOCOL, error };
        }

        peer.data.deviceId = device.id;
        peer.data.name = device.name;
        peer.data.autoSync = info.autoSync !== false;
        if (!this.online.has(device.id)) {
            this.online.set(device.id, new Set());
        }
        this.online.get(device.id).add(peer);

        peer.data.approved = device.status === Devices.STATUS.APPROVED;
        this.log(1, peer, "Device", device.id, device.status + (device.approved_by && device.created === device.last_online ? " (" + device.approved_by + ")" : ""));

        if (device.status === Devices.STATUS.PENDING) {
            this.tellApproved({ type: "device_request", device: this.devices.public(device) });
        }
        if (device.status === Devices.STATUS.REVOKED) {
            setTimeout(() => peer.disconnect("Device removed"), 100);
        }

        return {
            protocol: PROTOCOL,
            server: this.version,
            features: FEATURES,
            device: this.devices.public(device),
            epoch: XStorage.epoch
        };
    }

    // ---- devices ----

    listDevices() {
        return this.devices.list().map(device => Object.assign(device, {
            online: this.online.has(device.id)
        }));
    }

    approveDevice(id, by) {
        const device = this.devices.approve(id, by || "server");
        this.log(1, null, "Approved device:", device.name, "(" + device.id + ") by", by || "server");
        for (const peer of this.online.get(device.id) || []) {
            peer.data.approved = true;
            peer.send({ type: "device_status", status: device.status }).catch(() => {});
        }
        this.tellApproved({ type: "devices_changed" });
        return this.devices.public(device);
    }

    revokeDevice(id) {
        const device = this.devices.revoke(id);
        this.log(1, null, "Removed device:", device.name, "(" + device.id + ")");
        this.disconnectDevice(device.id, "Device removed");
        this.tellApproved({ type: "devices_changed" });
        return this.devices.public(device);
    }

    removeDevice(id) {
        const device = this.devices.remove(id);
        this.log(1, null, "Declined device:", device.name, "(" + device.id + ")");
        this.disconnectDevice(device.id, "Device declined");
        this.tellApproved({ type: "devices_changed" });
        return this.devices.public(device);
    }

    disconnectDevice(id, reason) {
        for (const peer of this.online.get(id) || []) {
            peer.data.approved = false;
            peer.send({ type: "device_status", status: "revoked" }).catch(() => {}).finally(() => {
                setTimeout(() => peer.disconnect(reason), 100);
            });
        }
    }

    tellApproved(message, except) {
        for (const peers of this.online.values()) {
            for (const peer of peers) {
                if (peer !== except && peer.data.approved) {
                    peer.send(message).catch(() => {});
                }
            }
        }
    }

    // ---- changes ----

    broadcastChanges(paths, origin) {
        const entries = paths.map(p => [p, XStorage.index.get(p)]).filter(e => e[1]);
        const message = { type: "changed", entries, epoch: XStorage.epoch };
        for (const [deviceId, peers] of this.online) {
            for (const peer of peers) {
                // the device that made the change got the outcome in its reply
                if (!peer.data.approved || (origin && deviceId === origin.id)) {
                    continue;
                }
                peer.send(message).catch(() => {});
            }
        }
    }

    onMessage(packet) {
        // everything in 1.6.0 goes over RPC; plain messages are 1.5.x clients that never updated
        if (packet.msg == null || !packet.peer.isE2EEnabled()) {
            return packet.peer.disconnect("Encryption required");
        }
        this.log(2, packet.peer, "Ignored message from an outdated client:", packet.msg && packet.msg.type);
    }

    // ---- server CLI, over a local socket ----

    adminSocketPath() {
        return module.exports.adminSocketPath(this.config);
    }

    async listenAdmin() {
        const socketPath = this.adminSocketPath();
        if (process.platform !== "win32" && fs.existsSync(socketPath)) {
            fs.unlinkSync(socketPath);
        }
        this.admin = new AnySocket({ auth: { secret: this.config.password } });
        this.admin.onAuth = () => true;
        this.admin.rpc = {
            devices: {
                list: () => this.listDevices(),
                approve: (id) => this.approveDevice(id, "server"),
                revoke: (id) => this.revokeDevice(id),
                remove: (id) => this.removeDevice(id)
            }
        };
        this.admin.rpcGuard = (peer) => peer.isAuthenticated();
        try {
            await this.admin.listen("ipc", { path: socketPath });
        } catch (e) {
            console.error("[SERVER] Admin socket unavailable (" + socketPath + "):", e.message);
        }
    }

    async stop() {
        await this.server.stop().catch(() => {});
        if (this.admin) {
            await this.admin.stop().catch(() => {});
        }
    }
}

// where the server CLI finds the running server
module.exports.adminSocketPath = (config) => {
    if (process.platform === "win32") {
        return "\\\\.\\pipe\\anysocket-sync-" + config.port;
    }
    const socketPath = path.join(config.data_path || path.join(config.app_dir, config.data_dir), "admin.sock");
    // unix socket paths are limited to ~108 bytes
    return socketPath.length < 100 ? socketPath : path.join(os.tmpdir(), "anysocket-sync-" + config.port + ".sock");
};
