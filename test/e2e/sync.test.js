const test = require("node:test");
const assert = require("node:assert");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { Server, Device, waitFor, waitSame, settleAll, sleep } = require("./harness");

const sha = (b) => crypto.createHash("sha256").update(b).digest("hex");

// a server with two approved devices
async function pair(t, options = {}) {
    const server = await new Server(t, options.server).start();
    const laptop = new Device(t, server, { name: "Laptop", ...(options.laptop || {}) });
    await laptop.start();
    await laptop.waitSynced();
    const phone = new Device(t, server, { name: "Phone", ...(options.phone || {}) });
    await phone.start();
    await phone.waitState(s => s.status === "waiting_approval", "waiting for approval");
    server.cli("devices", "approve", "Phone");
    await phone.waitSynced();
    return { server, laptop, phone };
}

test("text, binary and folders reach the other device byte for byte", async (t) => {
    const { server, laptop, phone } = await pair(t);
    const image = crypto.randomBytes(300 * 1024);
    await laptop.write("Notes/hello.md", "# Hello\n\nünïcødé ✓\n");
    await laptop.writeBinary("Assets/photo.png", image);
    await laptop.mkdir("Empty folder");
    await laptop.write("Deep/er/and/deeper/note.md", "deep");

    const tree = await waitSame([laptop, phone]);
    assert.equal(tree["Assets/photo.png"], sha(image));
    assert.equal(tree["Empty folder"], "folder");
    assert.equal(await phone.read("Notes/hello.md"), "# Hello\n\nünïcødé ✓\n");
    assert.ok((await phone.readBinary("Assets/photo.png")).equals(image));
    assert.ok(server.stored("Assets/photo.png").data.equals(image));
});

test("edits, deletes and renames show up live on the other device", async (t) => {
    const { laptop, phone } = await pair(t);
    await laptop.write("a.md", "v1");
    await waitSame([laptop, phone]);

    await laptop.write("a.md", "v2");
    await waitFor(async () => (await phone.read("a.md")) === "v2", { message: "edit" });

    await laptop.rename("a.md", "Moved/b.md");
    await waitFor(async () => (await phone.read("Moved/b.md")) === "v2" && !(await phone.exists("a.md")), { message: "rename" });

    await laptop.remove("Moved/b.md");
    await waitFor(async () => !(await phone.exists("Moved/b.md")), { message: "delete" });
    await waitSame([laptop, phone]);
});

test("a rename keeps the file's history, and the other device renames instead of downloading", async (t) => {
    const { server, laptop, phone } = await pair(t);
    await laptop.write("old name.md", "v1");
    await laptop.settle();
    await laptop.write("old name.md", "v2");
    await waitSame([laptop, phone]);
    const before = server.versions("old name.md");
    assert.equal(before.length, 2);

    await laptop.rename("old name.md", "Folder/new name.md");
    await waitSame([laptop, phone]);
    assert.deepEqual(server.versions("Folder/new name.md"), before);
    assert.equal(server.stored("old name.md").meta.renamed_to, "Folder/new name.md");
    const versions = await phone.listVersions("Folder/new name.md");
    assert.equal(versions.data.length, 2);

    const activity = (await phone.state()).activity;
    assert.ok(activity.includes("renamed:Folder/new name.md"), activity.join(","));
    assert.ok(!activity.includes("downloaded:Folder/new name.md"), "renamed, not downloaded again");
});

test("renaming and deleting folders with their contents", async (t) => {
    const { laptop, phone } = await pair(t);
    await laptop.write("Project/a.md", "a");
    await laptop.write("Project/sub/b.md", "b");
    await laptop.writeBinary("Project/sub/c.png", Buffer.from([1, 2, 3]));
    await waitSame([laptop, phone]);

    await laptop.rename("Project", "Archive/Project 2024");
    const tree = await waitSame([laptop, phone]);
    assert.deepEqual(Object.keys(tree).filter(p => p.startsWith("Archive/Project 2024/")).sort(),
        ["Archive/Project 2024/a.md", "Archive/Project 2024/sub", "Archive/Project 2024/sub/b.md", "Archive/Project 2024/sub/c.png"]);
    assert.ok(!(await phone.exists("Project")));

    await laptop.remove("Archive/Project 2024");
    const after = await waitSame([laptop, phone]);
    assert.ok(!Object.keys(after).some(p => p.includes("Project 2024")), JSON.stringify(after));
});

test("changes made while a device was off arrive when it comes back, both ways", async (t) => {
    const { laptop, phone } = await pair(t);
    await laptop.write("shared.md", "one\ntwo\nthree\n");
    await laptop.write("to-delete.md", "bye");
    await waitSame([laptop, phone]);

    await phone.quit();
    await laptop.write("from-laptop.md", "written while the phone was off");
    // edited with Obsidian closed on the phone, and a file removed from disk
    await phone.writeOffline("from-phone.md", "written while offline");
    fs.rmSync(path.join(phone.vaultDir, "to-delete.md"));

    await phone.start();
    await phone.waitSynced();
    const tree = await waitSame([laptop, phone]);
    assert.ok(tree["from-laptop.md"] && tree["from-phone.md"]);
    assert.ok(!tree["to-delete.md"]);
});

test("two devices editing different parts of a note: the edits are combined", async (t) => {
    const { server, laptop, phone } = await pair(t);
    await laptop.write("note.md", "Title\n\nMonday: \nTuesday: \nWednesday: \n");
    await waitSame([laptop, phone]);

    await phone.quit();
    await laptop.write("note.md", "Title\n\nMonday: gym\nTuesday: \nWednesday: \n");
    await laptop.settle();
    await phone.writeOffline("note.md", "Title\n\nMonday: \nTuesday: \nWednesday: dentist\n");
    await phone.start();
    await phone.waitSynced();

    await waitSame([laptop, phone]);
    const expected = "Title\n\nMonday: gym\nTuesday: \nWednesday: dentist\n";
    assert.equal(await phone.read("note.md"), expected);
    assert.equal(await laptop.read("note.md"), expected);
    assert.equal((await phone.keptCopies()).length, 0, "nothing to review");
    assert.ok(server.versions("note.md").length >= 3, "every version is in the history");
});

test("two devices changing the same line: both versions are kept, explained simply", async (t) => {
    const { laptop, phone } = await pair(t);
    await laptop.write("Plans/trip.md", "Destination: ?\n");
    await waitSame([laptop, phone]);

    await phone.quit();
    await laptop.write("Plans/trip.md", "Destination: Rome\n");
    await laptop.settle();
    await phone.writeOffline("Plans/trip.md", "Destination: Lisbon\n");
    await phone.start();
    await phone.waitSynced();

    const tree = await waitSame([laptop, phone]);
    const copies = Object.keys(tree).filter(p => p.includes("'s version, "));
    assert.equal(copies.length, 1, JSON.stringify(tree));
    assert.match(copies[0], /^Plans\/trip \((Laptop|Phone)'s version, [A-Z][a-z]{2} \d+\)\.md$/);
    const contents = [await phone.read("Plans/trip.md"), await phone.read(copies[0])].sort();
    assert.deepEqual(contents, ["Destination: Lisbon\n", "Destination: Rome\n"], "nothing is lost");

    // the phone made the change that collided: it tells the person, plainly
    const notices = (await phone.notices()).join("\n");
    assert.match(notices, /"trip\.md" was changed on two devices at the same time\. Both versions were kept, nothing was lost\./);
    assert.doesNotMatch(notices, /conflict|merge/i);
    await waitFor(async () => (await laptop.state()).attention === 1 && (await phone.state()).attention === 1, { message: "attention badge" });
    assert.match((await laptop.state()).statusBar, /1 to review/);

    const panel = (await laptop.panel()).join("\n");
    assert.match(panel, /Needs your attention/);
    assert.match(panel, /trip\.md was changed on two devices/);
    assert.match(panel, /Done, remove the copy/);

    // done reviewing: removing the copy clears it everywhere
    await laptop.remove(copies[0]);
    await waitSame([laptop, phone]);
    await waitFor(async () => (await phone.state()).attention === 0, { message: "attention cleared" });
});

test("an edit wins over a delete of the version it changed", async (t) => {
    const { laptop, phone } = await pair(t);
    await laptop.write("keep me.md", "original");
    await waitSame([laptop, phone]);

    await phone.quit();
    await laptop.remove("keep me.md");
    await laptop.settle();
    await phone.writeOffline("keep me.md", "edited on the phone");
    await phone.start();
    await phone.waitSynced();

    await waitSame([laptop, phone]);
    assert.equal(await laptop.read("keep me.md"), "edited on the phone");
});

test("a delete of a file that was changed elsewhere keeps the newer version", async (t) => {
    const { laptop, phone } = await pair(t);
    await laptop.write("report.md", "draft");
    await waitSame([laptop, phone]);

    await phone.quit();
    await laptop.write("report.md", "final version");
    await laptop.settle();
    fs.rmSync(path.join(phone.vaultDir, "report.md"));
    await phone.start();
    await phone.waitSynced();

    await waitSame([laptop, phone]);
    assert.equal(await phone.read("report.md"), "final version");
    assert.match((await phone.notices()).join("\n"), /"report\.md" was changed on another device, so it was kept instead of deleted\./);
});

test("binary files changed on both devices: both kept", async (t) => {
    const { laptop, phone } = await pair(t);
    await laptop.writeBinary("img.png", Buffer.from([1, 1, 1]));
    await waitSame([laptop, phone]);
    await phone.quit();
    await laptop.writeBinary("img.png", Buffer.from([2, 2, 2]));
    await laptop.settle();
    fs.writeFileSync(path.join(phone.vaultDir, "img.png"), Buffer.from([3, 3, 3]));
    await phone.start();
    await phone.waitSynced();
    const tree = await waitSame([laptop, phone]);
    const images = Object.keys(tree).filter(p => p.endsWith(".png")).sort();
    assert.equal(images.length, 2, JSON.stringify(tree));
    const hashes = images.map(p => tree[p]).sort();
    assert.deepEqual(hashes, [sha(Buffer.from([2, 2, 2])), sha(Buffer.from([3, 3, 3]))].sort());
});

test("files whose extension says text but aren't UTF-8, and upper-case binaries, stay byte-identical", async (t) => {
    const { laptop, phone } = await pair(t);
    const latin1 = Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0a]); // "café" in latin-1
    const png = crypto.randomBytes(5000);
    const bom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("with a BOM\r\nand CRLF\r\n")]);
    await laptop.writeExternal("latin1.txt", latin1);
    await laptop.writeExternal("Photo.PNG", png);
    await laptop.writeExternal("bom.md", bom);
    await waitSame([laptop, phone]);
    assert.ok((await phone.readBinary("latin1.txt")).equals(latin1));
    assert.ok((await phone.readBinary("Photo.PNG")).equals(png));
    assert.ok((await phone.readBinary("bom.md")).equals(bom));
});

test("names with spaces, unicode and dots; empty files", async (t) => {
    const { laptop, phone } = await pair(t);
    for (const name of ["Ünïcödé/日本語のノート.md", "with spaces/a b c.md", "dots/v1.2.3.md", "empty.md", "emoji 🎉.md"]) {
        await laptop.write(name, name === "empty.md" ? "" : "content of " + name);
    }
    const tree = await waitSame([laptop, phone]);
    assert.equal(tree["empty.md"], sha(""));
    assert.equal(await phone.read("Ünïcödé/日本語のノート.md"), "content of Ünïcödé/日本語のノート.md");
});

test("a second device that already has the same files uploads nothing and duplicates nothing", async (t) => {
    const server = await new Server(t).start();
    const laptop = new Device(t, server, { name: "Laptop" });
    await laptop.start();
    await laptop.waitSynced();
    for (let i = 0; i < 20; i++) {
        await laptop.write("Notes/n" + i + ".md", "note " + i);
    }
    await laptop.settle();

    // the vault was copied to the phone by hand (plugin settings and index included)
    const phone = new Device(t, server, { name: "Phone" });
    fs.cpSync(laptop.vaultDir, phone.vaultDir, { recursive: true });
    await phone.start();
    await phone.waitState(s => s.status === "waiting_approval", "a copied vault is still a new device");
    server.cli("devices", "approve", "Phone");
    await phone.waitSynced();

    const tree = await waitSame([laptop, phone]);
    assert.equal(Object.keys(tree).filter(p => p.includes("'s version")).length, 0);
    const uploads = (await phone.state()).activity.filter(a => a.startsWith("uploaded:"));
    assert.deepEqual(uploads, []);
});

test("version history: list, read and restore an older version", async (t) => {
    const { laptop, phone } = await pair(t);
    await laptop.write("diary.md", "first");
    await laptop.settle();
    await laptop.write("diary.md", "second");
    await laptop.settle();
    await laptop.write("diary.md", "third");
    await waitSame([laptop, phone]);

    const versions = await phone.listVersions("diary.md");
    assert.equal(versions.data.length, 3);
    const oldest = versions.data[versions.data.length - 1];
    assert.equal(Buffer.from(await phone.readVersion("diary.md", oldest), "base64").toString(), "first");

    await phone.restore("diary.md", oldest);
    await waitFor(async () => (await laptop.read("diary.md")) === "first", { message: "restore everywhere" });
    assert.equal((await laptop.listVersions("diary.md")).data.length, 4, "restoring adds a version");
});

test("binary files keep a few versions, and deleted files can be found", async (t) => {
    const { laptop } = await pair(t);
    for (let i = 1; i <= 5; i++) {
        await laptop.writeBinary("pic.png", Buffer.from([i]));
        await laptop.settle();
        await sleep(20);
    }
    assert.equal((await laptop.listVersions("pic.png")).data.length, 3);

    await laptop.write("gone.md", "x");
    await laptop.settle();
    await laptop.remove("gone.md");
    await laptop.settle();
    const deleted = await laptop.files(true);
    assert.ok(deleted.some(f => f.path === "gone.md"));
});

test("a server restart: devices reconnect and nothing is duplicated", async (t) => {
    const { server, laptop, phone } = await pair(t);
    await laptop.write("before.md", "before");
    await waitSame([laptop, phone]);

    await server.restart();
    await laptop.waitState(s => s.engine === "v2" && s.status === "synced", "reconnect", 30000);
    await phone.waitState(s => s.engine === "v2" && s.status === "synced", "reconnect", 30000);
    await laptop.write("after.md", "after");
    const tree = await waitSame([laptop, phone]);
    assert.deepEqual(Object.keys(tree).sort(), ["after.md", "before.md"]);
});

test("typing fast (many saves in a row) ends with the last text everywhere", async (t) => {
    const { server, laptop, phone } = await pair(t);
    let text = "";
    for (let i = 0; i < 30; i++) {
        text += "word" + i + " ";
        await laptop.write("typing.md", text);
    }
    await waitSame([laptop, phone]);
    assert.equal(await phone.read("typing.md"), text);
    assert.equal(server.stored("typing.md").data.toString(), text);
});
