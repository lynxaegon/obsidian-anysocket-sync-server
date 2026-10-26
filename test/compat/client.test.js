/**
 * The headless client (obsidian-anysocket-sync-client, e.g. a bot) with a 1.6.0 server and
 * with the 1.5 production server. Skipped when the client isn't next to this repo.
 */
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const { Server, Device, waitFor, tmp, PASSWORD } = require("../e2e/harness");
const { ProductionServer } = require("./production");

const CLIENT = path.resolve(__dirname, "..", "..", "..", "obsidian-anysocket-sync-client");
const available = fs.existsSync(path.join(CLIENT, "index.js"));

function client(t, server, name) {
    const XSyncClient = require(CLIENT);
    const c = new XSyncClient(name, { host: "127.0.0.1", port: server.port, password: PASSWORD, deviceFile: path.join(tmp("client"), "device.json") });
    t.after(() => c.anysocket && c.anysocket.stop().catch(() => {}));
    return c;
}

test("headless client with a 1.6.0 server: approved once, then lists, reads, writes and hears changes", { skip: !available }, async (t) => {
    const server = await new Server(t).start();
    const laptop = new Device(t, server, { name: "Laptop" });
    await laptop.start();
    await laptop.waitSynced();
    await laptop.write("Daily Log/today.md", "from the laptop");
    await laptop.settle();

    const bot = client(t, server, "discord-bot");
    const pending = new Promise(r => bot.once("pending", r));
    const connected = new Promise(r => bot.once("connected", r));
    await bot.init();
    await pending;
    assert.match(server.cli("devices"), /WAITING\s+discord-bot\s+node/);
    server.cli("devices", "approve", "discord-bot");
    await connected;
    assert.equal(bot.protocol, 2);

    const files = await bot.listFiles();
    assert.ok(files.some(f => f.path === "Daily Log/today.md"));
    assert.equal(await bot.readFile("Daily Log/today.md"), "from the laptop");

    const result = await bot.writeFile("Daily Log/today.md", "from the laptop\n\nand the bot");
    assert.equal(result.result, "applied");
    await waitFor(async () => (await laptop.read("Daily Log/today.md")) === "from the laptop\n\nand the bot", { message: "laptop gets the bot's edit" });

    const update = new Promise(r => bot.on("file_update", (u) => { if (u.path === "new.md") r(u); }));
    await laptop.write("new.md", "a new note");
    const u = await update;
    assert.equal(u.metadata.action, "created");
    assert.equal(u.data, "a new note");
});

test("headless client with the 1.5 production server works as before", { skip: !available }, async (t) => {
    const server = await new ProductionServer(t).start();
    const bot = client(t, server, "discord-bot");
    const connected = new Promise(r => bot.once("connected", r));
    await bot.init();
    await connected;
    assert.equal(bot.protocol, 1);
    await bot.writeFile("from-bot.md", "hello");
    await waitFor(() => { const s = server.stored("from-bot.md"); return s && s.data && s.data.toString() === "hello"; }, { message: "stored" });
    assert.equal(await bot.readFile("from-bot.md"), "hello");
    assert.ok((await bot.listFiles()).some(f => f.path === "from-bot.md"));
});
