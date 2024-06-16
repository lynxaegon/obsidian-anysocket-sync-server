// TODO: - BUG: check why XLSX files don't work over e2e :/
// TODO: - IDEA: Backups/Snapshots every X time
// TODO: - IDEA: Server settings in Obsidian
// TODO: - IDEA: Server commands in Obsidian (cleanup)

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