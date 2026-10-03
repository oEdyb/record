import importlib.util
from pathlib import Path
from types import SimpleNamespace
import unittest

spec = importlib.util.spec_from_file_location('verify_resolve', Path(__file__).with_name('verify-source-handoff-resolve.py'))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class ResolveOwnershipTests(unittest.TestCase):
    def setUp(self):
        self.created = []
        self.imported = []
        self.selected = []
        self.timeline = SimpleNamespace(
            GetName=lambda: 'Source timeline', GetUniqueId=lambda: 'owned-timeline',
            GetSettings=lambda: {'timelineFrameRate': '60'}, GetStartFrame=lambda: 0,
            GetEndFrame=lambda: 7200, GetCurrentTimecode=lambda: '00:00:01:00',
            SetCurrentTimecode=lambda value: self.selected.append(value) or True,
            GetTrackCount=lambda kind: 2, GetTrackName=lambda kind, index: f'{kind} {index}',
            GetItemListInTrack=lambda kind, index: [],
        )
        self.owned = SimpleNamespace(
            GetName=lambda: 'Klippt source quality verification 2026-10-03 test',
            GetUniqueId=lambda: 'owned-project',
            GetMediaPool=lambda: SimpleNamespace(ImportTimelineFromFile=lambda filename: self.imported.append(filename) or self.timeline),
            SetCurrentTimeline=lambda timeline: timeline is self.timeline,
        )
        self.original = SimpleNamespace(
            GetName=lambda: 'Existing user project', GetUniqueId=lambda: 'original-project',
            GetCurrentTimeline=lambda: None,
        )
        self.manager = SimpleNamespace(
            GetCurrentProject=lambda: self.original,
            GetProjectListInCurrentFolder=lambda: ['Existing user project'],
            CreateProject=lambda name: self.created.append(name) or self.owned,
        )
        self.resolve = SimpleNamespace(
            GetProjectManager=lambda: self.manager, GetCurrentPage=lambda: 'edit',
            GetVersionString=lambda: '21.1.0.17', OpenPage=lambda page: True,
        )
        self.config = {'projectName': self.owned.GetName(), 'timelinePath': '/tmp/owned sources/timeline.otio'}

    def test_creates_only_owned_project_and_returns_original_identity(self):
        result = module.import_owned_source_timeline(self.resolve, self.config)
        self.assertEqual(self.created, [self.config['projectName']])
        self.assertEqual(self.imported, [self.config['timelinePath']])
        self.assertEqual(result['original']['id'], 'original-project')
        self.assertEqual(result['project']['id'], 'owned-project')
        self.assertEqual(len(result['tracks']), 4)

    def test_rejects_unowned_or_existing_project_before_any_creation(self):
        for name in ['Existing user project', 'Klippt source quality verification 2026-10-03 existing']:
            self.manager.GetProjectListInCurrentFolder = lambda: [name]
            with self.assertRaises(RuntimeError):
                module.import_owned_source_timeline(self.resolve, {**self.config, 'projectName': name})
        self.assertEqual(self.created, [])
        self.assertEqual(self.imported, [])

    def test_import_failure_is_not_a_success_receipt(self):
        self.owned.GetMediaPool = lambda: SimpleNamespace(ImportTimelineFromFile=lambda filename: None)
        with self.assertRaisesRegex(RuntimeError, 'rejected'):
            module.import_owned_source_timeline(self.resolve, self.config)

    def test_unlinked_import_item_is_not_verified(self):
        self.timeline.GetItemListInTrack = lambda kind, index: [SimpleNamespace(GetMediaPoolItem=lambda: None)]
        with self.assertRaisesRegex(RuntimeError, 'linked media'):
            module.import_owned_source_timeline(self.resolve, self.config)

    def test_preserves_camera30_source_units_and_records_audio_timeline_tolerance(self):
        def items(kind, index):
            if (kind, index) not in [('video', 2), ('audio', 1)]:
                return []
            media = SimpleNamespace(
                GetUniqueId=lambda: 'owned-media',
                GetClipProperty=lambda key=None: '/tmp/owned/camera.mov' if key else {'FPS': '30' if kind == 'video' else ''},
            )
            return [SimpleNamespace(
                GetMediaPoolItem=lambda: media, GetName=lambda: 'owned-item', GetUniqueId=lambda: 'owned-item-id',
                GetStart=lambda precise: 60, GetEnd=lambda precise: 180,
                GetSourceStartTime=lambda: 1.0, GetSourceEndTime=lambda: 3 - 1 / 30,
                GetSourceStartFrame=lambda: 30, GetSourceEndFrame=lambda: 89,
            )]
        self.timeline.GetItemListInTrack = items
        tracks = module.resolve_track_snapshot(self.timeline)
        camera = tracks[1]['clips'][0]
        self.assertEqual((camera['start'], camera['end']), (60, 180))
        self.assertEqual((camera['sourceStartFrame'], camera['sourceEndFrame']), (30, 89))
        self.assertEqual(camera['sourceStartSec'], 1.0)
        self.assertAlmostEqual(camera['sourceTimeToleranceSec'], 1 / 30 + 0.001)
        self.assertEqual(camera['sourceTimeToleranceBasis'], 'media frame')
        microphone = tracks[2]['clips'][0]
        self.assertAlmostEqual(microphone['sourceTimeToleranceSec'], 1 / 60 + 0.001)
        self.assertIn('audio has no video FPS', microphone['sourceTimeToleranceBasis'])


if __name__ == '__main__':
    unittest.main()
