const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { storage, tmpdir } = require("../helpers/tmp");
const Storage = require("../../libs/fs/Storage");
const FSAdapter = require("../../libs/fs/FSAdapter");

const meta = (mtime, extra) => Object.assign({ type: "file", action: "created", mtime, sha1: "x" }, extra);

test("entries load into memory on start, with their sequence numbers", async (t) => {
    const { dir, storage: s } = await storage(t);
    await s.storeEntry("a.md", meta(1), "a");
    await s.storeEntry("Deep/Folder/b.md", meta(2), "b");
    assert.equal(s.seq, 2);

    const again = new Storage(dir + "/files/");
    await again.init();
    assert.deepEqual((await again.iterate()).sort(), ["Deep/Folder/b.md", "a.md"]);
    assert.equal(again.seq, 2);
    assert.equal((await again.readMetadata("a.md")).seq, 1);
    assert.equal(await again.read("Deep/Folder/b.md"), "b");
    assert.notEqual(again.epoch, s.epoch);
});

test("writes are atomic: no temp files are left, and leftovers from a crash are cleaned up", async (t) => {
    const { dir, storage: s } = await storage(t);
    await s.storeEntry("a.md", meta(1), "a");
    const entry = path.join(dir, "files", "a.md");
    assert.deepEqual(fs.readdirSync(entry).sort(), ["1", "metadata"]);

    fs.writeFileSync(path.join(entry, ".tmp-deadbeef"), "half written");
    const again = new Storage(dir + "/files/");
    await again.init();
    assert.deepEqual(fs.readdirSync(entry).sort(), ["1", "metadata"]);
    assert.deepEqual((await again.iterateVersions("a.md")).map(v => v.timestamp), [1]);
});

test("corrupt metadata is rebuilt from the newest version (server issue #2)", async (t) => {
    const { dir, storage: s } = await storage(t);
    await s.storeEntry("a.md", meta(1), "old");
    await s.storeEntry("a.md", meta(5), "newest");
    fs.writeFileSync(path.join(dir, "files", "a.md", "metadata"), "{\"action\":\"cre");

    const again = new Storage(dir + "/files/");
    await again.init();
    const rebuilt = await again.readMetadata("a.md");
    assert.equal(rebuilt.action, "created");
    assert.equal(rebuilt.mtime, 5);
    assert.equal(rebuilt.sha1, crypto.createHash("sha256").update("newest").digest("hex"));
    assert.equal(await again.read("a.md"), "newest");
    // and it is written back
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir, "files", "a.md", "metadata"), "utf8")).mtime, 5);
});

test("corrupt folder metadata is rebuilt as a folder", async (t) => {
    const { dir, storage: s } = await storage(t);
    await s.storeEntry("F", { type: "folder", action: "created", mtime: 1 });
    await s.storeEntry("F/a.md", meta(1), "a");
    fs.writeFileSync(path.join(dir, "files", "F", "metadata"), "");
    const again = new Storage(dir + "/files/");
    await again.init();
    assert.equal((await again.readMetadata("F")).type, "folder");
});

test("binary files keep their newest versions (3 by default)", async (t) => {
    const { storage: s } = await storage(t);
    for (let i = 1; i <= 5; i++) {
        await s.storeEntry("img.png", meta(i), Buffer.from([i]), true);
    }
    assert.deepEqual((await s.iterateVersions("img.png")).map(v => v.timestamp), [5, 4, 3]);
});

test("the number of binary versions is configurable", async (t) => {
    const { storage: s } = await storage(t, { binaryVersions: 1 });
    for (let i = 1; i <= 3; i++) {
        await s.storeEntry("img.png", meta(i), Buffer.from([i]), true);
    }
    assert.deepEqual((await s.iterateVersions("img.png")).map(v => v.timestamp), [3]);
});

test("text files keep all their versions", async (t) => {
    const { storage: s } = await storage(t);
    for (let i = 1; i <= 5; i++) {
        await s.storeEntry("a.md", meta(i), "v" + i);
    }
    assert.equal((await s.iterateVersions("a.md")).length, 5);
});

test("an entry without content is refused before anything is written", async (t) => {
    const { storage: s } = await storage(t);
    await assert.rejects(() => s.storeEntry("a.md", meta(1), null), /missing content/);
    assert.equal(await s.readMetadata("a.md"), null);
});

test("version files only count when their whole name is a timestamp", async (t) => {
    const dir = tmpdir(t);
    const adapter = new FSAdapter(dir + "/");
    await adapter.init();
    await adapter.write("a.md/123", "x");
    await adapter.write("a.md/123.bak", "x");
    await adapter.write("a.md/.hidden", "x");
    await adapter.write("a.md/metadata", "{}");
    assert.deepEqual((await adapter.iterateVersions("a.md")).map(v => v.timestamp), [123]);
    assert.deepEqual(await adapter.iterateVersions("missing"), []);
});

test("changesSince returns changes in order", async (t) => {
    const { storage: s } = await storage(t);
    await s.storeEntry("a.md", meta(1), "a");
    await s.storeEntry("b.md", meta(1), "b");
    await s.storeEntry("a.md", meta(2), "a2");
    assert.deepEqual(s.changesSince(1).map(e => e[0]), ["b.md", "a.md"]);
    assert.deepEqual(s.changesSince(3), []);
});

test("delete removes an entry but never its children", async (t) => {
    const { dir, storage: s } = await storage(t);
    await s.storeEntry("F", { type: "folder", action: "deleted", mtime: 1 });
    await s.storeEntry("F/a.md", meta(1), "a");
    await s.delete("F");
    assert.equal(await s.readMetadata("F"), null);
    assert.equal(await s.read("F/a.md"), "a");
    assert.ok(fs.existsSync(path.join(dir, "files", "F", "a.md", "metadata")));
    await s.delete("F/a.md");
    assert.equal(await s.readMetadata("F/a.md"), null);
});

test("findVersionBySha finds older versions by content", async (t) => {
    const { storage: s } = await storage(t);
    await s.storeEntry("a.md", meta(1), "one");
    await s.storeEntry("a.md", meta(2), "two");
    const sha = crypto.createHash("sha256").update("one").digest("hex");
    assert.equal(await s.findVersionBySha("a.md", sha), "one");
    assert.equal(await s.findVersionBySha("a.md", "nope"), null);
    assert.equal(await s.findVersionBySha("a.md", null), null);
});

test("locks serialize work per path, and different paths run in parallel", async (t) => {
    const { storage: s } = await storage(t);
    const order = [];
    const slow = (label, ms) => async () => { order.push(label + ":start"); await new Promise(r => setTimeout(r, ms)); order.push(label + ":end"); };
    await Promise.all([
        s.withLock("a", slow("a1", 50)),
        s.withLock("a", slow("a2", 1)),
        s.withLock("b", slow("b1", 1))
    ]);
    assert.ok(order.indexOf("a1:end") < order.indexOf("a2:start"), order.join(","));
    assert.ok(order.indexOf("b1:end") < order.indexOf("a1:end"), order.join(","));
    assert.equal(s.locks.size, 0);
});

test("a failing locked task releases the lock", async (t) => {
    const { storage: s } = await storage(t);
    await assert.rejects(() => s.withLock("a", async () => { throw new Error("boom"); }), /boom/);
    assert.equal(await s.withLock("a", async () => "ok"), "ok");
});
