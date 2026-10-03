def resolve_track_snapshot(timeline):
    base = timeline.GetStartFrame()
    timeline_rate = float(timeline.GetSettings().get('timelineFrameRate'))
    tracks = []
    for kind in ['video', 'audio']:
        for index in range(1, timeline.GetTrackCount(kind) + 1):
            clips = []
            for item in timeline.GetItemListInTrack(kind, index):
                media = item.GetMediaPoolItem()
                if not media:
                    raise RuntimeError('Imported timeline item has no linked media')
                properties = media.GetClipProperty()
                media_rate = float(properties.get('FPS') or 0)
                if kind == 'video' and not media_rate > 0:
                    raise RuntimeError('Imported video has no measured media frame rate')
                source_rate = media_rate if kind == 'video' else timeline_rate
                clips.append({
                    'name': item.GetName(),
                    'id': item.GetUniqueId(),
                    'start': item.GetStart(True) - base,
                    'end': item.GetEnd(True) - base,
                    'sourceStartSec': item.GetSourceStartTime(),
                    'sourceEndSec': item.GetSourceEndTime(),
                    'sourceStartFrame': item.GetSourceStartFrame(),
                    'sourceEndFrame': item.GetSourceEndFrame(),
                    'media': media.GetClipProperty('File Path'),
                    'mediaId': media.GetUniqueId(),
                    'mediaProperties': properties,
                    'sourceTimeToleranceSec': 1 / source_rate + 0.001,
                    'sourceTimeToleranceBasis': 'media frame' if kind == 'video' else 'timeline frame (audio has no video FPS)',
                })
            tracks.append({'kind': kind, 'index': index, 'name': timeline.GetTrackName(kind, index), 'clips': clips})
    return tracks


def import_owned_source_timeline(resolve, config):
    manager = resolve.GetProjectManager()
    original = manager.GetCurrentProject()
    original_timeline = original.GetCurrentTimeline() if original else None
    original_state = {
        'name': original.GetName() if original else None,
        'id': original.GetUniqueId() if original else None,
        'timelineName': original_timeline.GetName() if original_timeline else None,
        'timelineId': original_timeline.GetUniqueId() if original_timeline else None,
        'timecode': original_timeline.GetCurrentTimecode() if original_timeline else None,
        'page': resolve.GetCurrentPage(),
    }
    prefix = 'Klippt source quality verification 2026-10-03 '
    if not config['projectName'].startswith(prefix):
        raise RuntimeError('Refusing a project outside this isolated validation')
    if config['projectName'] in manager.GetProjectListInCurrentFolder():
        raise RuntimeError('The owned test project must be new')
    owned = manager.CreateProject(config['projectName'])
    if not owned:
        raise RuntimeError('Could not create the isolated Resolve test project')
    imported = owned.GetMediaPool().ImportTimelineFromFile(config['timelinePath'])
    if not imported:
        raise RuntimeError('Resolve rejected the exported OTIO')
    if not owned.SetCurrentTimeline(imported):
        raise RuntimeError('Could not select the owned imported timeline')
    resolve.OpenPage('edit')
    imported.SetCurrentTimecode('00:00:01:00')
    return {
        'version': resolve.GetVersionString(),
        'original': original_state,
        'project': {'name': owned.GetName(), 'id': owned.GetUniqueId()},
        'timeline': {
            'name': imported.GetName(), 'id': imported.GetUniqueId(),
            'rate': imported.GetSettings().get('timelineFrameRate'),
            'startFrame': imported.GetStartFrame(), 'endFrame': imported.GetEndFrame(),
            'timecode': imported.GetCurrentTimecode(),
        },
        'tracks': resolve_track_snapshot(imported),
    }
