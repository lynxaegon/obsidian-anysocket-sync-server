// TODO: - IDEA: Backups/Snapshots every X time
// TODO: - IDEA: Server settings in Obsidian

const fs = require("fs");
const path = require("path");
if(parseInt(process.versions.node) < 20) {
    console.log("Node.js 20 or newer is required (running " + process.version + ")");
    return process.exit(-1);
}

// a malformed packet from one connection must never take the server down
process.on("unhandledRejection", (e) => {
    console.error("[SERVER] Unhandled rejection:", e);
});

// ANYSOCKET_SYNC_CONFIG / ANYSOCKET_SYNC_DATA point somewhere else than ./config.js and ./data
const configPath = path.resolve(process.env.ANYSOCKET_SYNC_CONFIG || path.join(__dirname, "config.js"));
if(!fs.existsSync(configPath)) {
    console.log("Required \"./config.js\" is missing!\n");

    console.log("If you are running docker, you should mount the config.js")
    console.log("docker command: docker run \
-v ${PWD}/config.js:/app/config.js \
-v ${PWD}/data:/app/data \
-p 3000:3000 \
--rm \
lynxaegon/obsidian-anysocket-sync-server\n");

    console.log("\n\"./config.js\" example:\n", fs.readFileSync(path.join(__dirname, "config.example.js"), "utf8"));
    return process.exit(-1);
}
const config = require(configPath);
if(!config.password || config.password === "default-server-password") {
    console.log("Please set your own \"password\" in config.js (it is still the example one)");
    return process.exit(-1);
}
config.app_dir = __dirname;
config.data_dir = "data";
const dataPath = path.resolve(process.env.ANYSOCKET_SYNC_DATA || path.join(__dirname, config.data_dir));
config.data_path = dataPath;

const version = JSON.parse(fs.readFileSync(path.join(__dirname, "package.json"), "utf8")).version;
require("./libs/Backup").beforeUpgrade(dataPath, version);

const cleanup = config.cleanup || {};
global.XStorage = new (require("./libs/fs/Storage"))(dataPath + "/files/", {
    binaryVersions: cleanup.binary_versions_per_file
});
global.XDB = new (require("./libs/DB"))(dataPath + "/db");
const SyncServer = require("./libs/server");
const SyncCleanup = require("./libs/SyncCleanup");
(async () => {
    await XStorage.init();
    const server = new SyncServer(config);
    try {
        await server.listen();
    } catch (e) {
        console.error("[SERVER] Could not listen on port " + config.port + ":", e.message || e);
        process.exit(1);
    }
    await new SyncCleanup(config, server.devices).start();
})();
