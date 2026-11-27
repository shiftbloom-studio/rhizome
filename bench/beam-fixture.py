# SPDX-License-Identifier: AGPL-3.0-or-later
#
# Writes test/fixtures/beam-official.json from a BEAM checkout, so
# test/bench-beam.test.ts can hold bench/beam.ts to it:
#
#   git clone https://github.com/mohammadtavakoli78/BEAM
#   git -C BEAM checkout b2da22eac88bb0874c64665f13457eb99835774a
#   python3 -I bench/beam-fixture.py BEAM > test/fixtures/beam-official.json
#
# Needs scipy. Nothing of the checkout runs: its prompts and the strings of the judge's
# messages are read from the source with ast, and the event-ordering cases are scored
# with scipy's kendalltau, the function compute_metrics.py calls.

import ast
import json
import os
import subprocess
import sys

from scipy.stats import kendalltau

root = os.path.abspath(sys.argv[1])
commit = subprocess.run(["git", "-C", root, "rev-parse", "HEAD"], capture_output=True, text=True, check=True).stdout.strip()


def constants(path):
    out = {}
    for node in ast.parse(open(path, encoding="utf-8").read()).body:
        if isinstance(node, ast.Assign) and isinstance(node.value, ast.Constant) and isinstance(node.value.value, str):
            for target in node.targets:
                if isinstance(target, ast.Name):
                    out[target.id] = node.value.value
    return out


prompts = constants(os.path.join(root, "src", "prompts.py"))

# llm_equivalence() in compute_metrics.py: the system message is a plain string, the user
# message an f-string with the two snippets; both are read from the syntax tree.
metrics = ast.parse(open(os.path.join(root, "src", "evaluation", "compute_metrics.py"), encoding="utf-8").read())
equivalence = next(n for n in metrics.body if isinstance(n, ast.FunctionDef) and n.name == "llm_equivalence")
dicts = [n for n in ast.walk(equivalence) if isinstance(n, ast.Dict)]
system = next(v.value for d in dicts for k, v in zip(d.keys, d.values) if isinstance(k, ast.Constant) and k.value == "content" and isinstance(v, ast.Constant))
fstring = next(v for d in dicts for k, v in zip(d.keys, d.values) if isinstance(k, ast.Constant) and k.value == "content" and isinstance(v, ast.JoinedStr))
pieces = [p.value if isinstance(p, ast.Constant) else "{" + p.value.id + "}" for p in fstring.values]
user_template = "".join(pieces)


def equivalence_messages(first, second):
    return [{"role": "system", "content": system}, {"role": "user", "content": user_template.replace("{first_paragraph}", first).replace("{second_paragraph}", second)}]


def tau_norm(reference, system_canon):
    """event_ordering_score() after the alignment, as compute_metrics.py computes it."""
    tp = len(set(reference) & set(system_canon))
    fp = len([x for x in system_canon if x not in reference])
    fn = len([x for x in reference if x not in system_canon])
    precision = tp / (tp + fp) if tp + fp else 0
    recall = tp / (tp + fn) if tp + fn else 0
    f1 = 2 * precision * recall / (precision + recall) if precision + recall else 0
    union = list(dict.fromkeys(reference + system_canon))
    tie_rank = len(union) + 1

    def to_rank(seq):
        r = {item: i + 1 for i, item in enumerate(seq)}
        return [r.get(u, tie_rank) for u in union]

    tau_b, _ = kendalltau(to_rank(reference), to_rank(system_canon), variant="b", method="auto")
    tau = float(tau_b)
    norm = (tau + 1) / 2
    return {"precision": precision, "recall": recall, "f1": f1, "tau_norm": None if norm != norm else norm, "final_score": None if norm != norm else norm * f1}


# Aligned lists (what align_with_llm returns for the system's lines) and their scores.
cases = [
    (["A", "B", "C"], ["A", "B", "C"]),
    (["A", "B", "C"], ["C", "A", "B"]),
    (["A", "B", "C"], ["", "intro", "A", "C", "B"]),
    (["A", "B", "C", "D"], ["C", "A", "D"]),
    (["A", "B"], ["x"]),
    (["A", "B", "C"], ["A", "A again", "B", "C"]),
    (["A", "B", "C"], ["C", "B", "A"]),
    (["A"], ["A"]),
]

print(json.dumps({
    "upstream": {"repo": "https://github.com/mohammadtavakoli78/BEAM", "commit": commit},
    "readerPrompt": prompts["answer_generation_for_rag"].replace("<context>", "CONTEXT TEXT").replace("<question>", "QUESTION TEXT"),
    "judgePrompt": prompts["unified_llm_judge_base_prompt"].replace("<rubric_item>", "RUBRIC ITEM").replace("<llm_response>", "RESPONSE TEXT"),
    "equivalence": equivalence_messages("First event", "Second event"),
    "ordering": [{"reference": r, "system": s, "score": tau_norm(r, s)} for r, s in cases],
}, indent=1, ensure_ascii=False))
