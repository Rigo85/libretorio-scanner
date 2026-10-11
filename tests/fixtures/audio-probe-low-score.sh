#!/bin/sh
for input do :; done
case "$input" in /proc/[0-9]*/fd/[0-9]*) ;; *) exit 2 ;; esac
printf '{"streams":[{"codec_type":"audio","codec_name":"mp3"}],"format":{"format_name":"mp3","duration":"1","probe_score":1}}\n'
