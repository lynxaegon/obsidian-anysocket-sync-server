module.exports = {
    // server password
    "password": "default-server-password",

    // listen on host/port
    "host": "0.0.0.0",
    "port": 3000,

    // optional, enables https
    // "certs": {
    //     "pk": "./certs/privkey.pem",
    //     "cert": "./certs/fullchain.pem"
    // },

    logs: {
        // 0 - disabled
        // 1 - connect/disconnect only
        // 2 - client/server updates (paths only)
        // 3 - verbose
        level: 1
    },

    // cleanup
    cleanup: {
        // crontab format
        // defaults to: 0 * * * *
        "schedule": "0 * * * *",

        // number of versions to keep for each file
        // defaults to: 1000
        "versions_per_file": 1000,

        // number of seconds to keep deleted files
        //  - they will only be deleted if all connected devices have synced up to that file
        // defaults to: 3 days
        "keep_deleted_files_time": 3 * 24 * 60 * 60
    }
};