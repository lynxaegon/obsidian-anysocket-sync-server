// TODO: - BUG: check why XLSX files don't work over e2e :/
// TODO: - IDEA: Backups/Snapshots every X time
// TODO: - IDEA: Server settings in Obsidian
// TODO: - IDEA: Server commands in Obsidian (cleanup)

const fs = require("fs");
if(!fs.existsSync("./config.js")) {
    console.log("Required \"./config.js\" is missing!\n");

    console.log("If you are running docker, you should mount the config.js")
    console.log("docker command: docker run \
-v ${PWD}/config.js:/app/config.js \
-v ${PWD}/data:/app/data \
-p 3000:3000 \
--rm \
lynxaegon/obsidian-anysocket-sync-server\n");
    
    console.log("\n\"./config.js\" example:\n", fs.readFileSync("./config.example.js", "utf8"));
    return process.exit(-1);
}
const config = require("./config");
config.app_dir = __dirname;
config.data_dir = "data";

global.XStorage = new (require("./libs/fs/Storage"))(config.app_dir + "/" + config.data_dir + "/files/");
global.XDB = new (require("./libs/DB"))(config.app_dir + "/" + config.data_dir + "/db");
const SyncServer = require("./libs/server");
const SyncCleanup = require("./libs/SyncCleanup");
(async () => {
    await XStorage.init();
    new SyncServer(config);
    new SyncCleanup(config);
})();