/**
 * Enough of Obsidian to run the real plugin bundle (main.js) in node, over a real folder.
 *
 * It reproduces what the real app does (checked against Obsidian 1.12):
 *  - adapter.write / writeBinary fire "create" / "modify" before they return
 *  - adapter.write fails when the parent folder is missing
 *  - renaming a folder fires "rename" for the folder, then for everything in it
 *  - deleting a folder fires "delete" for everything in it, the folder last
 *  - the root folder "/" is part of getAllLoadedFiles()
 */
const fs = require("fs");
const path = require("path");
const Module = require("module");

class TAbstractFile {
    constructor(vault, filePath) {
        this.vault = vault;
        this.path = filePath;
        this.name = filePath.split("/").pop();
    }
    get parent() {
        const parent = this.path.split("/").slice(0, -1).join("/");
        return this.vault.getAbstractFileByPath(parent || "/");
    }
}

class TFile extends TAbstractFile {
    // like Obsidian: a deleted file keeps its last known stat
    get stat() {
        try {
            const s = fs.statSync(this.vault.abs(this.path));
            this._stat = { mtime: Math.round(s.mtimeMs), ctime: Math.round(s.ctimeMs), size: s.size };
        } catch (e) {
            // gone: the last one we saw
        }
        return this._stat;
    }
    get basename() {
        return this.name.replace(/\.[^.]*$/, "");
    }
    get extension() {
        const dot = this.name.lastIndexOf(".");
        return dot === -1 ? "" : this.name.slice(dot + 1);
    }
}

class TFolder extends TAbstractFile {
    get children() {
        const prefix = this.path === "/" ? "" : this.path + "/";
        return [...this.vault.items.values()].filter(item =>
            item.path !== "/" && item.path.startsWith(prefix) && !item.path.slice(prefix.length).includes("/"));
    }
    isRoot() {
        return this.path === "/";
    }
}

class Events {
    constructor() {
        this.handlers = {};
    }
    on(type, fn) {
        (this.handlers[type] = this.handlers[type] || []).push(fn);
        return { type, fn };
    }
    offref(ref) {
        if (ref && this.handlers[ref.type]) {
            this.handlers[ref.type] = this.handlers[ref.type].filter(f => f !== ref.fn);
        }
    }
    trigger(type, ...args) {
        for (const fn of (this.handlers[type] || []).slice()) {
            try {
                const result = fn(...args);
                if (result && result.catch) result.catch(e => console.error("[fake-obsidian] handler", type, e));
            } catch (e) {
                console.error("[fake-obsidian] handler", type, e);
            }
        }
    }
}

const norm = (p) => {
    p = String(p).replace(/\\/g, "/").replace(/\/+/g, "/").replace(/^\/|\/$/g, "");
    return p || "/";
};

class Vault extends Events {
    constructor(root, configDir) {
        super();
        this.root = root;
        this.configDir = configDir || ".obsidian";
        this.items = new Map();
        fs.mkdirSync(root, { recursive: true });
        this.items.set("/", new TFolder(this, "/"));
        this.scan("");
        this.adapter = new Adapter(this);
    }

    abs(p) {
        return path.join(this.root, p === "/" ? "" : p);
    }

    // loads what is on disk (dot folders excluded, like Obsidian)
    scan(dir) {
        for (const entry of fs.readdirSync(this.abs(dir || "/"), { withFileTypes: true })) {
            if (entry.name.startsWith(".")) continue;
            const p = dir ? dir + "/" + entry.name : entry.name;
            if (entry.isDirectory()) {
                this.items.set(p, new TFolder(this, p));
                this.scan(p);
            } else {
                this.items.set(p, new TFile(this, p));
            }
        }
    }

    tracked(p) {
        return !p.split("/").some(part => part.startsWith("."));
    }

    getName() {
        return path.basename(this.root);
    }
    getAbstractFileByPath(p) {
        return this.items.get(norm(p)) || null;
    }
    getAllLoadedFiles() {
        return [...this.items.values()];
    }
    getFiles() {
        return [...this.items.values()].filter(i => i instanceof TFile);
    }
    getConfig() {
        return "system";
    }

    async createFolder(p) {
        p = norm(p);
        if (this.items.has(p)) {
            throw new Error("Folder already exists.");
        }
        const parts = p.split("/");
        for (let i = 1; i <= parts.length; i++) {
            const sub = parts.slice(0, i).join("/");
            if (!this.items.has(sub)) {
                fs.mkdirSync(this.abs(sub), { recursive: true });
                const folder = new TFolder(this, sub);
                this.items.set(sub, folder);
                this.trigger("create", folder);
            }
        }
        return this.items.get(p);
    }

    async create(p, data) {
        p = norm(p);
        if (this.items.has(p)) {
            throw new Error("File already exists.");
        }
        await this.adapter.write(p, data);
        return this.items.get(p);
    }

    async modify(file, data) {
        await this.adapter.write(file.path, data);
    }

    async read(file) {
        return this.adapter.read(file.path);
    }

    async rename(file, newPath) {
        newPath = norm(newPath);
        const oldPath = file.path;
        if (this.items.has(newPath)) {
            throw new Error("Destination file already exists!");
        }
        const parent = newPath.split("/").slice(0, -1).join("/");
        if (parent && !this.items.has(parent)) {
            throw new Error("Parent folder does not exist");
        }
        fs.renameSync(this.abs(oldPath), this.abs(newPath));
        // the item and everything below it move; events: the item first, then its contents
        const moved = [...this.items.values()]
            .filter(i => i.path === oldPath || i.path.startsWith(oldPath + "/"))
            .sort((a, b) => a.path.length - b.path.length);
        const renames = [];
        for (const item of moved) {
            const before = item.path;
            this.items.delete(before);
            item.path = newPath + before.slice(oldPath.length);
            item.name = item.path.split("/").pop();
            this.items.set(item.path, item);
            renames.push([item, before]);
        }
        for (const [item, before] of renames) {
            this.trigger("rename", item, before);
        }
    }

    // like fileManager.trashFile: contents first, the folder last
    async trash(file) {
        const all = [...this.items.values()].filter(i => i.path === file.path || i.path.startsWith(file.path + "/"));
        const trashDir = path.join(this.root, ".trash");
        fs.mkdirSync(trashDir, { recursive: true });
        fs.renameSync(this.abs(file.path), path.join(trashDir, file.name + "-" + Date.now() + "-" + Math.random().toString(36).slice(2)));
        const ordered = all.filter(i => i !== file).sort((a, b) => b.path.length - a.path.length);
        ordered.push(file);
        for (const item of ordered) {
            this.items.delete(item.path);
            this.trigger("delete", item);
        }
    }
}

class Adapter {
    constructor(vault) {
        this.vault = vault;
        this.basePath = vault.root;
    }

    checkParent(p) {
        const parent = path.dirname(this.vault.abs(p));
        if (!fs.existsSync(parent)) {
            const e = new Error("ENOENT: no such file or directory, open '" + this.vault.abs(p) + "'");
            e.code = "ENOENT";
            throw e;
        }
    }

    afterWrite(p, existed, options) {
        if (options && options.mtime) {
            const t = new Date(options.mtime);
            fs.utimesSync(this.vault.abs(p), t, t);
        }
        if (!this.vault.tracked(p)) {
            return;
        }
        let file = this.vault.items.get(p);
        if (!file) {
            file = new TFile(this.vault, p);
            this.vault.items.set(p, file);
        }
        this.vault.trigger(existed ? "modify" : "create", file);
    }

    async write(p, data, options) {
        p = norm(p);
        this.checkParent(p);
        const existed = this.vault.tracked(p) ? this.vault.items.has(p) : fs.existsSync(this.vault.abs(p));
        fs.writeFileSync(this.vault.abs(p), data, "utf8");
        this.afterWrite(p, existed, options);
    }

    async writeBinary(p, data, options) {
        p = norm(p);
        this.checkParent(p);
        const existed = this.vault.tracked(p) ? this.vault.items.has(p) : fs.existsSync(this.vault.abs(p));
        fs.writeFileSync(this.vault.abs(p), Buffer.from(data));
        this.afterWrite(p, existed, options);
    }

    async read(p) {
        return fs.readFileSync(this.vault.abs(norm(p)), "utf8");
    }

    async readBinary(p) {
        const b = fs.readFileSync(this.vault.abs(norm(p)));
        return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
    }

    async exists(p) {
        return fs.existsSync(this.vault.abs(norm(p)));
    }

    async remove(p) {
        fs.rmSync(this.vault.abs(norm(p)), { force: true });
    }

    async mkdir(p) {
        fs.mkdirSync(this.vault.abs(norm(p)), { recursive: true });
    }
}

class Notice {
    constructor(message, duration) {
        this.message = message || "";
        this.noticeEl = element();
        this.noticeEl._notice = this;
        Notice.all.push(this);
    }
    setMessage(message) {
        this.message = message;
        return this;
    }
    hide() {
        this.hidden = true;
    }
    // what a person would read: the message and any text added to the element
    get text() {
        return [this.message, ...collectText(this.noticeEl)].filter(Boolean).join(" ");
    }
}
Notice.all = [];

function collectText(el) {
    const out = [];
    if (el._text) out.push(el._text);
    for (const child of el._children) out.push(...collectText(child));
    return out;
}

// a tiny DOM element: enough for the plugin's status bar, notices and panels
function element(tag = "div") {
    const el = {
        tagName: tag,
        _children: [],
        _text: "",
        _attrs: {},
        _classes: new Set(),
        _listeners: {},
        style: {},
        createEl(t, o) { const c = element(t); applyOptions(c, o); this._children.push(c); return c; },
        createDiv(o) { return this.createEl("div", typeof o === "string" ? { cls: o } : o); },
        createSpan(o) { return this.createEl("span", typeof o === "string" ? { cls: o } : o); },
        setText(t) { this._text = String(t); },
        get textContent() { return this._text; },
        set textContent(t) { this._text = String(t); },
        get innerText() { return this._text; },
        set innerText(t) { this._text = String(t); },
        set innerHTML(t) { this._html = t; },
        addClass(...c) { c.forEach(x => this._classes.add(x)); },
        removeClass(...c) { c.forEach(x => this._classes.delete(x)); },
        toggleClass(c, on) { on ? this._classes.add(c) : this._classes.delete(c); },
        hasClass(c) { return this._classes.has(c); },
        setAttr(k, v) { this._attrs[k] = v; },
        getAttr(k) { return this._attrs[k]; },
        addEventListener(type, fn) { (this._listeners[type] = this._listeners[type] || []).push(fn); },
        click() { (this._listeners.click || []).forEach(fn => fn({ stopPropagation() {} })); },
        empty() { this._children = []; this._text = ""; },
        remove() { this._removed = true; },
        hide() {}, show() {},
        setDisabled(d) { this.disabled = d; },
        querySelector() { return null; }
    };
    return el;
}

function applyOptions(el, o) {
    if (!o) return;
    if (o.text) el._text = o.text;
    if (o.cls) String(o.cls).split(" ").filter(Boolean).forEach(c => el._classes.add(c));
    if (o.attr) Object.assign(el._attrs, o.attr);
}

class Plugin {
    constructor(app, manifest) {
        this.app = app;
        this.manifest = manifest;
    }
    async loadData() {
        const file = path.join(this.app.vault.root, this.manifest.dir, "data.json");
        return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : null;
    }
    async saveData(data) {
        const dir = path.join(this.app.vault.root, this.manifest.dir);
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, "data.json"), JSON.stringify(data, null, 2));
    }
    registerEvent() {}
    addCommand(command) {
        this.app.commands[command.id] = command;
    }
    addSettingTab(tab) {
        this.app.settingTab = tab;
    }
    addStatusBarItem() {
        const el = element();
        this.app.statusBar = el;
        return el;
    }
    register() {}
    registerInterval() {}
}

class Modal {
    constructor(app) {
        this.app = app;
        this.modalEl = element();
        this.titleEl = element();
        this.contentEl = element();
        this.containerEl = element();
    }
    open() { this.isOpen = true; if (this.onOpen) this.onOpen(); }
    close() { this.isOpen = false; if (this.onClose) this.onClose(); }
}

class SuggestModal extends Modal {
    setPlaceholder() {}
}

class PluginSettingTab {
    constructor(app, plugin) {
        this.app = app;
        this.plugin = plugin;
        this.containerEl = element();
    }
}

class Setting {
    constructor(el) {
        this.settingEl = element();
        this.descEl = element();
        this.nameEl = element();
    }
    setName(n) { this.nameEl.setText(n); return this; }
    setDesc(d) { this.descEl.setText(d); return this; }
    setHeading() { return this; }
    addText(cb) { cb(control()); return this; }
    addToggle(cb) { cb(control()); return this; }
    addDropdown(cb) { cb(control()); return this; }
    addButton(cb) { cb(control()); return this; }
}

function control() {
    const c = {
        inputEl: element("input"),
        value: null,
        setPlaceholder() { return c; },
        setValue(v) { c.value = v; return c; },
        getValue() { return c.value; },
        onChange(fn) { c.change = fn; return c; },
        onClick(fn) { c.click = fn; return c; },
        setButtonText() { return c; },
        addOption() { return c; },
        setDisabled() { return c; }
    };
    return c;
}

class MarkdownPreviewView {
    constructor() {}
    set(text) { this.text = text; }
    get() { return this.text; }
    applyScroll() {}
}

/**
 * Builds globals + the "obsidian" module for one device.
 * platform: "desktop" | "ios" | "android"
 */
function install({ vaultDir, platform = "desktop", name = "device" }) {
    const isMobile = platform !== "desktop";
    const vault = new Vault(vaultDir);
    const workspace = new Events();
    workspace.layoutReady = true;
    workspace.onLayoutReady = (fn) => fn();
    workspace.getLeaf = () => ({ openFile: async () => {}, view: {} });
    workspace.openLinkText = async () => {};

    // outside the vault, like Obsidian's (copying a vault folder doesn't copy it)
    const localStorageFile = vaultDir.replace(/[\/]+$/, "") + ".localStorage.json";
    const store = fs.existsSync(localStorageFile) ? JSON.parse(fs.readFileSync(localStorageFile, "utf8")) : {};
    const saveStore = () => {
        fs.mkdirSync(path.dirname(localStorageFile), { recursive: true });
        fs.writeFileSync(localStorageFile, JSON.stringify(store));
    };

    const app = {
        vault,
        workspace,
        commands: {},
        isMobile,
        fileManager: {
            trashFile: (file) => vault.trash(file),
            renameFile: (file, to) => vault.rename(file, to)
        },
        plugins: {
            disabled: 0, enabled: 0,
            disablePlugin() { this.disabled++; },
            enablePlugin() { this.enabled++; }
        },
        // per device and vault, not in the vault's files (like Obsidian's)
        loadLocalStorage: (key) => (key in store ? store[key] : null),
        saveLocalStorage: (key, value) => { store[key] = value; saveStore(); },
        setting: { open() {}, openTabById() {} },
        emulateMobile() {}
    };

    const localStorage = {
        getItem: (k) => (("ls:" + k) in store ? store["ls:" + k] : null),
        setItem: (k, v) => { store["ls:" + k] = String(v); saveStore(); },
        removeItem: (k) => { delete store["ls:" + k]; saveStore(); }
    };

    const documentListeners = {};
    const document = {
        hidden: false,
        body: element(),
        addEventListener: (type, fn) => (documentListeners[type] = documentListeners[type] || []).push(fn),
        removeEventListener: (type, fn) => { documentListeners[type] = (documentListeners[type] || []).filter(f => f !== fn); },
        querySelector: () => element(),
        createElement: (t) => element(t),
        // test hook: the app goes to the background / comes back
        setHidden(hidden) {
            this.hidden = hidden;
            (documentListeners.visibilitychange || []).forEach(fn => fn());
        }
    };

    const userAgent = {
        desktop: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) obsidian/1.12.7 Chrome/130.0 Electron/33.0 Safari/537.36",
        ios: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148",
        android: "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Mobile Safari/537.36"
    }[platform];

    global.window = globalThis;
    global.app = app;
    global.document = document;
    global.localStorage = localStorage;
    window.localStorage = localStorage;
    Object.defineProperty(globalThis, "navigator", { value: { userAgent, platform: "test" }, configurable: true });
    // a browser's WebSocket: send() coerces non-binary data to a string
    const WS = require("ws");
    global.WebSocket = class BrowserLikeWebSocket extends WS {
        // a browser's second argument is subprotocols: anything else is refused, as in Obsidian
        constructor(url, protocols) {
            // (null becomes the string "null", which a browser accepts)
            if (protocols != null && typeof protocols !== "string" && !Array.isArray(protocols)) {
                throw new SyntaxError("Failed to construct 'WebSocket': The subprotocol '" + String(protocols) + "' is invalid.");
            }
            super(url, protocols);
        }
        send(data, ...rest) {
            if (!(data instanceof ArrayBuffer || ArrayBuffer.isView(data))) data = String(data);
            return super.send(data, ...rest);
        }
    };

    const obsidian = {
        Plugin, PluginSettingTab, Setting, Notice, Modal, SuggestModal, MarkdownPreviewView,
        TAbstractFile, TFile, TFolder,
        Platform: {
            isMobile, isDesktop: !isMobile, isMobileApp: isMobile, isDesktopApp: !isMobile,
            isIosApp: platform === "ios", isAndroidApp: platform === "android",
            isWin: platform === "desktop" && process.platform === "win32",
            isMacOS: platform === "desktop" && process.platform === "darwin",
            isLinux: platform === "desktop" && process.platform === "linux",
            isTablet: false, isPhone: isMobile
        },
        normalizePath: norm,
        setIcon: (el, icon) => { if (el) el._icon = icon; },
        debounce: (fn) => fn
    };

    const original = Module._load;
    Module._load = function (request, ...rest) {
        if (request === "obsidian") return obsidian;
        // desktop Obsidian has node's os; the plugin only asks for the hostname
        if (request === "os") return { hostname: () => name };
        return original.call(this, request, ...rest);
    };

    return { app, vault, document, obsidian, Notice };
}

module.exports = { install, Notice, TFile, TFolder };
