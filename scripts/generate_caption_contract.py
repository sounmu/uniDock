"""Read public Python caption fixtures/projections only; no module imports or writes to reference."""
import ast
import hashlib
import html
import json
from pathlib import Path
import re
import sys

root = Path(__file__).resolve().parents[1]
arguments = [arg for arg in sys.argv[1:] if arg != '--check']
reference = Path(arguments[0]) if arguments else root.parent / 'ku-lms-cli'
paths = ['src/ku_lms_cli/captions.py', 'src/ku_lms_cli/live.py', 'tests/test_provider_cli_core.py']
texts = {path:(reference/path).read_text() for path in paths}
names = {'is_korean_caption_track','_caption_body_to_plain_text','_plain_caption_lines','_plain_caption_json','_looks_like_javascript_body'}
functions = [node for path in paths[:2] for node in ast.parse(texts[path]).body if isinstance(node,ast.FunctionDef) and node.name in names]
assert len(functions) == len(names)
scope = {'Any':object,'html':html,'re':re,'json':json}
exec(compile(ast.Module(body=functions,type_ignores=[]),'public-caption-contract','exec'),scope)
cases = []
for node in ast.parse(texts[paths[2]]).body:
    if isinstance(node,ast.FunctionDef) and node.name in {'test_live_recording_captions_cli_uses_course_and_optional_title','test_recording_captions_cli_saves_only_korean_track_with_week_session_timestamp'}:
        method = next(child for child in ast.walk(node) if isinstance(child,ast.FunctionDef) and child.name == 'recording_captions')
        returned = next(child for child in method.body if isinstance(child,ast.Return))
        tracks = ast.literal_eval(returned.value)['tracks']
        expected = [{'label':track['label'],'source':track['source'],'text':scope['_caption_body_to_plain_text'](track['text'])+'\n'} for track in tracks if scope['is_korean_caption_track'](track)]
        cases.append({'name':node.name,'tracks':tracks,'expected':expected})
assert len(cases) == 2
value = {'provenance':{path:hashlib.sha256(text.encode()).hexdigest() for path,text in texts.items()},'cases':cases}
serialized = json.dumps(value,ensure_ascii=False,indent=2)+'\n'
target = root/'tests/fixtures/python-captions.json'
if '--check' in sys.argv:
    if target.read_text() != serialized: raise SystemExit('Public caption contract drift detected.')
    print('Public Python caption contract matches.')
else:
    target.write_text(serialized)
    print('Generated public Python caption contract.')
