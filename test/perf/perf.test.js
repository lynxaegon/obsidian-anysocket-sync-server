const test = require("node:test");
const assert = require("node:assert");
const crypto = require("crypto");
const { Server, Device, waitSame, waitFor } = require("../e2e/harness");

const NOTES = Number(process.env.PERF_NOTES || 2000);
const IMAGES = Number(process.env.PERF_IMAGES || 50);

function makeVault(device) {
    let bytes = 0;
    for (let i = 0; i < NOTES; i++) {
        const text = "# Note " + i + "\n\n" + crypto.randomBytes(700).toString("base64") + "\n";
        device.writeOffline("Folder " + (i % 40) + "/note " + i + ".md", text);
        bytes += text.length;
    }
    for (let i = 0; i < IMAGES; i++) {
        const image = crypto.randomBytes(200 * 1024);
        device.writeOffline("Attachments/image " + i + ".png", image);
        bytes += image.length;
    }
    return bytes;
}

const seconds = (ms) => (ms / 1000).toFixed(1) + "s";

test("a " + NOTES + "-note vault: first upload, a new device's first sync, and reconnecting", { timeout: 600000 }, async (t) => {
    const server = await new Server(t, { config: { logs: { level: 1 } } }).start();
    const laptop = new Device(t, server, { name: "Laptop", settings: { notifications: 0 } });
    const bytes = makeVault(laptop);

    let start = Date.now();
    await laptop.start();
    await laptop.waitSynced(300000);
    const upload = Date.now() - start;

    const phone = new Device(t, server, { name: "Phone", settings: { notifications: 0 } });
    await phone.start();
    await phone.waitState(s => s.status === "waiting_approval", "waiting");
    start = Date.now();
    server.cli("devices", "approve", "Phone");
    await phone.waitSynced(300000);
    const download = Date.now() - start;
    await waitSame([laptop, phone], 120000);

    // a change while the phone was away, then it reconnects
    await phone.quit();
    await laptop.write("Folder 1/note 1.md", "changed while the phone was off");
    await laptop.settle();
    start = Date.now();
    await phone.start();
    await phone.waitSynced(120000);
    const reconnect = Date.now() - start;
    assert.equal(await phone.read("Folder 1/note 1.md"), "changed while the phone was off");

    console.log("PERF " + JSON.stringify({
        notes: NOTES, images: IMAGES, megabytes: +(bytes / 1048576).toFixed(1),
        upload: seconds(upload), firstSyncOfNewDevice: seconds(download), reconnectWithOneChange: seconds(reconnect)
    }));
    assert.ok(reconnect < 15000, "reconnecting is quick: " + seconds(reconnect));
});
