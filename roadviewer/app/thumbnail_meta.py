"""prepared/thumbnail.json, beside thumbnail.jpg: how the thumbnail was made and how good its picture is.

Without PyAV (thumbnail.py imports it), so the list and the backfill can read it. A thumbnail.jpg without this file
(or with an older version) came from an older way of choosing the frame: the backfill makes it again.

version 2: the best-exposed of a few frames in the first seconds, then levelled (thumbnail.py). score: how well
exposed that frame was before levelling; the drive card shows the segment with the highest one (library.js)."""
import json

NAME='thumbnail.json'
VERSION=2

def read(prepared):
 # {} when there is none or it does not parse: an old thumbnail.
 try:info=json.loads((prepared/NAME).read_text())
 except (OSError,ValueError):return {}
 return info if isinstance(info,dict) else {}

def current(prepared):
 return read(prepared).get('version')==VERSION
