def align_timeline(frames, video):
 """Use the union of model and synchronized video coverage, starting at zero."""
 start=min(frames[0]['t'],video['start'] if video else frames[0]['t'])
 for frame in frames:frame['t']=round(frame['t']-start,6)
 if video:video['start']=round(video['start']-start,6)
 log_start,log_end=frames[0]['t'],frames[-1]['t']
 end=max(log_end,video['start']+video['duration'] if video else log_end)
 return {'duration':end,'logStart':log_start,'logEnd':log_end}
