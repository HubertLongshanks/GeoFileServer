import express from "express";
import { stat, existsSync, globSync, unlink } from "node:fs"

const app = express();

const CLEANER_INTERVAL = process.env.TRANSFORM_SERVER_TIMEOUT ? parseInt(process.env.TRANSFORM_SERVER_TIMEOUT) * 1000 : 360 * 1000

app.use(express.json());

app.get("/health", (_, res) => {
    res.status(200).send();
});

app.listen(3031, () => {
    console.log(`cleaner server running on port: ${3031}`);
});

setInterval(() => {
    console.log("cleaning files");


    if (!existsSync("/tmpfiles")) {
        console.error("ok, so the tempfile path is gone....");
        return;
    }

    let files = globSync("/tmpfiles/*");

    for ( let file of files ) {

        let now = Date.now() - CLEANER_INTERVAL;

        stat(file , ( err , stat) => {
            if ( !err && stat.birthtime > new Date(now) ) {
                unlink(file , (err) => {
                    console.error(`error: ${err?.toString()} unlinking temp file: ${file}`);
                })
            }
        });
    }

}, CLEANER_INTERVAL);