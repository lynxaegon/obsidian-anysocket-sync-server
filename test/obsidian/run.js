#!/usr/bin/env node
/**
 * The real Obsidian app, end to end: two isolated Obsidian instances (a desktop, and one in
 * Obsidian's mobile emulation) with throwaway vaults, the release build of the plugin, and a
 * local 1.6.0 server. Driven over the Chrome DevTools protocol; screenshots go to OUT.
 *
 *   OBSIDIAN_BIN="C:\Program Files\Obsidian\Obsidian.exe" node test/obsidian/run.js
 *
 * Isolation: each instance gets its own APPDATA, --user-data-dir and vault list (only its
 * throwaway vault), so your own vaults are never listed, opened or touched. The run aborts
 * if Obsidian opens anything outside its temp folder.
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const crypto = require("crypto");
const { spawn } = require("child_process");
const WS = require("ws");
const { Server, waitFor, sleep, PASSWORD } = require("../e2e/harness");

const OBSIDIAN = process.env.OBSIDIAN_BIN;
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "anysocket-obsidian-"));
const OUT = process.env.OUT || path.join(ROOT, "screenshots");
const CLIENT = path.join(__dirname, "..", "..", "client");
fs.mkdirSync(OUT, { recursive: true });

const results = [];
function check(name, ok, extra) {
    results.push({ name, ok: !!ok });
    console.log((ok ? "  PASS " : "  FAIL ") + name + (extra ? "  (" + extra + ")" : ""));
}

// ---- Chrome DevTools protocol ----

function getJSON(url) {
    return new Promise((resolve, reject) => {
        http.get(url, (res) => { let s = ""; res.on("data", d => s += d); res.on("end", () => { try { resolve(JSON.parse(s)); } catch (e) { reject(e); } }); }).on("error", reject);
    });
}

async function page(port) {
    const targets = await waitFor(async () => {
        try {
            const list = await getJSON("http://127.0.0.1:" + port + "/json");
            return list.find(t => t.type === "page" && /app:\/\/obsidian\.md/.test(t.url)) || null;
        } catch (e) {
            return null;
        }
    }, { timeout: 60000, message: "obsidian window on " + port });
    return targets.webSocketDebuggerUrl;
}

async function cdp(port, method, params = {}) {
    const ws = new WS(await page(port), { perMessageDeflate: false });
    await new Promise((resolve, reject) => { ws.on("open", resolve); ws.on("error", reject); });
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { ws.close(); reject(new Error(method + " timed out")); }, 120000);
        ws.on("message", (m) => {
            const msg = JSON.parse(m);
            if (msg.id !== 1) return;
            clearTimeout(timer);
            ws.close();
            msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
        });
        ws.send(JSON.stringify({ id: 1, method, params }));
    });
}

// runs an async function body inside Obsidian and returns its value
async function run(port, body) {
    const result = await cdp(port, "Runtime.evaluate", {
        expression: "(async () => { " + body + " })()",
        awaitPromise: true,
        returnByValue: true
    });
    if (result.exceptionDetails) {
        throw new Error((result.exceptionDetails.exception && result.exceptionDetails.exception.description) || result.exceptionDetails.text);
    }
    return result.result.value;
}

async function screenshot(port, name) {
    const shot = await cdp(port, "Page.captureScreenshot", { format: "png" });
    const file = path.join(OUT, name + ".png");
    fs.writeFileSync(file, Buffer.from(shot.data, "base64"));
    return file;
}

// ---- Obsidian instances ----

class Instance {
    constructor(name, port, server) {
        this.name = name;
        this.port = port;
        this.server = server;
        this.dir = path.join(ROOT, name);
        this.vault = path.join(this.dir, "vault");
        this.appdata = path.join(this.dir, "appdata");
    }

    install(settings) {
        const plugin = path.join(this.vault, ".obsidian", "plugins", "anysocket-sync");
        fs.mkdirSync(plugin, { recursive: true });
        for (const f of ["main.js", "manifest.json", "styles.css"]) {
            fs.copyFileSync(path.join(CLIENT, f), path.join(plugin, f));
        }
        fs.writeFileSync(path.join(plugin, "data.json"), JSON.stringify(Object.assign({
            host: "127.0.0.1", port: String(this.server.port), password: PASSWORD, syncEnabled: true,
            delayedSync: 0, autoSync: true, notifications: 1, deviceName: this.name, debug: false
        }, settings)));
        fs.writeFileSync(path.join(this.vault, ".obsidian", "community-plugins.json"), JSON.stringify(["anysocket-sync"]));
        // the only vault this instance knows
        fs.mkdirSync(path.join(this.appdata, "obsidian"), { recursive: true });
        fs.writeFileSync(path.join(this.appdata, "obsidian", "obsidian.json"), JSON.stringify({
            vaults: { ["test" + crypto.randomBytes(6).toString("hex")]: { path: this.vault, ts: Date.now(), open: true } }
        }));
    }

    async launch() {
        this.proc = spawn(OBSIDIAN, ["--user-data-dir=" + path.join(this.appdata, "obsidian"), "--remote-debugging-port=" + this.port], {
            env: Object.assign({}, process.env, { APPDATA: this.appdata }),
            stdio: "ignore"
        });
        await sleep(2000);
        await this.run("await new Promise(r => app.workspace.onLayoutReady(r)); return true;");
        // isolation guard: this must be our throwaway vault, nothing else
        const opened = await this.run("return app.vault.adapter.basePath;");
        if (path.resolve(opened) !== path.resolve(this.vault)) {
            this.kill();
            throw new Error("ABORT: " + this.name + " opened " + opened + ", not its test vault");
        }
        const known = await this.run("return Object.values(require('electron').ipcRenderer.sendSync('vault-list')).map(v => v.path);");
        if (known.some(p => !path.resolve(p).startsWith(path.resolve(ROOT)))) {
            this.kill();
            throw new Error("ABORT: " + this.name + " knows vaults outside the test folder");
        }
    }

    // community plugins on (a new vault starts in restricted mode), which loads ours, exactly once
    async enablePlugin() {
        await this.run(`
            if (!window.__errors) {
                window.__errors = [];
                const original = console.error;
                console.error = (...args) => {
                    window.__errors.push(args.map(a => a && (a.stack || a.message) || String(a)).join(" "));
                    original(...args);
                };
            }
            return true;
        `);
        // as a person does it: "Trust author and enable plugins" in the dialog a new vault with plugins
        // shows. That loads the vault's enabled plugins (ours); doing anything else on top of it
        // (setEnable, enablePlugin) would load a second instance, which no real user has.
        await this.run(`
            const trust = [...document.querySelectorAll(".modal button")].find(b => /Trust author/.test(b.textContent));
            if (trust) {
                trust.click();
            } else if (!app.plugins.isEnabled()) {
                await app.plugins.setEnable(true);
            }
            for (let i = 0; i < 50 && !app.plugins.plugins["anysocket-sync"]; i++) {
                await new Promise(r => setTimeout(r, 100));
            }
            if (!app.plugins.plugins["anysocket-sync"]) {
                await app.plugins.loadManifests();
                await app.plugins.enablePluginAndSave("anysocket-sync");
            }
            return !!app.plugins.plugins["anysocket-sync"];
        `);
    }

    run(body) { return run(this.port, body); }
    shot(name) { return screenshot(this.port, this.name + "-" + name); }

    state() {
        return this.run(`
            const p = app.plugins.plugins["anysocket-sync"];
            if (!p) return { loaded: false };
            const x = p.xSync;
            return {
                loaded: true, status: x.status.state, text: x.status.shortText(), engine: x.engine === x.v2 ? "v2" : (x.engine ? "legacy" : null),
                device: x.device, attention: x.status.attention, mobile: app.isMobile,
                statusBar: (document.querySelector(".anysocket-status") || {}).textContent || "",
                indicator: !!document.querySelector(".anysocket-mobile-indicator"),
                notices: [...document.querySelectorAll(".notice")].map(n => n.textContent)
            };
        `);
    }

    waitState(pred, message, timeout = 30000) {
        return waitFor(async () => { const s = await this.state(); return pred(s) ? s : null; }, { timeout, message: this.name + ": " + message });
    }

    read(p) {
        const f = path.join(this.vault, p);
        return fs.existsSync(f) ? fs.readFileSync(f) : null;
    }

    kill() {
        if (this.proc) this.proc.kill();
    }
}

async function main() {
    if (!OBSIDIAN || !fs.existsSync(OBSIDIAN)) {
        console.log("Set OBSIDIAN_BIN to the Obsidian executable to run the real-app tests.");
        process.exit(0);
    }
    console.log("Test folder:", ROOT);
    const t = { after: (fn) => cleanups.push(fn) };
    const cleanups = [];
    const server = await new Server(t, { config: { logs: { level: 2 } } }).start();
    const desktop = new Instance("Desktop", 9341, server);
    const phone = new Instance("Phone", 9342, server);

    try {
        // ---- first device ----
        console.log("\n=== desktop: first device");
        desktop.install();
        await desktop.launch();
        await desktop.enablePlugin();
        let s = await desktop.waitState(s => s.status === "synced", "synced");
        check("desktop: approved as the first device and synced", s.device && s.device.status === "approved" && s.engine === "v2");
        check("desktop: status bar reads \"Synced\"", /Synced/.test(s.statusBar), s.statusBar);
        await desktop.shot("01-synced");

        // ---- a phone (Obsidian's mobile emulation) asks to join ----
        console.log("\n=== phone (mobile emulation): approval");
        phone.install();
        await phone.launch();
        await phone.run("app.emulateMobile(true); return true;");
        await sleep(4000);
        await phone.run("await new Promise(r => app.workspace.onLayoutReady(r)); return true;");
        await phone.enablePlugin();
        s = await phone.waitState(s => s.status === "waiting_approval", "waiting for approval");
        check("phone: runs in mobile mode", s.mobile === true);
        check("phone: shows the floating indicator", s.indicator === true);
        check("phone: explains it is waiting for approval", s.notices.some(n => /is waiting to be approved/.test(n)), s.notices.join(" | "));
        await phone.shot("02-waiting");

        await waitFor(async () => (await desktop.state()).notices.some(n => /wants to sync with this vault/.test(n)), { message: "approval request on the desktop" });
        await desktop.shot("03-approval-request");
        const clicked = await desktop.run(`
            const button = [...document.querySelectorAll(".notice button")].find(b => b.textContent === "Approve");
            if (!button) return false;
            button.click();
            return true;
        `);
        check("desktop: the Approve button in the notice works", clicked);
        s = await phone.waitState(s => s.status === "synced", "synced after approval", 40000);
        check("phone: syncs once approved", s.engine === "v2");

        // ---- files ----
        console.log("\n=== files");
        const image = crypto.randomBytes(200 * 1024);
        await desktop.run(`
            await app.vault.createFolder("Notes").catch(() => {});
            await app.vault.create("Notes/Groceries.md", "# Groceries\\n\\n- milk\\n- bread\\n- eggs\\n");
            await app.vault.createBinary("Notes/photo.png", new Uint8Array([${[...image].join(",")}]).buffer);
            return true;
        `);
        await waitFor(() => phone.read("Notes/Groceries.md") && phone.read("Notes/photo.png"), { message: "files on the phone" });
        check("phone: got the note", phone.read("Notes/Groceries.md").toString() === "# Groceries\n\n- milk\n- bread\n- eggs\n");
        check("phone: got the image, byte for byte", phone.read("Notes/photo.png").equals(image));

        // ---- typing on the phone while the desktop edits another line ----
        console.log("\n=== editing at the same time, different lines");
        await phone.run(`
            const leaf = app.workspace.getLeaf(true);
            await leaf.openFile(app.vault.getAbstractFileByPath("Notes/Groceries.md"));
            window.__leaf = leaf;
            leaf.view.editor.replaceRange("- butter (typed on the phone)\\n", { line: 5, ch: 0 });
            return true;
        `);
        await desktop.run(`
            const file = app.vault.getAbstractFileByPath("Notes/Groceries.md");
            await app.vault.process(file, (text) => text.replace("- milk", "- oat milk (desktop)"));
            return true;
        `);
        await waitFor(() => {
            const a = desktop.read("Notes/Groceries.md"), b = phone.read("Notes/Groceries.md");
            return a && b && a.equals(b) && /oat milk/.test(a) && /butter/.test(a);
        }, { timeout: 40000, message: "both edits everywhere" });
        const merged = desktop.read("Notes/Groceries.md").toString();
        check("both edits are kept, on both devices", /oat milk \(desktop\)/.test(merged) && /butter \(typed on the phone\)/.test(merged), JSON.stringify(merged));
        const editor = await phone.run("return window.__leaf.view.editor.getValue();");
        check("phone: the open editor shows both edits", /oat milk/.test(editor) && /butter/.test(editor));
        await phone.shot("04-editor-merged");

        // ---- the same line on both: both versions kept ----
        console.log("\n=== the same line changed on both devices");
        await phone.run(`await app.plugins.disablePlugin("anysocket-sync"); return true;`);
        await desktop.run(`
            await app.vault.modify(app.vault.getAbstractFileByPath("Notes/Groceries.md"), "# Groceries\\n\\nDinner: pasta (desktop)\\n");
            return true;
        `);
        await sleep(1500);
        await phone.run(`
            window.__leaf && window.__leaf.detach();
            await app.vault.modify(app.vault.getAbstractFileByPath("Notes/Groceries.md"), "# Groceries\\n\\nDinner: soup (phone)\\n");
            await app.plugins.enablePlugin("anysocket-sync");
            return true;
        `);
        s = await phone.waitState(s => s.attention === 1, "one file to review", 40000);
        check("phone: tells you plainly that both versions were kept", s.notices.some(n => /was changed on two devices at the same time\. Both versions were kept, nothing was lost\./.test(n)), s.notices.join(" | "));
        check("phone: no jargon", !s.notices.some(n => /conflict|merge/i.test(n)));
        await phone.shot("05-both-kept-notice");
        await desktop.waitState(s => s.attention === 1, "desktop sees it too", 40000);
        await desktop.run(`app.commands.executeCommandById("anysocket-sync:open-sync-panel"); return true;`);
        await sleep(800);
        const panelText = await desktop.run(`return (document.querySelector(".anysocket-panel") || {}).textContent || "";`);
        check("panel: \"Needs your attention\" with both files named", /Needs your attention/.test(panelText) && /Groceries\.md was changed on two devices/.test(panelText), panelText.slice(0, 200));
        check("panel: lists both devices", /Desktop \(this device\)/.test(panelText) && /Phone/.test(panelText));
        await desktop.shot("06-sync-panel");
        await desktop.run(`
            const done = [...document.querySelectorAll(".anysocket-panel button")].find(b => b.textContent === "Done, remove the copy");
            done.click();
            return true;
        `);
        await phone.waitState(s => s.attention === 0, "cleared everywhere", 40000);
        check("removing the extra copy clears it on every device", true);
        await desktop.run(`document.querySelector(".anysocket-panel .modal-close-button")?.click(); return true;`);

        // ---- folder rename ----
        console.log("\n=== renaming a folder");
        await desktop.run(`await app.vault.createFolder("Archive").catch(() => {}); await app.fileManager.renameFile(app.vault.getAbstractFileByPath("Notes"), "Archive/Notes 2026"); return true;`);
        await waitFor(() => phone.read("Archive/Notes 2026/photo.png") && !phone.read("Notes/photo.png"), { timeout: 40000, message: "renamed on the phone" });
        check("phone: the folder was renamed, files intact", phone.read("Archive/Notes 2026/photo.png").equals(image));

        // ---- settings ----
        await desktop.run(`app.setting.open(); app.setting.openTabById("anysocket-sync"); return true;`);
        await sleep(800);
        await desktop.shot("07-settings");
        const settingsText = await desktop.run(`return document.querySelector(".anysocket-settings").textContent;`);
        check("settings: plain status line and the new options", /Everything is up to date/.test(settingsText) && /Largest file to sync/.test(settingsText) && /Test connection/.test(settingsText));
        await desktop.run(`
            const button = [...document.querySelectorAll(".anysocket-settings button")].find(b => b.textContent === "Test");
            button.click();
            return true;
        `);
        await sleep(2500);
        const testResult = await desktop.run(`return [...document.querySelectorAll(".anysocket-settings .setting-item")].find(e => /Test connection/.test(e.textContent)).textContent;`);
        check("settings: \"Test\" reports an encrypted connection", /Connected, encrypted/.test(testResult), testResult);
        await desktop.shot("08-test-connection");
        await desktop.run(`app.setting.close(); return true;`);
        await phone.shot("09-phone-final");
    } catch (e) {
        check("run finished without an error", false, e.message);
        console.log("Server log:\n" + server.logs.split("\n").filter(l => /SYNC|Device|Approved/.test(l)).slice(-25).join("\n"));
        for (const instance of [desktop, phone]) {
            try {
                const files = await instance.run(`return Promise.all(app.vault.getFiles().filter(f => /Groceries/.test(f.path)).map(async f => f.path + " = " + JSON.stringify(await app.vault.read(f))));`);
                console.log(instance.name + " files:\n  " + files.join("\n  "));
                const activity = await instance.run(`return app.plugins.plugins["anysocket-sync"].xSync.activity.items.slice(0, 8).map(i => i.type + ":" + i.path);`);
                console.log(instance.name + " activity: " + activity.join(", "));
            } catch (x) {}
            try {
                const errors = await instance.run("return (window.__errors || []).slice(-8);");
                console.log(instance.name + " errors:\n" + errors.join("\n"));
            } catch (x) {}
        }
        try { await desktop.shot("error"); await phone.shot("error"); } catch (x) {}
    } finally {
        desktop.kill();
        phone.kill();
        await sleep(1500);
        for (const fn of cleanups) await fn();
    }

    const failed = results.filter(r => !r.ok);
    console.log("\n" + (results.length - failed.length) + "/" + results.length + " passed. Screenshots: " + OUT);
    process.exit(failed.length ? 1 : 0);
}

if (require.main === module) {
    main();
}

module.exports = { Instance, Server, waitFor, sleep, run, screenshot, ROOT };
