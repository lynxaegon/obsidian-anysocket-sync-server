/**
 * The production baseline, rebuilt from git: the 1.5.x server (as deployed) and the
 * 1.5.0 plugin bundle it serves. Installed once into the OS temp dir and reused.
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const net = require("net");
const { execFileSync, spawn } = require("child_process");
const { Server, waitFor, tmp, freePort, SERVER_DIR, PASSWORD } = require("../e2e/harness");

// the server commit production runs, and the plugin build it ships
const PRODUCTION_COMMIT = process.env.PRODUCTION_COMMIT || "5189d97";
const CACHE = path.join(os.tmpdir(), "anysocket-sync-compat-cache");

const git = (...args) => execFileSync("git", ["-c", "safe.directory=*", "-C", SERVER_DIR, ...args]);

// the 1.5 server at PRODUCTION_COMMIT with a given anysocket 0.4.x, installed once
function productionServerDir(anysocketVersion = "0.4.27") {
    const dir = path.join(CACHE, "server-" + PRODUCTION_COMMIT + "-anysocket-" + anysocketVersion);
    if (fs.existsSync(path.join(dir, ".ready"))) {
        return dir;
    }
    // a leftover from an interrupted build
    if (fs.existsSync(dir)) {
        fs.rmSync(dir, { recursive: true, force: true });
    }
    // built aside and renamed into place, so tests running in parallel never see half of it
    const building = dir + ".building-" + process.pid + "-" + Date.now();
    fs.mkdirSync(building, { recursive: true });
    const files = git("ls-tree", "-r", "--name-only", PRODUCTION_COMMIT, "--", "index.js", "libs", "client", "config.example.js", "package.json")
        .toString().split("\n").map(f => f.trim()).filter(Boolean);
    for (const file of files) {
        const target = path.join(building, file);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, git("show", PRODUCTION_COMMIT + ":" + file));
    }
    execFileSync(process.platform === "win32" ? "npm.cmd" : "npm",
        ["install", "--no-audit", "--no-fund", "--no-save", "anysocket@" + anysocketVersion, "node-cron@3"],
        { cwd: building, stdio: "ignore", shell: process.platform === "win32" });
    fs.writeFileSync(path.join(building, ".ready"), new Date().toISOString());
    try {
        fs.renameSync(building, dir);
    } catch (e) {
        // another test got there first
        fs.rmSync(building, { recursive: true, force: true });
        if (!fs.existsSync(path.join(dir, ".ready"))) {
            throw new Error("could not prepare " + dir + ": " + e.message);
        }
    }
    if (!fs.existsSync(path.join(dir, "node_modules", "anysocket", "package.json"))) {
        throw new Error("npm install of anysocket@" + anysocketVersion + " failed in " + dir);
    }
    return dir;
}

// the 1.5.0 plugin bundle the production server pushes to devices
function productionPlugin() {
    const file = path.join(CACHE, "plugin-" + PRODUCTION_COMMIT + ".js");
    if (!fs.existsSync(file)) {
        fs.mkdirSync(CACHE, { recursive: true });
        fs.writeFileSync(file, git("show", PRODUCTION_COMMIT + ":client/main.js"));
    }
    return file;
}

function productionBuildInfo() {
    return JSON.parse(git("show", PRODUCTION_COMMIT + ":client/build_info.json").toString());
}

function portOpen(port) {
    return new Promise((resolve) => {
        const socket = net.connect(port, "127.0.0.1");
        socket.on("connect", () => { socket.destroy(); resolve(true); });
        socket.on("error", () => resolve(false));
    });
}

/**
 * The 1.5 server: it reads ./config.js and keeps its data in ./data, so every
 * instance runs from its own copy. `dataDir` (optional) is used as its ./data.
 */
class ProductionServer {
    constructor(t, { anysocket = "0.4.27", dataDir, buildInfo } = {}) {
        this.t = t;
        this.base = productionServerDir(anysocket);
        this.dir = tmp("prod-server");
        fs.cpSync(this.base, this.dir, { recursive: true });
        this.dataDir = dataDir || path.join(this.dir, "data");
        if (buildInfo) {
            fs.writeFileSync(path.join(this.dir, "client", "build_info.json"), JSON.stringify(buildInfo));
        }
        this.logs = "";
        t.after(() => this.stop(true));
    }

    async start() {
        if (!this.port) this.port = await freePort();
        if (this.dataDir !== path.join(this.dir, "data")) {
            // 1.5 has no setting for the data folder: link it
            fs.rmSync(path.join(this.dir, "data"), { recursive: true, force: true });
            fs.symlinkSync(this.dataDir, path.join(this.dir, "data"), "junction");
        }
        fs.writeFileSync(path.join(this.dir, "config.js"), "module.exports = " + JSON.stringify({
            password: PASSWORD, host: "127.0.0.1", port: this.port, logs: { level: 2 },
            cleanup: { schedule: "0 0 1 1 *", versions_per_file: 1000, keep_deleted_files_time: 259200 }
        }) + ";");
        this.proc = spawn(process.execPath, ["index.js"], { cwd: this.dir });
        this.proc.stdout.on("data", d => this.logs += d);
        this.proc.stderr.on("data", d => this.logs += d);
        this.exited = false;
        this.proc.on("exit", () => this.exited = true);
        await waitFor(async () => this.exited || await portOpen(this.port), { message: "1.5 server start" });
        if (this.exited) throw new Error("1.5 server exited:\n" + this.logs);
        return this;
    }

    async stop(cleanup) {
        if (this.proc && !this.exited) {
            this.proc.kill();
            await waitFor(() => this.exited, { timeout: 5000, message: "stop" }).catch(() => {});
        }
        if (cleanup) {
            try { fs.unlinkSync(path.join(this.dir, "data")); } catch (e) {}
            fs.rmSync(this.dir, { recursive: true, force: true });
        }
    }

    stored(p) {
        return Server.prototype.stored.call(this, p);
    }
}

module.exports = { ProductionServer, productionPlugin, productionBuildInfo, productionServerDir, PRODUCTION_COMMIT };
