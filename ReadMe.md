# GeoFileServer
This is a small (Work In Progress) repo that implements a streaming based file server mainly directed towards GeoTIFF and FlatGeoBuffer files.
The server exposes a few REST endpoints that allow for (hopefully) efficient streaming of geographic files, subsets of those files and reprojections ( and any combiination thereof ) to a client. 

## Why
Geographic file servers exist (a la GeoServer) and are *Very* good at what they do - but sometimes it's too much. For a portion of a project where all you want to do is efficiently stream some spatial files stored on disk to some client ( maybe put it behind Nginx and add some rate limits ) and allow for reprojection/subsetting - GeoServer can feel like overkill. This gets that portion up and running in 5 minutes, hopefully.

## How do I Use It?
Clone the repo, run ```sh npm run build``` and ```sh npm run postbuild``` and build the docker image, thats it.

When you run the container - bind the directry you want to serve files out of on your host to the */files* path in the container - any files/directories there will be accessible to the server.

The server runs on port 3000 in the container.

E.g.
```sh
docker run mycontainer -p 3000:3000 -v /path/to/my/files:/files
```

And you should be off to the races.

## API
The server is *Super* simple and only exposes 3 endpoints (right now), the streaming endpoint, an endpoint to list files/directories and a healthcheck.

### /transformDatasetStream

*Method*
GET

*Query Params*
```txt
{
    file : string | string[], //the file(s) to subset/transform
    bbox? : [ minx , miny , maxx , maxy ],
    reprojectTo? : string //epsg code,
    readme? : boolean //if exists we push a zip with a simple readme auto generated ( this really can just be used to trick the browser into starting the download before the stream has started, can be nice with large TIFF files)
}
```

*Returns*
A zipfile stream with your data in it, reprojected, subsetted to a BBOX and so forth

### /list

*Method*
GET

*Query Params*
```txt
{
    dir : string #the subdirectory to list ( or "/" for root of serving directory)
}
```

*Returns*
```txt
{ 
    "name": string, 
    "size": number, #in bytes
    "isDir": boolean, 
    "path": string 
}[]
```

### /health

*Method*
GET

*Returns*
status code 200
