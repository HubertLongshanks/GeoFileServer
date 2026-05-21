# About This Server Component

## Why This Exists
We have fairly large geospatial datasets that we host here (the ones in file format) - we want to be able to subset and combine them fairly freely.

This is best done through the GDAL utilities and so we use a small nodeJS server here to provide an API layer that can be called. The server simply prepares files by subsetting them or transforming their CRS to the specified, it then makes those files available to the fileserver so they can be served to users via the FileBrowser API.

It is seperated from the main Node Server (under /app) as this process is compute intensive and we dont want it interferring with other functions of the app ( like answering queries or serving content), if file downloaidg gets overwhelmed it shouldnt break the rest of the app.

## What It Does
The server subsets and transforms geospatial data based on the passed coordinates and the specified CRS and then writes them to a file(s), returning those file(s) name(s) or streaming the file(s) to the caller of the method 