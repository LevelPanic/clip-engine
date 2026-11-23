#!/usr/bin/env python3
"""What each subagent run cost, and whether it looked. One line per run.

    python3 tools/agent-runs.py                  # runs of the last 24 hours
    python3 tools/agent-runs.py --hours 3 expert # last 3 hours, briefs containing "expert"
    python3 tools/agent-runs.py --commands ...   # also print each run's shell commands

Run it from the project root. It reads Claude Code's own subagent logs for this project
(~/.claude/projects/<project>/<session>/subagents/agent-*.jsonl). That format is not a contract:
if the numbers come back empty after an update, the log layout changed.

Columns: model, turns (one model reply with its tool calls), shell calls, stills the run was shown
(paths printed by `clip frames` or a dossier) and how many of those it read, verdict saves and
refusals, cached tokens re-read, and the cost at API list prices. The cost is a yardstick for how
much of a usage limit a run takes, not a bill. An agent re-reads its whole conversation every turn,
so cost follows turns times context: the dossier exists to keep both small.
"""
import collections
import glob
import json
import os
import re
import sys
import time

# $ per million tokens: input, output, cache read. List prices as of 2026-11; cache write = 1.25x input (5 min) or 2x (1 h).
PRICE = {
    'claude-fable-5-2': (8.0, 40.0, 0.20),
    'claude-opus-5-5': (4.0, 20.0, 0.20),
    'claude-sonnet-5-5': (2.0, 10.0, 0.10),
    'claude-haiku-5-5': (0.10, 0.50, 0.01),
}

args = sys.argv[1:]
hours = 24.0
commands = False
keep = []
while args:
    a = args.pop(0)
    if a == '--hours':
        hours = float(args.pop(0))
    elif a == '--commands':
        commands = True
    else:
        keep.append(a.lower())

project = os.getcwd().replace('/', '-')
logs = glob.glob(os.path.expanduser(f'~/.claude/projects/{project}/*/subagents/agent-*.jsonl'))
logs = sorted((f for f in logs if os.path.getmtime(f) >= time.time() - hours * 3600), key=os.path.getmtime)
if not logs:
    sys.exit(f'no subagent runs in the last {hours:g} h under ~/.claude/projects/{project}')

total_cost = 0.0
total_turns = 0
shown_runs = 0
for f in logs:
    prompt = ''
    model = ''
    usage = {}
    bash = []
    calls = {}
    shown, read = set(), set()
    saves = refusals = 0
    for line in open(f):
        try:
            d = json.loads(line)
        except ValueError:
            continue
        m = d.get('message') or {}
        c = m.get('content')
        if d.get('type') == 'user' and not prompt:
            prompt = c if isinstance(c, str) else ' '.join(b.get('text', '') for b in c or [] if isinstance(b, dict) and b.get('type') == 'text')
        if d.get('type') == 'assistant':
            model = m.get('model') or model
            if m.get('id'):
                usage[m['id']] = m.get('usage') or usage.get(m['id'], {})
        if not isinstance(c, list):
            continue
        for b in c:
            if not isinstance(b, dict):
                continue
            if b.get('type') == 'tool_use':
                inp = b.get('input') or {}
                calls[b.get('id')] = b.get('name')
                if b.get('name') == 'Bash':
                    bash.append(inp.get('command', ''))
                if b.get('name') == 'Read' and str(inp.get('file_path', '')).endswith('.jpg'):
                    read.add(os.path.basename(inp['file_path']))
            if b.get('type') == 'tool_result' and calls.get(b.get('tool_use_id')) == 'Bash':
                rc = b.get('content')
                text = rc if isinstance(rc, str) else ' '.join(x.get('text', '') for x in rc or [] if isinstance(x, dict))
                shown.update(re.findall(r'/frames/(\d+(?:_\d+)?\.jpg)', text))
                refusals += len(re.findall(r'✖ refused', text))
                saves += len(re.findall(r'^saved \d+', text, re.M))
    if keep and not any(k in prompt.lower() for k in keep):
        continue
    t = collections.Counter()
    w5 = w1h = 0
    for u in usage.values():
        for k in ('input_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens', 'output_tokens'):
            t[k] += u.get(k) or 0
        cc = u.get('cache_creation') or {}
        w5 += cc.get('ephemeral_5m_input_tokens') or 0
        w1h += cc.get('ephemeral_1h_input_tokens') or 0
    if w5 + w1h == 0:
        w5 = t['cache_creation_input_tokens']
    pin, pout, pread = PRICE.get(model, (0.0, 0.0, 0.0))
    cost = (t['input_tokens'] * pin + w5 * pin * 1.25 + w1h * pin * 2 + t['cache_read_input_tokens'] * pread + t['output_tokens'] * pout) / 1e6
    who = re.search(r'agents/([a-z-]+)\.md|skills/([a-z-]+)/SKILL', prompt)
    role = (who.group(1) or who.group(2)) if who else re.sub(r'\s+', ' ', prompt)[:22]
    unread = len(shown - read)
    print(
        f"{time.strftime('%m-%d %H:%M', time.localtime(os.path.getmtime(f)))}  {role:18.18}  {model.replace('claude-', ''):11}  turns {len(usage):3}  shell {len(bash):3}  "
        f"stills {len(read):3}/{len(shown):<3}{' (unread ' + str(unread) + ')' if unread else '':13}  saves {saves}  refused {refusals}  "
        f"re-read {t['cache_read_input_tokens'] / 1e6:5.2f}M  {'$%5.2f' % cost if model in PRICE else 'no price'}"
    )
    if commands:
        for cmd in bash:
            print('      $', re.sub(r'\s+', ' ', cmd)[:200])
    total_cost += cost
    total_turns += len(usage)
    shown_runs += 1
print(f'{shown_runs} runs, {total_turns} turns, about ${total_cost:.2f} at API list prices')
