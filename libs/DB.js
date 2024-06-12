const fs = require("fs");

module.exports = class DB {
    constructor(root) {
        this.path = root + "data.json";
        if(!fs.existsSync(root)) {
            fs.mkdirSync(root, {
                recursive: true
            });
        }

        if(fs.existsSync(this.path)) {
            this.data = JSON.parse(fs.readFileSync(this.path, "utf8"));
        }
        else {
            this.data = {
                devices: {}
            };
            this.save();
        }

        this.devices = {
            add: (id) => {
                if(!this.data.devices[id]) {
                    this.data.devices[id] = {};
                    this.save();
                }
            },
            set: (id, key, value) => {
                this.data.devices[id][key] = value;
                this.save();
            },
            get: (id, key) => {
                return this.data.devices[id][key];
            },
            has: (id) => {
                return !!this.data.devices[id];
            },
            remove: (id) => {
                delete this.data.devices[id];
                this.save();
            },
            list: () => {
                return Object.keys(this.data.devices);
            }
        }
    }

    save() {
        fs.writeFileSync(this.path, JSON.stringify(this.data), "utf8");
    }
}