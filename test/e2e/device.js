/**
 * One device: the real plugin bundle in a fake Obsidian over a real folder.
 * Started by harness.js (child_process.fork); takes commands over IPC.
 */
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const { PLUGIN_MAIN, VAULT, PLATFORM, DEVICE_NAME } = process.env;
const fake = require("./fake-obsidian").install({ vaultDir: VAULT, platform: PLATFORM || "desktop", name: DEVICE_NAME });
const { app, vault, document, Notice } = fake;
const { TFile, TFolder } = require("./fake-obsidian");

const PLUGIN_DIR = ".obsidian/plugins/anysocket-sync";
let plugin = null;
let PluginClass = null;

process.on("unhandledRejection", (e) => {
    console.error("[device " + DEVICE_NAME + "] unhandled rejection", e);
});

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const sha = (buf) => crypto.createHash("sha256").update(buf).digest("hex");

async function ensureFolder(p) {
    const parent = p.split("/").slice(0, -1).join("/");
    if (parent && !vault.getAbstractFileByPath(parent)) {
        await vault.createFolder(parent);
    }
}

// what's in the vault: path -> sha256 (files) or "folder"
function tree() {
    const out = {};
    for (const item of vault.getAllLoadedFiles()) {
        if (item.path === "/") continue;
        out[item.path] = item instanceof TFile ? sha(fs.readFileSync(vault.abs(item.path))) : "folder";
    }
    return out;
}

function state() {
    if (!plugin) {
        return { loaded: false };
    }
    const x = plugin.xSync;
    return {
        loaded: true,
        status: x.status.state,
        info: x.status.info,
        text: x.status.shortText(),
        sentence: x.status.sentence(),
        pending: x.pendingCount(),
        attention: x.status.attention,
        protocol: x.protocol,
        engine: x.engine === x.v2 ? "v2" : x.engine === x.legacy ? "legacy" : null,
        device: x.device,
        syncing: x.v2.syncing,
        connected: x.anysocket.isConnected,
        statusBar: app.statusBar ? app.statusBar._children.map(c => c._text).join("") : "",
        activity: x.activity.items.map(i => i.type + ":" + i.path),
        version: plugin.VERSION,
        plugins: { disabled: app.plugins.disabled, enabled: app.plugins.enabled }
    };
}

function noticeTexts() {
    return Notice.all.map(n => n.text);
}

// finds a button by its label in the newest notice that has it, and presses it
function pressNoticeButton(label) {
    for (const notice of Notice.all.slice().reverse()) {
        const stack = [notice.noticeEl];
        while (stack.length) {
            const el = stack.pop();
            if (el.tagName === "button" && el._text === label) {
                el.click();
                return true;
            }
            stack.push(...el._children);
        }
    }
    return false;
}

async function load(settings) {
    if (settings) {
        const dir = path.join(VAULT, PLUGIN_DIR);
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, "data.json"), JSON.stringify(settings, null, 2));
    }
    if (!PluginClass) {
        const exported = require(path.resolve(PLUGIN_MAIN));
        PluginClass = exported.default || exported;
    }
    plugin = new PluginClass(app, { id: "anysocket-sync", dir: PLUGIN_DIR, version: "test" });
    await plugin.onload();
}

const commands = {
    async load({ settings }) {
        await load(settings);
        return state();
    },
    async unload() {
        if (plugin) {
            await plugin.onunload();
            plugin = null;
        }
        return true;
    },
    async state() {
        return state();
    },
    async notices() {
        return noticeTexts();
    },
    async press({ label }) {
        return pressNoticeButton(label);
    },
    async tree() {
        return tree();
    },
    async read({ path: p, binary }) {
        const file = vault.abs(p);
        if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) return null;
        const data = fs.readFileSync(file);
        return binary ? data.toString("base64") : data.toString("utf8");
    },
    async exists({ path: p }) {
        return !!vault.getAbstractFileByPath(p);
    },
    // as a person editing in Obsidian
    async write({ path: p, text, base64 }) {
        await ensureFolder(p);
        const data = base64 !== undefined ? Buffer.from(base64, "base64") : text;
        const existing = vault.getAbstractFileByPath(p);
        if (base64 !== undefined) {
            await vault.adapter.writeBinary(p, data);
        } else if (existing) {
            await vault.modify(existing, data);
        } else {
            await vault.create(p, data);
        }
        return true;
    },
    async mkdir({ path: p }) {
        if (!vault.getAbstractFileByPath(p)) {
            await vault.createFolder(p);
        }
        return true;
    },
    async rename({ from, to }) {
        await ensureFolder(to);
        await app.fileManager.renameFile(vault.getAbstractFileByPath(from), to);
        return true;
    },
    async remove({ path: p }) {
        const file = vault.getAbstractFileByPath(p);
        if (file) await app.fileManager.trashFile(file);
        return true;
    },
    // another app wrote the file; Obsidian's watcher notices it and fires the event
    async external({ path: p, base64 }) {
        await ensureFolder(p);
        const existed = !!vault.getAbstractFileByPath(p);
        fs.writeFileSync(vault.abs(p), Buffer.from(base64, "base64"));
        if (!existed) {
            vault.items.set(p, new TFile(vault, p));
        }
        vault.trigger(existed ? "modify" : "create", vault.getAbstractFileByPath(p));
        return true;
    },
    // waits until nothing is queued in the sync engine
    async settle({ timeout = 15000 } = {}) {
        const end = Date.now() + timeout;
        while (Date.now() < end) {
            const x = plugin && plugin.xSync;
            if (x && x.engine === x.v2) {
                await x.v2.queue;
                await sleep(50);
                if (!x.v2.syncing && x.xTimeouts && Object.keys(x.xTimeouts.timeouts).length === 0) {
                    await x.v2.queue;
                    return state();
                }
            } else {
                await sleep(50);
            }
        }
        return state();
    },
    async syncNow({ full } = {}) {
        await plugin.xSync.sync(!!full);
        return state();
    },
    async background({ hidden }) {
        document.setHidden(hidden);
        return true;
    },
    async devices() {
        return await plugin.xSync.listDevices();
    },
    async approve({ id }) {
        return await plugin.xSync.approveDevice(id);
    },
    async decline({ id }) {
        return await plugin.xSync.declineDevice(id);
    },
    async revoke({ id }) {
        return await plugin.xSync.revokeDevice(id);
    },
    async keptCopies() {
        return plugin.xSync.keptCopies();
    },
    // opens the sync panel and returns the text a person would see
    async panel() {
        plugin.openSyncPanel();
        const panel = plugin.panel;
        await panel.loadDevices();
        const out = [];
        const walk = (el) => { if (el._text) out.push(el._text); el._children.forEach(walk); };
        walk(panel.contentEl);
        panel.close();
        return out;
    },
    async listVersions({ path: p }) {
        const engine = plugin.xSync.historyEngine();
        return engine ? await engine.listVersions(p) : null;
    },
    async readVersion({ path: p, timestamp }) {
        const bytes = await plugin.xSync.historyEngine().readVersion(p, timestamp);
        return bytes ? Buffer.from(bytes).toString("base64") : null;
    },
    async restore({ path: p, timestamp }) {
        const engine = plugin.xSync.historyEngine();
        const bytes = await engine.readVersion(p, timestamp);
        await engine.restore(p, bytes);
        return true;
    },
    async files({ deleted }) {
        return await plugin.xSync.historyEngine().listFiles(!!deleted);
    },
    async index() {
        return plugin.xSync.v2.index.entries;
    },
    async exit() {
        setTimeout(() => process.exit(0), 10);
        return true;
    }
};

process.on("message", async (msg) => {
    const { id, cmd, args } = msg;
    try {
        if (!commands[cmd]) throw new Error("unknown command " + cmd);
        const result = await commands[cmd](args || {});
        process.send({ id, result });
    } catch (e) {
        process.send({ id, error: (e && (e.stack || e.message || e.error)) || String(e) });
    }
});

process.send({ ready: true });
