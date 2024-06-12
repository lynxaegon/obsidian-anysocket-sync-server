// TODO: - check why XLSX files don't work over e2e :/

// TODO: -- add an option to do a snapshot every X time, copy the whole data folder,
// TODO: -- and allow a backup system to be made, for ex: tell where the backup should be copied
const config = require("./config");

global.XStorage = new (require("./libs/fs/Storage"))(config.app_dir + "/" + config.data_dir + "/files/");
global.XDB = new (require("./libs/DB"))(config.app_dir + "/" + config.data_dir + "db/");
const SyncServer = require("./libs/server");
const SyncCleanup = require("./libs/SyncCleanup");
(async () => {
    await XStorage.init();
    new SyncServer(config);
    new SyncCleanup(config);
})();