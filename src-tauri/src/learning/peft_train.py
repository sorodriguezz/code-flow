"""LoRA training on an NVIDIA card, written by CodeFlow next to each run (src-tauri/src/learning/peft_train.py).

Reads train.jsonl / valid.jsonl of {"messages": [...]} rows, trains a LoRA adapter with PEFT, and
prints the same progress lines as `mlx_lm lora` so the app reads both the same way:

    Iter N: Val loss X
    Iter N: Train loss X, Tokens/sec T, Peak mem M GB
    Iter N: Saved adapter weights to DIR

The loss covers the assistant's answer only (the prompt is masked), like `mlx_lm lora --mask-prompt`.
"""

import argparse
import json
import os
import random
import time

import torch
from peft import LoraConfig, get_peft_model, set_peft_model_state_dict
from transformers import AutoModelForCausalLM, AutoTokenizer

parser = argparse.ArgumentParser()
parser.add_argument("--model", required=True)
parser.add_argument("--data", required=True)
parser.add_argument("--out", required=True)
parser.add_argument("--iters", type=int, required=True)
parser.add_argument("--batch", type=int, default=1)
parser.add_argument("--lr", type=float, default=1e-5)
parser.add_argument("--max-seq", type=int, default=2048)
parser.add_argument("--rank", type=int, default=8)
parser.add_argument("--report", type=int, default=5)
parser.add_argument("--eval", type=int, default=25)
parser.add_argument("--resume", default=None)
# A mixture of experts: leave the routed experts alone — llama.cpp has no single tensor per expert
# for a LoRA to land on (src-tauri/src/learning/gguf_lora.rs).
parser.add_argument("--exclude-experts", action="store_true")
args = parser.parse_args()


def rows(name):
    with open(os.path.join(args.data, name), encoding="utf-8") as handle:
        return [json.loads(line)["messages"] for line in handle if line.strip()]


device = "cuda" if torch.cuda.is_available() else "cpu"
tokenizer = AutoTokenizer.from_pretrained(args.model)
if tokenizer.pad_token is None:
    tokenizer.pad_token = tokenizer.eos_token
model = AutoModelForCausalLM.from_pretrained(
    args.model, torch_dtype=torch.bfloat16 if device == "cuda" else torch.float32
).to(device)
model.gradient_checkpointing_enable()
model.enable_input_require_grads()
model = get_peft_model(
    model,
    LoraConfig(
        r=args.rank,
        lora_alpha=args.rank * 2,
        lora_dropout=0.05,
        task_type="CAUSAL_LM",
        target_modules="all-linear",
        exclude_modules=r".*\.experts\..*" if args.exclude_experts else None,
    ),
)
if args.resume:
    from safetensors.torch import load_file

    set_peft_model_state_dict(model, load_file(args.resume))


def encode(messages):
    prompt = tokenizer.apply_chat_template(messages[:-1], tokenize=False, add_generation_prompt=True)
    full = tokenizer.apply_chat_template(messages, tokenize=False)
    prompt_ids = tokenizer(prompt, add_special_tokens=False)["input_ids"]
    ids = tokenizer(full, add_special_tokens=False)["input_ids"][: args.max_seq]
    masked = min(len(prompt_ids), len(ids))
    labels = [-100] * masked + ids[masked:]
    return ids, labels


train = [encode(m) for m in rows("train.jsonl")]
valid = [encode(m) for m in rows("valid.jsonl")]


def collate(items):
    width = max(len(ids) for ids, _ in items)
    input_ids = torch.full((len(items), width), tokenizer.pad_token_id, dtype=torch.long)
    labels = torch.full((len(items), width), -100, dtype=torch.long)
    attention = torch.zeros((len(items), width), dtype=torch.long)
    for row, (ids, label) in enumerate(items):
        input_ids[row, : len(ids)] = torch.tensor(ids)
        labels[row, : len(label)] = torch.tensor(label)
        attention[row, : len(ids)] = 1
    return input_ids.to(device), labels.to(device), attention.to(device)


def validation_loss():
    model.eval()
    total, count = 0.0, 0
    with torch.no_grad():
        for start in range(0, len(valid), args.batch):
            input_ids, labels, attention = collate(valid[start : start + args.batch])
            total += model(input_ids=input_ids, attention_mask=attention, labels=labels).loss.item()
            count += 1
    model.train()
    return total / max(count, 1)


def save(step):
    model.save_pretrained(args.out)
    print(f"Iter {step}: Saved adapter weights to {args.out}", flush=True)


optimizer = torch.optim.AdamW([p for p in model.parameters() if p.requires_grad], lr=args.lr)
model.train()
random.seed(0)
order = []
print(f"Iter 1: Val loss {validation_loss():.3f}", flush=True)
started = time.time()
tokens = 0
for step in range(1, args.iters + 1):
    if len(order) < args.batch:
        order = list(range(len(train)))
        random.shuffle(order)
    batch = [train[order.pop()] for _ in range(min(args.batch, len(train)))]
    input_ids, labels, attention = collate(batch)
    loss = model(input_ids=input_ids, attention_mask=attention, labels=labels).loss
    loss.backward()
    optimizer.step()
    optimizer.zero_grad()
    tokens += int(attention.sum())
    if step % args.report == 0 or step == args.iters:
        peak = torch.cuda.max_memory_allocated() / 1e9 if device == "cuda" else 0.0
        rate = tokens / max(time.time() - started, 1e-6)
        print(f"Iter {step}: Train loss {loss.item():.3f}, Tokens/sec {rate:.1f}, Peak mem {peak:.3f} GB", flush=True)
    if step % args.eval == 0 or step == args.iters:
        print(f"Iter {step}: Val loss {validation_loss():.3f}", flush=True)
        save(step)
