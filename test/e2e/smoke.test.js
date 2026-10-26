const test = require("node:test");
const assert = require("node:assert");
const { Server, Device } = require("./harness");

test("smoke: first device connects, is approved and syncs a note", async (t) => {
    const server = await new Server(t).start();
    const laptop = new Device(t, server, { name: "Laptop" });
    await laptop.start();
    const s = await laptop.waitSynced();
    assert.equal(s.engine, "v2");
    assert.equal(s.device.status, "approved");
    await laptop.write("Notes/hello.md", "# Hello\n");
    await laptop.settle();
    assert.equal(server.stored("Notes/hello.md").data.toString(), "# Hello\n");
});
