#!/bin/bash
#this is a shell script that we can set as a crontab to delete the temp files 
#created by user downloads every
#60 minutes or so

#set this to be the path to the temp files
find "/home/hugh/wildfire_interactive_map/server/FILE_SERVER/FILES/tmp" -type f -mmin +30 ! -name ".gitinclude" -delete