const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const { Server, Device, waitFor, waitSame, sleep, tmp } = require("./harness");

async function laptopOnly(t, serverOptions) {
    const server = await new Server(t, serverOptions).start();
    const laptop = new Device(t, server, { name: "Laptop" });
    await laptop.start();
    await laptop.waitSynced();
    return { server, laptop };
}

test("a new device waits for approval, and nothing is exchanged until then", async (t) => {
    const { server, laptop } = await laptopOnly(t);
    await laptop.write("private.md", "only for approved devices");
    await laptop.settle();

    const stranger = new Device(t, server, { name: "Unknown laptop" });
    await stranger.writeOffline("theirs.md", "from a device nobody approved");
    await stranger.start();
    const s = await stranger.waitState(s => s.status === "waiting_approval", "waiting");
    assert.equal(s.text, "Waiting for approval");
    assert.match(s.sentence, /needs to be approved/);
    assert.match((await stranger.notices()).join("\n"), /"Unknown laptop" is waiting to be approved/);
    assert.match((await stranger.notices()).join("\n"), /node cli\.js devices approve "Unknown laptop"/);

    await sleep(1500);
    assert.equal(await stranger.exists("private.md"), false, "nothing downloaded");
    assert.equal(server.stored("theirs.md"), null, "nothing uploaded");
});

test("approving from another device's notice", async (t) => {
    const { server, laptop } = await laptopOnly(t);
    await laptop.write("a.md", "hello");
    await laptop.settle();

    const phone = new Device(t, server, { name: "Phone", platform: "ios" });
    await phone.start();
    await phone.waitState(s => s.status === "waiting_approval", "waiting");

    // the laptop is asked, in plain words
    await waitFor(async () => (await laptop.notices()).some(n => /"Phone" wants to sync with this vault\. Is this your device\?/.test(n)), { message: "request notice" });
    assert.equal(await laptop.press("Approve"), true);

    await phone.waitSynced();
    assert.equal(await phone.read("a.md"), "hello");
    assert.match((await phone.notices()).join("\n"), /this device was approved, syncing now/);
});

test("approving from the sync panel, and the panel's device list", async (t) => {
    const { server, laptop } = await laptopOnly(t);
    const phone = new Device(t, server, { name: "Phone" });
    await phone.start();
    await phone.waitState(s => s.status === "waiting_approval", "waiting");

    const panel = (await laptop.panel()).join("\n");
    assert.match(panel, /Laptop \(this device\)/);
    assert.match(panel, /Phone/);
    assert.match(panel, /Wants to sync with this vault\. Approve it only if it's your device\./);

    const pending = (await laptop.devices()).find(d => d.name === "Phone");
    assert.equal(pending.status, "pending");
    assert.equal(pending.online, true);
    await laptop.approve(pending.id);
    await phone.waitSynced();
    assert.equal((await laptop.devices()).find(d => d.name === "Phone").status, "approved");
});

test("approving on the server with the CLI", async (t) => {
    const { server } = await laptopOnly(t);
    const phone = new Device(t, server, { name: "My Phone" });
    await phone.start();
    await phone.waitState(s => s.status === "waiting_approval", "waiting");

    const list = server.cli("devices");
    assert.match(list, /WAITING\s+My Phone/);
    assert.match(list, /APPROVED\s+Laptop/);
    assert.match(list, /Approve with: node cli\.js devices approve "My Phone"/);

    assert.match(server.cli("devices", "approve", "my phone"), /Approved: My Phone/);
    await phone.waitSynced();
    assert.match(server.cli("devices", "approve", "nobody"), /Error: No device "nobody"/);
    assert.match(server.cli("bogus"), /Usage:/);
});

test("declining: the device stops asking, and asks again after a restart", async (t) => {
    const { server, laptop } = await laptopOnly(t);
    const phone = new Device(t, server, { name: "Phone" });
    await phone.start();
    await phone.waitState(s => s.status === "waiting_approval", "waiting");
    const id = (await laptop.devices()).find(d => d.name === "Phone").id;
    await laptop.decline(id);
    assert.equal((await laptop.devices()).find(d => d.name === "Phone"), undefined);

    const s = await phone.waitState(s => s.status === "revoked", "declined");
    assert.equal(s.text, "Request declined");
    assert.match((await phone.notices()).join("\n"), /request to sync was declined/);
    // no new request while it runs (no prompt storm on the other devices)
    await sleep(3000);
    assert.equal((await laptop.devices()).find(d => d.name === "Phone"), undefined);

    await phone.quit();
    await phone.start();
    await phone.waitState(s => s.status === "waiting_approval", "asks again");
    await waitFor(async () => (await laptop.devices()).some(d => d.name === "Phone" && d.status === "pending"), { message: "asks again" });
});

test("removing a device stops it syncing, without a reconnect storm", async (t) => {
    const { server, laptop } = await laptopOnly(t);
    const phone = new Device(t, server, { name: "Phone" });
    await phone.start();
    await phone.waitState(s => s.status === "waiting_approval", "waiting");
    server.cli("devices", "approve", "Phone");
    await phone.waitSynced();

    const id = (await laptop.devices()).find(d => d.name === "Phone").id;
    await laptop.revoke(id);
    const s = await phone.waitState(s => s.status === "revoked", "removed");
    assert.equal(s.text, "Device removed");
    assert.match((await phone.notices()).join("\n"), /this device was removed from sync/);

    await laptop.write("after.md", "the phone must not get this");
    await laptop.settle();
    const connections = (server.logs.match(/\] Connected/g) || []).length;
    await sleep(4000);
    assert.equal((server.logs.match(/\] Connected/g) || []).length, connections, "it does not keep reconnecting");
    assert.equal(await phone.exists("after.md"), false);

    // approved again on the server: it syncs after its next start
    assert.match(server.cli("devices", "approve", "Phone"), /Approved/);
    await phone.quit();
    await phone.start();
    await phone.waitSynced();
    await waitFor(async () => (await phone.read("after.md")) === "the phone must not get this", { message: "syncs again" });
});

test("the CLI works when the server is stopped", async (t) => {
    const { server, laptop } = await laptopOnly(t);
    const phone = new Device(t, server, { name: "Phone" });
    await phone.start();
    await phone.waitState(s => s.status === "waiting_approval", "waiting");
    await phone.quit();
    await laptop.quit();
    await server.stop();

    const out = server.cli("devices", "approve", "Phone");
    assert.match(out, /server is not running, editing data\.json directly/);
    assert.match(out, /Approved: Phone/);
    await server.start();
    await phone.start();
    await phone.waitSynced();
});

test("someone who copies a device's id without its secret is refused", async (t) => {
    const { server, laptop } = await laptopOnly(t);
    const real = (await laptop.state()).device;

    const thief = new Device(t, server, { name: "Thief" });
    fs.writeFileSync(thief.vaultDir + ".localStorage.json", JSON.stringify({
        "anysocket-sync-device": JSON.stringify({ id: real.id, secret: "not-the-real-secret-at-all" })
    }));
    await thief.start();
    await waitFor(() => /Refused: invalid device credentials/.test(server.logs), { message: "refused" });
    const s = await thief.state();
    assert.notEqual(s.engine, "v2");
});

test("upgrading a 1.5 server: devices that synced recently are approved, new ones wait", async (t) => {
    // data as a 1.5 server leaves it
    const dataDir = tmp("legacy-data");
    fs.mkdirSync(path.join(dataDir, "db"), { recursive: true });
    fs.mkdirSync(path.join(dataDir, "files", "old.md"), { recursive: true });
    const now = Date.now();
    fs.writeFileSync(path.join(dataDir, "files", "old.md", "metadata"), JSON.stringify({ action: "created", sha1: "x", mtime: 1000, type: "file", path: "old.md" }));
    fs.writeFileSync(path.join(dataDir, "files", "old.md", "1000"), "from the 1.5 days");
    fs.writeFileSync(path.join(dataDir, "db", "data.json"), JSON.stringify({
        devices: { "Laptop": { last_online: now - 3600000 }, "Phone": { last_online: now - 86400000 } }
    }));

    const server = await new Server(t, { dataDir }).start();
    assert.match(server.logs, /Backing up data before running 1\.6\.0/);
    assert.ok(fs.readdirSync(path.join(dataDir, "backups")).some(n => n.startsWith("pre-1.6.0-")));

    const laptop = new Device(t, server, { name: "Laptop" });
    const phone = new Device(t, server, { name: "Phone" });
    const tablet = new Device(t, server, { name: "Tablet" });
    await laptop.start();
    await phone.start();
    await laptop.waitSynced();
    await phone.waitSynced();
    assert.equal(await phone.read("old.md"), "from the 1.5 days");

    await tablet.start();
    await tablet.waitState(s => s.status === "waiting_approval", "a device the old server never saw waits");
});
