"""Developer-only golden contract generator; never imported by the extension.

Reads only two named public source files, not env/config/discovery artifacts.
Extracts literal FakeSession responses and executes only selected pure projection/discovery
functions via AST (no imports or provider/login code from the reference repo).
"""
import ast
import asyncio
import hashlib
import json
from datetime import datetime, timezone
from pathlib import Path
import sys
from types import SimpleNamespace

root = Path(__file__).resolve().parents[1]
arguments = [arg for arg in sys.argv[1:] if arg != "--check"]
reference = Path(arguments[0]) if arguments else root.parent / "ku-lms-cli"
source = (reference / "src/ku_lms_cli/live.py").read_text()
tests = (reference / "tests/test_live_provider.py").read_text()
source_tree, test_tree = ast.parse(source), ast.parse(tests)
selected_names = {"_public_assignment", "_public_planner_item", "_public_todo_item", "_remaining_candidate", "_recording_candidates", "_fetch_recording_pages", "_recording_accessible", "_looks_like_handout", "_public_recording"}
selected = [node for node in source_tree.body if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) and node.name in selected_names]
assert len(selected) == len(selected_names)
provider = next(node for node in source_tree.body if isinstance(node, ast.ClassDef) and node.name == "LiveLmsProvider")
deadlines = next(node for node in provider.body if isinstance(node, ast.FunctionDef) and node.name == "deadlines")
selected.append(deadlines)
fixed_now = "2026-09-11T00:00:00Z"

class FrozenDatetime(datetime):
    @classmethod
    def now(cls, tz=None):
        return datetime(2026, 9, 11, tzinfo=timezone.utc)

scope = {"datetime": FrozenDatetime, "timezone": timezone, "Any": object, "LiveCommandError": RuntimeError}
exec(compile(ast.Module(body=selected, type_ignores=[]), "public-reference-projections", "exec"), scope)
fake = next(node for node in test_tree.body if isinstance(node, ast.ClassDef) and node.name == "FakeSession")
fetch = next(node for node in fake.body if isinstance(node, ast.AsyncFunctionDef) and node.name == "fetch_json")
paths = {"recordings": "/api/v1/courses/101/modules", "courses": "/api/v1/courses?", "assignments": "/api/v1/courses/101/assignments", "upcoming": "/api/v1/planner/items?", "todo": "/api/v1/users/self/todo?"}
raw = {}
for branch in fetch.body:
    if isinstance(branch, ast.If) and isinstance(branch.test, ast.Call):
        prefix = ast.literal_eval(branch.test.args[0])
        for name, path in paths.items():
            if prefix == path:
                literal = next(node for node in branch.body if isinstance(node, ast.Return))
                raw[name] = ast.literal_eval(literal.value)
assert len(raw) == 5

class RecordingFixture:
    async def fetch_json(self, path):
        assert path == '/api/v1/courses/101/modules?per_page=100&include[]=items'
        return raw['recordings']


def expected(data):
    assignments = [scope['_public_assignment'](item) for item in data['assignments']]
    result = {
        'assignments': assignments,
        'deadlines': scope['deadlines'](SimpleNamespace(assignments=lambda course: assignments), '국제법'),
        'upcoming': [scope['_public_planner_item'](item) for item in data['upcoming']],
        'todo': [scope['_public_todo_item'](item) for item in data['todo']],
    }
    if 'recordings' in data:
        candidates = asyncio.run(scope['_recording_candidates'](RecordingFixture(), {'id':101,'name':'국제법'}))
        result['recordings'] = [scope['_public_recording'](item) for item in candidates]
    return result

# Additional public synthetic edge cases evaluated by the same Python functions.
edge = {
    'assignments': [
        {}, {'title': '제목 대체', 'due_at': None, 'submission': None},
        {'name': '진행 중', 'due_at': '2099-01-01T00:00:00Z'},
        {'name': '잠김', 'due_at': '2099-01-01T00:00:00Z', 'locked_for_user': True},
        {'name': '제출됨', 'due_at': '2099-01-01T00:00:00Z', 'submission': {'submitted_at': '2026-01-01T00:00:00Z'}},
        {'name': '채점됨', 'due_at': '2099-01-01T00:00:00Z', 'submission': {'workflow_state': 'graded', 'missing': True, 'late': True}},
        {'name': '제출 상태', 'due_at': '2099-01-01T00:00:00Z', 'submission': {'workflow_state': 'submitted'}},
        {'name': '마감 지남', 'due_at': '2000-01-01T00:00:00Z'},
        {'name': '경계 시각', 'due_at': fixed_now},
        {'name': 'UTC 기본값', 'due_at': '2026-09-11T00:00:01'},
        {'name': '시차', 'due_at': '2026-09-11T09:00:00+09:00'},
        {'name': '잘못된 날짜', 'due_at': 'not-a-date'},
        {'name': '달력 범위 오류', 'due_at': '2099-02-30T00:00:00Z'},
        {'name': '미공개도 원본 유지', 'due_at': '2099-01-01', 'published': False, 'points_possible': 0, 'submission_types': []},
    ],
    'upcoming': [
        {}, {'title': '최상위 제목', 'plannable': None, 'submissions': False},
        {'plannable': {'name': '이름 대체', 'due_at': '2026-09-12', 'type': 'quiz'}, 'submissions': {'submitted_at': '2026-09-10'}, 'new_activity': True},
        {'title': '후순위', 'plannable_date': '2026-09-13', 'plannable_type': 'assignment', 'plannable': {'title': '우선 제목', 'due_at': '2026-09-12'}, 'submissions': {'submitted': True}, 'context_name': '샘플 과목'},
    ],
    'todo': [
        {}, {'type': 'submitting', 'assignment': None},
        {'type': 'submitting', 'assignment': {'title': '대체 제목', 'due_at': None}, 'ignore': True},
        {'type': 'grading', 'assignment': {'name': '이름 우선', 'title': '후순위', 'due_at': '2026-09-13'}, 'context_name': '샘플 과목'},
    ],
}
remaining_test = next(node for node in test_tree.body if isinstance(node, ast.FunctionDef) and node.name == 'test_remaining_candidate_logic')
remaining = []
for node in remaining_test.body:
    call = node.test.left
    args = [ast.literal_eval(value) for value in call.args]
    result = ast.literal_eval(node.test.comparators[0])
    assert scope['_remaining_candidate'](*args) == result
    remaining.append({'args': args, 'expected': result})
output = {
    'provenance': {'source': 'ku-lms-cli/tests/test_live_provider.py::FakeSession', 'source_sha256': hashlib.sha256(source.encode()).hexdigest(), 'tests_sha256': hashlib.sha256(tests.encode()).hexdigest(), 'now': fixed_now},
    'raw': raw, 'expected': expected(raw), 'edge': {'raw': edge, 'expected': expected(edge)}, 'remaining': remaining,
}
target = root / 'tests/fixtures/python-contract.json'
serialized = json.dumps(output, ensure_ascii=False, indent=2) + '\n'
if '--check' in sys.argv:
    if target.read_text() != serialized:
        raise SystemExit('Public Python contract drift detected; review and regenerate.')
    print('Public Python contract matches the read-only reference.')
else:
    target.write_text(serialized)
    print('Generated public fixture contract (no reference imports or writes).')
