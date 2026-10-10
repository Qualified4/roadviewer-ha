def align_timeline(frames, video, videos=None):
 """Use the union of model and synchronized video coverage, starting at zero."""
 streams=list(videos.values()) if videos is not None else ([video] if video else [])
 start=min([frames[0]['t']]+[item['start'] for item in streams])
 for frame in frames:frame['t']=round(frame['t']-start,6)
 for item in streams:item['start']=round(item['start']-start,6)
 log_start,log_end=frames[0]['t'],frames[-1]['t']
 end=max([log_end]+[item['start']+item['duration'] for item in streams])
 return {'duration':end,'logStart':log_start,'logEnd':log_end}
