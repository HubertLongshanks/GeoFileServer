import express from "express";
import * as v from "valibot";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import { rm, existsSync, unlink, Stats, ReadStream } from "node:fs";
import * as crypto from "node:crypto";
import Archiver from "archiver";
import { createReadStream } from "node:fs";
import { Readable } from "node:stream";
import { basename, join, resolve } from "node:path";
import { readdir, stat } from "node:fs/promises";

/**
 * you can pass in a string as a filename or array of strings, each entry being a filename, this will 
 * create new files transformed from the source datasets. only use this server if you want to subset or cast to another srs, otherwise just serve the file from filebrowser
 * 
 */

const app = express();
const portNo = process.env.TRANSFORM_PORT ? parseInt(process.env.TRANSFORM_PORT) : 3000;

app.use(express.json());

const REQTIMEOUT = process.env.TRANSFORM_SERVER_TIMEOUT ? parseInt(process.env.TRANSFORM_SERVER_TIMEOUT) * 1000 : 5 * 1000 * 60 //5min defualt timeout

if (process.env.TRANSFORM_SOURCE_FILES_PATH === undefined) throw TypeError("env var TRANSFORM_SOURCE_FILES_PATH is undefined");
if (process.env.TRANSFORM_FILES_PATH === undefined) throw TypeError("env var TRANSFORM_FILES_PATH is undefined");


/*streams response back to client, TTFB should be quite good performance
* req format {
        file : string | string[], //the file(s) to subset/transform
        bbox : [ minx , miny , maxx , maxy ],
        reprojectTo : string //epsg code,
        readme : string = "true" //if exists we push a zip with a simple readme auto generated ( this really can just be used to trick the browser into starting the download before the stream has started, use it in frontend always)
    }
    
    resp format : zipFile stream || file stream
*
*/
app.get("/transformDatasetStream", async (req, res) => {

    console.log(`transforming file stream requesting by: ${req.ip}   ${new Date().toISOString()}`);

    const schema = v.object({
        file: v.union([v.array(v.string()), v.string()]),
        bbox: v.optional(v.array(v.string())),
        reprojectTo: v.optional(v.string()),
        readme: v.optional(v.string())
    });

    try {
        var params = v.parse(schema, req.query);

        if (params.bbox) {
            for (let coord of params.bbox) {
                let coor = parseFloat(coord);

                if (Math.abs(coor) > 180) {
                    res.status(401).json({ "message": "invalid bbox" });

                    return;
                }
            }
        }

        if (typeof params.file === "string") {
            let tmp = params.file;

            params.file = [tmp];
        }
    }
    catch (error) {
        res.status(401).json({ "message": "invalid url search params" });
        console.log('err 401 parse schema')
        return;
    }

    if (params.bbox && params.bbox.length !== 4) {
        res.status(401).json({
            "message": "bbox has invalid number of entries"
        });
        return;
    }

    try {

        let filesToTransform = params.file;

        let absolutePaths: string[] = [];

        for (let file of filesToTransform) {

            let pth = await validateFilePathExists(file);

            if (!pth) {
                res.status(404).json({
                    "message": `${file} not found`
                });

                return;
            }

            absolutePaths.push(pth);
        }

        //all files listed exist under proper directory

        let properFileTypePromises = [];

        for (let path of absolutePaths) {
            properFileTypePromises.push(validateFileType(path));
        }

        let fileTypeResults = await Promise.all(properFileTypePromises);

        for (let result of fileTypeResults) {
            if (!result) {
                res.status(404).json({
                    "message": "invalid file type requested, not raster or vector and GDAL/OSGEO compatible"
                });

                return;
            }
        }

        //all files listed are valid raster or fgb

        //the fileresourceentries for the files we need to work with

        let relevantFileRecords: { "stats": Stats, "type": "vector" | "raster", "path": string, "basename": string }[] = [];

        let neededStats = await getFileStats(absolutePaths);

        for (let i = 0; i < fileTypeResults.length; i++) {
            relevantFileRecords.push({
                "stats": neededStats[i],
                "type": fileTypeResults[i] as any,
                "path": absolutePaths[i],
                "basename": basename(absolutePaths[i])
            });
        }

        //the archiver option
        let zipArchive: Archiver.Archiver = Archiver("zip", {
            "forceZip64": true,
            "gzipOptions": {
                "level": 0
            },
            "zlib": {
                "level": 0
            }
        });

        zipArchive.on("error", (err) => {
            console.error(`archiver exited with error: ${err}`);

            if (!res.destroyed) {
                res.destroy();
            }
        });

        res.setHeader("Content-Disposition", `attachment; filename=user_download.zip`);

        res.setHeader("Content-Type", "application/zip");

        res.setHeader("Cache-Control", "no-cache");

        //if the user wants to reproject / subset the data it gets complicated
        if (params.bbox || params.reprojectTo) {

            //details about each subproccess , if type === "raster" -> tmpFilePath is defined else undefined
            let fileStreams: {
                type: "raster" | "vector",
                tmpFilePath?: string,
                shortName: string,
                subProc: ChildProcessWithoutNullStreams,
                aborter?: AbortController,
                timeout?: NodeJS.Timeout
            }[] = [];

            //create streams and set up callback handling
            for (let fileEntry of relevantFileRecords) {

                let entryObj: {
                    type: "raster" | "vector",
                    tmpFilePath?: string,
                    shortName: string,
                    subProc: ChildProcessWithoutNullStreams,
                    aborter?: AbortController,
                    timeout?: NodeJS.Timeout
                } = {} as any;

                const FILETYPE = fileEntry.type;

                entryObj.type = FILETYPE;
                entryObj.shortName = fileEntry.basename;

                const FILENAME_IF_RASTER = `${process.env.TRANSFORM_FILES_PATH}/${crypto.randomUUID().slice(0, 7)}_${fileEntry.basename}`;

                if (FILETYPE === "raster") {
                    entryObj.tmpFilePath = FILENAME_IF_RASTER;
                }

                let subProc = startGDALSubprocess(
                    FILETYPE,
                    fileEntry.basename,
                    FILETYPE === "raster" ? FILENAME_IF_RASTER : undefined,
                    params.bbox as any,
                    params.reprojectTo,
                    true
                );

                //error in subprocess, unlink all temp files, destroy other streams, finalize corrupted zip stream and end response
                //causes res.close() to be emitted
                subProc.on("error", async (err) => {
                    console.error(`GDAL subprocess on zip exited with ${err.message}`);

                    if (existsSync(FILENAME_IF_RASTER))
                        unlink(FILENAME_IF_RASTER, () => { });

                    //cleanup others as well
                    cleanupFileStreams(fileStreams);

                    zipArchive.destroy();
                    res.end();
                });
                subProc.stdout.on("error", (err) => { console.error("GDAL Error...") });
                subProc.stderr.on("data", (data) => { console.error(data?.toString()) });

                entryObj.subProc = subProc;

                //client disconnect or we finish/destroy response
                res.on("close", (ev) => {

                    cleanupFileStreams(fileStreams);

                    if (!zipArchive.destroyed) {
                        zipArchive.destroy();
                    }
                });

                //handle timeout on raster data

                if (FILETYPE === "raster") {
                    let abortHandler = new AbortController();

                    entryObj.aborter = abortHandler;

                    abortHandler.signal.onabort = async (ev) => { //kill on timeout
                        console.warn("Killed subproces due to timeout.");
                        subProc?.kill(9);
                        if (existsSync(FILENAME_IF_RASTER))
                            unlink(FILENAME_IF_RASTER, () => { });

                        cleanupFileStreams(fileStreams);

                        zipArchive.destroy();
                        res.end();
                    };

                    let tm = setTimeout(() => {
                        if (FILETYPE === "raster") //timeout only valid if we arent directly stream downloading
                            abortHandler.abort(); //signal kill
                    }, REQTIMEOUT);

                    entryObj.timeout = tm;
                }


                //add process to tracking array
                fileStreams.push(entryObj);

            }

            //start piping the vector (if any) streams to zip
            for (let stream of fileStreams) {
                if (stream.type === "vector")
                    zipArchive.append(stream.subProc.stdout, { "name": stream.shortName });
            }

            //we want an instant response even if the vector or raster streams arent instant, so if params.readme is spefified
            //we write a simple dummy readme for the user thand pipe it

            if (params.readme) {
                let readmeContent: string = "We hope you like your data!\n\nNote that if you subsetted and reprojected your data, the bounds may be slightly larger than you expected if the reprojection was considerable.\nReprojections change coordinate spaces and we use approximate bounds to speedup the download process."

                let readmeStream = Readable.from(readmeContent);

                zipArchive.append(readmeStream, { "name": "readme.txt" });
            }

            zipArchive.pipe(res);

            let subprocPromises: Promise<any[]>[] = [];

            for (let subproc of fileStreams) {
                subprocPromises.push(once(subproc.subProc, "close"));
            }

            let promErr: boolean = false;

            let exitCodes = await Promise.all(subprocPromises).catch((err) => {
                console.error(`streaming subprocesses Promise.all() rejected for: ${err?.toString()}`);

                if (!res.destroyed) res.destroy();

                promErr = true;
            }); //pause here to wait for all to finish

            //clear existing timeouts
            for (let stream of fileStreams) {
                if (stream.timeout) clearTimeout(stream.timeout);
            }

            if (promErr) return;

            //all processes exited, check exit codes
            for (let code of exitCodes as any[][]) {
                if (code[0] !== 0) { //error
                    console.error(`error in stream subprocess exited with code: ${code[0]}`);

                    if (!res.destroyed) res.destroy();

                    return; //exit function
                }
            }

            //now we need to pipe any raster output to the respoonse stream

            let finishedRasterStreamDetails = fileStreams.map((el) => {
                if (el.type !== "raster") return undefined;

                return { path: el.tmpFilePath, name: el.shortName };
            }).filter((el) => { return el !== undefined });

            let readableFileStreams: { "stream": ReadStream, "name": string }[] = [];

            for (let raster of finishedRasterStreamDetails) {
                readableFileStreams.push({
                    stream: createReadStream(raster.path as string),
                    name: raster.name
                });
            }

            //end response on error and cleanup
            for (let stream of readableFileStreams) {
                stream.stream.on("error", (err) => {
                    console.error(`error in readable raster filestream: ${err?.toString()}`);

                    for (let stream of readableFileStreams) {
                        if (!stream.stream.closed) {
                            stream.stream.destroy();
                        }
                    }

                    if (!res.destroyed) res.destroy();
                });
            }

            //have all the read streams, add them to the zip download

            for (let readStream of readableFileStreams) {
                zipArchive.append(readStream.stream, { "name": readStream.name });
            }
        }
        else {

            let streams: ReadStream[] = [];

            let streamPromises = [];

            let err: boolean = false;

            for (let fileEntry of relevantFileRecords) {

                let stream = createReadStream(fileEntry.path);

                streams.push(stream);

                stream.on("error", (er) => {

                    if (!res.destroyed) {
                        res.destroy();
                    }

                    if (!zipArchive.destroyed) {
                        zipArchive.destroy();
                    }

                    err = true;
                });

                streamPromises.push(once(stream, "close"));

                zipArchive.append(stream, {
                    "name": fileEntry.basename,
                    "stats": fileEntry.stats
                });

            }

            zipArchive.pipe(res);

            let [exitCodes] = await Promise.all(streamPromises);

            if (err) {
                console.error(`error in stream`);
                return;
            }

        }
        //should be streaming from temp file to archive now, which is piped to res.

        await zipArchive.finalize();
    } catch (error) {

        if ((error as any).code && (error as any).code === 'EMFILE') {
            throw Error("Hit file descriptor limit, mem leak possible");
        }

        if (!res.closed) res.end();
        console.error("error handling files..");
        return;
    }


});

app.get("/list", async (req, res) => {

    const schema = v.object({
        "dir": v.string()
    });

    try {
        var params = v.parse(schema, req.query);
    }
    catch (error) {
        res.status(400).json({ "message": "include the 'dir' query param to list for a directory relative to the base." });
        return;
    }

    let path = await validateDirectoryPath(params.dir);

    if (!path) {
        res.status(404).send();
        return;
    }

    let dirContent = await readdir(path);
    let dirContentTypes = await readdir(path, { withFileTypes: true });

    let details: { "name": string, "size": number, "isDir": boolean, "path": string }[] = [];

    for (let i = 0; i < dirContent.length; i++) {

        let fullPath = dirContentTypes[i].isDirectory() ? await validateDirectoryPath(join(path, dirContent[i]), false) : await validateFilePathExists(join(path, dirContent[i]), false);

        if (!fullPath) {
            res.status(404).json({ "message": "directory not found" });
            return;
        }

        let stats = await stat(fullPath);

        details.push({
            "name": basename(dirContent[i]),
            "path": join(path, dirContent[i]),
            "size": stats.size,
            "isDir": dirContentTypes[i].isDirectory()
        });
    }

    return res.status(200).json(details);
});

app.get("/health", (_, res) => {
    res.status(200).send();
});

app.listen(portNo, '0.0.0.0', () => {
    console.log(`Geo file transform server started on internal docker port ${portNo}`);
});

/**
 * 
 * @param path the stirng path given by a user
 * @returns the normalized basolute path to the file, that must be within TRANSFORM_SOURCE_FILES_PATH dir, or undefined if err
 * @description validates that a file path given by the user is within the proper TRANSFORM_SOURCE_FILES_PATH dir and exists
 */
async function validateFilePathExists(path: string, prepend: boolean = true): Promise<string | undefined> {

    let absolute = resolve(prepend ? join(process.env.TRANSFORM_SOURCE_FILES_PATH as string, path) : path);

    if (!absolute.startsWith(process.env.TRANSFORM_SOURCE_FILES_PATH as string)) return undefined;

    if (!existsSync(absolute)) return undefined;

    if (!(await stat(absolute)).isFile()) return undefined;

    return absolute;
}

async function validateDirectoryPath(path: string, prepend: boolean = true): Promise<string | undefined> {
    let absolute = resolve(prepend ? join(process.env.TRANSFORM_SOURCE_FILES_PATH as string, path) : path);

    if (!absolute.startsWith(process.env.TRANSFORM_SOURCE_FILES_PATH as string)) return undefined;

    if (!existsSync(absolute)) return undefined;

    if (!(await stat(absolute)).isDirectory()) {
        console.warn(`path not dir ${absolute}`);
        return undefined;
    }

    return absolute;
}

/**
 * 
 * @param path the absolute path to file
 * @description validates that a file path is a raster or flatgeobuffer file
 */
async function validateFileType(path: string): Promise<"raster" | "vector" | undefined> {

    let isRaster = spawn("gdalinfo", [path]);

    let isFGB = spawn("ogrinfo", [path]);

    let results = await Promise.all([once(isRaster, "close"), once(isFGB, "close")]);

    return results[0][0] !== 0 && results[1][0] !== 0 ? undefined : results[0][0] === 0 ? "raster" : results[1][0] === 0 ? "vector" : undefined;
}

async function getFileStats(files: string[]): Promise<Stats[]> {

    let stats: Stats[] = [];

    for (let path of files) {
        stats.push(await stat(path));
    }

    return stats;
}

//space delimete bbox string
function getBboxAsStringArray(bbox: [number, number, number, number] | [string, string, string, string]): string[] {
    return [bbox[0].toString(), bbox[1].toString(), bbox[2].toString(), bbox[3].toString()];
}

//we dpeend on GDAL/osgeo libs to handle the subsetting an dreprojecting, server just orchestrates
//if piping to stdout , onlt geotiff and flatgeobuf drivers are supported, feel free to add more
function startGDALSubprocess(
    type: "vector" | "raster",
    src: string, //src dataset in root files dir
    dst?: string, //dst dataset in files dir/tmp
    bbox?: [number, number, number, number] | undefined, //assumed in epsg 4326
    targSrs?: string | undefined,
    sendToStdout: boolean = false //only affects for 'vector' type , cant stream rasters directly
): ChildProcessWithoutNullStreams {

    if (!sendToStdout && !dst) throw new TypeError("no destination file specified");

    if (type !== "raster" && type !== "vector") throw new TypeError("invalid type param passed");

    var subProc: ChildProcessWithoutNullStreams | undefined = undefined;

    if (type === 'raster') { //use gdal here to subset and/or reproject

        //[ minx , miny , maxx , maxy ]
        subProc = spawn("gdalwarp", [
            bbox ? "-te" : undefined, bbox ? getBboxAsStringArray(bbox)[0] : undefined, bbox ? getBboxAsStringArray(bbox)[1] : undefined, bbox ? getBboxAsStringArray(bbox)[2] : undefined, bbox ? getBboxAsStringArray(bbox)[3] : undefined,
            bbox ? "-te_srs" : undefined, bbox ? "EPSG:4326" : undefined,
            "-q",
            "-of", "GTiff",
            targSrs ? "-t_srs" : undefined, targSrs ? targSrs : undefined,
            "-co", "COMPRESS=LZW",
            "-co", "TILED=YES",
            "-co", "SPARSE_OK=YES",
            process.env.TRANSFORM_SOURCE_FILES_PATH + "/" + src, //src
            dst //dst
        ].filter((el) => el !== undefined));
    }
    else if (type === "vector") { //ogr util to subset/reproject here
        subProc = spawn("ogr2ogr", [
            bbox ? "-spat" : undefined, bbox ? getBboxAsStringArray(bbox)[0] : undefined, bbox ? getBboxAsStringArray(bbox)[1] : undefined, bbox ? getBboxAsStringArray(bbox)[2] : undefined, bbox ? getBboxAsStringArray(bbox)[3] : undefined,
            bbox ? "-spat_srs" : undefined, bbox ? "EPSG:4326" : undefined,
            targSrs ? "-t_srs" : undefined, targSrs ? targSrs : undefined,
            "-f", "FlatGeobuf",
            sendToStdout ? "-lco" : undefined, sendToStdout ? "SPATIAL_INDEX=NO" : undefined,
            sendToStdout ? "/vsistdout/dummy.fgb" : dst, //dst
            process.env.TRANSFORM_SOURCE_FILES_PATH + "/" + src //src
        ].filter((el) => el !== undefined));
    }

    return subProc as ChildProcessWithoutNullStreams;
}

//kill subproccesses and unlink temp files
function cleanupFileStreams(streams: {
    type: "raster" | "vector",
    tmpFilePath?: string,
    subProc: ChildProcessWithoutNullStreams,
    aborter?: AbortController
}[]) {
    for (let str of streams) {
        if (!str.subProc.killed) {
            str.subProc.kill(9);
        }

        if (str.tmpFilePath) {
            if (existsSync(str.tmpFilePath))
                unlink(str.tmpFilePath, () => { });
        }
    }
}