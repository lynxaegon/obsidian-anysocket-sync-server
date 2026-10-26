const test = require("node:test");
const assert = require("node:assert");
const crypto = require("crypto");
const { Server, Device, waitFor, waitSame, sleep } = require("./harness");

const MB = 1024 * 1024;

async function pair(t, phoneSettings = {}) {
    const server = await new Server(t, { config: { logs: { level: 1 } } }).start();
    const laptop = new Device(t, server, { name: "Laptop", settings: { notifications: 1 } });
    await laptop.start();
    await laptop.waitSynced();
    const phone = new Device(t, server, { name: "Phone", platform: "ios", settings: Object.assign({ notifications: 1 }, phoneSettings) });
    await phone.start();
    await phone.waitState(s => s.status === "waiting_approval", "waiting");
    server.cli("devices", "approve", "Phone");
    await phone.waitSynced();
    return { server, laptop, phone };
}

test("phones skip files above their size limit (both ways), and say so", async (t) => {
    const { server, laptop, phone } = await pair(t, { maxFileSize: 1 });
    const big = crypto.randomBytes(3 * MB);
    await laptop.writeBinary("Videos/clip.mp4", big);
    await laptop.write("small.md", "small");
    await laptop.settle();
    await waitFor(async () => (await phone.exists("small.md")), { message: "small file arrives" });
    await phone.settle();

    const s = await phone.state();
    assert.equal(await phone.exists("Videos/clip.mp4"), false, "not downloaded");
    assert.deepEqual(s.skipped, ["Videos/clip.mp4"]);
    assert.equal(s.status, "synced", "not an error");
    const panel = (await phone.panel()).join("\n");
    assert.match(panel, /Not synced on this device/);
    assert.match(panel, /1 file is larger than 1 MB/);
    assert.match(panel, /clip\.mp4 \(3 MB\)/);

    // and a big file on the phone stays on the phone
    await phone.writeBinary("phone-video.mov", crypto.randomBytes(2 * MB));
    await phone.settle();
    assert.equal(server.stored("phone-video.mov"), null);
    assert.ok((await phone.state()).skipped.includes("phone-video.mov"));
    // the laptop (no limit) has everything it should
    assert.ok((await laptop.readBinary("Videos/clip.mp4")).equals(big));
});

test("raising the limit brings the skipped files in", async (t) => {
    const { laptop, phone } = await pair(t, { maxFileSize: 1 });
    const big = crypto.randomBytes(3 * MB);
    await laptop.writeBinary("big.png", big);
    await laptop.settle();
    await sleep(1000);
    await phone.settle();
    assert.equal(await phone.exists("big.png"), false);

    await phone.quit();
    await phone.start({ maxFileSize: 0 });
    await phone.waitSynced();
    // the limit changed: a full look at the server
    await phone.syncNow(true);
    await waitFor(async () => { const b = await phone.readBinary("big.png"); return b && b.equals(big); }, { message: "downloaded after raising the limit" });
});

test("many big files: memory stays bounded (one big file in flight at a time)", { timeout: 300000 }, async (t) => {
    const server = await new Server(t, { config: { logs: { level: 1 } } }).start();
    const laptop = new Device(t, server, { name: "Laptop", settings: { notifications: 0 } });
    // already in the vault when Obsidian starts (found by the first scan, sent by the parallel uploader)
    for (let i = 0; i < 8; i++) {
        laptop.writeOffline("Big/file" + i + ".bin", crypto.randomBytes(25 * MB));
    }
    await laptop.start();
    await laptop.waitSynced(240000);
    const laptopState = await laptop.state();
    assert.equal(Object.keys(await laptop.tree()).filter(p => p.startsWith("Big/file")).length, 8, "the files are really there");
    for (let i = 0; i < 8; i++) {
        assert.equal(server.stored("Big/file" + i + ".bin").data.length, 25 * MB);
    }

    const phone = new Device(t, server, { name: "Phone", settings: { notifications: 0 } });
    await phone.start();
    await phone.waitState(s => s.status === "waiting_approval", "waiting");
    await phone.resetPeak();
    const phoneBase = (await phone.state()).peakRss;
    server.cli("devices", "approve", "Phone");
    await phone.waitSynced(240000);
    const tree = await waitSame([laptop, phone], 240000);
    assert.equal(Object.keys(tree).filter(p => p.startsWith("Big/file")).length, 8);
    const downloadPeak = (await phone.state()).peakRss - phoneBase;

    const phoneState = await phone.state();
    console.log("MEM " + JSON.stringify({ files: "8 x 25MB", uploadPeakRssMB: Math.round(laptopState.peakRss / MB),
        downloadPeakAboveIdleMB: Math.round(downloadPeak / MB), upload: laptopState.transfers, download: phoneState.transfers }));
    // what matters: a file bigger than the 16MB budget always travels alone
    assert.equal(laptopState.transfers.maxFiles, 1, "uploads: one big file at a time");
    assert.equal(phoneState.transfers.maxFiles, 1, "downloads: one big file at a time");
    assert.ok(phoneState.transfers.maxBytes <= 25 * MB);
    // node frees buffers lazily, so peak memory also counts garbage not yet collected; it still
    // must not look like all 200MB were held several times over
    assert.ok(laptopState.peakRss < 500 * MB, "upload: peak memory " + Math.round(laptopState.peakRss / MB) + "MB");
    assert.ok(downloadPeak < 400 * MB, "download: " + Math.round(downloadPeak / MB) + "MB above idle");
});

test("a vault larger than one page of the server's list", { timeout: 300000 }, async (t) => {
    const server = await new Server(t, { config: { logs: { level: 1 } } }).start();
    const laptop = new Device(t, server, { name: "Laptop", settings: { notifications: 0 } });
    for (let i = 0; i < 6200; i++) {
        laptop.writeOffline("F" + (i % 50) + "/n" + i + ".md", "n" + i);
    }
    await laptop.start();
    await laptop.waitSynced(240000);
    const phone = new Device(t, server, { name: "Phone", settings: { notifications: 0 } });
    await phone.start();
    await phone.waitState(s => s.status === "waiting_approval", "waiting");
    server.cli("devices", "approve", "Phone");
    await phone.waitSynced(240000);
    const tree = await waitSame([laptop, phone], 240000);
    assert.equal(Object.keys(tree).filter(p => p.endsWith(".md")).length, 6200);
});

test("many small files go several at a time, within the byte budget", async (t) => {
    const server = await new Server(t, { config: { logs: { level: 1 } } }).start();
    const laptop = new Device(t, server, { name: "Laptop", settings: { notifications: 0 } });
    for (let i = 0; i < 200; i++) {
        laptop.writeOffline("Small/n" + i + ".md", crypto.randomBytes(3000).toString("hex"));
    }
    await laptop.start();
    await laptop.waitSynced(120000);
    const s = await laptop.state();
    assert.ok(s.transfers.maxFiles > 1 && s.transfers.maxFiles <= 8, JSON.stringify(s.transfers));
    assert.ok(s.transfers.maxBytes <= 16 * MB, JSON.stringify(s.transfers));
});
