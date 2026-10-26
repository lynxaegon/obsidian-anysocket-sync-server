/**
 * End-to-end harness: a real server process and real plugin bundles on fake devices,
 * over real sockets. Everything lives in temp folders and is removed after each test.
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const net = require("net");
const { spawn, fork, execFileSync } = require("child_process");

const SERVER_DIR = path.resolve(__dirname, "../..");
const PLUGIN_MAIN = path.join(SERVER_DIR, "client", "main.js");
const PASSWORD = "e2e-password-1234";
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function tmp(name) {
    return fs.mkdtempSync(path.join(os.tmpdir(), "anysocket-e2e-" + name + "-"));
}

function freePort() {
    return new Promise((resolve, reject) => {
        const srv = net.createServer();
        srv.listen(0, "127.0.0.1", () => {
            const { port } = srv.address();
            srv.close(() => resolve(port));
        });
        srv.on("error", reject);
    });
}

async function waitFor(fn, { timeout = 15000, interval = 100, message = "condition" } = {}) {
    const end = Date.now() + timeout;
    let last;
    while (Date.now() < end) {
        last = await fn();
        if (last) return last;
        await sleep(interval);
    }
    throw new Error("Timed out waiting for " + message);
}

class Server {
    constructor(t, { dir = SERVER_DIR, config = {}, dataDir } = {}) {
        this.t = t;
        this.dir = dir;
        this.configOverrides = config;
        this.dataDir = dataDir || tmp("server");
        this.logs = "";
        t.after(() => this.stop(true));
    }

    async start() {
        if (!this.port) {
            this.port = await freePort();
        }
        this.configPath = path.join(this.dataDir, "..", path.basename(this.dataDir) + "-config.js");
        const config = Object.assign({
            password: PASSWORD,
            host: "127.0.0.1",
            port: this.port,
            logs: { level: 2 },
            cleanup: { schedule: "0 0 1 1 *", versions_per_file: 1000, keep_deleted_files_time: 3 * 24 * 60 * 60 }
        }, this.configOverrides);
        fs.writeFileSync(this.configPath, "module.exports = " + JSON.stringify(config, null, 2) + ";");

        this.proc = spawn(process.execPath, ["index.js"], {
            cwd: this.dir,
            env: Object.assign({}, process.env, {
                ANYSOCKET_SYNC_CONFIG: this.configPath,
                ANYSOCKET_SYNC_DATA: this.dataDir
            })
        });
        this.proc.stdout.on("data", d => this.logs += d);
        this.proc.stderr.on("data", d => this.logs += d);
        this.exited = false;
        this.proc.on("exit", (code) => { this.exited = true; this.exitCode = code; });
        await waitFor(() => /listening on port|Listening on port/.test(this.logs) || this.exited, { message: "server start" });
        if (this.exited) {
            throw new Error("server exited:\n" + this.logs);
        }
        return this;
    }

    async stop(cleanup = false) {
        if (this.proc && !this.exited) {
            this.proc.kill();
            await waitFor(() => this.exited, { timeout: 5000, message: "server stop" }).catch(() => {});
        }
        if (cleanup) {
            fs.rmSync(this.dataDir, { recursive: true, force: true });
            if (this.configPath) fs.rmSync(this.configPath, { force: true });
        }
    }

    async restart() {
        await this.stop();
        return this.start();
    }

    cli(...args) {
        try {
            return execFileSync(process.execPath, ["cli.js", ...args], {
                cwd: this.dir,
                env: Object.assign({}, process.env, { ANYSOCKET_SYNC_CONFIG: this.configPath, ANYSOCKET_SYNC_DATA: this.dataDir }),
                encoding: "utf8"
            });
        } catch (e) {
            return (e.stdout || "") + (e.stderr || "");
        }
    }

    // content of the current version on the server's disk
    stored(p) {
        const metaFile = path.join(this.dataDir, "files", p, "metadata");
        if (!fs.existsSync(metaFile)) return null;
        const meta = JSON.parse(fs.readFileSync(metaFile, "utf8"));
        if (meta.action !== "created" || meta.type !== "file") return { meta };
        return { meta, data: fs.readFileSync(path.join(this.dataDir, "files", p, String(meta.mtime))) };
    }

    versions(p) {
        const dir = path.join(this.dataDir, "files", p);
        if (!fs.existsSync(dir)) return [];
        return fs.readdirSync(dir).filter(n => /^\d+$/.test(n)).map(Number).sort((a, b) => b - a);
    }
}

class Device {
    constructor(t, server, { name, platform = "desktop", vaultDir, main = PLUGIN_MAIN, settings = {} } = {}) {
        this.t = t;
        this.server = server;
        this.name = name;
        this.platform = platform;
        this.vaultDir = vaultDir || tmp("vault-" + name.replace(/[^a-z0-9]/gi, ""));
        this.main = main;
        this.settings = Object.assign({
            host: "127.0.0.1",
            port: String(server.port),
            password: PASSWORD,
            syncEnabled: true,
            delayedSync: 0,
            autoSync: true,
            notifications: 2,
            deviceName: name,
            debug: false
        }, settings);
        this.pending = new Map();
        this.seq = 0;
        this.logs = "";
        t.after(() => this.kill(true));
    }

    async spawn() {
        this.proc = fork(path.join(__dirname, "device.js"), [], {
            env: Object.assign({}, process.env, {
                PLUGIN_MAIN: this.main,
                VAULT: this.vaultDir,
                PLATFORM: this.platform,
                DEVICE_NAME: this.name
            }),
            stdio: ["ignore", "pipe", "pipe", "ipc"]
        });
        this.proc.stdout.on("data", d => this.logs += d);
        this.proc.stderr.on("data", d => this.logs += d);
        this.exited = false;
        this.proc.on("exit", () => {
            this.exited = true;
            for (const { reject } of this.pending.values()) reject(new Error("device " + this.name + " exited\n" + this.logs.slice(-3000)));
            this.pending.clear();
        });
        await new Promise((resolve) => {
            this.proc.on("message", (msg) => {
                if (msg.ready) return resolve();
                const p = this.pending.get(msg.id);
                if (!p) return;
                this.pending.delete(msg.id);
                msg.error ? p.reject(new Error(msg.error)) : p.resolve(msg.result);
            });
        });
        return this;
    }

    call(cmd, args, timeout = 60000) {
        if (this.exited) return Promise.reject(new Error("device " + this.name + " is not running"));
        const id = ++this.seq;
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pending.delete(id);
                reject(new Error(this.name + ": " + cmd + " timed out\n" + this.logs.slice(-3000)));
            }, timeout);
            this.pending.set(id, {
                resolve: (v) => { clearTimeout(timer); resolve(v); },
                reject: (e) => { clearTimeout(timer); reject(e); }
            });
            this.proc.send({ id, cmd, args });
        });
    }

    // starts the plugin (the device process too, if needed)
    async start(settings) {
        if (!this.proc || this.exited) await this.spawn();
        if (settings) Object.assign(this.settings, settings);
        return this.call("load", { settings: this.settings });
    }

    // quits "Obsidian": the plugin unloads and the process ends
    async quit() {
        if (this.proc && !this.exited) {
            await this.call("unload").catch(() => {});
            await this.call("exit").catch(() => {});
            await waitFor(() => this.exited, { timeout: 5000, message: this.name + " exit" }).catch(() => this.proc.kill());
        }
    }

    async kill(cleanup = false) {
        if (this.proc && !this.exited) this.proc.kill();
        if (cleanup) {
            fs.rmSync(this.vaultDir, { recursive: true, force: true });
            fs.rmSync(this.vaultDir + ".localStorage.json", { force: true });
        }
    }

    state() { return this.call("state"); }
    notices() { return this.call("notices"); }
    press(label) { return this.call("press", { label }); }
    tree() { return this.call("tree"); }
    read(p) { return this.call("read", { path: p }); }
    readBinary(p) { return this.call("read", { path: p, binary: true }).then(b => b === null ? null : Buffer.from(b, "base64")); }
    exists(p) { return this.call("exists", { path: p }); }
    write(p, text) { return this.call("write", { path: p, text }); }
    writeBinary(p, buffer) { return this.call("write", { path: p, base64: Buffer.from(buffer).toString("base64") }); }
    // written while Obsidian is closed (no event; found by the next scan)
    writeOffline(p, data) {
        const file = path.join(this.vaultDir, p);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, data);
    }
    // written by another app while Obsidian runs: its file watcher picks it up
    writeExternal(p, buffer) { return this.call("external", { path: p, base64: Buffer.from(buffer).toString("base64") }); }
    mkdir(p) { return this.call("mkdir", { path: p }); }
    rename(from, to) { return this.call("rename", { from, to }); }
    remove(p) { return this.call("remove", { path: p }); }
    settle(timeout) { return this.call("settle", { timeout }, (timeout || 15000) + 5000); }
    syncNow(full) { return this.call("syncNow", { full }); }
    background(hidden) { return this.call("background", { hidden }); }
    devices() { return this.call("devices"); }
    approve(id) { return this.call("approve", { id }); }
    decline(id) { return this.call("decline", { id }); }
    revoke(id) { return this.call("revoke", { id }); }
    keptCopies() { return this.call("keptCopies"); }
    panel() { return this.call("panel"); }
    listVersions(p) { return this.call("listVersions", { path: p }); }
    readVersion(p, timestamp) { return this.call("readVersion", { path: p, timestamp }); }
    restore(p, timestamp) { return this.call("restore", { path: p, timestamp }); }
    files(deleted) { return this.call("files", { deleted }); }
    index() { return this.call("index"); }

    waitState(predicate, message, timeout) {
        return waitFor(async () => {
            const s = await this.state();
            return predicate(s) ? s : null;
        }, { message: this.name + ": " + message, timeout });
    }

    // connected, approved and done with the first sync
    waitSynced(timeout) {
        return this.waitState(s => s.engine === "v2" && s.status === "synced", "synced", timeout).then(() => this.settle());
    }
}

// all devices end up with the same files (dot folders aside)
async function sameVaults(...devices) {
    const trees = await Promise.all(devices.map(d => d.tree()));
    const first = JSON.stringify(sortKeys(trees[0]));
    return trees.every(t => JSON.stringify(sortKeys(t)) === first) ? trees[0] : null;
}

function sortKeys(o) {
    return Object.keys(o).sort().reduce((r, k) => (r[k] = o[k], r), {});
}

async function settleAll(...devices) {
    for (let round = 0; round < 3; round++) {
        await Promise.all(devices.map(d => d.settle()));
        await sleep(150);
    }
}

async function waitSame(devices, timeout = 20000) {
    return waitFor(async () => {
        await settleAll(...devices);
        return sameVaults(...devices);
    }, { timeout, interval: 200, message: "vaults to match" });
}

module.exports = { Server, Device, PASSWORD, waitFor, sleep, tmp, freePort, sameVaults, settleAll, waitSame, SERVER_DIR, PLUGIN_MAIN };
