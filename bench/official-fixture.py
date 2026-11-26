# SPDX-License-Identifier: AGPL-3.0-or-later
#
# Writes test/fixtures/longmemeval-official.json from LongMemEval's own code, so
# test/bench-official.test.ts can hold bench/official.ts to it:
#
#   git clone https://github.com/xiaowu0162/LongMemEval
#   git -C LongMemEval checkout 9e0b455f4ef0e2ab8f2e582289761153549043fc
#   python3 bench/official-fixture.py LongMemEval > test/fixtures/longmemeval-official.json
#
# Needs numpy. Only the prompt function of evaluate_qa.py runs, so its other imports
# (openai, backoff, tqdm) are stubbed; print_qa_metrics.py runs as it is.

import ast
import json
import os
import subprocess
import sys
import tempfile
import types

import numpy as np

root = os.path.abspath(sys.argv[1])
commit = subprocess.run(["git", "-C", root, "rev-parse", "HEAD"], capture_output=True, text=True, check=True).stdout.strip()

# evaluate_qa.py, for get_anscheck_prompt().
stub_openai = types.ModuleType("openai")
stub_openai.RateLimitError = stub_openai.APIError = Exception
stub_openai.OpenAI = object
stub_backoff = types.ModuleType("backoff")
stub_backoff.expo = None
stub_backoff.on_exception = lambda *a, **k: (lambda f: f)
stub_tqdm = types.ModuleType("tqdm")
stub_tqdm.tqdm = lambda x: x
sys.modules.update({"openai": stub_openai, "backoff": stub_backoff, "tqdm": stub_tqdm})
sys.path.insert(0, os.path.join(root, "src", "evaluation"))
from evaluate_qa import get_anscheck_prompt  # noqa: E402

# eval_utils.py, for the retrieval scores. numpy 2 dropped asfarray, which it calls.
if not hasattr(np, "asfarray"):
    np.asfarray = lambda a: np.asarray(a, dtype=float)
sys.path.insert(0, os.path.join(root, "src", "retrieval"))
from eval_utils import evaluate_retrieval  # noqa: E402

# run_retrieval.py imports retrievers at the top; take process_item_flat_index() out of its source.
source = open(os.path.join(root, "src", "retrieval", "run_retrieval.py")).read()
for node in ast.parse(source).body:
    if isinstance(node, ast.FunctionDef) and node.name == "process_item_flat_index":
        exec(compile(ast.Module(body=[node], type_ignores=[]), "run_retrieval.py", "exec"))
        break
else:
    raise SystemExit("process_item_flat_index not found in run_retrieval.py")

# run_generation.py builds its prompt inside prepare_prompt(); take the template it uses
# with cot true and no fact expansion (the default reading method, "con").
templates = [
    n.value
    for n in ast.walk(ast.parse(open(os.path.join(root, "src", "generation", "run_generation.py")).read()))
    if isinstance(n, ast.Constant)
    and isinstance(n.value, str)
    and n.value.startswith("I will give you several history chats between you and a user. Please answer the question based on the relevant chat history. Answer the question step by step")
]
if len(templates) != 1:
    raise SystemExit(f"expected one reader template, found {len(templates)}")
reader_template = templates[0]

# Inputs with the characters that trip ports up: quotes, braces, backslashes, newlines, tabs, non-ASCII, emoji.
QUESTION = 'What did I say about "Luna" {the cat}?\tIt\'s café time 🐈'
RESPONSE = "Step 1: you said \"Luna\".\n\nSo the answer is Luna. \\o/ Ünïcödé ✓"
TYPES = ["single-session-user", "single-session-assistant", "multi-session", "temporal-reasoning", "knowledge-update", "single-session-preference"]

judge = []
for task in TYPES:
    for answer in ["Luna, a café-au-lait cat {named}", 3]:
        judge.append({"task": task, "question": QUESTION, "answer": answer, "response": RESPONSE, "abstention": False, "prompt": get_anscheck_prompt(task, QUESTION, answer, RESPONSE, abstention=False)})
judge.append({"task": "multi-session", "question": QUESTION, "answer": "You never mentioned a dog.", "response": RESPONSE, "abstention": True, "prompt": get_anscheck_prompt("multi-session", QUESTION, "You never mentioned a dog.", RESPONSE, abstention=True)})

HISTORY = "- [01ABC] (profile · conversation · user_explicit · bench · 2023-05-20) [user] My cat is called \"Luna\" {x}.\n[assistant] Lovely! ✓"
DATE = "2023/05/30 (Tue) 23:40"
reader = [{"history": HISTORY, "date": DATE, "question": QUESTION, "prompt": reader_template.format(HISTORY, DATE, QUESTION)}]

# The two files: run_generation.py's lines and evaluate_qa.py's lines.
HYPOTHESES = [("e47becba", RESPONSE), ("gpt4_2655b836_abs", "I don't know.\u2028\u0007\u007f\U0001F600"), ("q3", "")]
files = []
for qid, hyp in HYPOTHESES:
    entry = json.loads(json.dumps({"question_id": qid, "hypothesis": hyp}))
    hyp_line = json.dumps({"question_id": qid, "hypothesis": hyp})
    for label in [True, False]:
        e = dict(entry)
        e["autoeval_label"] = {"model": "gpt-4o-2024-08-06", "label": label}
        files.append({"question_id": qid, "hypothesis": hyp, "label": label, "hypothesis_line": hyp_line, "eval_line": json.dumps(e)})

# print_qa_metrics.py, run as it is on a small results file.
refs = []
results = []
labels = {
    "single-session-user": [1, 1, 0, 1, 1, 1, 0],
    "single-session-preference": [1, 0, 0],
    "single-session-assistant": [1, 1, 1, 1],
    "multi-session": [0, 1, 0, 1, 1, 0, 1, 1],
    "temporal-reasoning": [1, 0, 1, 1, 0, 0],
    "knowledge-update": [1, 1, 0, 1, 1],
}
for t, ls in labels.items():
    for i, label in enumerate(ls):
        qid = f"{t}-{i}" + ("_abs" if i in (1, 2) else "")
        refs.append({"question_id": qid, "question_type": t, "question": "q", "answer": "a"})
        results.append({"question_id": qid, "hypothesis": "h", "autoeval_label": {"model": "gpt-4o-2024-08-06", "label": bool(label)}})
with tempfile.TemporaryDirectory() as tmp:
    in_file, ref_file = os.path.join(tmp, "results"), os.path.join(tmp, "refs.json")
    with open(in_file, "w") as f:
        for r in results:
            print(json.dumps(r), file=f)
    with open(ref_file, "w") as f:
        json.dump(refs, f)
    printout = subprocess.run([sys.executable, os.path.join(root, "src", "evaluation", "print_qa_metrics.py"), in_file, ref_file], capture_output=True, text=True, check=True).stdout
qa = {"judged": [{"id": r["question_id"], "type": ref["question_type"], "label": r["autoeval_label"]["label"]} for r, ref in zip(results, refs)], "printout": printout}

# Session-level retrieval scores, with the corpus and evidence of run_retrieval.py.
def turns(*flags):
    out = []
    for i, f in enumerate(flags):
        out.append({"role": "user", "content": f"u{i}", "has_answer": f})
        out.append({"role": "assistant", "content": f"a{i}", "has_answer": False})
    return out

CASES = [
    # two evidence sessions; one answer session holds its evidence on the assistant side only (becomes noans_)
    {"question_id": "r1", "ids": ["s_1", "answer_a", "s_2", "answer_b", "answer_c", "s_3"], "sessions": [turns(False), turns(True), turns(False), turns(False, True), [{"role": "user", "content": "x", "has_answer": False}, {"role": "assistant", "content": "y", "has_answer": True}], turns(False)], "order": ["answer_c", "s_2", "answer_b", "s_9"]},
    # an id twice in the history, ranked once
    {"question_id": "r2", "ids": ["answer_a", "s_1", "answer_a", "s_2"], "sessions": [turns(True), turns(False), turns(True), turns(False)], "order": ["s_2", "answer_a"]},
    # nothing recalled
    {"question_id": "r3", "ids": ["s_1", "answer_a", "s_2"], "sessions": [turns(False), turns(True), turns(False)], "order": []},
    # left out of the averages: abstention, and no evidence on the user side
    {"question_id": "r4_abs", "ids": ["s_1", "answer_a"], "sessions": [turns(False), turns(True)], "order": ["answer_a"]},
    {"question_id": "r5", "ids": ["s_1", "answer_a"], "sessions": [turns(False), [{"role": "user", "content": "x", "has_answer": False}, {"role": "assistant", "content": "y", "has_answer": True}]], "order": ["answer_a"]},
]
retrieval = []
for c in CASES:
    corpus_ids = []
    for sid, sess in zip(c["ids"], c["sessions"]):
        corpus_ids += process_item_flat_index(sess, "session", sid, "2023/01/01 (Sun) 00:00")[1]
    correct_docs = list(set([doc_id for doc_id in corpus_ids if "answer" in doc_id]))
    # The ranking bench/official.ts builds: the recalled sessions in order (every entry of an id), then the rest in history order.
    rankings = []
    for sid in c["order"]:
        rankings += [i for i, x in enumerate(c["ids"]) if x == sid and i not in rankings]
    rankings += [i for i in range(len(c["ids"])) if i not in rankings]
    # run_retrieval.py, main(): which questions its averages leave out.
    counted = "_abs" not in c["question_id"] and any(("has_answer" in turn) and (turn["has_answer"]) for turn in [x for y in c["sessions"] for x in y if x["role"] == "user"])
    scores = {}
    for k in [1, 3, 5, 10, 30, 50]:
        recall_any, recall_all, ndcg_any = evaluate_retrieval(rankings, correct_docs, corpus_ids, k=k)
        scores.update({f"recall_any@{k}": recall_any, f"recall_all@{k}": recall_all, f"ndcg_any@{k}": float(ndcg_any)})
    retrieval.append({"question": {"question_id": c["question_id"], "haystack_session_ids": c["ids"], "haystack_sessions": c["sessions"]}, "order": c["order"], "counted": counted, "scores": scores if counted else None})

json.dump({"upstream": {"repo": "https://github.com/xiaowu0162/LongMemEval", "commit": commit}, "judge": judge, "reader": reader, "files": files, "qa": qa, "retrieval": retrieval}, sys.stdout, indent=1, ensure_ascii=False)
print()
