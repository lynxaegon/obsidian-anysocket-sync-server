/**
 * Upgrading a live setup: the 1.5 production server and plugin (rebuilt from git)
 * against 1.6.0, in every order the update can happen.
 */
const test = require("node:test");
const assert = require("node:assert");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { Server, Device, waitFor, waitSame, sleep, SERVER_DIR } = require("../e2e/harness");
const { ProductionServer, productionPlugin, productionBuildInfo } = require("./production");

const OLD_PLUGIN = productionPlugin();
const NEW_BUILD = JSON.parse(fs.readFileSync(path.join(SERVER_DIR, "client", "build_info.json"), "utf8"));
const OLD_BUILD = productionBuildInfo();
const sha = (b) => crypto.createHash("sha256").update(b).digest("hex");
const pluginFile = (device, name) => path.join(device.vaultDir, ".obsidian", "plugins", "anysocket-sync", name);

// a 1.5 device: the production plugin, synced with whatever server
async function oldDevice(t, server, name, options = {}) {
    const device = new Device(t, server, Object.assign({ name, main: OLD_PLUGIN }, options));
    await device.start();
    return device;
}

// what the 1.5 plugin shows once its sync finished
const oldSynced = (device) => device.waitState(s => s.connected && /Sync completed|Connected/.test(s.statusBar || "") || s.connected, "1.5 connected");

// a device that got a plugin update pushed: Obsidian loads the new main.js
async function reloadPushedPlugin(device) {
    await device.quit();
    device.main = pluginFile(device, "main.js");
    await device.start();
}

// the old plugin's own sync status, read from the server's disk
async function storedEventually(server, p, content) {
    await waitFor(() => {
        const s = server.stored(p);
        return s && s.data && s.data.toString() === content;
    }, { message: "server has " + p, timeout: 20000 });
}

test("baseline: production as it is today (1.5 server, 1.5 plugins) syncs in this harness", async (t) => {
    const server = await new ProductionServer(t).start();
    const laptop = await oldDevice(t, server, "Laptop");
    const phone = await oldDevice(t, server, "Phone");
    await sleep(1500);
    await laptop.write("hello.md", "from the 1.5 laptop");
    await storedEventually(server, "hello.md", "from the 1.5 laptop");
    await waitFor(async () => (await phone.read("hello.md")) === "from the 1.5 laptop", { message: "phone gets it" });
});

for (const anysocket of ["0.4.27", "0.4.32"]) {
    test("the 1.6.0 plugin on a 1.5 server (anysocket " + anysocket + "): the server switches it to its own 1.5.0 build", async (t) => {
        const server = await new ProductionServer(t, { anysocket }).start();
        const device = new Device(t, server, { name: "Laptop" });
        await device.start();
        await waitFor(async () => (await device.state()).plugins.enabled === 1, { message: "plugin swapped" });
        assert.equal(fs.readFileSync(pluginFile(device, "main.js"), "utf8"), fs.readFileSync(OLD_PLUGIN, "utf8"));
        assert.match((await device.notices()).join("\n"), /older version, switched from 1\.6\.0 to 1\.5\.0/);

        // the 1.5.0 build it now runs syncs normally
        await reloadPushedPlugin(device);
        await sleep(1500);
        await device.write("a.md", "after the switch");
        await storedEventually(server, "a.md", "after the switch");
    });
}

test("the 1.6.0 plugin syncs with a 1.5 server the way 1.5.0 did (when the server doesn't switch it)", async (t) => {
    // a 1.5 server that considers this build current (so it pushes nothing): both
    // devices run 1.6.0 and sync with the 1.5.0 protocol
    const server = await new ProductionServer(t, { buildInfo: NEW_BUILD }).start();
    const modern = new Device(t, server, { name: "Laptop" });
    await modern.start();
    const s = await modern.waitState(s => s.engine === "legacy", "legacy engine");
    assert.equal(s.protocol, 1);
    const old = new Device(t, server, { name: "Phone" });
    await old.start();
    await old.waitState(s => s.engine === "legacy", "legacy engine");

    const image = crypto.randomBytes(100 * 1024);
    await modern.write("Notes/from 1.6.md", "written by 1.6.0");
    await modern.writeBinary("pic.png", image);
    await old.write("from 1.5.md", "written by 1.5.0");
    await waitFor(async () => (await old.read("Notes/from 1.6.md")) === "written by 1.6.0" &&
        (await modern.read("from 1.5.md")) === "written by 1.5.0", { message: "both ways", timeout: 30000 });
    await waitFor(async () => { const b = await old.readBinary("pic.png"); return b && b.equals(image); }, { message: "binary" });

    await modern.rename("Notes/from 1.6.md", "Notes/renamed.md");
    await waitFor(async () => (await old.exists("Notes/renamed.md")) && !(await old.exists("Notes/from 1.6.md")), { message: "rename", timeout: 30000 });
    await old.remove("from 1.5.md");
    await waitFor(async () => !(await modern.exists("from 1.5.md")), { message: "delete", timeout: 30000 });

    // the panel explains why there are no devices to manage
    assert.match((await modern.panel()).join("\n"), /Update your server to 1\.6\.0 to manage devices\./);
});

test("the upgrade itself: a live 1.5 setup moves to 1.6.0 without losing or duplicating anything", async (t) => {
    // 1. today: a 1.5 server and two 1.5 devices with a vault
    const old = await new ProductionServer(t).start();
    const laptop = await oldDevice(t, old, "Laptop");
    const phone = await oldDevice(t, old, "Phone");
    await sleep(1500);
    const image = crypto.randomBytes(50 * 1024);
    await laptop.write("Journal/2026-10-26.md", "a day");
    await laptop.writeBinary("Attachments/scan.png", image);
    await phone.write("Ideas.md", "an idea from the phone");
    await laptop.write("Journal/2026-10-25.md", "the day before");
    await storedEventually(old, "Ideas.md", "an idea from the phone");
    await storedEventually(old, "Journal/2026-10-25.md", "the day before");
    await waitFor(async () => (await phone.exists("Journal/2026-10-25.md")) && (await laptop.exists("Ideas.md")), { message: "1.5 in sync", timeout: 30000 });
    const before = await waitSame([laptop, phone]);
    await laptop.quit();
    await phone.quit();
    await old.stop();

    // 2. the server is replaced by 1.6.0, on the same data
    const server = await new Server(t, { dataDir: old.dataDir }).start();
    assert.match(server.logs, /Backing up data before running 1\.6\.0/);

    // 3. the 1.5 plugins connect, are updated, and come back as 1.6.0
    for (const device of [laptop, phone]) {
        device.server = server;
        device.settings.port = String(server.port);
        await device.start();
        await waitFor(async () => (await device.state()).plugins.enabled === 1, { message: device.name + " updated" });
        assert.equal(fs.readFileSync(pluginFile(device, "main.js"), "utf8"), fs.readFileSync(path.join(SERVER_DIR, "client", "main.js"), "utf8"));
        // 1.5.0 says it, right before Obsidian loads the new version
        await waitFor(async () => (await device.notices()).some(n => /Updated to version: 1\.6\.0/.test(n)), { message: "update notice" });
        await reloadPushedPlugin(device);
    }
    // devices that synced with the old server recently are approved on their own
    await laptop.waitSynced();
    await phone.waitSynced();

    const after = await waitSame([laptop, phone]);
    assert.deepEqual(after, before, "the same files, nothing lost, nothing duplicated");
    for (const device of [laptop, phone]) {
        const uploads = (await device.state()).activity.filter(a => a.startsWith("uploaded:") || a.startsWith("kept_both:"));
        assert.deepEqual(uploads, [], device.name + " re-sent nothing");
    }

    // 4. and it keeps working
    await phone.write("Ideas.md", "an idea from the phone, edited after the upgrade");
    await waitFor(async () => (await laptop.read("Ideas.md")) === "an idea from the phone, edited after the upgrade", { message: "sync after upgrade" });
});

test("rolling the server back to 1.5 on data written by 1.6.0 still works", async (t) => {
    const server = await new Server(t).start();
    const laptop = new Device(t, server, { name: "Laptop" });
    await laptop.start();
    await laptop.waitSynced();
    await laptop.write("a.md", "v1");
    await laptop.settle();
    await laptop.write("a.md", "v2");
    await laptop.writeBinary("b.png", Buffer.from([1, 2, 3]));
    await laptop.rename("a.md", "Folder/a.md");
    await laptop.settle();
    await laptop.quit();
    await server.stop();

    const old = await new ProductionServer(t, { dataDir: server.dataDir }).start();
    const phone = await oldDevice(t, old, "Phone");
    await waitFor(async () => (await phone.read("Folder/a.md")) === "v2", { message: "1.5 reads 1.6 data", timeout: 30000 });
    const b = await phone.readBinary("b.png");
    assert.ok(b && b.equals(Buffer.from([1, 2, 3])));
    assert.equal(await phone.exists("a.md"), false);
});

test("a delete the 1.5 plugin had queued but not sent is not undone by the upgrade", async (t) => {
    const old = await new ProductionServer(t).start();
    const laptop = await oldDevice(t, old, "Laptop");
    await sleep(1500);
    await laptop.write("old note.md", "to be deleted");
    await storedEventually(old, "old note.md", "to be deleted");
    await laptop.quit();
    await old.stop();

    // deleted, and queued by 1.5 in its sync-delete-queue.json, but never sent
    const stored = old.stored("old note.md");
    fs.rmSync(path.join(laptop.vaultDir, "old note.md"));
    fs.writeFileSync(pluginFile(laptop, "sync-delete-queue.json"), JSON.stringify({
        "old note.md": {
            action: "delete",
            path: "old note.md",
            metadata: { action: "deleted", sha1: stored.meta.sha1, mtime: Date.now(), type: "file" },
            timestamp: Date.now()
        }
    }, null, 2));

    // the server is upgraded and the plugin updated before the delete was ever sent
    const server = await new Server(t, { dataDir: old.dataDir }).start();
    laptop.server = server;
    laptop.settings.port = String(server.port);
    laptop.main = path.join(SERVER_DIR, "client", "main.js");
    await laptop.start();
    await laptop.waitSynced();
    await sleep(500);
    assert.equal(await laptop.exists("old note.md"), false, "not brought back");
    assert.equal(server.stored("old note.md").meta.action, "deleted");
});
